# Brain Memory Bank

GSD-inspired persistent context pattern for brain-mcp multi-agent workflows.

**Use when:** Using brain-mcp to coordinate multiple subagents that need shared context across tasks.

**What it solves:** Subagents have no memory between tasks. This makes the orchestrator the memory bank using a single STATE.md file.

---

## Pattern

```
Orchestrator
│
│  MAINTAINS: ~/.hermes/.brain/STATE.md
│
│  PER TASK:
│    1. brain_set("task_context", $SLICE_OF_STATE)
│    2. brain_wake(agent, goal + context)
│
│  AFTER RESULTS:
│    1. brain_read() — collect agent posts
│    2. Update STATE.md — "What Was Done", "Agent Context"
│    3. brain_set next wave or end
│
└── Subagents: read brain_get("task_context"), do work, brain_post() results
```

---

## Orchestrator Workflow

### 1. Initialize Session

```bash
BRAIN_STATE="$HOME/.hermes/.brain/STATE.md"
mkdir -p "$(dirname "$BRAIN_STATE")"

cat > "$BRAIN_STATE" <<'EOF'
# Brain MCP — Session State

## Session

Project: [project-name]
Session ID: [session-id]
Started: [YYYY-MM-DD HH:MM]
Status: active

## Current Phase

Phase: init
Updated: [YYYY-MM-DD HH:MM]

## Orchestrator Memory

### What Was Done
- (empty — fill after first wave)

### Active Decisions
- (empty)

### Blockers
- (none)

### Pending Results
- (none)

## Agent Context

## Files Under Work

## Session Log
EOF
```

### 2. Per-Wave: Inject Context Slices

Before `brain_wake`, extract relevant slice from STATE.md:

```bash
# Extract context relevant to this task
get_context_slice() {
  local phase="$1"  # e.g., "auth", "api", "frontend"
  local state="$HOME/.hermes/.brain/STATE.md"

  # Get orchestrator memory (always relevant)
  echo "## Orchestrator Memory"
  grep -A 20 "## Orchestrator Memory" "$state" 2>/dev/null || echo "(no memory yet)"

  # Get relevant files under work
  echo ""
  echo "## Files Under Work (relevant to: $phase)"
  grep -A 10 "## Files Under Work" "$state" 2>/dev/null | grep -i "$phase" || echo "(none)"

  # Get agent context for relevant agents
  echo ""
  echo "## Agent Context"
  grep -A 8 "### agent-" "$state" 2>/dev/null | grep -A 8 "$phase" || echo "(none)"
}
```

### 3. After Results: Update State

```bash
# Called after brain_read() — updates STATE.md with results
update_session_state() {
  local wave="$1"
  local agent="$2"
  local result="$3"
  local state="$HOME/.hermes/.brain/STATE.md"

  # Update "What Was Done"
  sed -i '' "/### What Was Done/a\\
- Wave $wave ($agent): $result" "$state"

  # Update agent status
  sed -i '' "/### agent-/,\/### agent-/s/Status:.\*/Status: complete/" "$state"

  # Update "Pending Results" — clear if incorporated
  sed -i '' "/### Pending Results/,/---/c\\### Pending Results\\
(none)" "$state"
}
```

---

## State File Structure

```
## Session             → Project, session ID, status
## Current Phase       → init | planning | executing | reviewing | complete
## Orchestrator Memory → Accumulated context (the "memory bank")
## Agent Context       → Per-agent status and work tracking
## Files Under Work    → Who is editing what (claim/release tracking)
## Session Log         → Wave-by-wave history for resume
```

---

## Key Principles

1. **One file, not KV** — STATE.md is the source of truth. brain KV is just transport.
2. **Orchestrator writes** — Subagents read context and post results. Orchestrator updates state.
3. **Slices, not dumps** — Each agent gets only what it needs. Keep it lean.
4. **Git-diffable** — STATE.md is human-readable, git-tracked, resumable.
5. **Persistent** — Survives agent restarts. Brain KV doesn't.

---

## Example Prompt to Subagent

```
<task>
Fix the authentication bug in src/auth/login.ts
</task>

<context_from_orchestrator>
## Orchestrator Memory
### What Was Done
- (none yet)

### Blockers
- (none)

## Files Under Work
| File | Agent | Status |
| src/auth/login.ts | agent-1 | in-progress |

## Agent Context
### agent-1
Role: auth specialist
Status: working
</context_from_orchestrator>

<instructions>
1. brain_register("agent-1")
2. brain_get("task_context") — already provided above
3. brain_claim("src/auth/login.ts") if available
4. Fix the bug
5. brain_post() your result
6. /exit
</instructions>
```

---

## Files

- State: `~/.hermes/.brain/STATE.md`
- Optional log: `~/.hermes/.brain/SESSION.md` (full transcript)
