"""
Hermes Brain Orchestrator — zero-token multi-agent coordination.

Replaces hermes's basic delegate_task with brain-powered orchestration:
  - Task DAG with dependency resolution
  - Parallel agent spawning via hermes -q
  - Integration gate between phases
  - Auto-recovery of failed agents
  - Multi-model routing
  - Performance metrics

All coordination is pure Python — LLM tokens only spent on real work.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from typing import Any, Optional

from hermes.db import BrainDB
from hermes.gate import run_gate_and_notify, GateResult
from hermes.prompt import agent_prompt

# ── ANSI helpers ──

C_RESET = "\033[0m"
C_BOLD = "\033[1m"
C_DIM = "\033[2m"
C_GREEN = "\033[32m"
C_RED = "\033[31m"
C_YELLOW = "\033[33m"
C_BLUE = "\033[34m"
C_MAGENTA = "\033[35m"
C_CYAN = "\033[36m"

STATUS_ICONS = {
    "idle": f"{C_DIM}○{C_RESET}",
    "working": f"{C_YELLOW}●{C_RESET}",
    "done": f"{C_GREEN}✓{C_RESET}",
    "failed": f"{C_RED}✗{C_RESET}",
    "stale": f"{C_RED}?{C_RESET}",
    "queued": f"{C_DIM}◌{C_RESET}",
}


@dataclass
class AgentConfig:
    name: str
    task: str
    files: list[str] | None = None
    model: str | None = None


@dataclass
class PhaseConfig:
    name: str
    parallel: bool
    agents: list[AgentConfig]


class Orchestrator:
    """Spawns and coordinates hermes agents through a task pipeline."""

    def __init__(
        self,
        task: str,
        cwd: str | None = None,
        model: str = "claude-sonnet-4-5",
        gate: bool = True,
        max_gate_retries: int = 3,
        timeout: int = 600,
        db_path: str | None = None,
    ):
        self.task = task
        self.cwd = cwd or os.getcwd()
        self.model = model
        self.gate = gate
        self.max_gate_retries = max_gate_retries
        self.timeout = timeout

        self.db = BrainDB(db_path)
        self.conductor_id = str(uuid.uuid4())
        self.db.register_session(
            "conductor", self.cwd,
            json.dumps({"role": "conductor", "model": model}),
            self.conductor_id,
        )
        self.db.pulse(self.conductor_id, "working", "orchestrating")
        self._agent_ids: dict[str, str] = {}  # name → session_id
        self._processes: dict[str, subprocess.Popen] = {}  # name → process

    def close(self) -> None:
        self.db.pulse(self.conductor_id, "done", "conductor exited")
        self.db.close()

    # ── Spawn a single hermes agent ──

    def spawn_agent(self, config: AgentConfig) -> str:
        """Spawn a hermes agent as a background process. Returns session ID."""
        agent_sid = str(uuid.uuid4())
        self._agent_ids[config.name] = agent_sid

        # Pre-register in brain
        self.db.register_session(
            config.name, self.cwd,
            json.dumps({
                "parent_session_id": self.conductor_id,
                "conductor": True,
                "model": config.model or self.model,
            }),
            agent_sid,
        )
        self.db.pulse(agent_sid, "working", "spawned by conductor; starting hermes")

        # Build prompt
        prompt = agent_prompt(
            agent_name=config.name,
            task=config.task,
            assigned_by="conductor",
            file_scope=config.files,
        )

        # Build env
        env = os.environ.copy()
        env["BRAIN_ROOM"] = self.cwd
        env["BRAIN_SESSION_ID"] = agent_sid
        env["BRAIN_SESSION_NAME"] = config.name
        if self.db.conn:
            # Pass DB path if custom
            db_path = os.environ.get("BRAIN_DB_PATH")
            if db_path:
                env["BRAIN_DB_PATH"] = db_path

        # Model routing
        agent_model = config.model or self.model
        if agent_model:
            env["HERMES_MODEL"] = agent_model

        # Write prompt to file (avoids shell argument length limits)
        prompt_file = os.path.join(tempfile.gettempdir(), f"brain-hermes-{agent_sid[:8]}.txt")
        with open(prompt_file, "w") as f:
            f.write(prompt)

        # Spawn hermes chat -q (non-interactive query mode, -Q suppresses TUI)
        log_file = os.path.join(tempfile.gettempdir(), f"brain-agent-{agent_sid[:8]}.log")
        with open(log_file, "w") as log_f:
            proc = subprocess.Popen(
                ["hermes", "chat", "-q", prompt, "-Q", "--yolo"],
                cwd=self.cwd,
                env=env,
                stdout=log_f,
                stderr=subprocess.STDOUT,
            )
        self._processes[config.name] = proc

        self._print_status(config.name, "spawned", C_BLUE)
        return agent_sid

    # ── Spawn a batch of agents ──

    def spawn_phase(self, phase: PhaseConfig) -> None:
        """Spawn all agents in a phase."""
        self._print_header(f"Phase: {phase.name}")
        for agent in phase.agents:
            self.spawn_agent(agent)

    # ── Wait for all agents to finish ──

    def wait_for_agents(
        self, names: list[str] | None = None, poll_interval: float = 5.0,
    ) -> dict[str, str]:
        """Poll until all named agents report done/failed. Returns name → status."""
        targets = names or list(self._agent_ids.keys())
        results: dict[str, str] = {}

        while True:
            agents = self.db.get_agent_health(self.cwd)
            all_done = True
            for name in targets:
                sid = self._agent_ids.get(name)
                if not sid:
                    continue

                # Hermes doesn't propagate BRAIN_SESSION_ID to MCP subprocesses,
                # so the spawned agent creates its own session via brain_register.
                # Discover the real session by name and switch tracking to it,
                # removing the pre-registered zombie row.
                real_agent = next(
                    (a for a in agents
                     if a.name == name
                     and a.id != sid
                     and a.id != self.conductor_id),
                    None,
                )
                if real_agent:
                    try:
                        self.db.remove_session(sid)
                    except Exception:
                        pass
                    self._agent_ids[name] = real_agent.id
                    sid = real_agent.id
                    agents = self.db.get_agent_health(self.cwd)

                agent = next((a for a in agents if a.id == sid), None)
                if not agent:
                    continue

                if agent.status in ("done", "failed"):
                    results[name] = agent.status
                elif agent.is_stale:
                    results[name] = "stale"
                else:
                    all_done = False

                # Print live status
                icon = STATUS_ICONS.get(agent.status, STATUS_ICONS["idle"])
                if agent.is_stale:
                    icon = STATUS_ICONS["stale"]
                progress = agent.progress or agent.status
                if len(progress) > 40:
                    progress = progress[:37] + "..."
                print(f"\r  {icon} {name:<20} {progress:<42}", end="", flush=True)

            if all_done and len(results) >= len(targets):
                print()  # newline after status
                break

            # Also check if processes have exited
            for name in targets:
                if name in results:
                    continue
                proc = self._processes.get(name)
                if proc and proc.poll() is not None:
                    sid = self._agent_ids[name]
                    # Process exited but agent didn't self-report via brain_pulse.
                    # Exit code 0 alone is not enough — some hermes/model pairs
                    # emit malformed tool calls that hermes silently ignores, so
                    # the process exits cleanly without the agent doing anything.
                    # Verify observable work (messages, DMs, or contracts) before
                    # marking done.
                    health = next(
                        (a for a in agents if a.id == sid), None
                    )
                    if health and health.status not in ("done", "failed"):
                        if proc.returncode == 0:
                            did_work, summary = self._agent_produced_work(sid)
                            if did_work:
                                self.db.pulse(sid, "done", f"process completed (exit 0, {summary})")
                                results[name] = "done"
                            else:
                                self.db.pulse(sid, "failed", "exit 0 but no observable work (no messages, DMs, or contracts)")
                                results[name] = "failed"
                        else:
                            self.db.pulse(sid, "failed", f"process exited with code {proc.returncode}")
                            results[name] = "failed"

            time.sleep(poll_interval)

        return results

    # ── Work verification ──

    def _agent_produced_work(self, sid: str) -> tuple[bool, str]:
        """Check if an agent session has observable artifacts in brain.

        Returns (did_work, summary). We check rows that persist beyond session
        cleanup (messages, DMs, contracts) rather than claims (released on exit)
        or session rows (deleted on exit).
        """
        conn = self.db.conn
        msgs = conn.execute(
            "SELECT COUNT(*) FROM messages WHERE sender_id=?", (sid,)
        ).fetchone()[0]
        dms = conn.execute(
            "SELECT COUNT(*) FROM direct_messages WHERE from_id=?", (sid,)
        ).fetchone()[0]
        contracts = conn.execute(
            "SELECT COUNT(*) FROM contracts WHERE agent_id=?", (sid,)
        ).fetchone()[0]
        total = msgs + dms + contracts
        if total == 0:
            return False, "nothing"
        parts = []
        if msgs:
            parts.append(f"{msgs} msg")
        if dms:
            parts.append(f"{dms} dm")
        if contracts:
            parts.append(f"{contracts} contract")
        return True, ", ".join(parts)

    # ── Integration gate ──

    def run_gate(self) -> GateResult:
        """Run the integration gate once."""
        return run_gate_and_notify(
            self.db, self.cwd, self.cwd,
            self.conductor_id, "conductor",
        )

    def run_gate_loop(self) -> GateResult:
        """Run gate in a loop until pass or max retries."""
        for attempt in range(1, self.max_gate_retries + 1):
            self._print_status("gate", f"attempt {attempt}/{self.max_gate_retries}", C_CYAN)
            result = self.run_gate()

            if result.passed:
                self._print_status("gate", "PASSED", C_GREEN)
                return result

            self._print_status(
                "gate",
                f"FAILED — {result.compile_error_count} compile, {result.contract_mismatch_count} contract",
                C_RED,
            )

            if attempt < self.max_gate_retries:
                print(f"  {C_YELLOW}Agents notified via DM. Waiting for fixes...{C_RESET}")
                # Wait for agents to fix and re-report done
                time.sleep(15)
                working_agents = [
                    a.name for a in self.db.get_agent_health(self.cwd)
                    if a.status == "working" and a.name != "conductor"
                ]
                if working_agents:
                    self.wait_for_agents(working_agents)

        return result

    # ── Auto-recovery ──

    def respawn_failed(self, name: str, extra_context: str = "") -> str | None:
        """Respawn a failed/stale agent with recovery context."""
        sid = self._agent_ids.get(name)
        if not sid:
            return None

        session = self.db.get_session(sid)
        if not session:
            return None

        # Gather context from failed agent
        messages = [
            m for m in self.db.get_messages("general", self.cwd)
            if m.sender_id == sid
        ]
        health = next(
            (a for a in self.db.get_agent_health(self.cwd) if a.id == sid), None
        )

        recovery = [
            f'RECOVERY: You are replacing agent "{name}" which failed.',
            f'Last known progress: "{health.progress if health else "unknown"}"',
        ]
        if health and health.claims:
            recovery.append(f"Files it was working on: {', '.join(health.claims)}")
        if messages:
            recovery.append(f"Its messages: {'; '.join(m.content for m in messages[-3:])}")
        if extra_context:
            recovery.append(f"Additional context: {extra_context}")
        recovery.append("Pick up where they left off.")

        # Release old claims
        self.db.release_all(sid)

        # Record failure metric
        self.db.record_metric(self.cwd, name, agent_id=sid, outcome="failed")

        # Spawn replacement
        replacement_name = f"{name}-r{int(time.time()) % 10000}"
        metadata = json.loads(session.metadata or "{}")
        original_task = metadata.get("task", "Continue the work")

        new_config = AgentConfig(
            name=replacement_name,
            task="\n".join(recovery) + "\n\nORIGINAL TASK:\n" + original_task,
            model=metadata.get("model"),
        )
        self._print_status(replacement_name, "respawning (recovery)", C_YELLOW)
        return self.spawn_agent(new_config)

    # ── Run a complete pipeline ──

    def run_pipeline(self, phases: list[PhaseConfig]) -> bool:
        """Execute a multi-phase pipeline. Returns True if all phases pass."""
        self._print_header("Hermes Brain Orchestrator")
        print(f"  {C_DIM}Task: {self.task[:70]}{C_RESET}")
        print(f"  {C_DIM}Phases: {len(phases)} | Model: {self.model} | Gate: {self.gate}{C_RESET}")

        for i, phase in enumerate(phases):
            self._print_header(f"Phase {i+1}/{len(phases)}: {phase.name}")

            # Spawn agents
            self.spawn_phase(phase)

            # Wait for completion
            agent_names = [a.name for a in phase.agents]
            results = self.wait_for_agents(agent_names)

            # Check for failures
            failed = [n for n, s in results.items() if s in ("failed", "stale")]
            if failed:
                print(f"\n  {C_RED}Failed agents: {', '.join(failed)}{C_RESET}")

                # Auto-recover
                for name in failed:
                    new_sid = self.respawn_failed(name)
                    if new_sid:
                        # Wait for recovery agent
                        recovery_name = [
                            n for n in self._agent_ids
                            if n.startswith(name) and n != name
                        ]
                        if recovery_name:
                            self.wait_for_agents(recovery_name)

            # Run gate
            if self.gate:
                gate_result = self.run_gate_loop()
                if not gate_result.passed:
                    print(f"\n  {C_RED}Phase \"{phase.name}\" — gate failed after {self.max_gate_retries} attempts{C_RESET}")
                    self._print_remaining_errors(gate_result)
                    return False
            else:
                print(f"\n  {C_GREEN}Phase \"{phase.name}\" complete (no gate){C_RESET}")

        # Record metrics for successful agents
        for name, sid in self._agent_ids.items():
            health = next(
                (a for a in self.db.get_agent_health(self.cwd) if a.id == sid), None
            )
            if health and health.status == "done":
                self.db.record_metric(self.cwd, name, agent_id=sid, outcome="success")

        self._print_summary()
        return True

    # ── Display helpers ──

    def _print_header(self, text: str) -> None:
        print(f"\n  {C_MAGENTA}{'─' * 50}{C_RESET}")
        print(f"  {C_BOLD}{C_MAGENTA}{text}{C_RESET}")
        print(f"  {C_MAGENTA}{'─' * 50}{C_RESET}")

    def _print_status(self, name: str, status: str, color: str = C_RESET) -> None:
        print(f"  {color}▸{C_RESET} {name:<20} {color}{status}{C_RESET}")

    def _print_remaining_errors(self, result: GateResult) -> None:
        for routed in result.routed:
            print(f"  {routed.agent_name}:")
            for err in routed.errors:
                print(f"    {err}")

    def _print_summary(self) -> None:
        self._print_header("Summary")
        agents = self.db.get_agent_health(self.cwd)
        done = [a for a in agents if a.status == "done" and a.name != "conductor"]
        failed = [a for a in agents if a.status == "failed"]
        contracts = self.db.get_contracts(self.cwd)
        mismatches = self.db.validate_contracts(self.cwd)
        memories = self.db.recall_memory(self.cwd)

        print(f"  Agents: {len(done)} done, {len(failed)} failed")
        print(f"  Contracts: {len(contracts)} published, {len(mismatches)} mismatches")
        print(f"  Memories: {len(memories)} stored")

        metrics = self.db.get_metrics_summary(self.cwd)
        if metrics:
            print(f"\n  Performance:")
            for m in metrics:
                avg = m.get("avg_duration")
                dur = f"{avg:.0f}s avg" if avg else "n/a"
                print(f"    {m['agent_name']}: {m['total_tasks']} tasks, {m['successes']} ok, {dur}")

        if not failed and not mismatches:
            print(f"\n  {C_GREEN}{C_BOLD}All phases passed. Ship it.{C_RESET}")
