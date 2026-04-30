# brain-mcp — Improvements Plan

Author: Claude (analysis pass against current main, 2026-04-29)
Approach: **depth-first on the highest-leverage item, learn, then expand.**

## Status (updated 2026-04-29)

- ✅ **Phase 1 complete and shippable behind feature flag.** Daemon code lands on `main` with `BRAIN_WATCHER_MODE` defaulting to `bash` — production behavior unchanged until the flag is flipped.
- ⏭ **Next:** burn-in `BRAIN_WATCHER_MODE=daemon` against real Hermes workflows for ~2 weeks, then flip the default and remove bash code in a follow-up.
- ⏸ **Phase 2–5:** scoped with sub-task checklists (this doc). Recommended landing order: **2.4 → 2.1 → 5.1 → 2.2 → 3.1** (cheap correctness fixes + test coverage before refactors).
- 🔍 **Investigation surprise:** the codebase has **7** watcher generators in two contract families, not 4 as estimated. The two older sites in `src/tools/router-tools.ts` and `src/tools/swarm.ts` skip `STATE_FILE`/finalizer entirely — closing that correctness gap is a free win when `BRAIN_WATCHER_MODE=daemon` is on.

### Phase tracker

| Phase | Item | Status | Notes |
|-------|------|--------|-------|
| 1.1 | Investigation | ✅ | `docs/watcher-contract.md` |
| 1.2 | Daemon design | ✅ | inline in `src/agent-watcher.ts` |
| 1.3 | Implementation | ✅ | daemon + DB schema + 7 callsites wired |
| 1.4 | Verification | ✅ | unit + smoke; live-env smoke deferred |
| 1.5 | Migration safety | ✅ | flag default `bash`; flip after burn-in |
| 2.1 | Persist failureTracker | ⏸ | unblocked by Phase 1 |
| 2.2 | `process.kill(pid, 0)` standardization | ⏸ | mechanical |
| 2.3 | tmux `pane-died` hook | ⏸ | wait until daemon is default |
| 2.4 | Watchdog SIGTERM handler | ✅ | graceful SIGINT/SIGTERM shutdown |
| 3.1 | `src/constants.ts` | ⏸ | needs 2.1 done first (constants will move) |
| 3.2 | `execFile` migration | ⏸ | parallelizable |
| 3.3 | Env allowlist | ⏸ | parallelizable |
| 3.4 | `mkdtemp` 0o700 | ⏸ | parallelizable |
| 3.5 | Per-runtime `STARTUP_GRACE_MS` | ⏸ | quick |
| 4.1 | `AgentRuntime` interface | ⏸ | wait until Phase 1 burned in + bash deleted |
| 4.2 | `index.ts` decomposition | ⏸ | mechanical, churn-heavy |
| 4.3 | Tmux runtime abstraction | ⏸ | depends on 4.1 |
| 5.1 | `spawn-recovery.ts` tests | ⏸ | **prereq for 4.1** |
| 5.2 | wake+daemon integration test | ⏸ | parallelizable |
| 5.3 | Spawn metrics | ⏸ | hook into existing `spawn_metrics` table |
| 5.4 | Structured logging | ⏸ | **skip until earned** |

A breadth-first parallel swarm against this codebase is the wrong move because (a) the bash watcher pattern likely encodes load-bearing reliability behavior I haven't grokked yet, (b) brain-mcp is the runtime your hermes integration depends on so a bad PR breaks live workflow, and (c) the architecture-level items conflict with each other and can't be parallelized safely.

## Current state (observed)

- `src/index.ts` is **3,380 lines** with 45+ tool registrations (ARCHITECTURE.md from earlier listed 2,917 — has grown). Decomposition is half-finished and trending backwards.
- Test surface: `model-resolution.test.ts`, `renderer.test.ts`, `tmux-runtime.test.ts`, `workflow.test.ts`. **No tests for `spawn-recovery.ts`, `conductor.ts`, or `watchdog.ts`** — the critical-path agent lifecycle code is untested.
- Recent commits show momentum in the right direction:
  - `b8da305 feat: harden Hermes workflows and tmux agent lifecycle` — actively improving the same surface
  - `254d9dc fix: brain-statusbar queries SQLite directly instead of shelling out` — already moving away from shell-outs
- Untracked `bench-agent-spawn.mjs`, `bench-agent.mjs`, `benchmark-agent.mjs` suggest spawn perf is being measured.
- Tiny WIP on main: `--yolo` flag added to hermes invocations in 4 files. Unrelated to this work.

## Phase 1 — Node watcher daemon ✅ DONE (behind `BRAIN_WATCHER_MODE=daemon` flag)

**Why this first:** the bash watcher pattern was assumed to be 4 callsites; investigation found **7** in two contract families. One Node daemon replaces all of them. The replacement enumerates every state and edge case the bash version handled, which served as the cheapest possible audit of agent-lifecycle correctness.

### 1.1 Investigation ✅
- [x] Read every `tmux send-keys`, `tmux capture-pane`, `tmux display-message` in `src/` — see `docs/watcher-contract.md` §1 (catalogue) and §2 (anatomy).
- [x] Read `bench-agent-spawn.mjs`, `bench-agent.mjs`, `benchmark-agent.mjs` — all benchmark end-to-end via real `hermes` CLI; not runnable without API keys.
- [x] Established green baseline: `npx tsc --noEmit` exit 0; all 4 existing test files pass (`tmux-runtime`, `workflow`, `model-resolution`, `renderer`).
- [x] Documented the watcher contract in `docs/watcher-contract.md` (~250 lines). Surfaced 6 edge cases including the `src/tools/*` reconciliation gap and pi mode's asymmetric `systemFile` cleanup.

### 1.2 Daemon design ✅
- [x] Long-lived child process, spawned lazily on first `enqueueDaemonWatch` call (not from `BrainDB` constructor — only the spawn path needs it, so wiring at MCP-server init would be wasted overhead).
- [x] SQLite-only IPC: `pane_watches` table read every 2s; no pipes/sockets.
- [x] Single `tmux list-panes -aF '#{pane_id}|#{pane_dead}'` per tick covers all watched panes; `capture-pane` only fires for `ready_wait` rows.
- [x] State machine: `ready_wait` → `running` → `terminal` (where `terminal_state ∈ {pane_closed, timeout, watcher_error}`). Three states instead of the proposed five — simpler and matches bash's behavior 1:1.
- [x] On terminal: runs `cleanup_paths`, calls `reconcileSessionExit` (or `markDone` for `finalizer_kind='mark_failed'`), updates the row.
- [x] Recovery on daemon restart: `pane_watches` rows survive; next daemon boot reads `paneWatch_active()` and resumes. Stale-tolerant `daemon_locks` row prevents duplicate daemons (uses `process.kill(pid, 0)` to detect dead lock holders).

### 1.3 Implementation ✅
- [x] `src/agent-watcher.ts` (~340 lines) — pure `decide()` state-machine + thin runner; lazy-spawn helper `ensureAgentWatcherDaemon`; wrapper `enqueueDaemonWatch`.
- [x] `src/agent-watcher.test.ts` (30 PASS) — state transitions including fallback markers, max-attempts exhaustion, kill-grace ordering, cleanup-paths flow, `mark_failed` pass-through.
- [x] DB migration in `src/db.ts`: `pane_watches` table + `daemon_locks` table; APIs `paneWatch_insert/active/update/get`, `daemonLock_acquire/release/holder`. Uses existing `CREATE TABLE IF NOT EXISTS` pattern.
- [x] All 7 callsites wrapped with `if (watcherModeFromEnv() === 'daemon') enqueueDaemonWatch(...) else { ...existing bash... }`:
  - `src/conductor.ts` ×3 (pi, py, claude)
  - `src/index.ts` ×2 (swarm v2 ~1492, single-spawn `wake` ~2531)
  - `src/tools/router-tools.ts` ×1 (older family — daemon path uses `reconcile` finalizer, closing the correctness gap)
  - `src/tools/swarm.ts` ×1 (older family — same)
- [x] Bash watcher generation **kept** behind the flag. Per-callsite deletion is a follow-up PR after burn-in (Phase 1.5).
- [x] Daemon lazy-spawned by `enqueueDaemonWatch` rather than `BrainDB` constructor — fewer surprises during MCP boot.

### 1.4 Verification ✅
- [x] `npx tsc --noEmit` clean.
- [x] All 5 unit test files pass: 171 PASS, 0 FAIL (`tmux-runtime` 4, `workflow` 12, `model-resolution` 11, `renderer` 114, `agent-watcher` 30).
- [x] End-to-end smoke (in-repo, no live CLI): daemon claims lock → drives a synthetic dead-pane watch to `terminal/pane_closed` → calls `reconcileSessionExit` → exits cleanly on SIGTERM → releases lock.
- [ ] **Deferred (need live env):** `bench-agent-spawn.mjs` daemon-vs-bash latency comparison. Requires real `hermes` + API keys.
- [ ] **Deferred:** spawn pi/py/claude agent each via `wake` with `BRAIN_WATCHER_MODE=daemon`, exercise normal exit + timeout + crash paths.
- [ ] **Deferred:** kill daemon mid-flight, restart MCP server, verify recovery via the existing `pane_watches` rows.
- [ ] **Deferred:** Hermes integration smoke — `hermes chat` workflow that spawns sub-agents, verify end-to-end with the flag on.

### 1.5 Migration safety ✅
- [x] `BRAIN_WATCHER_MODE=daemon|bash`, default `bash` — production behavior unchanged until you flip it.
- [ ] **Pending:** after ~2 weeks of `daemon` running cleanly in your real workflow, flip the default and delete bash watcher code in a follow-up PR. Roughly ~250 lines to remove across 4 files.

### 1.6 Bonus / surprises observed during the work
- 🐛 **Fixed**: `setTimeout(...).unref()` in the daemon's sleep was suppressing SIGTERM handler delivery on macOS. Removed unref. Daemon governs its own lifecycle via explicit 5-minute idle exit.
- 🐛 **Fixed (in daemon mode)**: pi mode's asymmetric `systemFile` cleanup (leaked on timeout, deleted on pane_closed) — daemon path runs `cleanup_paths` on both terminal kinds.
- 🐛 **Fixed (in daemon mode)**: `src/tools/router-tools.ts` and `src/tools/swarm.ts` previously left DB rows stale on normal pane closure — daemon path reconciles via `reconcileSessionExit`. Bash mode at those callsites still has the gap (out of scope).
- 📝 `src/index.ts:1496` hardcoded `ABSOLUTE_TIMEOUT=3600` for swarm v2 ignores user-supplied `agentTimeout`. Daemon path preserves parity (still passes 3600). Consider fixing in a follow-up.
- 📝 `attachTmuxWatcherFinalizer` is defined identically twice (`src/index.ts:183` and `src/conductor.ts:247`). Cleanup candidate for the post-burn-in PR.

**Actuals vs estimate:** estimate was ~400 new / ~250 deleted, single PR. Actuals: ~520 new (`src/agent-watcher.ts` ~340, `src/agent-watcher.test.ts` ~150, db schema/API ~167), ~0 deleted (bash code retained behind flag — deletion is the follow-up). One PR.

## Phase 2 — Items unlocked by the daemon (after Phase 1 lands)

These get easier or become trivial once the daemon owns lifecycle. Recommended order: **2.4 → 2.1 → 2.2 → 2.3** (cheapest correctness fix first; defer the hook until after persistent state).

### 2.1 Persist `failureTracker` to SQLite ⏸
Two parallel in-memory `Map`s — `watchdog.ts:62` and `spawn-recovery.ts:51` — both wipe on process restart, so repeat-failing agents get re-spawned forever after a crash.

- [ ] Schema: `agent_failures (agent_id PK, agent_name, failure_count, last_failure_at, last_spawned_at, backoff_until, escalation_level, death_type)`. Add to migrate() in `db.ts`.
- [ ] DB API on `BrainDB`: `failure_get(agent_id)`, `failure_record(agent_id, fields)`, `failure_clear(agent_id)`.
- [ ] Replace `failureTracker = new Map<string, AgentFailureRecord>()` in `watchdog.ts:62` with DB-backed accessors.
- [ ] Replace `failureRecords = new Map<string, SpawnFailureRecord>()` in `spawn-recovery.ts:51` with same.
- [ ] Verify: kill watchdog mid-flight while a failure record exists; restart; confirm record survives and backoff still applies.
- **Estimate:** ~150 lines, half-day. **Risk:** low — the in-memory Map API is small.

### 2.2 Standardize liveness on `process.kill(pid, 0)` ⏸
`watchdog.ts:103` shells out to `ps -o state= -p $pid` (~30ms each call, OS-specific). `spawn-recovery.ts:383` already uses the fast `process.kill(pid, 0)` form. With the daemon centralizing pane liveness, this becomes one helper.

- [ ] Decide: do we still need zombie (`Z` state) detection? `process.kill(pid, 0)` returns true for zombies, `ps` filters them out. Document the choice in code comment.
- [ ] If keeping zombie detection: shared helper `isProcessAlive(pid)` in `tmux-runtime.ts` that does `kill(pid, 0)` then a single `ps` check. Otherwise: `kill(pid, 0)` only.
- [ ] Migrate `watchdog.ts:103` to the shared helper.
- [ ] Delete the duplicate `isProcessAlive` in `spawn-recovery.ts`.
- **Estimate:** <100 lines, hour. **Risk:** low — change is mechanical.

### 2.3 tmux `pane-died` event hook ⏸
Daemon registers `tmux set-hook pane-died "run-shell '...'"` once; the hook writes a row into a `pane_events` table. Daemon's main loop tails that table instead of polling every 2s. Only safe after Phase 1 since hooks scattered across 7 callsites would be a mess.

- [ ] Schema: `pane_events (id, pane_id, kind, observed_at)` plus index.
- [ ] Daemon boot: detect tmux version, register hook with a tiny Node-or-shell helper that writes to `pane_events`.
- [ ] Daemon main loop: consume `pane_events` rows for known pane_ids; treat as `pane_closed`. Keep the polling path as fallback at a slow cadence (e.g. 30s) for liveness sanity.
- [ ] Daemon shutdown: unregister the hook (`tmux set-hook -u pane-died`).
- [ ] Verify: kill a watched pane externally → reconciliation latency drops from ≤2s to ≤200ms.
- **Estimate:** ~200 lines, day. **Risk:** medium — tmux hook semantics differ across versions; needs testing on tmux ≥3.0.

### 2.4 SIGTERM/graceful shutdown for watchdog ✅
`src/watchdog.ts` `main()` is `while(true)` with no signal handling. Phase 1 already proved `setTimeout(...).unref()` can suppress SIGTERM on macOS — same lesson applies here.

- [x] Add `stopping` flag and `process.on('SIGINT'|'SIGTERM', stop)` handlers to `watchdog.ts`.
- [x] On stop: best-effort `db.close()`, write final log line.
- [x] Audit any `setTimeout(...).unref()` in watchdog (skim — likely none, but check).
- [x] Verify: `kill -TERM <watchdog-pid>` exits cleanly within ≤1s.
- **Estimate:** <50 lines, ≤1 hour. **Risk:** trivial. **Recommend doing this first** — it's the cheapest of the four.

## Phase 3 — Independent cleanups (parallelizable later)

Mechanical and isolated — these can run in parallel via subagents once Phase 1+2 stabilize. Each item is a single PR.

### 3.1 Extract `src/constants.ts` ⏸
- [ ] New file `src/constants.ts` exporting `MAX_RESPAWN_ATTEMPTS`, `ESCALATION_THRESHOLD`, `BACKOFF_BASE_MS`, `BACKOFF_BASE_SEC`, `BACKOFF_MAX_*`, `STARTUP_GRACE_MS`.
- [ ] Migrate imports in `watchdog.ts` and `spawn-recovery.ts`. Reconcile drifted values (`BACKOFF_BASE_SEC=15` vs `BACKOFF_BASE_MS=500` represent different windows — pick the right one for each call site).
- [ ] Verify: tsc clean; agent backoff behavior unchanged in the smoke.

### 3.2 Replace `execSync` with `execFile` everywhere ⏸
~50 callsites, mostly tmux invocations. Eliminates shell injection risk and unblocks the event loop.
- [ ] Audit: `grep -n execSync src/` to enumerate.
- [ ] Categorize: which calls take user-controlled args (security concern) vs. fixed strings (just slow).
- [ ] Migrate the security-relevant ones first (anything with `${target}`, `${paneId}`, `${tmuxName}` etc.).
- [ ] Migrate the rest mechanically.
- [ ] Verify: tsc clean, all unit tests pass, smoke flag-off and flag-on.

### 3.3 Explicit env allowlist for spawned agents ⏸
`spawn-recovery.ts:592` passes full `process.env` to children — leaks unrelated secrets (RAILWAY_TOKEN, GITHUB_TOKEN, etc.) into the agent process tree.
- [ ] Define `AGENT_ENV_ALLOW = ['PATH','HOME','USER','LANG','LC_*','TERM','BRAIN_*','HERMES_*','ANTHROPIC_API_KEY','OPENAI_API_KEY']` (review with user before locking in).
- [ ] Helper `buildAgentEnv(extras)` filters `process.env` then merges `extras`.
- [ ] Update all spawn sites in `spawn-recovery.ts`, `conductor.ts`, `index.ts`, `tools/*.ts` to use the helper.
- [ ] Verify: spawn an agent in headless mode, dump env, confirm no leaked secrets.

### 3.4 Secure tmp files via `mkdtemp` 0o700 ⏸
Predictable `/tmp/brain-watch-${ts}-${name}.sh` paths in shared `/tmp` is a symlink-attack surface. Move to per-spawn dirs.
- [ ] Replace `tmpdir() + 'brain-...'` patterns with `fs.mkdtempSync(join(tmpdir(), 'brain-'))` returning a 0o700 dir.
- [ ] Files inside that dir get fixed names (no race).
- [ ] Update `cleanupStaleTempFiles` patterns in `watchdog.ts` to match new naming.
- [ ] Verify: spawn → confirm dir mode 0o700 and isolated.

### 3.5 Per-runtime `STARTUP_GRACE_MS` ⏸
Currently hardcoded `1500` in `spawn-recovery.ts:27`. Claude needs ~5–10s to print first marker; pi/py <1s. Mismatch causes false-positive crash detection on slow Claude boot.
- [ ] Add `STARTUP_GRACE_BY_RUNTIME = { claude: 8000, hermes: 5000, codex: 8000, pi: 1500, py: 1500 }`.
- [ ] `waitForStartup` accepts a runtime and uses the appropriate grace.
- [ ] Verify: existing spawn-recovery tests still pass (when 5.1 lands).

## Phase 4 — Architecture (large, sequential)

These are big refactors. Each gets its own design pass before implementation; expect 2–5 day work each. Sequence matters: 4.2 → 4.1 → 4.3 (decompose first so the rest happens in smaller files).

### 4.1 `AgentRuntime` interface ⏸
pi/py/claude branches in `conductor.ts:313–588` duplicate ~350 lines of spawn logic with subtle per-runtime variation. Hermes/codex were bolted on later in `index.ts` and `router-tools.ts` — same shape, different file.

- [ ] Design pass: define `interface AgentRuntime { buildSpawnCmd(ctx); postSpawnWatchParams(ctx); cleanupOnTerminal(); }`.
- [ ] Implementations: `ClaudeRuntime`, `HermesRuntime`, `CodexRuntime`, `PiRuntime`, `PyRuntime` — each in its own file under `src/runtimes/`.
- [ ] Migrate `conductor.ts` `spawnAgent` to dispatch via `runtimes[mode]`.
- [ ] Migrate `index.ts` swarm v2 + wake to the same dispatch.
- [ ] Migrate `tools/router-tools.ts` and `tools/swarm.ts` similarly.
- [ ] Adding a 6th runtime = one file. Verify by adding a no-op `EchoRuntime` for tests.
- **Conflicts with Phase 1.** Don't start until Phase 1 has burned in and the bash watcher code is deleted (the if/else branches will get untangled together).

### 4.2 Complete `index.ts` decomposition ⏸
`ARCHITECTURE.md` plan exists; 6 of 19 modules extracted. File has grown from 2,917 → 3,380 lines since the plan was written. Slow MCP cold start, hard to test, scary for contributors.

- [ ] Re-read `ARCHITECTURE.md`; check which 13 modules remain.
- [ ] Extract one module per PR (don't bundle — easier review, easier revert).
- [ ] Verify per-extraction: tsc clean, all tests pass, no behavior change in smoke.
- [ ] Track progress here as a checklist (one box per module) once the inventory is fresh.
- [ ] Stop when `index.ts` is <600 lines (the boot + tool-registration scaffolding).
- **Risk:** mechanical but creates merge conflicts. Don't run while other in-flight branches are open.

### 4.3 Tmux runtime abstraction ⏸
brain-mcp assumes tmux exists. Headless server use (Hermes background workers, CI) shouldn't require it. Extract a transport.

- [ ] Define `interface RuntimeTransport { spawn(cmd, env): Handle; isAlive(handle): boolean; sendInput?(handle, str): void; kill(handle): void }`.
- [ ] `TmuxTransport` wraps the existing tmux split-window/paste flow.
- [ ] `HeadlessTransport` wraps `child_process.spawn` directly (no terminal).
- [ ] Daemon's `tmuxAlivePanes()` becomes `transport.aliveAll()`.
- [ ] `BRAIN_RUNTIME_TRANSPORT=tmux|headless` env var (defaults to autodetect: `tmux` if `tmux display-message` works, else `headless`).
- [ ] Verify: spawn an agent on a tmux-less server (CI), confirm headless path works end-to-end.
- **Depends on 4.1 and the daemon being default.**

## Phase 5 — Tests + observability

Can run in parallel with Phase 2 — none of these depend on the daemon being default. **5.1 should land before 4.1** (need test coverage before refactoring the spawn paths).

### 5.1 Unit tests for `spawn-recovery.ts` ⏸
Currently zero coverage on `classifyError`, `recordSpawnFailure`, `shouldEscalate`, `reconcileSessionExit`, `waitForStartup` — the critical retry/backoff path.

- [ ] `src/spawn-recovery.test.ts` (new). Mirror the hand-rolled `test()` framework already used elsewhere.
- [ ] `classifyError`: ENOENT/EACCES/ETIMEDOUT/UNKNOWN cases; recoverable flags.
- [ ] Backoff math: `recordSpawnFailure` increments + sets `backoffUntil` correctly.
- [ ] Escalation: `shouldEscalate` flips at `ESCALATION_THRESHOLD`.
- [ ] `reconcileSessionExit`: exit 0 with/without confirmed work; exit non-zero; idempotent on already-terminal session.
- [ ] Verify: ≥80% line coverage on `spawn-recovery.ts`.

### 5.2 Integration test for `wake` + watcher daemon ⏸
End-to-end test that spawns a real daemon process against a real tmux pane.

- [ ] `src/integration/wake-watcher.test.ts` (new). Skip when no tmux available (`tmux display-message` fails).
- [ ] Test 1: enqueue `pi`-style watch on a pane running `sleep 1`; confirm row transitions to `terminal/pane_closed` and session reconciled within 5s.
- [ ] Test 2: enqueue with `timeout_sec=2` on `sleep 60`; confirm soft-exit + kill-pane + `terminal/timeout` + exit 124.
- [ ] Test 3: spawn daemon, kill mid-flight (SIGKILL), respawn, confirm in-flight watches resume from `pane_watches`.
- [ ] Wire into smoke harness (`smoke-test.mjs` or new entry).

### 5.3 Spawn metrics ⏸
Already a `spawn_metrics` table in `db.ts:524`. Hook it into all spawn paths so we can see daemon-vs-bash latency and failure rates.

- [ ] Audit: which spawn sites already write `spawn_metrics`? Which don't?
- [ ] Helper `recordSpawnMetric(db, { agentName, sessionId, spawnDurationMs, success, error?, runtime })`.
- [ ] Call from every spawn path including the daemon path.
- [ ] Add `brain_metrics view=daemon_summary` query for at-a-glance.
- [ ] Verify: run a swarm; query `spawn_metrics`; confirm rows for each agent.

### 5.4 Structured logging ⏸
`src/server-log.ts` is fine for now (file-backed, optional stderr mirror). Replace with `pino` only if/when it earns its keep.

- [ ] **Skip until needed.** The current logger is 47 lines and zero deps. A pino migration is ~200 lines + a runtime dep. Defer until: (a) we need log levels, (b) we need rotation, or (c) we want JSON output for ingestion.
- [ ] If pursued: drop-in replace `createServerLogger`; preserve the same `log.path` and `log.log()` surface so callers don't change.

## What I'm NOT recommending

- **Spawning 5–10 parallel subagents.** Without familiarity with the production behavior, they'll produce plausible-looking PRs that subtly break the hermes integration. The bash watchers might be load-bearing for crash isolation in ways the code comments don't explain.
- **Starting with the index.ts decomposition.** It's mechanical and low-risk per-extraction, but it churns thousands of lines and creates merge headaches for any other in-flight work. Better as a final pass after the architecture has settled.
- **Hooking up `pane-died` events first.** Tempting because it's the lowest-CPU solution, but premature without the daemon owning state — you'd have hooks scattered across 4 callsites again.

## How to start

~~I propose: I begin Phase 1.1 (the investigation, no code changes), produce `docs/watcher-contract.md`, and report back what I learned.~~ ✅ Done. Phase 1 shipped behind `BRAIN_WATCHER_MODE=daemon` flag. Default still `bash` so production is unchanged.

### Burn-in checklist for the daemon (before flipping the default)

- [ ] Set `BRAIN_WATCHER_MODE=daemon` in your shell.
- [ ] Run a normal Hermes workflow that spawns sub-agents — confirm panes spawn, prompts paste, agents run to completion, `pane_watches` rows transition to `terminal/pane_closed`, sessions get reconciled.
- [ ] Run a workflow that exceeds `agentTimeout` (or set `BRAIN_WORKFLOW_TIMEOUT` low) — confirm `terminal/timeout` path: soft `/exit` (or `C-c` for pi/py) → grace → `kill-pane` → session marked failed exit_code 124.
- [ ] Tail `/tmp/brain-mcp/<room>.log` for `agent-watcher` entries — verify start, idle exits, SIGTERM-clean releases.
- [ ] `bench-agent-spawn.mjs` with daemon vs bash — confirm latency parity or improvement.
- [ ] Kill the daemon mid-flight (`kill -TERM <pid>`); restart MCP / spawn a new agent — confirm a fresh daemon takes the lock and resumes pending watches.

When all of the above passes for ~2 weeks of real use, open the follow-up PR that flips the default to `daemon` and deletes the bash watcher generators.
