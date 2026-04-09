from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


PLUGIN_PATH = Path(__file__).resolve().parent / ".hermes" / "plugins" / "brain_swarm" / "__init__.py"


def _load_plugin():
    spec = importlib.util.spec_from_file_location("brain_swarm_plugin", PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_load_presets():
    plugin = _load_plugin()
    presets = plugin._load_presets()

    assert {"fullstack-4", "bugfix-3", "workflow-4"} <= set(presets)
    assert presets["fullstack-4"]["kind"] == "swarm"
    assert presets["workflow-4"]["kind"] == "workflow"


def test_build_swarm_invocation_uses_headless_default():
    plugin = _load_plugin()
    preset = plugin._load_presets()["fullstack-4"]

    invocation = plugin._build_tool_invocation(
        preset,
        "refactor auth flow",
        "run",
        room="/repo/brain-mcp",
    )

    assert invocation.tool_name == "swarm"
    assert invocation.default_cli == "hermes"
    assert invocation.arguments["layout"] == "headless"
    assert invocation.arguments["task"] == "Full-stack objective: refactor auth flow"
    assert len(invocation.arguments["agents"]) == 4
    assert "refactor auth flow" in invocation.arguments["agents"][0]["task"]


def test_build_swarm_invocation_overrides_tmux_layout():
    plugin = _load_plugin()
    preset = plugin._load_presets()["bugfix-3"]

    invocation = plugin._build_tool_invocation(
        preset,
        "fix renderer transport issue",
        "tmux",
        room="/repo/brain-mcp",
    )

    assert invocation.tool_name == "swarm"
    assert invocation.arguments["layout"] == "tiled"
    assert invocation.arguments["task"] == "Bugfix objective: fix renderer transport issue"


def test_build_workflow_invocation():
    plugin = _load_plugin()
    preset = plugin._load_presets()["workflow-4"]

    invocation = plugin._build_tool_invocation(
        preset,
        "ship the auth refactor",
        "run",
        room="/repo/brain-mcp",
    )

    assert invocation.tool_name == "workflow_run"
    assert invocation.arguments["goal"] == "ship the auth refactor"
    assert invocation.arguments["max_agents"] == 4
    assert invocation.arguments["mode"] == "pi-core"


def test_render_launch_result_mentions_auto_monitoring():
    plugin = _load_plugin()
    preset = plugin._load_presets()["workflow-4"]
    invocation = plugin.ToolInvocation("workflow_run", {"goal": "ship it"})

    rendered = plugin._render_launch_result(
        preset,
        "ship it",
        invocation,
        {
            "data": {
                "plan_id": "21720261-da96-4e1d-b0ba-141149b079e0",
                "pid": 15755,
                "config_path": "/tmp/workflow.json",
                "log_path": "/tmp/workflow.log",
            },
            "is_error": False,
        },
        auto_monitoring=True,
    )

    assert "Plan: 21720261-da96-4e1d-b0ba-141149b079e0" in rendered
    assert "Auto-monitoring started." in rendered


def test_plan_status_summary_renders_progress_and_failures():
    plugin = _load_plugin()

    progress = plugin._summarize_plan_status({
        "plan_id": "21720261-da96-4e1d-b0ba-141149b079e0",
        "total": 4,
        "done": 1,
        "running": 1,
        "ready": 1,
        "failed": 0,
        "pending": 1,
        "tasks": [
            {"name": "design:planner", "status": "running", "agent_name": "planner"},
            {"name": "impl:builder", "status": "ready", "agent_name": "builder"},
        ],
    })
    progress_line = plugin._render_plan_summary_line(progress, "workflow-4")

    assert "1/4 done" in progress_line
    assert "1 running" in progress_line
    assert "design:planner" in progress_line

    failed = plugin._summarize_plan_status({
        "plan_id": "21720261-da96-4e1d-b0ba-141149b079e0",
        "total": 2,
        "done": 1,
        "running": 0,
        "ready": 0,
        "failed": 1,
        "pending": 0,
        "tasks": [
            {"name": "design:planner", "status": "failed", "agent_name": "planner", "result": "planner Model not found"},
            {"name": "impl:builder", "status": "done", "agent_name": "builder"},
        ],
    })
    failed_line = plugin._render_plan_summary_line(failed, "workflow-4")

    assert "finished with failures" in failed_line
    assert "design:planner" in failed_line
    assert "Model not found" in failed_line


if __name__ == "__main__":
    test_load_presets()
    test_build_swarm_invocation_uses_headless_default()
    test_build_swarm_invocation_overrides_tmux_layout()
    test_build_workflow_invocation()
    test_render_launch_result_mentions_auto_monitoring()
    test_plan_status_summary_renders_progress_and_failures()
    print("brain-swarm plugin tests passed")
