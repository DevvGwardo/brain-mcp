#!/usr/bin/env python3
"""
hermes-brain — Multi-agent orchestration CLI for Hermes Agent.

Usage:
  hermes-brain "Build a REST API" --agents api-worker db-worker test-worker
  hermes-brain "Refactor auth" --agents backend frontend --model claude-haiku-4-5
  hermes-brain --config pipeline.json

Examples:
  # Simple: 2 agents, auto-named
  hermes-brain "Add error handling to the codebase"

  # Named agents with model routing
  hermes-brain "Build a game" --agents engine ui store --model claude-sonnet-4-5

  # Cheap model for boilerplate
  hermes-brain "Generate test files" --agents test-1 test-2 test-3 --model claude-haiku-4-5

  # Config file for complex pipelines
  hermes-brain --config pipeline.json
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys

from hermes.orchestrator import Orchestrator, PhaseConfig, AgentConfig


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="hermes-brain",
        description="Multi-agent orchestration for Hermes Agent",
    )
    p.add_argument("task", nargs="?", help="Task description for the agents")
    p.add_argument("--agents", nargs="+", help="Agent names to spawn (default: agent-1 agent-2)")
    p.add_argument("--model", default="claude-sonnet-4-5", help="Model for agents (default: claude-sonnet-4-5)")
    p.add_argument("--no-gate", action="store_true", help="Skip integration gate")
    p.add_argument("--timeout", type=int, default=600, help="Per-agent timeout in seconds (default: 600)")
    p.add_argument("--retries", type=int, default=3, help="Max gate retry attempts (default: 3)")
    p.add_argument("--config", help="Load pipeline from JSON config file")
    p.add_argument("--db-path", help="Custom brain database path")
    return p.parse_args()


def load_config(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def main() -> None:
    args = parse_args()

    # Load from config file
    if args.config:
        config = load_config(args.config)
        task = config.get("task", args.task or "")
        phases = []
        for phase_cfg in config.get("phases", []):
            agents = [
                AgentConfig(
                    name=a["name"],
                    task=a.get("task", task),
                    files=a.get("files"),
                    model=a.get("model"),
                )
                for a in phase_cfg.get("agents", [])
            ]
            phases.append(PhaseConfig(
                name=phase_cfg.get("name", "main"),
                parallel=phase_cfg.get("parallel", True),
                agents=agents,
            ))
        model = config.get("model", args.model)
        gate = config.get("gate", not args.no_gate)
        timeout = config.get("timeout", args.timeout)
        retries = config.get("max_gate_retries", args.retries)
    else:
        # Build from CLI args
        if not args.task:
            print("Error: task is required (or use --config)")
            print("Usage: hermes-brain \"task description\" --agents name1 name2")
            sys.exit(1)

        task = args.task
        agent_names = args.agents or ["agent-1", "agent-2"]
        model = args.model
        gate = not args.no_gate
        timeout = args.timeout
        retries = args.retries

        agents = [
            AgentConfig(name=name, task=task)
            for name in agent_names
        ]
        phases = [PhaseConfig(name="main", parallel=True, agents=agents)]

    # Create orchestrator
    orch = Orchestrator(
        task=task,
        model=model,
        gate=gate,
        max_gate_retries=retries,
        timeout=timeout,
        db_path=args.db_path,
    )

    # Handle Ctrl+C gracefully
    def cleanup(sig, frame):
        print("\n\nShutting down...")
        orch.close()
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    try:
        success = orch.run_pipeline(phases)
        orch.close()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"\nError: {e}")
        orch.close()
        sys.exit(1)


if __name__ == "__main__":
    main()
