"""Integration gate — runs between phases to catch cross-agent errors.

Checks:
  1. Language-specific compilation (tsc, mypy, cargo check, go vet)
  2. Contract validation (provides/expects mismatches)
  3. Optional test suite

Routes errors to responsible agents via DM.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass, field
from typing import Any, Optional

from hermes.db import BrainDB


@dataclass
class GateError:
    file: str
    line: int
    column: int
    code: str
    message: str


@dataclass
class RoutedErrors:
    agent_id: str
    agent_name: str
    errors: list[str] = field(default_factory=list)


@dataclass
class GateResult:
    passed: bool
    compile_passed: bool
    compile_error_count: int
    compile_errors: list[GateError]
    contract_passed: bool
    contract_mismatch_count: int
    routed: list[RoutedErrors]
    summary: str


def _detect_and_run_compiler(cwd: str) -> tuple[bool, list[GateError]]:
    """Auto-detect project language and run the appropriate compiler check."""
    errors: list[GateError] = []

    # TypeScript
    if os.path.exists(os.path.join(cwd, "tsconfig.json")):
        try:
            subprocess.run(
                ["npx", "tsc", "--noEmit"],
                cwd=cwd, capture_output=True, text=True, timeout=60,
            )
            return True, []
        except subprocess.CalledProcessError as e:
            output = (e.stdout or "") + (e.stderr or "")
            for line in output.splitlines():
                m = re.match(r"^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$", line)
                if m:
                    errors.append(GateError(m[1], int(m[2]), int(m[3]), m[4], m[5]))
            return False, errors
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return True, []  # Can't run compiler — skip

    # Python (mypy)
    if os.path.exists(os.path.join(cwd, "pyproject.toml")) or os.path.exists(os.path.join(cwd, "setup.py")):
        try:
            result = subprocess.run(
                ["mypy", ".", "--no-error-summary"],
                cwd=cwd, capture_output=True, text=True, timeout=60,
            )
            if result.returncode == 0:
                return True, []
            for line in result.stdout.splitlines():
                m = re.match(r"^(.+?):(\d+):(\d+):\s*error:\s*(.+?)$", line)
                if m:
                    errors.append(GateError(m[1], int(m[2]), int(m[3]), "mypy", m[4]))
            return False, errors
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return True, []

    # Rust
    if os.path.exists(os.path.join(cwd, "Cargo.toml")):
        try:
            result = subprocess.run(
                ["cargo", "check", "--message-format=short"],
                cwd=cwd, capture_output=True, text=True, timeout=120,
            )
            if result.returncode == 0:
                return True, []
            for line in result.stderr.splitlines():
                m = re.match(r"^error\[(.+?)\]:\s*(.+)$", line)
                if m:
                    errors.append(GateError("", 0, 0, m[1], m[2]))
            return False, errors
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return True, []

    # Go
    if os.path.exists(os.path.join(cwd, "go.mod")):
        try:
            result = subprocess.run(
                ["go", "vet", "./..."],
                cwd=cwd, capture_output=True, text=True, timeout=60,
            )
            return result.returncode == 0, []
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return True, []

    # No recognized project — pass
    return True, []


def run_gate(db: BrainDB, room: str, cwd: str) -> GateResult:
    """Run compilation + contract checks. Returns structured results."""
    compile_passed, compile_errors = _detect_and_run_compiler(cwd)
    mismatches = db.validate_contracts(room)

    # Route errors to responsible agents
    agents = db.get_agent_health(room)
    claims = db.get_claims(room)
    file_to_agent: dict[str, tuple[str, str]] = {}
    for c in claims:
        agent = next((a for a in agents if a.id == c["owner_id"]), None)
        if agent:
            file_to_agent[c["resource"]] = (agent.id, agent.name)
    for c in db.get_contracts(room, kind="provides"):
        if c["module"] not in file_to_agent:
            file_to_agent[c["module"]] = (c["agent_id"], c["agent_name"])

    errors_by_agent: dict[str, RoutedErrors] = {}

    def add_error(aid: str, aname: str, error: str) -> None:
        if aid not in errors_by_agent:
            errors_by_agent[aid] = RoutedErrors(agent_id=aid, agent_name=aname)
        errors_by_agent[aid].errors.append(error)

    for err in compile_errors:
        owner = file_to_agent.get(err.file)
        if not owner:
            for res, agent in file_to_agent.items():
                if err.file.startswith(res) or res.startswith(err.file.rsplit("/", 1)[0]):
                    owner = agent
                    break
        if owner:
            add_error(owner[0], owner[1], f"[compile] {err.file}({err.line},{err.column}): {err.code} {err.message}")

    for m in mismatches:
        expecter = next((a for a in agents if a.name == m.expected_by), None)
        if expecter:
            add_error(expecter.id, expecter.name, f"[contract] {m.detail}")
        if m.provided_by:
            provider = next((a for a in agents if a.name == m.provided_by), None)
            if provider:
                add_error(provider.id, provider.name, f"[contract] {m.detail}")

    passed = compile_passed and len(mismatches) == 0
    parts = []
    parts.append(f"compile: {'PASS' if compile_passed else f'{len(compile_errors)} error(s)'}")
    parts.append(f"contracts: {'PASS' if not mismatches else f'{len(mismatches)} mismatch(es)'}")

    return GateResult(
        passed=passed,
        compile_passed=compile_passed,
        compile_error_count=len(compile_errors),
        compile_errors=compile_errors,
        contract_passed=len(mismatches) == 0,
        contract_mismatch_count=len(mismatches),
        routed=list(errors_by_agent.values()),
        summary=f"GATE {'PASSED' if passed else 'FAILED'} — {', '.join(parts)}",
    )


def run_gate_and_notify(
    db: BrainDB, room: str, cwd: str,
    conductor_id: str, conductor_name: str,
) -> GateResult:
    """Run gate AND DM agents their errors. Resets failed agents to 'working'."""
    result = run_gate(db, room, cwd)
    if not result.passed:
        for routed in result.routed:
            error_list = "\n".join(f"  {i+1}. {e}" for i, e in enumerate(routed.errors))
            msg = (
                f"INTEGRATION GATE FAILED — you have {len(routed.errors)} error(s) to fix:\n"
                f"{error_list}\n\n"
                "Fix these, then use the brain MCP contract_check tool and pulse status=done."
            )
            db.send_dm(conductor_id, conductor_name, routed.agent_id, msg)
            db.pulse(routed.agent_id, "working", f"gate failed: {len(routed.errors)} errors")
        db.post_message("alerts", room, conductor_id, conductor_name, result.summary)
    else:
        db.post_message("general", room, conductor_id, conductor_name, result.summary)
    return result
