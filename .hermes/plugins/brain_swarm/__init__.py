"""Hermes project plugin: launch named brain-mcp presets with /agents."""

from __future__ import annotations

import json
import logging
import os
import queue
import shlex
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _PLUGIN_DIR.parents[2]
_PRESETS_FILE = _PLUGIN_DIR / "presets.yaml"
_DIST_SERVER = _REPO_ROOT / "dist" / "index.js"
_AUTO_MONITOR_POLL_SECONDS = 2.0


@dataclass(frozen=True)
class ToolInvocation:
    tool_name: str
    arguments: dict[str, Any]
    default_cli: str = "hermes"


def register(ctx) -> None:
    """Register the /agents slash command and its compatibility shim."""
    _install_plugin_command_shim()
    _register_agents_command(ctx)


def _install_plugin_command_shim() -> None:
    """Restore the pieces of Hermes's plugin slash-command path that regressed."""
    import hermes_cli.plugins as plugins_mod

    manager = plugins_mod.get_plugin_manager()
    if not hasattr(manager, "_plugin_commands"):
        manager._plugin_commands = {}

    if not hasattr(plugins_mod, "get_plugin_command_handler"):
        def get_plugin_command_handler(name: str):
            entry = getattr(plugins_mod.get_plugin_manager(), "_plugin_commands", {}).get(name)
            if callable(entry):
                return entry
            if isinstance(entry, dict):
                return entry.get("handler")
            return None

        plugins_mod.get_plugin_command_handler = get_plugin_command_handler

    plugin_context = getattr(plugins_mod, "PluginContext", None)
    if plugin_context is not None and not hasattr(plugin_context, "register_command"):
        def register_command(self, name: str, handler, description: str = "") -> None:
            if not hasattr(self._manager, "_plugin_commands"):
                self._manager._plugin_commands = {}
            self._manager._plugin_commands[name] = {
                "handler": handler,
                "description": description,
                "plugin": self.manifest.name,
            }

        plugin_context.register_command = register_command


def _register_agents_command(ctx) -> None:
    from hermes_cli.commands import COMMAND_REGISTRY, CommandDef, register_plugin_command

    if not any(cmd.name == "agents" for cmd in COMMAND_REGISTRY):
        register_plugin_command(
            CommandDef(
                "agents",
                "Launch named brain-mcp swarm/workflow presets",
                "Tools & Skills",
                args_hint="[list|show|run|tmux|headless] [preset] [goal]",
                subcommands=("list", "show", "run", "tmux", "headless"),
                cli_only=True,
            )
        )

    if not hasattr(ctx._manager, "_plugin_commands"):
        ctx._manager._plugin_commands = {}
    ctx._manager._plugin_commands["agents"] = {
        "handler": _handle_agents_command,
        "description": "Launch named brain-mcp presets",
        "plugin": ctx.manifest.name,
    }


def _handle_agents_command(raw_args: str) -> str:
    try:
        presets = _load_presets()
    except Exception as exc:
        return f"Failed to load presets from {_PRESETS_FILE}: {exc}"

    try:
        args = shlex.split(raw_args or "")
    except ValueError as exc:
        return f"Invalid /agents arguments: {exc}"

    if not args or args[0] in {"list", "ls"}:
        return _render_preset_list(presets)

    if args[0] == "show":
        if len(args) != 2:
            return _usage("Usage: /agents show <preset>")
        preset = presets.get(args[1])
        if preset is None:
            return _usage(f"Unknown preset: {args[1]}")
        return _render_preset_details(preset)

    action = args[0]
    if action not in {"run", "tmux", "headless"}:
        return _usage(f"Unknown /agents action: {action}")

    if len(args) < 3:
        return _usage(f"Usage: /agents {action} <preset> <goal>")

    preset_name = args[1]
    preset = presets.get(preset_name)
    if preset is None:
        return _usage(f"Unknown preset: {preset_name}")

    goal = " ".join(args[2:]).strip()
    if not goal:
        return _usage("Goal cannot be empty.")

    room = _current_room()

    try:
        invocation = _build_tool_invocation(preset, goal, action, room=room)
        result = _call_brain_tool(invocation, room=room)
    except Exception as exc:
        logger.exception("brain-swarm /agents failed")
        return f"/agents failed for preset '{preset_name}': {exc}"

    auto_monitoring = _maybe_start_workflow_monitor(
        preset,
        invocation,
        result,
        room=room,
    )

    return _render_launch_result(preset, goal, invocation, result, auto_monitoring=auto_monitoring)


def _load_presets() -> dict[str, dict[str, Any]]:
    data = yaml.safe_load(_PRESETS_FILE.read_text()) or {}
    raw_presets = data.get("presets", data)
    if not isinstance(raw_presets, dict):
        raise ValueError("presets.yaml must contain a top-level 'presets' mapping")

    return {
        str(name): _normalize_preset(str(name), raw)
        for name, raw in raw_presets.items()
    }


def _normalize_preset(name: str, raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f"Preset '{name}' must be a mapping")

    kind = str(raw.get("kind") or ("swarm" if raw.get("agents") else "workflow")).strip().lower()
    if kind not in {"swarm", "workflow"}:
        raise ValueError(f"Preset '{name}' has unsupported kind '{kind}'")

    preset: dict[str, Any] = {
        "name": name,
        "kind": kind,
        "description": str(raw.get("description") or "").strip(),
        "default_cli": str(raw.get("default_cli") or "hermes").strip() or "hermes",
        "goal_template": str(raw.get("goal_template") or "{goal}").strip() or "{goal}",
    }

    if kind == "swarm":
        agents_raw = raw.get("agents")
        if not isinstance(agents_raw, list) or not agents_raw:
            raise ValueError(f"Preset '{name}' must define a non-empty agents list")
        preset["default_layout"] = str(raw.get("default_layout") or "headless").strip()
        preset["tmux_layout"] = str(raw.get("tmux_layout") or "tiled").strip()
        preset["agents"] = [_normalize_agent(name, agent_raw) for agent_raw in agents_raw]
        if raw.get("model") is not None:
            preset["model"] = str(raw["model"]).strip()
        if raw.get("isolation") is not None:
            preset["isolation"] = str(raw["isolation"]).strip()
        return preset

    for key in ("max_agents",):
        if raw.get(key) is not None:
            preset[key] = int(raw[key])
    for key in ("mode", "thinking_level", "isolation"):
        if raw.get(key) is not None:
            preset[key] = str(raw[key]).strip()
    for key in ("available_models", "focus_files"):
        if raw.get(key) is not None:
            preset[key] = _normalize_string_list(raw[key], name, key)
    if raw.get("auto_route_models") is not None:
        preset["auto_route_models"] = bool(raw["auto_route_models"])
    return preset


def _normalize_agent(preset_name: str, raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f"Preset '{preset_name}' has a non-mapping agent definition")

    name = str(raw.get("name") or "").strip()
    task = str(raw.get("task") or raw.get("task_template") or "").strip()
    if not name or not task:
        raise ValueError(f"Preset '{preset_name}' requires each agent to define name and task")

    agent: dict[str, Any] = {"name": name, "task": task}

    for key in ("files", "acceptance", "depends_on"):
        if raw.get(key) is not None:
            agent[key] = _normalize_string_list(raw[key], preset_name, f"agent.{key}")

    for key in ("model", "role", "isolation"):
        if raw.get(key) is not None:
            agent[key] = str(raw[key]).strip()

    return agent


def _normalize_string_list(value: Any, preset_name: str, field_name: str) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"Preset '{preset_name}' field '{field_name}' must be a list")
    return [str(item).strip() for item in value if str(item).strip()]


def _build_tool_invocation(
    preset: dict[str, Any],
    goal: str,
    action: str,
    *,
    room: str,
) -> ToolInvocation:
    render_ctx = {
        "goal": goal,
        "preset": preset["name"],
        "cwd": room,
        "room": room,
        "repo_root": str(_REPO_ROOT),
    }

    if preset["kind"] == "swarm":
        layout = preset.get("default_layout", "headless")
        if action == "tmux":
            layout = preset.get("tmux_layout") or "tiled"
        elif action == "headless":
            layout = "headless"

        agents: list[dict[str, Any]] = []
        for agent in preset["agents"]:
            rendered = {
                "name": agent["name"],
                "task": _render_template(agent["task"], render_ctx),
            }
            for key in ("files", "acceptance", "depends_on"):
                if agent.get(key):
                    rendered[key] = [_render_template(item, render_ctx) for item in agent[key]]
            for key in ("model", "role", "isolation"):
                if agent.get(key):
                    rendered[key] = _render_template(str(agent[key]), render_ctx)
            agents.append(rendered)

        arguments: dict[str, Any] = {
            "task": _render_template(preset["goal_template"], render_ctx),
            "agents": agents,
            "layout": layout,
        }
        if preset.get("model"):
            arguments["model"] = _render_template(str(preset["model"]), render_ctx)
        if preset.get("isolation"):
            arguments["isolation"] = preset["isolation"]
        return ToolInvocation("swarm", arguments, default_cli=preset["default_cli"])

    if action == "tmux":
        raise ValueError(f"Preset '{preset['name']}' uses workflow_run and does not support the tmux shortcut")

    arguments = {
        "goal": _render_template(preset["goal_template"], render_ctx),
    }
    for key in ("max_agents", "mode", "thinking_level", "available_models", "focus_files", "auto_route_models", "isolation"):
        if key in preset:
            arguments[key] = preset[key]
    return ToolInvocation("workflow_run", arguments, default_cli=preset["default_cli"])


def _render_template(template: str, context: dict[str, str]) -> str:
    class _SafeDict(dict):
        def __missing__(self, key: str) -> str:
            return "{" + key + "}"

    return template.format_map(_SafeDict(context))


def _current_room() -> str:
    return os.path.realpath(os.path.expanduser(os.getenv("TERMINAL_CWD") or os.getcwd()))


def _current_cli():
    try:
        from hermes_cli.plugins import get_plugin_manager
        return get_plugin_manager()._cli_ref
    except Exception:
        return None


def _current_brain_identity() -> tuple[str, str]:
    cli = _current_cli()
    if cli is not None:
        raw_id = str(getattr(cli, "session_id", "") or "").strip()
        if raw_id:
            session_name = None
            session_db = getattr(cli, "_session_db", None)
            if session_db is not None:
                try:
                    session = session_db.get_session(raw_id)
                    if session:
                        session_name = session.get("title")
                except Exception:
                    session_name = None
            session_name = str(session_name or getattr(cli, "_pending_title", "") or f"hermes-{raw_id[:8]}").strip()
            return (f"hermes:{raw_id}", session_name)

    fallback_id = f"brain-swarm:{uuid.uuid4()}"
    return (fallback_id, "brain-swarm")


class _McpProcessClient:
    def __init__(self, *, room: str, default_cli: str) -> None:
        if not _DIST_SERVER.exists():
            raise FileNotFoundError(f"Missing built brain server at {_DIST_SERVER}. Run 'npm run build' in {_REPO_ROOT}.")

        session_id, session_name = _current_brain_identity()
        env = os.environ.copy()
        env["BRAIN_DEFAULT_CLI"] = default_cli
        env["BRAIN_ROOM"] = room
        env["BRAIN_SESSION_ID"] = session_id
        env["BRAIN_SESSION_NAME"] = session_name

        self._stderr_lines: list[str] = []
        self._queue: queue.Queue[str] = queue.Queue()
        self._next_id = 1
        self._proc = subprocess.Popen(
            ["node", str(_DIST_SERVER)],
            cwd=str(_REPO_ROOT),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

        assert self._proc.stdout is not None
        assert self._proc.stderr is not None
        assert self._proc.stdin is not None

        self._stdout_thread = threading.Thread(
            target=self._read_stdout,
            name="brain-swarm-mcp-stdout",
            daemon=True,
        )
        self._stderr_thread = threading.Thread(
            target=self._read_stderr,
            name="brain-swarm-mcp-stderr",
            daemon=True,
        )
        self._stdout_thread.start()
        self._stderr_thread.start()

        init = self._send(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "brain-swarm-plugin", "version": "0.1.0"},
            },
            timeout=10.0,
        )
        if init.get("error"):
            raise RuntimeError(_format_rpc_error(init["error"]))

    def close(self) -> None:
        if self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=3.0)

    def call_tool(self, tool_name: str, arguments: dict[str, Any], *, timeout: float = 90.0) -> dict[str, Any]:
        response = self._send(
            "tools/call",
            {"name": tool_name, "arguments": arguments},
            timeout=timeout,
        )
        if response.get("error"):
            raise RuntimeError(_format_rpc_error(response["error"]))
        return response

    def _send(self, method: str, params: dict[str, Any], *, timeout: float) -> dict[str, Any]:
        message_id = self._next_id
        self._next_id += 1
        payload = {"jsonrpc": "2.0", "id": message_id, "method": method, "params": params}
        self._proc.stdin.write(json.dumps(payload) + "\n")
        self._proc.stdin.flush()
        return self._await_response(message_id, timeout=timeout)

    def _await_response(self, message_id: int, *, timeout: float) -> dict[str, Any]:
        import time

        stop_at = time.monotonic() + timeout
        while time.monotonic() < stop_at:
            remaining = max(0.1, stop_at - time.monotonic())
            try:
                line = self._queue.get(timeout=remaining)
            except queue.Empty:
                if self._proc.poll() is not None:
                    break
                continue

            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue

            if message.get("id") == message_id:
                return message

        stderr_tail = "\n".join(self._stderr_lines[-12:]).strip()
        exit_note = f" (process exited {self._proc.poll()})" if self._proc.poll() is not None else ""
        if stderr_tail:
            raise TimeoutError(f"MCP call timed out{exit_note}. stderr:\n{stderr_tail}")
        raise TimeoutError(f"MCP call timed out{exit_note}.")

    def _read_stdout(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            text = line.strip()
            if text:
                self._queue.put(text)

    def _read_stderr(self) -> None:
        assert self._proc.stderr is not None
        for line in self._proc.stderr:
            text = line.rstrip()
            if text:
                self._stderr_lines.append(text)


def _call_brain_tool(invocation: ToolInvocation, *, room: str) -> dict[str, Any]:
    client = _McpProcessClient(room=room, default_cli=invocation.default_cli)
    try:
        response = client.call_tool(invocation.tool_name, invocation.arguments)
        return _extract_tool_payload(response)
    finally:
        client.close()


def _extract_tool_payload(response: dict[str, Any]) -> dict[str, Any]:
    result = response.get("result") or {}
    content = result.get("content") or []
    text_parts = [
        item.get("text", "")
        for item in content
        if isinstance(item, dict) and item.get("type") == "text"
    ]
    text = "\n".join(part for part in text_parts if part).strip()
    parsed: Any = None
    if text:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = text
    return {
        "raw": response,
        "result": result,
        "text": text,
        "data": parsed,
        "is_error": bool(result.get("isError")),
    }


def _render_preset_list(presets: dict[str, dict[str, Any]]) -> str:
    lines = ["brain-mcp presets:"]
    for name, preset in sorted(presets.items()):
        if preset["kind"] == "swarm":
            detail = f"swarm | default={preset.get('default_layout', 'headless')} | tmux={preset.get('tmux_layout', 'tiled')}"
        else:
            detail = f"workflow | mode={preset.get('mode', 'pi-core')} | max_agents={preset.get('max_agents', '?')}"
        lines.append(f"  {name:<12} {detail} - {preset.get('description', '').strip()}")
    lines.append("")
    lines.append("Usage:")
    lines.append('  /agents run <preset> "<goal>"')
    lines.append('  /agents tmux <preset> "<goal>"')
    lines.append("  /agents show <preset>")
    lines.append(f"Preset file: {_PRESETS_FILE}")
    return "\n".join(lines)


def _render_preset_details(preset: dict[str, Any]) -> str:
    lines = [
        f"{preset['name']} ({preset['kind']})",
        preset.get("description", "").strip() or "No description.",
        f"default_cli: {preset.get('default_cli', 'hermes')}",
    ]
    if preset["kind"] == "swarm":
        lines.append(f"default_layout: {preset.get('default_layout', 'headless')}")
        lines.append(f"tmux_layout: {preset.get('tmux_layout', 'tiled')}")
        lines.append("agents:")
        for agent in preset["agents"]:
            role = f" [{agent['role']}]" if agent.get("role") else ""
            lines.append(f"  - {agent['name']}{role}")
    else:
        lines.append(f"mode: {preset.get('mode', 'pi-core')}")
        if preset.get("max_agents") is not None:
            lines.append(f"max_agents: {preset['max_agents']}")
        if preset.get("thinking_level") is not None:
            lines.append(f"thinking_level: {preset['thinking_level']}")
    return "\n".join(lines)


def _render_launch_result(
    preset: dict[str, Any],
    goal: str,
    invocation: ToolInvocation,
    result: dict[str, Any],
    *,
    auto_monitoring: bool = False,
) -> str:
    lines = [f"Started preset '{preset['name']}' via {invocation.tool_name}."]
    lines.append(f"Goal: {goal}")

    data = result.get("data")
    if isinstance(data, dict):
        if invocation.tool_name == "swarm":
            lines.append(f"Agents: {data.get('spawned', 0)} spawned, {data.get('failed', 0)} failed")
            if data.get("layout"):
                lines.append(f"Layout: {data['layout']}")
            if data.get("cli"):
                lines.append(f"CLI: {data['cli']}")
            if data.get("attachCommand"):
                lines.append(f"Attach: {data['attachCommand']}")
        else:
            if data.get("plan_id"):
                lines.append(f"Plan: {data['plan_id']}")
            if data.get("pid"):
                lines.append(f"PID: {data['pid']}")
            if data.get("config_path"):
                lines.append(f"Config: {data['config_path']}")
            if data.get("log_path"):
                lines.append(f"Log: {data['log_path']}")
        if data.get("message"):
            lines.append(str(data["message"]))
    elif result.get("text"):
        lines.append(result["text"])

    if result.get("is_error"):
        lines.append("The backend reported an error. Inspect the returned payload before retrying.")
    elif auto_monitoring:
        lines.append("Auto-monitoring started. Progress updates will print here as the workflow advances.")
    else:
        lines.append("Monitor progress with the brain tools: agents, plan_status, and workflow state.")

    return "\n".join(lines)


def _workflow_auto_monitor_enabled() -> bool:
    raw = os.getenv("BRAIN_SWARM_AUTO_MONITOR", "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _maybe_start_workflow_monitor(
    preset: dict[str, Any],
    invocation: ToolInvocation,
    result: dict[str, Any],
    *,
    room: str,
) -> bool:
    if invocation.tool_name != "workflow_run" or result.get("is_error") or not _workflow_auto_monitor_enabled():
        return False

    cli = _current_cli()
    if cli is None:
        return False

    data = result.get("data")
    if not isinstance(data, dict):
        return False

    plan_id = str(data.get("plan_id") or "").strip()
    if not plan_id:
        return False

    if not hasattr(cli, "_brain_workflow_monitors"):
        cli._brain_workflow_monitors = {}

    monitors = getattr(cli, "_brain_workflow_monitors", {})
    if plan_id in monitors:
        return True

    thread = threading.Thread(
        target=_monitor_workflow_progress,
        kwargs={
            "cli": cli,
            "room": room,
            "plan_id": plan_id,
            "preset_name": str(preset.get("name") or "workflow"),
            "default_cli": invocation.default_cli,
        },
        name=f"brain-workflow-monitor-{plan_id[:8]}",
        daemon=True,
    )
    monitors[plan_id] = thread
    cli._brain_workflow_monitors = monitors
    thread.start()
    return True


def _monitor_workflow_progress(
    *,
    cli: Any,
    room: str,
    plan_id: str,
    preset_name: str,
    default_cli: str,
) -> None:
    client = _McpProcessClient(room=room, default_cli=default_cli)
    last_snapshot: tuple[Any, ...] | None = None

    try:
        while not getattr(cli, "_should_exit", False):
            response = client.call_tool("plan_status", {"plan_id": plan_id}, timeout=15.0)
            payload = _extract_tool_payload(response)
            data = payload.get("data")
            if not isinstance(data, dict):
                _emit_cli_notice(
                    cli,
                    f"⚠️  {preset_name} {plan_id[:8]} auto-monitor stopped: invalid plan_status payload.",
                )
                return

            summary = _summarize_plan_status(data)
            snapshot = _plan_snapshot_signature(summary)
            if snapshot != last_snapshot:
                _emit_cli_notice(cli, _render_plan_summary_line(summary, preset_name))
                last_snapshot = snapshot

            if summary["finished"]:
                return

            time.sleep(_AUTO_MONITOR_POLL_SECONDS)
    except Exception as exc:
        _emit_cli_notice(
            cli,
            f"⚠️  {preset_name} {plan_id[:8]} auto-monitor stopped: {exc}",
        )
    finally:
        try:
            client.close()
        except Exception:
            pass
        monitors = getattr(cli, "_brain_workflow_monitors", {})
        monitors.pop(plan_id, None)


def _summarize_plan_status(data: dict[str, Any]) -> dict[str, Any]:
    tasks = data.get("tasks") or []
    total = int(data.get("total") or len(tasks) or 0)
    done = int(data.get("done") or 0)
    running = int(data.get("running") or 0)
    ready = int(data.get("ready") or 0)
    failed = int(data.get("failed") or 0)
    pending = int(data.get("pending") or 0)

    running_tasks = [
        _task_label(task)
        for task in tasks
        if isinstance(task, dict) and str(task.get("status") or "") == "running"
    ]
    ready_tasks = [
        _task_label(task)
        for task in tasks
        if isinstance(task, dict) and str(task.get("status") or "") == "ready"
    ]
    failed_tasks = [
        _task_label(task)
        for task in tasks
        if isinstance(task, dict) and str(task.get("status") or "") == "failed"
    ]
    failure_details = [
        _compact_line(str(task.get("result") or ""))
        for task in tasks
        if isinstance(task, dict) and str(task.get("status") or "") == "failed" and str(task.get("result") or "").strip()
    ]

    finished = total > 0 and (done + failed) >= total and running == 0 and ready == 0 and pending == 0

    return {
        "plan_id": str(data.get("plan_id") or ""),
        "total": total,
        "done": done,
        "running": running,
        "ready": ready,
        "failed": failed,
        "pending": pending,
        "running_tasks": running_tasks,
        "ready_tasks": ready_tasks,
        "failed_tasks": failed_tasks,
        "failure_detail": failure_details[0] if failure_details else "",
        "finished": finished,
    }


def _task_label(task: dict[str, Any]) -> str:
    name = str(task.get("name") or task.get("id") or "?").strip()
    agent_name = str(task.get("agent_name") or "").strip()
    if agent_name and agent_name not in name:
        return f"{name} ({agent_name})"
    return name


def _compact_line(raw: str, limit: int = 96) -> str:
    text = " ".join(raw.strip().split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _plan_snapshot_signature(summary: dict[str, Any]) -> tuple[Any, ...]:
    return (
        summary.get("done"),
        summary.get("running"),
        summary.get("ready"),
        summary.get("failed"),
        tuple(summary.get("running_tasks") or []),
        tuple(summary.get("ready_tasks") or []),
        tuple(summary.get("failed_tasks") or []),
        summary.get("failure_detail"),
        summary.get("finished"),
    )


def _render_plan_summary_line(summary: dict[str, Any], preset_name: str) -> str:
    plan_short = str(summary.get("plan_id") or "")[:8]
    total = int(summary.get("total") or 0)
    done = int(summary.get("done") or 0)
    running = int(summary.get("running") or 0)
    ready = int(summary.get("ready") or 0)
    failed = int(summary.get("failed") or 0)
    running_tasks = summary.get("running_tasks") or []
    ready_tasks = summary.get("ready_tasks") or []
    failed_tasks = summary.get("failed_tasks") or []
    failure_detail = str(summary.get("failure_detail") or "")

    if summary.get("finished"):
        if failed > 0:
            detail = f" · failed: {', '.join(failed_tasks[:2])}" if failed_tasks else ""
            if failure_detail:
                detail += f" · {failure_detail}"
            return f"⚠️  {preset_name} {plan_short} finished with failures ({done}/{total} done, {failed} failed){detail}"
        return f"✅ {preset_name} {plan_short} complete ({done}/{total} done)"

    segments = [f"{done}/{total} done"]
    if running > 0:
        segments.append(f"{running} running")
    if ready > 0:
        segments.append(f"{ready} ready")
    if failed > 0:
        segments.append(f"{failed} failed")

    detail = ""
    if running_tasks:
        detail = f" · running: {', '.join(running_tasks[:2])}"
    elif ready_tasks:
        detail = f" · ready: {', '.join(ready_tasks[:2])}"

    return f"↻ {preset_name} {plan_short} progress · {' · '.join(segments)}{detail}"


def _emit_cli_notice(cli: Any, message: str) -> None:
    try:
        app = getattr(cli, "_app", None)
        if app is not None:
            app.invalidate()
            time.sleep(0.05)

        try:
            from cli import _cprint

            _cprint(f"\n{message}")
        except Exception:
            print(f"\n{message}")
    finally:
        try:
            cli._invalidate(min_interval=0.0)
        except Exception:
            pass


def _format_rpc_error(error: Any) -> str:
    if isinstance(error, dict):
        code = error.get("code")
        message = error.get("message") or "unknown error"
        return f"{message} (code={code})"
    return str(error)


def _usage(message: str) -> str:
    presets = []
    try:
        presets = sorted(_load_presets())
    except Exception:
        pass
    hint = ", ".join(presets) if presets else "no presets loaded"
    return f"{message}\nAvailable presets: {hint}"
