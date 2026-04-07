# Brain-MCP Analysis — 2026-04-07

## Critical Findings

### 1. 90% Agent Failure Rate — Root Cause Identified

Swarm-spawned agents silently die. During this analysis, all 3 spawned agents went stale at "spawned by swarm; initializing" — never producing output or logs.

**Root causes:**

1. **Headless spawn with `stdio: 'ignore'`** — detached processes can't be monitored for exit codes. The spawn creates `bash -c "hermes chat -q <prompt> -Q"` with `stdio: 'ignore'`, so if the process exits immediately (bad CLI, missing env vars, prompt too large for shell args), it dies silently.

2. **Ghost sessions from pre-registration** — swarm pre-registers sessions as "working" before confirming the spawned process started. Failed spawns leave permanent ghost agents that pollute metrics and agent listings.

3. **No exit code tracking** — detached processes have their exit codes discarded. Sessions stay "working" forever unless the watchdog catches them 120s later.

**Fix:** Capture stderr/stdout with pipes, check exit code in callback, retry on failure. Register sessions as "queued" not "working" until first confirmed heartbeat.

### 2. Watchdog is Passive — Detection Without Recovery

`src/watchdog.ts` (76 lines) only logs stale agents to an "alerts" channel. It never respawns, kills, or recovers failed agents. Line 63 literally says: `"In a real implementation, you'd check the process table"`.

**Fix:** Add auto-respawn for agents that go stale within 30s (spawn failure) vs 120s (crash). Differentiate detection from recovery.

### 3. No Spawn Retry or Error Feedback

Headless spawn has zero retry logic. If the bash process exits non-zero, it's silently recorded as success. No mechanism to detect immediate failure and retry.

---

## High Priority

### 4. `index.ts` at 2,917 Lines — Needs Decomposition

Contains 40+ tool registrations, session management, spawn logic, cleanup handlers, workflow compilation, and autopilot registration. Single file is unmaintainable.

**Fix:** Split into modules:
- `tools/identity.ts` — register, sessions, status
- `tools/messaging.ts` — post, read, dm, inbox
- `tools/state.ts` — set, get, keys, delete
- `tools/claims.ts` — claim, release, claims
- `tools/contracts.ts` — contract_set, contract_get, contract_check
- `tools/planning.ts` — plan, plan_next, plan_update, plan_status
- `tools/memory.ts` — remember, recall, forget
- `tools/context.ts` — context_push, context_get, context_summary, checkpoint, checkpoint_restore
- `tools/swarm.ts` — swarm, wake, respawn
- `tools/gate.ts` — gate, auto_gate
- `tools/admin.ts` — clear, incr, counter, wait_until, barrier_reset, compact

### 5. No Exit Code Tracking for Spawned Agents

Spawned processes exit with codes but since they're detached with `stdio: 'ignore'`, exit codes are never captured. The session stays "working" forever.

**Fix:** Use `stdio: ['pipe', 'pipe', 'pipe']` and capture in a callback. On non-zero exit, mark session as "failed" with exit code.

### 6. Spawn Health Check Missing

After spawning, no check confirms the process is still alive. The function returns immediately after `watcher.unref()`.

**Fix:** Wait 5s after spawning, check if process is still running. If dead, mark as "failed" with error and optionally retry.

---

## Medium Priority

### 7. Temp File Accumulation

Swarm creates prompt files (`/tmp/brain-prompt-*.txt`) and watcher scripts (`/tmp/brain-swarm-*.sh`). The watcher self-deletes on success, but on crash/kill these accumulate.

**Fix:** Add a cleanup sweep in watchdog or index.ts startup that removes stale temp files.

### 8. Gate Only Validates TypeScript — Not Behavior

`src/gate.ts` runs `tsc --noEmit` + contract validation but doesn't run tests. Behavioral failures (agent spawn failures, deadlocks, incorrect logic) go undetected by the gate.

**Fix:** Add test execution to gate, or document this as a known gap and rely on integration tests.

### 9. Synchronous SQLite (better-sqlite3) Blocks Event Loop

All DB operations use synchronous better-sqlite3 calls. During heavy multi-agent scenarios with concurrent tool calls, these block the Node.js event loop.

**Fix:** Move DB operations to a worker thread or use `db.pragma('wal'))` and async wrapper. For most workloads this is fine, but burst scenarios will have latency spikes.

---

## Recommendations (Priority Order)

1. **Fix headless spawn** — capture stderr/stdout, check exit code in callback, retry on non-zero with exponential backoff. Register as "queued" before spawn, "working" only after first heartbeat.
2. **Make watchdog active** — add auto-respawn for agents that die within 30s. Differentiate spawn failure (immediate) from crash (after running).
3. **Clean up ghost sessions** — periodic sweep that removes sessions in "working" state with no heartbeat for >5 minutes.
4. **Split index.ts** — extract tool groups into separate modules.
5. **Add spawn health check** — wait 5s post-spawn, verify process alive, mark failed if not.
6. **Add spawn exit code tracking** — pipe stderr/stdout, capture exit code, mark session accordingly.

---

## Metrics Snapshot (from brain)

- Total recent tasks: 10
- Failures: 9
- Successes: 1
- Failure rate: 90%

All failures are ghost sessions from failed spawns, not genuine task failures.
