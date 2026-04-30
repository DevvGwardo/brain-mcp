/**
 * Integration test for wake + agent-watcher daemon.
 *
 * Spawns a real isolated tmux session, real `sleep` panes, and a real
 * agent-watcher daemon subprocess. Each test cleans up its own tmux
 * session and tmp DB.
 *
 * Skipped automatically when tmux is unavailable. To run:
 *
 *   npx tsc && node dist/wake-daemon.integration.test.js
 *
 * Not part of the default `node dist/*.test.js` sweep — slower (5–10s
 * per case) and requires tmux on PATH.
 */

import { execFileSync, spawn as spawnProc } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainDB } from './db.js';

function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function fail(message: string): never {
  console.error(`  FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function assert(condition: boolean, message: string) {
  if (!condition) fail(message);
  console.log(`  PASS: ${message}`);
}

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`\n${name}\n`);
  try {
    await fn();
  } catch (e: any) {
    if (!e.message?.startsWith('FAIL:')) {
      console.error(`  FAIL: ${e.message ?? String(e)}`);
      process.exitCode = 1;
    }
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

interface Harness {
  db: BrainDB;
  dbPath: string;
  tmuxSession: string;
  daemon: ReturnType<typeof spawnProc> | null;
}

function setupHarness(): Harness {
  const dbPath = join(tmpdir(), `brain-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new BrainDB(dbPath);
  const tmuxSession = `brain-int-${Date.now().toString().slice(-6)}`;
  // Detached session avoids polluting the user's running tmux.
  execFileSync('tmux', ['new-session', '-d', '-s', tmuxSession, '-n', 'init'], { stdio: 'ignore' });
  return { db, dbPath, tmuxSession, daemon: null };
}

function spawnDaemon(harness: Harness): ReturnType<typeof spawnProc> {
  const proc = spawnProc(
    process.execPath,
    [join(import.meta.dirname || __dirname, 'agent-watcher.js')],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, BRAIN_DB_PATH: harness.dbPath },
    },
  );
  harness.daemon = proc;
  return proc;
}

async function teardown(harness: Harness) {
  if (harness.daemon && harness.daemon.exitCode === null) {
    harness.daemon.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => harness.daemon!.once('exit', () => r(null))),
      new Promise((r) => setTimeout(() => { harness.daemon!.kill('SIGKILL'); r(null); }, 3000)),
    ]);
  }
  try { execFileSync('tmux', ['kill-session', '-t', harness.tmuxSession], { stdio: 'ignore' }); } catch { /* may already be gone */ }
  try { harness.db.close(); } catch { /* best effort */ }
  for (const p of [harness.dbPath, `${harness.dbPath}-wal`, `${harness.dbPath}-shm`]) {
    if (existsSync(p)) { try { unlinkSync(p); } catch { /* best effort */ } }
  }
}

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs = 8000, intervalMs = 200): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = probe();
    if (v != null) return v;
    await sleep(intervalMs);
  }
  return null;
}

function spawnSleepPane(harness: Harness, seconds: number): string {
  // Target the session itself (works regardless of user's base-index setting).
  const paneId = execFileSync(
    'tmux',
    ['split-window', '-h', '-P', '-F', '#{pane_id}', '-t', harness.tmuxSession, `sleep ${seconds}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).toString().trim();
  return paneId;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

if (!tmuxAvailable()) {
  console.log('Skipping wake-daemon integration tests: tmux not available on PATH.');
  process.exit(0);
}

await test('normal exit: pane closes naturally → terminal/pane_closed + session done', async () => {
  const h = setupHarness();
  try {
    const sessionId = 'int-sess-normal';
    h.db.registerSession('int-agent', '/tmp/int-room', '{}', sessionId);
    h.db.pulse(sessionId, 'working', 'started');

    const paneId = spawnSleepPane(h, 1);
    const watchId = h.db.paneWatch_insert({
      pane_id: paneId,
      session_id: sessionId,
      ready_strategy: 'skip',
      status: 'running',
      timeout_sec: 0,
      finalizer_kind: 'reconcile',
    });

    spawnDaemon(h);

    const finalWatch = await waitFor(() => {
      const w = h.db.paneWatch_get(watchId);
      return w && w.status === 'terminal' ? w : null;
    });
    assert(!!finalWatch, 'watch transitioned to terminal within 8s');
    assert(finalWatch?.terminal_state === 'pane_closed', 'terminal_state is pane_closed');

    const session = h.db.getSession(sessionId);
    assert(session?.status === 'done' || session?.status === 'failed', `session reached terminal status (got ${session?.status})`);
    assert(session?.exit_code === 0, 'session exit_code is 0');
  } finally {
    await teardown(h);
  }
});

await test('timeout: long-running pane gets soft-exit + kill + terminal/timeout + exit 124', async () => {
  const h = setupHarness();
  try {
    const sessionId = 'int-sess-timeout';
    h.db.registerSession('int-agent', '/tmp/int-room', '{}', sessionId);
    h.db.pulse(sessionId, 'working', 'started');

    const paneId = spawnSleepPane(h, 30);
    const watchId = h.db.paneWatch_insert({
      pane_id: paneId,
      session_id: sessionId,
      ready_strategy: 'skip',
      status: 'running',
      timeout_sec: 3,
      kill_grace_sec: 2,
      exit_command: 'C-c',
      finalizer_kind: 'reconcile',
    });

    spawnDaemon(h);

    const finalWatch = await waitFor(() => {
      const w = h.db.paneWatch_get(watchId);
      return w && w.status === 'terminal' ? w : null;
    }, 12000);
    assert(!!finalWatch, 'watch transitioned to terminal within 12s');
    assert(finalWatch?.terminal_state === 'timeout', `terminal_state is timeout (got ${finalWatch?.terminal_state})`);

    const session = h.db.getSession(sessionId);
    assert(session?.exit_code === 124, `session exit_code is 124 (got ${session?.exit_code})`);
    assert(session?.status === 'failed', `session marked failed (got ${session?.status})`);
  } finally {
    await teardown(h);
  }
});

await test('daemon kill + respawn: in-flight watches resume from pane_watches', async () => {
  const h = setupHarness();
  try {
    const sessionId = 'int-sess-resume';
    h.db.registerSession('int-agent', '/tmp/int-room', '{}', sessionId);
    h.db.pulse(sessionId, 'working', 'started');

    // Pane outlives the first daemon
    const paneId = spawnSleepPane(h, 6);
    const watchId = h.db.paneWatch_insert({
      pane_id: paneId,
      session_id: sessionId,
      ready_strategy: 'skip',
      status: 'running',
      timeout_sec: 0,
      finalizer_kind: 'reconcile',
    });

    // First daemon
    const daemon1 = spawnDaemon(h);
    // Wait for daemon to acquire the lock
    const holder1 = await waitFor(() => {
      const pid = h.db.daemonLock_holder('agent-watcher');
      return pid && pid === daemon1.pid ? pid : null;
    }, 4000);
    assert(holder1 === daemon1.pid, 'first daemon acquired the lock');

    // Hard-kill the daemon mid-flight (SIGKILL leaves the lock row stale)
    daemon1.kill('SIGKILL');
    await new Promise((r) => daemon1.once('exit', () => r(null)));

    // Confirm the watch row is still pending
    const stillRunning = h.db.paneWatch_get(watchId);
    assert(stillRunning?.status === 'running', `watch still running after daemon SIGKILL (got ${stillRunning?.status})`);

    // Second daemon should detect stale lock and take over
    const daemon2 = spawnDaemon(h);

    // Now wait for the pane to die naturally (sleep 6 finishes) and the new daemon to reconcile
    const finalWatch = await waitFor(() => {
      const w = h.db.paneWatch_get(watchId);
      return w && w.status === 'terminal' ? w : null;
    }, 12000);
    assert(!!finalWatch, 'second daemon resumed and reconciled the watch');
    assert(finalWatch?.terminal_state === 'pane_closed', 'terminal_state is pane_closed (natural end)');

    const holderAfter = h.db.daemonLock_holder('agent-watcher');
    assert(holderAfter === daemon2.pid, 'second daemon now holds the lock');
  } finally {
    await teardown(h);
  }
});

await test('detached session: daemon kills it when last watch terminals', async () => {
  const h = setupHarness();
  // Simulate brain-mcp's createDetachedTmuxSession: a separate "brain-XXX" session.
  const detached = `brain-int-detached-${Date.now().toString().slice(-6)}`;
  execFileSync('tmux', ['new-session', '-d', '-s', detached, '-n', 'brain'], { stdio: 'ignore' });
  try {
    const sessionId = 'int-sess-detached';
    h.db.registerSession('int-agent', '/tmp/int-room', '{}', sessionId);
    h.db.pulse(sessionId, 'working', 'started');

    const paneId = execFileSync(
      'tmux',
      ['split-window', '-h', '-P', '-F', '#{pane_id}', '-t', detached, 'sleep 1'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();

    const watchId = h.db.paneWatch_insert({
      pane_id: paneId,
      session_id: sessionId,
      ready_strategy: 'skip',
      status: 'running',
      timeout_sec: 0,
      finalizer_kind: 'reconcile',
      tmux_session_name: detached,
    });

    spawnDaemon(h);

    const finalWatch = await waitFor(() => {
      const w = h.db.paneWatch_get(watchId);
      return w && w.status === 'terminal' ? w : null;
    });
    assert(!!finalWatch, 'watch transitioned to terminal');
    assert(finalWatch?.terminal_state === 'pane_closed', 'pane_closed terminal');

    // The daemon should have killed the detached session right after reconcile.
    const killed = await waitFor(() => {
      try {
        execFileSync('tmux', ['has-session', '-t', detached], { stdio: 'ignore' });
        return null; // still alive
      } catch {
        return true; // session is gone
      }
    }, 4000, 200);
    assert(killed === true, 'daemon killed the now-empty detached tmux session');
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', detached], { stdio: 'ignore' }); } catch { /* already dead */ }
    await teardown(h);
  }
});

console.log('\n✅ wake+daemon integration tests complete\n');
