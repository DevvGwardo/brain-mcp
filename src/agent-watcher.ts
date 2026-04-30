/**
 * agent-watcher — long-lived sibling daemon that owns tmux pane lifecycle.
 *
 * Replaces per-pane bash watcher scripts (see docs/watcher-contract.md).
 * Driven by the `pane_watches` table; ticks every TICK_MS; one
 * `tmux list-panes -aF` per tick covers liveness for all watched panes.
 *
 * Gated behind BRAIN_WATCHER_MODE=daemon. When the env var is unset or
 * 'bash', callers keep emitting bash watchers and this file is dormant.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BrainDB, type PaneWatch, type PaneWatchInsert, type PaneWatchTerminal } from './db.js';
import { reconcileSessionExit } from './spawn-recovery.js';
import { createServerLogger } from './server-log.js';

export const TICK_MS = 2000;
const LOCK_NAME = 'agent-watcher';

// ── Pure decision function ─────────────────────────────────────────────────────

export interface PaneEnv {
  paneAlive: boolean;
  paneContent: string | null; // capture-pane output, null if not captured this tick
  now: number;                // ms since epoch
}

export type WatchAction =
  | { kind: 'paste-prompt' }
  | { kind: 'send-exit' }
  | { kind: 'kill-pane'; afterMs: number }
  | { kind: 'cleanup-paths'; paths: string[] }
  | { kind: 'reconcile' };

export interface Decision {
  patch: Partial<PaneWatch>;
  actions: WatchAction[];
}

const NOTHING: Decision = { patch: {}, actions: [] };

function parseStartedAtMs(watch: PaneWatch): number {
  // SQLite TEXT 'YYYY-MM-DD HH:MM:SS' is treated as UTC by datetime('now').
  const ts = watch.started_at.includes('T') ? watch.started_at : watch.started_at.replace(' ', 'T') + 'Z';
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : Date.now();
}

function readMarkers(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function readPaths(json: string): string[] {
  return readMarkers(json);
}

function matchesAny(content: string, markers: string[]): boolean {
  for (const m of markers) {
    if (m && content.includes(m)) return true;
  }
  return false;
}

/**
 * Decide what to do with one pane_watch row this tick. Pure.
 *
 * Mirrors bash watcher state machine from docs/watcher-contract.md §2.
 * Caller is responsible for executing returned actions and applying
 * the patch to the row.
 */
export function decide(watch: PaneWatch, env: PaneEnv): Decision {
  if (watch.status === 'terminal') return NOTHING;

  // Terminal short-circuit: pane gone → success exit (bash exit 0 / pane_closed).
  if (!env.paneAlive) {
    return terminalDecision(watch, 'pane_closed', env.now);
  }

  if (watch.status === 'ready_wait') {
    const ready = isReady(watch, env.paneContent);
    const exhausted = (watch.ready_attempts + 1) >= watch.max_ready_ticks;
    if (ready || exhausted) {
      return enterRunning(watch, env.now);
    }
    return {
      patch: { ready_attempts: watch.ready_attempts + 1, last_polled_at: tsFromMs(env.now) },
      actions: [],
    };
  }

  // status === 'running'
  if (watch.timeout_sec > 0) {
    const elapsedMs = env.now - parseStartedAtMs(watch);
    if (elapsedMs >= watch.timeout_sec * 1000) {
      return terminalDecision(watch, 'timeout', env.now);
    }
  }
  return { patch: { last_polled_at: tsFromMs(env.now) }, actions: [] };
}

function isReady(watch: PaneWatch, paneContent: string | null): boolean {
  if (watch.ready_strategy === 'skip') return true;
  if (paneContent === null) return false;
  if (matchesAny(paneContent, readMarkers(watch.ready_markers))) return true;
  if (matchesAny(paneContent, readMarkers(watch.fallback_markers))) return true;
  return false;
}

function enterRunning(watch: PaneWatch, now: number): Decision {
  const actions: WatchAction[] = [];
  const patch: Partial<PaneWatch> = {
    status: 'running',
    ready_observed_at: tsFromMs(now),
    last_polled_at: tsFromMs(now),
  };
  if (watch.prompt_path) {
    actions.push({ kind: 'paste-prompt' });
    actions.push({ kind: 'cleanup-paths', paths: [watch.prompt_path] });
    patch.paste_completed_at = tsFromMs(now);
  }
  return { patch, actions };
}

function terminalDecision(watch: PaneWatch, terminal: PaneWatchTerminal, now: number): Decision {
  const actions: WatchAction[] = [];
  if (terminal === 'timeout') {
    actions.push({ kind: 'send-exit' });
    actions.push({ kind: 'kill-pane', afterMs: watch.kill_grace_sec * 1000 });
  }
  const cleanup = readPaths(watch.cleanup_paths);
  if (cleanup.length > 0) actions.push({ kind: 'cleanup-paths', paths: cleanup });
  actions.push({ kind: 'reconcile' });
  return {
    patch: {
      status: 'terminal',
      terminal_state: terminal,
      terminal_at: tsFromMs(now),
      last_polled_at: tsFromMs(now),
    },
    actions,
  };
}

function tsFromMs(ms: number): string {
  // datetime('now') format: 'YYYY-MM-DD HH:MM:SS' (UTC).
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

// ── Helpers exposed to call-sites ─────────────────────────────────────────────

export function watcherModeFromEnv(): 'daemon' | 'bash' {
  return process.env.BRAIN_WATCHER_MODE === 'daemon' ? 'daemon' : 'bash';
}

export function enqueueDaemonWatch(db: BrainDB, params: PaneWatchInsert): number {
  const id = db.paneWatch_insert(params);
  ensureAgentWatcherDaemon(db);
  return id;
}

export function ensureAgentWatcherDaemon(db: BrainDB): { spawned: boolean; pid: number | null } {
  const holder = db.daemonLock_holder(LOCK_NAME);
  if (holder) {
    let alive = false;
    try { process.kill(holder, 0); alive = true; } catch { alive = false; }
    if (alive) return { spawned: false, pid: holder };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, 'agent-watcher.js');
  if (!existsSync(entry)) return { spawned: false, pid: null };
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, BRAIN_DB_PATH: process.env.BRAIN_DB_PATH || '' },
  });
  child.unref();
  return { spawned: true, pid: child.pid ?? null };
}

// ── Side-effect runners (only used when daemon is the running process) ───────

function tmuxAlivePanes(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  try {
    const raw = execFileSync('tmux', ['list-panes', '-aF', '#{pane_id}|#{pane_dead}'], { encoding: 'utf8' });
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [paneId, dead] = trimmed.split('|');
      if (!paneId) continue;
      out.set(paneId, dead === '0');
    }
  } catch {
    // No tmux server / no panes — treat as nothing alive (daemon will mark all watches pane_closed).
  }
  return out;
}

function tmuxCapture(paneId: string): string | null {
  try {
    return execFileSync('tmux', ['capture-pane', '-t', paneId, '-p'], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function tmuxPaste(paneId: string, bufferName: string, promptPath: string): void {
  try { execFileSync('tmux', ['load-buffer', '-b', bufferName, promptPath]); } catch { return; }
  try { execFileSync('tmux', ['paste-buffer', '-b', bufferName, '-t', paneId]); } catch { /* best effort */ }
  try { execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter']); } catch { /* best effort */ }
  try { execFileSync('tmux', ['delete-buffer', '-b', bufferName]); } catch { /* best effort */ }
}

function tmuxSendExit(paneId: string, exitCommand: string): void {
  try {
    if (exitCommand === 'C-c') {
      execFileSync('tmux', ['send-keys', '-t', paneId, 'C-c']);
    } else {
      execFileSync('tmux', ['send-keys', '-t', paneId, exitCommand, 'Enter']);
    }
  } catch { /* best effort */ }
}

function tmuxKillPane(paneId: string): void {
  try { execFileSync('tmux', ['kill-pane', '-t', paneId]); } catch { /* best effort */ }
}

function tmuxKillSession(sessionName: string): void {
  try { execFileSync('tmux', ['kill-session', '-t', sessionName]); } catch { /* best effort — already gone */ }
}

function rmFiles(paths: string[]): void {
  for (const p of paths) {
    if (!p) continue;
    try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
  }
}

// ── Main loop (only runs when this module is the entry point) ────────────────

async function main(): Promise<void> {
  const log = createServerLogger({ component: 'agent-watcher', room: process.env.BRAIN_ROOM || 'default' });
  const db = new BrainDB(process.env.BRAIN_DB_PATH);

  const lock = db.daemonLock_acquire(LOCK_NAME, process.pid);
  if (!lock.acquired) {
    log.log(`another agent-watcher already holds the lock (pid ${lock.holder_pid}); exiting`);
    db.close();
    return;
  }
  log.log(`agent-watcher started (pid ${process.pid}), tick ${TICK_MS}ms`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    try { db.daemonLock_release(LOCK_NAME, process.pid); } catch { /* best effort */ }
    try { db.close(); } catch { /* best effort */ }
    log.log('agent-watcher stopped');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let idleTicks = 0;
  while (!stopping) {
    try {
      const watches = db.paneWatch_active();
      if (watches.length === 0) {
        idleTicks++;
        // After 5 minutes of nothing to watch, exit; will be re-spawned on demand.
        if (idleTicks * TICK_MS >= 5 * 60 * 1000) {
          log.log('idle for 5 minutes, exiting');
          stop();
          return;
        }
      } else {
        idleTicks = 0;
        const aliveMap = tmuxAlivePanes();
        for (const watch of watches) {
          const paneAlive = aliveMap.get(watch.pane_id) ?? false;
          const paneContent =
            watch.status === 'ready_wait' && paneAlive ? tmuxCapture(watch.pane_id) : null;
          const decision = decide(watch, { paneAlive, paneContent, now: Date.now() });
          executeActions(db, log, watch, decision);
          if (Object.keys(decision.patch).length > 0) {
            db.paneWatch_update(watch.id, decision.patch);
          }
        }
      }
    } catch (err) {
      log.log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(TICK_MS);
  }
}

function executeActions(
  db: BrainDB,
  log: ReturnType<typeof createServerLogger>,
  watch: PaneWatch,
  decision: Decision,
): void {
  for (const action of decision.actions) {
    switch (action.kind) {
      case 'paste-prompt': {
        if (watch.prompt_path && watch.buffer_name) {
          tmuxPaste(watch.pane_id, watch.buffer_name, watch.prompt_path);
        }
        break;
      }
      case 'send-exit': {
        tmuxSendExit(watch.pane_id, watch.exit_command);
        break;
      }
      case 'kill-pane': {
        const paneId = watch.pane_id;
        if (action.afterMs > 0) {
          setTimeout(() => tmuxKillPane(paneId), action.afterMs).unref();
        } else {
          tmuxKillPane(paneId);
        }
        break;
      }
      case 'cleanup-paths': {
        rmFiles(action.paths);
        break;
      }
      case 'reconcile': {
        const terminal = (decision.patch.terminal_state ?? watch.terminal_state) as PaneWatchTerminal | null;
        const exitCode = terminal === 'timeout' ? 124 : 0;
        const detail =
          terminal === 'timeout'
            ? 'tmux watcher timed out'
            : terminal === 'pane_closed'
              ? 'tmux pane closed'
              : 'tmux watcher error';
        try {
          if (watch.finalizer_kind === 'mark_failed') {
            db.markDone(watch.session_id, exitCode === 0 ? 0 : -1, exitCode !== 0, detail);
          } else {
            reconcileSessionExit(db, watch.session_id, exitCode, detail);
          }
        } catch (err) {
          log.log(`reconcile failed for session ${watch.session_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
        // If this watch lived in a brain-mcp-created detached tmux session
        // (createDetachedTmuxSession), and it's the last non-terminal watch
        // in that session, the session has only the anchor zsh left — kill
        // it so detached sessions don't accumulate. Set BRAIN_KEEP_DETACHED_SESSION=1
        // to opt out (e.g. if you want to attach and review output post-mortem).
        if (watch.tmux_session_name && process.env.BRAIN_KEEP_DETACHED_SESSION !== '1') {
          try {
            const others = db.paneWatch_activeInSession(watch.tmux_session_name, watch.id);
            if (others.length === 0) {
              tmuxKillSession(watch.tmux_session_name);
              log.log(`killed empty detached session ${watch.tmux_session_name}`);
            }
          } catch (err) {
            log.log(`session-cleanup failed for ${watch.tmux_session_name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        break;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run as a daemon when this file is invoked directly (node dist/agent-watcher.js).
const invokedDirectly = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`agent-watcher fatal: ${err}`);
    process.exit(1);
  });
}
