#!/usr/bin/env python3
"""
Cross-compatibility test: Python writes → Node.js reads → both see the same data.
Proves hermes and Claude Code agents can share the same brain.
"""

import json
import os
import subprocess
import sys
import tempfile

# Add parent dir to path so hermes package is importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from hermes.db import BrainDB

DB_PATH = os.path.join(tempfile.gettempdir(), f"brain-cross-test-{os.getpid()}.db")
ROOM = "/tmp/cross-test-room"

passed = 0
failed = 0


def ok(name, condition):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        print(f"  ✗ {name}")


def call_node_tool(tool_name, args):
    """Call a brain-mcp tool via the Node.js server."""
    msg = json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": args},
    })
    init = json.dumps({
        "jsonrpc": "2.0", "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "cross-test", "version": "1.0"},
        },
    })
    notify = json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

    stdin_data = f"{init}\n{notify}\n{msg}\n"
    proc = subprocess.run(
        ["node", "dist/index.js"],
        input=stdin_data, capture_output=True, text=True, timeout=10,
        env={**os.environ, "BRAIN_DB_PATH": DB_PATH, "BRAIN_ROOM": ROOM},
    )
    # Parse responses — find the one with id=1
    for line in proc.stdout.strip().splitlines():
        try:
            resp = json.loads(line)
            if resp.get("id") == 1:
                text = resp.get("result", {}).get("content", [{}])[0].get("text", "{}")
                return json.loads(text)
        except (json.JSONDecodeError, KeyError, IndexError):
            continue
    return None


try:
    print("\nCross-Compatibility Test: Python ↔ Node.js\n")

    # ── Python writes ──
    print("=== Python writes to brain ===")
    db = BrainDB(DB_PATH)

    sid = db.register_session("python-agent", ROOM, '{"lang": "python"}')
    ok("Python registers session", sid is not None)

    db.pulse(sid, "working", "writing test data")

    db.post_message("general", ROOM, sid, "python-agent", "Hello from Python!")
    ok("Python posts message", True)

    db.store_memory(ROOM, "python-discovery", "Python found that the API uses JWT", "architecture", sid, "python-agent")
    ok("Python stores memory", True)

    claim = db.claim("src/shared.ts", sid, "python-agent", ROOM, ttl_seconds=300)
    ok("Python claims file", claim["claimed"])

    db.set_state("build-config", ROOM, '{"target":"es2022"}', sid, "python-agent")
    ok("Python sets state", True)

    plan_id, tasks = db.create_plan(ROOM, [
        {"name": "python-task", "description": "Written by Python"},
        {"name": "node-task", "description": "For Node.js", "depends_on": ["python-task"]},
    ])
    ok("Python creates DAG plan", plan_id is not None and len(tasks) == 2)

    db.close()

    # ── Node.js reads ──
    print("\n=== Node.js reads from brain ===")

    # Register via Node
    reg = call_node_tool("brain_register", {"name": "node-agent"})
    ok("Node registers session", reg and reg.get("sessionId"))

    # Read messages
    msgs = call_node_tool("brain_read", {})
    ok("Node reads Python's message", msgs and any(m["content"] == "Hello from Python!" for m in msgs))

    # Read memory
    recall = call_node_tool("brain_recall", {"query": "JWT"})
    ok("Node recalls Python's memory", recall and recall["count"] >= 1)

    # Read state
    state = call_node_tool("brain_get", {"key": "build-config"})
    ok("Node reads Python's state", state and state.get("found") and '"es2022"' in state.get("value", ""))

    # Check claims
    claims = call_node_tool("brain_claims", {"current_room": True})
    ok("Node sees Python's claim", claims and any(c["resource"] == "src/shared.ts" for c in claims))

    # Check plan
    plan_status = call_node_tool("brain_plan_status", {})
    ok("Node sees Python's plan", plan_status and plan_status.get("plans") and len(plan_status["plans"]) >= 1)

    # ── Node.js writes ──
    print("\n=== Node.js writes to brain ===")

    node_post = call_node_tool("brain_post", {"content": "Hello from Node.js!"})
    ok("Node posts message", node_post and node_post.get("messageId"))

    node_mem = call_node_tool("brain_remember", {
        "key": "node-discovery",
        "content": "Node.js found that the DB uses Prisma",
        "category": "architecture",
    })
    ok("Node stores memory", node_mem and node_mem.get("ok"))

    # ── Python reads Node's data ──
    print("\n=== Python reads Node's data ===")

    db = BrainDB(DB_PATH)

    msgs = db.get_messages("general", ROOM)
    node_msgs = [m for m in msgs if m.content == "Hello from Node.js!"]
    ok("Python reads Node's message", len(node_msgs) >= 1)

    memories = db.recall_memory(ROOM, query="Prisma")
    ok("Python recalls Node's memory", len(memories) >= 1)

    # Both memories visible
    all_memories = db.recall_memory(ROOM)
    ok("Both memories visible", len(all_memories) >= 2)

    sessions = db.get_sessions(ROOM)
    names = [s.name for s in sessions]
    ok("Both sessions visible", "python-agent" in names)

    db.close()

    # ── Summary ──
    print(f"\n{'═' * 50}")
    print(f"  {passed} passed, {failed} failed")
    if failed == 0:
        print(f"  Python ↔ Node.js cross-compatibility: VERIFIED")
    print(f"{'═' * 50}\n")

finally:
    # Cleanup
    for ext in ("", "-wal", "-shm"):
        try:
            os.unlink(DB_PATH + ext)
        except FileNotFoundError:
            pass

sys.exit(1 if failed > 0 else 0)
