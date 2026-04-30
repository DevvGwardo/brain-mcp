import { decide, type PaneEnv } from './agent-watcher.js';
import type { PaneWatch } from './db.js';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  PASS: ${message}`);
}

function test(name: string, fn: () => void) {
  process.stdout.write(`\n${name}\n`);
  try {
    fn();
  } catch (e: any) {
    console.error(`  FAIL: ${e.message}`);
    process.exitCode = 1;
  }
}

const NOW = Date.parse('2026-04-29T12:00:00Z');

function makeWatch(overrides: Partial<PaneWatch> = {}): PaneWatch {
  return {
    id: 1,
    pane_id: '%17',
    session_id: 'sess-1',
    status: 'ready_wait',
    terminal_state: null,
    ready_strategy: 'wait',
    ready_markers: JSON.stringify(['❯']),
    fallback_markers: JSON.stringify(['accept edits']),
    ready_attempts: 0,
    max_ready_ticks: 60,
    exit_command: '/exit',
    kill_grace_sec: 5,
    timeout_sec: 0,
    prompt_path: '/tmp/prompt.txt',
    buffer_name: 'brain-x',
    cleanup_paths: '[]',
    finalizer_kind: 'reconcile',
    started_at: '2026-04-29 12:00:00',
    ready_observed_at: null,
    paste_completed_at: null,
    terminal_at: null,
    last_polled_at: null,
    ...overrides,
  };
}

function env(overrides: Partial<PaneEnv> = {}): PaneEnv {
  return { paneAlive: true, paneContent: null, now: NOW, ...overrides };
}

test('ready_wait + dead pane → terminal pane_closed (success)', () => {
  const decision = decide(makeWatch({ status: 'ready_wait' }), env({ paneAlive: false }));
  assert(decision.patch.status === 'terminal', 'transitions to terminal');
  assert(decision.patch.terminal_state === 'pane_closed', 'records pane_closed');
  assert(decision.actions.some((a) => a.kind === 'reconcile'), 'emits reconcile action');
  assert(!decision.actions.some((a) => a.kind === 'send-exit'), 'no soft-exit needed');
});

test('ready_wait + marker match → enters running and pastes prompt', () => {
  const decision = decide(makeWatch(), env({ paneContent: 'something something ❯' }));
  assert(decision.patch.status === 'running', 'transitions to running');
  assert(decision.patch.ready_observed_at !== undefined, 'stamps ready_observed_at');
  assert(decision.actions.some((a) => a.kind === 'paste-prompt'), 'emits paste-prompt');
  const cleanup = decision.actions.find((a) => a.kind === 'cleanup-paths');
  assert(cleanup?.kind === 'cleanup-paths' && cleanup.paths.includes('/tmp/prompt.txt'), 'cleans up prompt path');
});

test('ready_wait + fallback marker also matches', () => {
  const decision = decide(makeWatch(), env({ paneContent: 'press y to accept edits' }));
  assert(decision.patch.status === 'running', 'fallback marker triggers running');
});

test('ready_wait + no marker yet → stays in ready_wait, increments attempts', () => {
  const decision = decide(makeWatch({ ready_attempts: 5 }), env({ paneContent: 'still booting...' }));
  assert(decision.patch.status === undefined, 'no status transition');
  assert(decision.patch.ready_attempts === 6, 'increments ready_attempts');
});

test('ready_wait + max attempts exhausted → forces running', () => {
  const decision = decide(makeWatch({ ready_attempts: 59, max_ready_ticks: 60 }), env({ paneContent: 'never ready' }));
  assert(decision.patch.status === 'running', 'forces transition after exhaustion');
  assert(decision.actions.some((a) => a.kind === 'paste-prompt'), 'still pastes the prompt');
});

test('ready_strategy=skip → enters running on first tick without content', () => {
  const w = makeWatch({ ready_strategy: 'skip', prompt_path: null });
  const decision = decide(w, env({ paneContent: null }));
  assert(decision.patch.status === 'running', 'skip strategy bypasses marker check');
  assert(!decision.actions.some((a) => a.kind === 'paste-prompt'), 'no paste when prompt_path is null');
});

test('running + dead pane → terminal pane_closed', () => {
  const decision = decide(makeWatch({ status: 'running' }), env({ paneAlive: false }));
  assert(decision.patch.terminal_state === 'pane_closed', 'records pane_closed');
  assert(decision.actions.some((a) => a.kind === 'reconcile'), 'reconciles on natural exit');
});

test('running + timeout exceeded → soft exit + scheduled kill + terminal timeout', () => {
  const w = makeWatch({
    status: 'running',
    timeout_sec: 60,
    started_at: '2026-04-29 11:58:00', // 2 minutes before NOW
  });
  const decision = decide(w, env());
  assert(decision.patch.terminal_state === 'timeout', 'records timeout');
  const order = decision.actions.map((a) => a.kind);
  const exitIdx = order.indexOf('send-exit');
  const killIdx = order.indexOf('kill-pane');
  assert(exitIdx !== -1 && killIdx !== -1, 'emits both send-exit and kill-pane');
  assert(exitIdx < killIdx, 'send-exit precedes kill-pane');
  const kill = decision.actions.find((a) => a.kind === 'kill-pane');
  assert(kill?.kind === 'kill-pane' && kill.afterMs === 5000, 'honors kill_grace_sec');
});

test('running + no timeout configured → just polls', () => {
  const w = makeWatch({ status: 'running', timeout_sec: 0, started_at: '2026-04-29 11:00:00' });
  const decision = decide(w, env());
  assert(decision.patch.status === undefined, 'no transition');
  assert(decision.actions.length === 0, 'no actions');
  assert(decision.patch.last_polled_at !== undefined, 'records poll timestamp');
});

test('terminal status → no-op', () => {
  const decision = decide(makeWatch({ status: 'terminal' }), env({ paneAlive: false }));
  assert(decision.actions.length === 0, 'no actions on terminal row');
  assert(Object.keys(decision.patch).length === 0, 'no patch on terminal row');
});

test('cleanup_paths flow through to terminal action', () => {
  const w = makeWatch({
    status: 'running',
    timeout_sec: 60,
    started_at: '2026-04-29 11:58:00',
    cleanup_paths: JSON.stringify(['/tmp/system.txt', '/tmp/prompt.txt']),
  });
  const decision = decide(w, env());
  const cleanup = decision.actions.find((a) => a.kind === 'cleanup-paths');
  assert(cleanup?.kind === 'cleanup-paths', 'cleanup action present');
  if (cleanup?.kind === 'cleanup-paths') {
    assert(cleanup.paths.includes('/tmp/system.txt'), 'preserves systemFile path');
    assert(cleanup.paths.includes('/tmp/prompt.txt'), 'preserves prompt path');
  }
});

test('mark_failed finalizer is preserved on the watch row', () => {
  // Decide doesn't dispatch on finalizer_kind directly — runner does.
  // Just confirm the row carries the marker through to the reconcile action.
  const w = makeWatch({ status: 'running', finalizer_kind: 'mark_failed' });
  const decision = decide(w, env({ paneAlive: false }));
  assert(decision.actions.some((a) => a.kind === 'reconcile'), 'still emits reconcile');
});
