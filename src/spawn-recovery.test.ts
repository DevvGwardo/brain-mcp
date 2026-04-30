import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainDB } from './db.js';
import {
  buildRecoveryContext,
  classifyError,
  clearFailureRecord,
  cleanupSpawnTempFiles,
  formatRecoveryReport,
  getOrCreateFailureRecord,
  markGhostSession,
  recordSpawnFailure,
  reconcileSessionExit,
  savePreSpawnCheckpoint,
  shouldEscalate,
  shouldStopRetrying,
  spawnWithRecovery,
  waitForStartup,
} from './spawn-recovery.js';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  PASS: ${message}`);
}

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

async function withDb<T>(fn: (db: BrainDB, dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'brain-spawn-recovery-test-'));
  const db = new BrainDB(join(dir, 'brain.db'));
  try {
    return await fn(db, dir);
  } finally {
    try { db.close(); } catch { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

test('classifyError handles common spawn failures', () => {
  const enoent = classifyError(Object.assign(new Error('missing binary'), { code: 'ENOENT' }));
  assert(enoent.code === 'ENOENT', 'classifies ENOENT');
  assert(!enoent.recoverable, 'ENOENT is permanent');

  const eacces = classifyError(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
  assert(eacces.code === 'EACCES', 'classifies EACCES');
  assert(!eacces.recoverable, 'EACCES is permanent');

  const timeout = classifyError(Object.assign(new Error('spawn timeout'), { code: 'ETIMEDOUT' }));
  assert(timeout.code === 'ETIMEDOUT', 'classifies ETIMEDOUT');
  assert(timeout.recoverable, 'timeouts are recoverable');

  const unknown = classifyError(new Error('temporary failure'));
  assert(unknown.code === 'UNKNOWN', 'classifies unknown errors');
  assert(unknown.recoverable, 'unknown errors are retryable');
});

test('recordSpawnFailure persists count, backoff, and escalation', () => withDb((db) => {
  const record = getOrCreateFailureRecord(db, 'agent-1', 'worker', 'room-a');
  const before = Date.now();

  recordSpawnFailure(db, record, 1, 'first failure', 2);
  let row = db.failure_get('agent-1');
  assert(row?.failure_count === 1, 'persists first failure count');
  assert((row?.backoff_until ?? 0) >= before, 'persists first backoff timestamp');
  assert(row?.death_type === 'spawn_failure', 'records spawn failure death type');
  assert(!shouldEscalate(record), 'does not escalate on first failure');

  recordSpawnFailure(db, record, 2, 'second failure', 2);
  recordSpawnFailure(db, record, 3, 'third failure', 2);
  row = db.failure_get('agent-1');
  assert(row?.failure_count === 3, 'persists repeated failure count');
  assert(row?.escalation_level === 2, 'persists escalation level');
  assert(shouldEscalate(record), 'escalates at threshold');
  assert(!shouldStopRetrying(record), 'does not stop before max retries');

  const reloaded = getOrCreateFailureRecord(db, 'agent-1', 'worker', 'room-a');
  assert(reloaded.attempts.length === 3, 'reloads persisted failures into attempts');
  assert(reloaded.backoffUntil === row?.backoff_until, 'reloads persisted backoff');

  clearFailureRecord(db, 'agent-1');
  assert(db.failure_get('agent-1') === null, 'clears persisted failure record');
}));

test('shouldStopRetrying flips at max respawn attempts', () => withDb((db) => {
  const record = getOrCreateFailureRecord(db, 'agent-2', 'worker', 'room-a');
  for (let attempt = 1; attempt <= 5; attempt++) {
    recordSpawnFailure(db, record, attempt, `failure ${attempt}`, 1);
  }
  assert(shouldStopRetrying(record), 'stops retrying after five failures');
}));

test('reconcileSessionExit marks exit 0 without work as failed', () => withDb((db) => {
  db.registerSession('worker', 'room-a', undefined, 'sess-no-work');
  const result = reconcileSessionExit(db, 'sess-no-work', 0);
  const session = db.getSession('sess-no-work');
  assert(result.finalized, 'finalizes idle session');
  assert(result.status === 'failed', 'returns failed status');
  assert(session?.status === 'failed', 'marks session failed');
  assert(session?.exit_code === 0, 'stores exit code 0');
}));

test('reconcileSessionExit marks exit 0 with confirmed work as done', () => withDb((db) => {
  db.registerSession('worker', 'room-a', undefined, 'sess-work');
  db.postMessage('updates', 'room-a', 'sess-work', 'worker', 'made progress');
  const result = reconcileSessionExit(db, 'sess-work', 0);
  const session = db.getSession('sess-work');
  assert(result.finalized, 'finalizes worked session');
  assert(result.status === 'done', 'returns done status');
  assert(session?.status === 'done', 'marks session done');
}));

test('reconcileSessionExit marks non-zero exit as failed', () => withDb((db) => {
  db.registerSession('worker', 'room-a', undefined, 'sess-fail');
  const result = reconcileSessionExit(db, 'sess-fail', 42, 'boom');
  const session = db.getSession('sess-fail');
  assert(result.finalized, 'finalizes failed process');
  assert(result.status === 'failed', 'returns failed status');
  assert(session?.status === 'failed', 'marks session failed');
  assert(session?.exit_code === 42, 'stores non-zero exit code');
}));

test('reconcileSessionExit is idempotent for terminal sessions', () => withDb((db) => {
  db.registerSession('worker', 'room-a', undefined, 'sess-done');
  db.markDone('sess-done', 0, false, 'already done');
  const result = reconcileSessionExit(db, 'sess-done', 0);
  const session = db.getSession('sess-done');
  assert(!result.finalized, 'does not re-finalize terminal session');
  assert(result.status === 'done', 'reports existing status');
  assert(session?.status === 'done', 'keeps done status');
}));

test('waitForStartup treats clean early exit without work as not started', async () => {
  await withDb(async (db, dir) => {
    db.registerSession('worker', 'room-a', undefined, 'startup-early-exit');
    const proc = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const result = await waitForStartup(
      db,
      'startup-early-exit',
      proc,
      proc.pid!,
      join(dir, 'early.log'),
      join(dir, 'early.exit'),
    );
    assert(!result.started, 'early clean exit is not started');
    assert(result.exitCode === 0, 'reports exit code 0');
  });
});

test('waitForStartup treats live process after grace as started', async () => {
  await withDb(async (db, dir) => {
    db.registerSession('worker', 'room-a', undefined, 'startup-live');
    const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    try {
      const result = await waitForStartup(
        db,
        'startup-live',
        proc,
        proc.pid!,
        join(dir, 'live.log'),
        join(dir, 'live.exit'),
      );
      assert(result.started, 'live process is started');
    } finally {
      proc.kill('SIGTERM');
    }
  });
});

test('waitForStartup uses per-runtime startup grace', async () => {
  await withDb(async (db, dir) => {
    db.registerSession('worker', 'room-a', undefined, 'startup-claude');
    const proc = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2200)'], { stdio: 'ignore' });
    const result = await waitForStartup(
      db,
      'startup-claude',
      proc,
      proc.pid!,
      join(dir, 'claude.log'),
      join(dir, 'claude.exit'),
      'claude',
    );
    assert(!result.started, 'claude grace waits through early clean exit');
    assert(result.exitCode === 0, 'reports early claude exit code');
  });
});

test('buildRecoveryContext and formatRecoveryReport summarize persisted state', () => withDb((db) => {
  db.registerSession('worker', 'room-a', JSON.stringify({ role: 'test' }), 'ctx-agent');
  db.claim('resource-a', 'ctx-agent', 'worker', 'room-a');
  db.postMessage('updates', 'room-a', 'ctx-agent', 'worker', 'progress message');
  db.pushContext('room-a', 'ctx-agent', 'worker', 'action', 'edited file', 'detail', 'src/file.ts', ['test']);
  db.recordMetric('room-a', 'worker', 'ctx-agent', { outcome: 'failed' });

  const ctx = buildRecoveryContext(db, 'ctx-agent', 'worker', 'room-a');
  assert(ctx.claims.includes('resource-a'), 'includes owned claims');
  assert(ctx.recentActivity.some((entry) => entry.summary === 'edited file'), 'includes recent context');
  assert(ctx.metrics?.failures === 1, 'includes failure metrics');

  const report = formatRecoveryReport(ctx);
  assert(report.includes('RECOVERY CONTEXT for worker'), 'formats report header');
  assert(report.includes('resource-a'), 'formats claims');
}));

test('savePreSpawnCheckpoint and markGhostSession write recovery state', () => withDb((db) => {
  db.registerSession('worker', 'room-a', undefined, 'checkpoint-agent');
  savePreSpawnCheckpoint(db, 'room-a', 'checkpoint-agent', 'worker', 'do the task');
  const checkpoint = db.restoreCheckpoint('room-a', 'checkpoint-agent');
  assert(checkpoint !== undefined, 'saves pre-spawn checkpoint');

  markGhostSession(db, 'checkpoint-agent', 'worker');
  const session = db.getSession('checkpoint-agent');
  assert(session?.status === 'failed', 'marks ghost session failed');
  assert(session?.exit_code === -1, 'stores ghost exit code');
}));

test('spawnWithRecovery returns permanent CLI failures without retrying', async () => {
  await withDb(async (db, dir) => {
    const logFile = join(dir, 'auth.log');
    const result = await spawnWithRecovery(
      db,
      'room-a',
      'auth-agent',
      'worker',
      'do auth task',
      `printf "authentication failed" > "${logFile}"; exit 1`,
      logFile,
    );
    assert(!result.success, 'returns failed spawn result');
    assert(result.attempt === 1, 'does not retry permanent auth failure');
    assert(result.error?.includes('authentication failed') === true, 'returns classified auth error');
    assert(db.failure_get('auth-agent')?.failure_count === 1, 'persists permanent spawn failure');
  });
});

test('spawnWithRecovery confirms a live process and clears failures', async () => {
  await withDb(async (db, dir) => {
    db.failure_record('live-agent', {
      agent_name: 'worker',
      failure_count: 1,
      last_failure_at: Date.now(),
      backoff_until: 0,
      death_type: 'spawn_failure',
    });
    const logFile = join(dir, 'live-spawn.log');
    const result = await spawnWithRecovery(
      db,
      'room-a',
      'live-agent',
      'worker',
      'do live task',
      'sleep 5',
      logFile,
    );
    assert(result.success, 'returns successful spawn result');
    assert(typeof result.pid === 'number', 'returns spawned pid');
    assert(db.failure_get('live-agent') === null, 'clears previous failure on success');
    try { process.kill(-result.pid!, 'SIGTERM'); } catch { /* best effort */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });
});

test('cleanupSpawnTempFiles is best effort', () => {
  const removed = cleanupSpawnTempFiles(['definitely-not-a-brain-test-prefix-']);
  assert(removed === 0, 'returns zero when no files match');
});

async function run() {
  for (const { name, fn } of tests) {
    process.stdout.write(`\n${name}\n`);
    try {
      await fn();
    } catch (e: any) {
      console.error(`  FAIL: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

run().catch((e: any) => {
  console.error(`  FAIL: ${e.message}`);
  process.exitCode = 1;
});
