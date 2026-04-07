#!/bin/bash
# brain-memory.sh — GSD-inspired memory bank for brain-mcp
# Usage: source this in your orchestrator workflow

set -euo pipefail

BRAIN_STATE="${BRAIN_STATE:-$HOME/.hermes/.brain/STATE.md}"
BRAIN_DIR="$(dirname "$BRAIN_STATE")"

# ─── Init ────────────────────────────────────────────────────────────────────

brain-init() {
  local project="${1:-untitled}"
  local session_id="${2:-$(date +%s)}"

  mkdir -p "$BRAIN_DIR"

  cat > "$BRAIN_STATE" <<STATEEOF
# Brain MCP — Session State

## Session

Project: $project
Session ID: $session_id
Started: $(date '+%Y-%m-%d %H:%M')
Status: active

## Current Phase

Phase: init
Updated: $(date '+%Y-%m-%d %H:%M')

## Orchestrator Memory

### What Was Done
- (empty)

### Active Decisions
- (none)

### Blockers
- (none)

### Pending Results
- (none)

## Agent Context

## Files Under Work

## Session Log
STATEEOF

  echo "Initialized brain session: $project ($session_id)"
  echo "State: $BRAIN_STATE"
}

# ─── Read ────────────────────────────────────────────────────────────────────

brain-get-phase() {
  grep "^Phase:" "$BRAIN_STATE" | sed 's/Phase: //'
}

brain-get-memory() {
  grep -A 20 "## Orchestrator Memory" "$BRAIN_STATE"
}

brain-get-agent-status() {
  local agent="$1"
  grep -A 8 "### $agent" "$BRAIN_STATE" 2>/dev/null || echo "(unknown agent)"
}

brain-get-files-under-work() {
  grep -A 10 "## Files Under Work" "$BRAIN_STATE" 2>/dev/null || echo "(none)"
}

# ─── Context Slices ──────────────────────────────────────────────────────────

# Get relevant context slice for a task/phase
# Usage: brain-get-context-slice "auth" "fix login bug"
brain-get-context-slice() {
  local phase="${1:-general}"
  local task="${2:-no-task}"
  local output=""

  output+="## Brain Memory Bank Context\n"
  output+="**Project:** $(grep '^Project:' "$BRAIN_STATE" | sed 's/Project: //')\n"
  output+="**Phase:** $(grep '^Phase:' "$BRAIN_STATE" | sed 's/Phase: //')\n"
  output+="**Session:** $(grep '^Session ID:' "$BRAIN_STATE" | sed 's/Session ID: //')\n"
  output+="**This task:** $task\n\n"

  output+="## Orchestrator Memory (accumulated)\n"
  output+="$(grep -A 20 "## Orchestrator Memory" "$BRAIN_STATE" 2>/dev/null || echo '(none yet)')\n"

  output+="\n## Files Under Work (grepped: $phase)\n"
  local fuw
  fuw=$(grep -A 10 "## Files Under Work" "$BRAIN_STATE" 2>/dev/null || echo "(none)")
  if echo "$fuw" | grep -qi "^|"; then
    output+="$(echo "$fuw" | head -20)\n"
  else
    output+="(none)\n"
  fi

  output+="\n## Recent Session Log (last 2 waves)\n"
  output+="$(grep -A 30 "## Session Log" "$BRAIN_STATE" 2>/dev/null | tail -15)\n"

  echo -e "$output"
}

# ─── Update ─────────────────────────────────────────────────────────────────

brain-update-phase() {
  local phase="$1"
  local timestamp
  timestamp=$(date '+%Y-%m-%d %H:%M')

  # Update phase
  sed -i '' "s/^Phase:.\*/Phase: $phase/" "$BRAIN_STATE"
  # Update timestamp
  sed -i '' "/^Updated:.\*/s/Updated:.\*/Updated: $timestamp/" "$BRAIN_STATE"
}

brain-record-done() {
  local wave="$1"
  local agent="$2"
  local summary="$3"

  # Append to "What Was Done"
  sed -i '' "/### What Was Done/a\\
- Wave $wave [$agent]: $summary" "$BRAIN_STATE"
}

brain-record-decision() {
  local decision="$1"
  sed -i '' "/### Active Decisions/a\\
- $(date '+%Y-%m-%d %H:%M'): $decision" "$BRAIN_STATE"
}

brain-add-blocker() {
  local blocker="$1"
  sed -i '' "/### Blockers/a\\
- $(date '+%Y-%m-%d %H:%M'): $blocker" "$BRAIN_STATE"
}

brain-clear-blocker() {
  local pattern="$1"
  sed -i '' "/### Blockers/,\/---/s/-.\{$pattern\}.*/(cleared)/" "$BRAIN_STATE"
}

brain-set-agent() {
  local name="$1"
  local role="$2"
  local task="$3"

  # Check if agent exists
  if grep -q "### $name" "$BRAIN_STATE" 2>/dev/null; then
    sed -i '' "/### $name/,/### /c\\
### $name\\
Role: $role\\
Status: working\\
Last seen: $(date '+%Y-%m-%d %H:%M')\\
Work: $task\\
Result: (pending)
\\
### END" "$BRAIN_STATE"
  else
    # Append new agent
    sed -i '' "/## Agent Context/a\\
\\
### $name\\
Role: $role\\
Status: working\\
Last seen: $(date '+%Y-%m-%d %H:%M')\\
Work: $task\\
Result: (pending)
" "$BRAIN_STATE"
  fi
}

brain-complete-agent() {
  local name="$1"
  local result="${2:-completed}"

  sed -i '' "/### $name/,/Result:/s/Result:.\*/Result: $result/" "$BRAIN_STATE"
  sed -i '' "/### $name/,/Status:.\*/s/Status:.\*/Status: complete/" "$BRAIN_STATE"
}

brain-claim-file() {
  local file="$1"
  local agent="$2"

  # Remove existing entry for this file if any
  sed -i '' "\|$file|d" "$BRAIN_STATE"

  # Add new entry
  sed -i '' "/## Files Under Work/a\\
| $file | $agent | in-progress |" "$BRAIN_STATE"
}

brain-release-file() {
  local file="$1"

  sed -i '' "s/| $file |.\+| in-progress |/| $file | (released) | complete |/" "$BRAIN_STATE"
}

brain-log-wave() {
  local wave="$1"
  local agents="$2"
  local topic="$3"

  sed -i '' "/## Session Log/a\\
\\
### Wave $wave — $(date '+%Y-%m-%d %H:%M')\\
- Dispatched: $agents\\
- Topic: $topic" "$BRAIN_STATE"
}

brain-set-status() {
  local status="$1"
  sed -i '' "s/^Status:.\*/Status: $status/" "$BRAIN_STATE"
}

# ─── Dump ───────────────────────────────────────────────────────────────────

brain-dump() {
  cat "$BRAIN_STATE"
}

# ─── Export for brain_set ───────────────────────────────────────────────────

brain-export-context() {
  local phase="${1:-general}"
  local task="${2:-no-task}"
  brain-get-context-slice "$phase" "$task"
}
