#!/usr/bin/env node
/**
 * test-context.mjs — Full-spectrum test of the brain-mcp context system.
 *
 * Tests the three layers that survive context window compression:
 *   1. Context Ledger (context_push / context_get / context_summary)
 *   2. Checkpoints (checkpoint / checkpoint_restore)
 *   3. Memory (remember / recall / forget) with access tracking
 *
 * Plus integration scenarios:
 *   4. Recovery simulation — "forget everything" then restore via checkpoint
 *   5. Cross-session isolation — two agents' context doesn't bleed
 *   6. Autopilot auto-checkpoint — brain meta-tool triggers checkpoint at 12 calls
 *   7. Memory access tracking — recall bumps access_count
 *   8. Context + checkpoint interplay — checkpoint_restore returns recent context
 *
 * Run: node test-context.mjs
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';

const DB_PATH = join(tmpdir(), `brain-ctx-test-${Date.now()}.db`);
let reqId = 1;

// ── Server harness ──────────────────────────────────────────────────────────

function startServer(envOverrides = {}) {
  const proc = spawn('node', ['dist/index.js'], {
    env: { ...process.env, BRAIN_DB_PATH: DB_PATH, ...envOverrides },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  const rl = createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
      }
    } catch {}
  });

  proc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s && !s.includes('ExperimentalWarning')) console.error('  [stderr]', s);
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = reqId++;
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      pending.set(id, (resp) => {
        pending.delete(id);
        if (resp.error) reject(new Error(JSON.stringify(resp.error)));
        else resolve(resp.result);
      });
      proc.stdin.write(msg);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for response to ${method} (id=${id})`));
        }
      }, 10000);
    });
  }

  function notify(method, params = {}) {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  return { proc, send, notify };
}

async function callTool(send, name, args = {}) {
  const result = await send('tools/call', { name, arguments: args });
  const text = result.content?.[0]?.text;
  try {
    return text ? JSON.parse(text) : result;
  } catch {
    return { _raw: text };
  }
}

async function initServer(send, notify) {
  const initResult = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'context-test', version: '1.0' },
  });
  notify('notifications/initialized', {});
  await new Promise(r => setTimeout(r, 200));
  return initResult;
}

// ── Test framework ──────────────────────────────────────────────────────────

let totalPass = 0;
let totalFail = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    totalPass++;
    console.log(`  ✓ ${name}`);
  } else {
    totalFail++;
    failures.push(name);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function header(s) {
  console.log(`\n${'─'.repeat(60)}\n  ${s}\n${'─'.repeat(60)}`);
}

// ════════════════════════════════════════════════════════════════════════════
//  TEST SUITE
// ════════════════════════════════════════════════════════════════════════════

async function run() {
  console.log(`\n  brain-mcp context system test suite`);
  console.log(`  DB: ${DB_PATH}\n`);

  const { proc, send, notify } = startServer();

  try {
    await initServer(send, notify);

    // Register a session so tools work
    await callTool(send, 'register', { name: 'agent-alpha' });

    // ══════════════════════════════════════════════════════════════════════
    //  1. CONTEXT LEDGER — CRUD + FILTERING
    // ══════════════════════════════════════════════════════════════════════

    header('1. Context Ledger — push, get, filter');

    // Push various entry types
    const push1 = await callTool(send, 'context_push', {
      entry_type: 'action',
      summary: 'Added error handling to deploy route',
      detail: 'Wrapped deploy handler in try/catch, added 500 response',
      file_path: 'src/routes/deploy.ts',
      tags: JSON.stringify(['error-handling', 'deploy']),
    });
    ok('context_push returns ok + id', push1.ok === true && typeof push1.id === 'number');

    const push2 = await callTool(send, 'context_push', {
      entry_type: 'discovery',
      summary: 'Auth middleware requires session token in cookie',
      detail: 'Found via reading src/middleware/auth.ts line 42',
      file_path: 'src/middleware/auth.ts',
      tags: JSON.stringify(['auth', 'middleware']),
    });
    ok('second push returns incremented id', push2.ok && push2.id > push1.id);

    const push3 = await callTool(send, 'context_push', {
      entry_type: 'decision',
      summary: 'Using try/catch wrapper pattern for all routes',
      detail: 'Considered middleware approach but wrapper is simpler for this codebase',
    });
    ok('push without file_path works', push3.ok === true);

    const push4 = await callTool(send, 'context_push', {
      entry_type: 'error',
      summary: 'TypeScript error: Property token does not exist on type Request',
      file_path: 'src/routes/deploy.ts',
      tags: JSON.stringify(['typescript', 'deploy']),
    });
    ok('error entry stored', push4.ok === true);

    const push5 = await callTool(send, 'context_push', {
      entry_type: 'file_change',
      summary: 'Modified deploy route to add error handling',
      file_path: 'src/routes/deploy.ts',
    });
    ok('file_change entry stored', push5.ok === true);

    // Get all entries
    const getAll = await callTool(send, 'context_get', {});
    ok('context_get returns all entries', getAll.count === 5);
    ok('entries have correct structure',
      getAll.entries[0].type !== undefined &&
      getAll.entries[0].summary !== undefined &&
      getAll.entries[0].at !== undefined
    );

    // Filter by entry_type
    const getErrors = await callTool(send, 'context_get', { entry_type: 'error' });
    ok('filter by entry_type=error', getErrors.count === 1 && getErrors.entries[0].summary.includes('TypeScript'));

    const getActions = await callTool(send, 'context_get', { entry_type: 'action' });
    ok('filter by entry_type=action', getActions.count === 1);

    const getDecisions = await callTool(send, 'context_get', { entry_type: 'decision' });
    ok('filter by entry_type=decision', getDecisions.count === 1 && getDecisions.entries[0].summary.includes('try/catch'));

    // Filter by file_path
    const getByFile = await callTool(send, 'context_get', { file_path: 'src/routes/deploy.ts' });
    ok('filter by file_path returns correct entries', getByFile.count === 3); // action + error + file_change

    const getByAuthFile = await callTool(send, 'context_get', { file_path: 'src/middleware/auth.ts' });
    ok('filter by different file_path', getByAuthFile.count === 1);

    // Filter by since_id (only entries after a given ID)
    const sinceId = push3.id; // after the decision entry
    const getAfter = await callTool(send, 'context_get', { since_id: sinceId });
    ok('since_id filters older entries', getAfter.count === 2); // error + file_change

    // Limit
    const getLimited = await callTool(send, 'context_get', { limit: 2 });
    ok('limit caps results', getLimited.count === 2);

    // ══════════════════════════════════════════════════════════════════════
    //  2. CONTEXT SUMMARY — AGGREGATION
    // ══════════════════════════════════════════════════════════════════════

    header('2. Context Summary — aggregation');

    const summary = await callTool(send, 'context_summary', {});
    ok('context_summary total matches pushed count', summary.total_entries === 5);
    ok('by_type counts correct',
      summary.by_type.action === 1 &&
      summary.by_type.discovery === 1 &&
      summary.by_type.decision === 1 &&
      summary.by_type.error === 1 &&
      summary.by_type.file_change === 1
    );
    ok('files_touched lists unique files',
      summary.files_touched.length === 2 &&
      summary.files_touched.includes('src/routes/deploy.ts') &&
      summary.files_touched.includes('src/middleware/auth.ts')
    );
    ok('recent entries returned', summary.recent.length === 5);

    // ══════════════════════════════════════════════════════════════════════
    //  3. CHECKPOINTS — SAVE + RESTORE
    // ══════════════════════════════════════════════════════════════════════

    header('3. Checkpoints — save + restore');

    const cp1 = await callTool(send, 'checkpoint', {
      current_task: 'Adding error handling to all API routes',
      files_touched: JSON.stringify(['src/routes/deploy.ts', 'src/middleware/auth.ts']),
      decisions: JSON.stringify(['Using try/catch wrapper pattern', 'Keeping existing validation logic']),
      progress_summary: '2/7 routes done — deploy and auth complete',
      blockers: JSON.stringify([]),
      next_steps: JSON.stringify(['Add error handling to chat routes', 'Add error handling to instance routes']),
    });
    ok('checkpoint returns ok + id', cp1.ok === true && cp1.checkpoint_id);

    // Push more context after the checkpoint
    await callTool(send, 'context_push', {
      entry_type: 'action',
      summary: 'Added error handling to chat route',
      file_path: 'src/routes/chat.ts',
    });

    // Wait 1.1s so SQLite's datetime('now') gives a different second
    await new Promise(r => setTimeout(r, 1100));

    // Save a second checkpoint (should be newer)
    const cp2 = await callTool(send, 'checkpoint', {
      current_task: 'Adding error handling to all API routes',
      files_touched: JSON.stringify(['src/routes/deploy.ts', 'src/middleware/auth.ts', 'src/routes/chat.ts']),
      decisions: JSON.stringify(['Using try/catch wrapper pattern', 'Keeping existing validation logic']),
      progress_summary: '3/7 routes done — deploy, auth, chat complete',
      blockers: JSON.stringify([]),
      next_steps: JSON.stringify(['Add error handling to instance routes', 'Add error handling to user routes']),
    });
    ok('second checkpoint saved', cp2.ok === true && cp2.checkpoint_id !== cp1.checkpoint_id);

    // Restore — should get the LATEST checkpoint
    const restored = await callTool(send, 'checkpoint_restore', {});
    ok('checkpoint_restore finds checkpoint', restored.found === true);
    ok('restores latest checkpoint', restored.state.progress_summary.includes('3/7'));
    ok('state has current_task', restored.state.current_task === 'Adding error handling to all API routes');
    ok('state has files_touched', restored.state.files_touched.length === 3);
    ok('state has decisions', restored.state.decisions.length === 2);
    ok('state has next_steps', restored.state.next_steps.length === 2);
    ok('recent_activity returned as an array', Array.isArray(restored.recent_activity));

    // ══════════════════════════════════════════════════════════════════════
    //  4. RECOVERY SIMULATION — "forget everything" then restore
    // ══════════════════════════════════════════════════════════════════════

    header('4. Recovery Simulation — new connection restores state');

    // Kill the first server — simulates context loss / new session
    proc.kill();
    await new Promise(r => setTimeout(r, 500));

    // Start a FRESH server against the SAME database
    const srv2 = startServer();
    await initServer(srv2.send, srv2.notify);

    // Register as a NEW agent — simulating a fresh session after compression
    await callTool(srv2.send, 'register', { name: 'agent-alpha-revived' });

    // Agent "wakes up" confused. Uses checkpoint_restore to recover.
    const recovery = await callTool(srv2.send, 'checkpoint_restore', {});
    ok('recovery: finds checkpoint from previous session', recovery.found === true);
    ok('recovery: state intact', recovery.state.progress_summary.includes('3/7'));
    ok('recovery: files_touched preserved', recovery.state.files_touched.length === 3);
    ok('recovery: decisions preserved', recovery.state.decisions.includes('Using try/catch wrapper pattern'));
    ok('recovery: next_steps preserved', recovery.state.next_steps.includes('Add error handling to instance routes'));

    // Recovered agent reads the full context ledger to catch up
    const fullContext = await callTool(srv2.send, 'context_get', { limit: 50 });
    ok('recovery: full context ledger survives restart',
      fullContext.count >= 5, `got ${fullContext.count}, expected >= 5`);

    // Check that context_summary still works
    const recoverySummary = await callTool(srv2.send, 'context_summary', {});
    ok('recovery: context_summary survives restart',
      recoverySummary.total_entries >= 5);
    ok('recovery: files_touched survives restart',
      recoverySummary.files_touched.includes('src/routes/deploy.ts'));

    // Recovered agent checks for errors from previous session
    const previousErrors = await callTool(srv2.send, 'context_get', { entry_type: 'error' });
    ok('recovery: can retrieve errors from dead session',
      previousErrors.count >= 1 && previousErrors.entries[0].summary.includes('TypeScript'));

    // Recovered agent checks decisions to avoid re-deciding
    const previousDecisions = await callTool(srv2.send, 'context_get', { entry_type: 'decision' });
    ok('recovery: can retrieve decisions from dead session',
      previousDecisions.count >= 1 && previousDecisions.entries[0].summary.includes('try/catch'));

    // Recovered agent can CONTINUE pushing context
    const pushAfterRecovery = await callTool(srv2.send, 'context_push', {
      entry_type: 'action',
      summary: 'Resumed work after context recovery',
    });
    ok('recovery: can push new context entries', pushAfterRecovery.ok === true);

    // Verify new entries show in summary
    const postRecoverySummary = await callTool(srv2.send, 'context_summary', {});
    ok('recovery: new entries counted in summary',
      postRecoverySummary.total_entries > recoverySummary.total_entries);

    // ══════════════════════════════════════════════════════════════════════
    //  5. CROSS-SESSION ISOLATION
    // ══════════════════════════════════════════════════════════════════════

    header('5. Cross-Session Isolation');

    // Kill srv2 and start two servers with different rooms
    srv2.proc.kill();
    await new Promise(r => setTimeout(r, 500));

    const srvA = startServer({ BRAIN_ROOM: '/project-a' });
    const srvB = startServer({ BRAIN_ROOM: '/project-b' });
    await initServer(srvA.send, srvA.notify);
    await initServer(srvB.send, srvB.notify);

    await callTool(srvA.send, 'register', { name: 'agent-a' });
    await callTool(srvB.send, 'register', { name: 'agent-b' });

    // Push context to project-a
    await callTool(srvA.send, 'context_push', {
      entry_type: 'discovery',
      summary: 'Project A uses PostgreSQL',
      file_path: 'src/db.ts',
    });

    // Push context to project-b
    await callTool(srvB.send, 'context_push', {
      entry_type: 'discovery',
      summary: 'Project B uses MongoDB',
      file_path: 'src/db.ts',
    });

    // Verify isolation
    const ctxA = await callTool(srvA.send, 'context_get', {});
    const ctxB = await callTool(srvB.send, 'context_get', {});
    ok('room isolation: project-a only sees its own entries',
      ctxA.count === 1 && ctxA.entries[0].summary.includes('PostgreSQL'));
    ok('room isolation: project-b only sees its own entries',
      ctxB.count === 1 && ctxB.entries[0].summary.includes('MongoDB'));

    // Checkpoint isolation
    await callTool(srvA.send, 'checkpoint', {
      current_task: 'Building PostgreSQL adapter',
      files_touched: JSON.stringify(['src/db.ts']),
      decisions: JSON.stringify(['Using pg library']),
      progress_summary: 'PostgreSQL adapter 50% done',
      next_steps: JSON.stringify(['Add connection pooling']),
    });

    const restoreA = await callTool(srvA.send, 'checkpoint_restore', {});
    const restoreB = await callTool(srvB.send, 'checkpoint_restore', {});
    ok('checkpoint isolation: project-a restores its own checkpoint',
      restoreA.found === true && restoreA.state.current_task.includes('PostgreSQL'));
    ok('checkpoint isolation: project-b has no checkpoint',
      restoreB.found === false);

    // Memory isolation
    await callTool(srvA.send, 'remember', {
      key: 'db-config',
      content: 'PostgreSQL on port 5432',
      category: 'config',
    });
    await callTool(srvB.send, 'remember', {
      key: 'db-config',
      content: 'MongoDB on port 27017',
      category: 'config',
    });

    const recallA = await callTool(srvA.send, 'recall', { query: 'db-config' });
    const recallB = await callTool(srvB.send, 'recall', { query: 'db-config' });
    ok('memory isolation: project-a recalls PostgreSQL',
      recallA.count === 1 && recallA.memories[0].content.includes('PostgreSQL'));
    ok('memory isolation: project-b recalls MongoDB',
      recallB.count === 1 && recallB.memories[0].content.includes('MongoDB'));

    srvA.proc.kill();
    srvB.proc.kill();
    await new Promise(r => setTimeout(r, 500));

    // ══════════════════════════════════════════════════════════════════════
    //  6. AUTOPILOT AUTO-CHECKPOINT
    // ══════════════════════════════════════════════════════════════════════

    header('6. Autopilot — auto-checkpoint triggers after 12 tool calls');

    const srvAuto = startServer({ BRAIN_ROOM: '/auto-test' });
    await initServer(srvAuto.send, srvAuto.notify);
    await callTool(srvAuto.send, 'register', { name: 'agent-auto' });

    // Verify no checkpoint exists yet
    const preCheck = await callTool(srvAuto.send, 'checkpoint_restore', {});
    ok('no checkpoint before autopilot work', preCheck.found === false);

    // Make 13 calls via the brain meta-tool (threshold is 12)
    for (let i = 1; i <= 13; i++) {
      await callTool(srvAuto.send, 'brain', {
        action: 'set',
        key: `auto-k${i}`,
        value: `val${i}`,
      });
    }

    // Autopilot should have saved a checkpoint at call 12
    const autoCheck = await callTool(srvAuto.send, 'checkpoint_restore', {});
    ok('autopilot auto-checkpoint exists after 12 brain calls', autoCheck.found === true);
    ok('auto-checkpoint has progress info', autoCheck.state?.progress_summary?.includes('12'));

    srvAuto.proc.kill();
    await new Promise(r => setTimeout(r, 500));

    // ══════════════════════════════════════════════════════════════════════
    //  7. MEMORY ACCESS TRACKING
    // ══════════════════════════════════════════════════════════════════════

    header('7. Memory — access_count tracking');

    const srvMem = startServer({ BRAIN_ROOM: '/mem-test' });
    await initServer(srvMem.send, srvMem.notify);
    await callTool(srvMem.send, 'register', { name: 'agent-mem' });

    // Store memories
    await callTool(srvMem.send, 'remember', {
      key: 'hot-memory',
      content: 'This is frequently accessed knowledge',
      category: 'pattern',
    });
    await callTool(srvMem.send, 'remember', {
      key: 'cold-memory',
      content: 'This is rarely accessed knowledge',
      category: 'pattern',
    });

    // Recall hot-memory 5 times
    for (let i = 0; i < 5; i++) {
      await callTool(srvMem.send, 'recall', { query: 'frequently accessed' });
    }

    // Recall all — hot-memory should be first (higher access_count)
    const allMem = await callTool(srvMem.send, 'recall', {});
    ok('frequently recalled memory ranked first',
      allMem.memories.length === 2 && allMem.memories[0].key === 'hot-memory');

    // Verify categories are returned
    ok('recall returns categories', allMem.categories?.length >= 1);

    // Forget and verify
    await callTool(srvMem.send, 'forget', { key: 'hot-memory' });
    const afterForget = await callTool(srvMem.send, 'recall', {});
    ok('forget removes memory', afterForget.count === 1 && afterForget.memories[0].key === 'cold-memory');

    srvMem.proc.kill();
    await new Promise(r => setTimeout(r, 500));

    // ══════════════════════════════════════════════════════════════════════
    //  8. CONTEXT + CHECKPOINT INTERPLAY
    // ══════════════════════════════════════════════════════════════════════

    header('8. Context + Checkpoint interplay');

    const srvInter = startServer({ BRAIN_ROOM: '/interplay-test' });
    await initServer(srvInter.send, srvInter.notify);
    await callTool(srvInter.send, 'register', { name: 'agent-interplay' });

    // Push 5 context entries
    for (let i = 1; i <= 5; i++) {
      await callTool(srvInter.send, 'context_push', {
        entry_type: 'action',
        summary: `Step ${i} of work`,
        file_path: `src/step${i}.ts`,
      });
    }

    // Save checkpoint
    await callTool(srvInter.send, 'checkpoint', {
      current_task: 'Multi-step task',
      files_touched: JSON.stringify(['src/step1.ts', 'src/step2.ts', 'src/step3.ts', 'src/step4.ts', 'src/step5.ts']),
      decisions: JSON.stringify(['Incremental approach']),
      progress_summary: '5 steps complete',
      next_steps: JSON.stringify(['Step 6', 'Step 7']),
    });

    // Push 3 more entries AFTER the checkpoint
    for (let i = 6; i <= 8; i++) {
      await callTool(srvInter.send, 'context_push', {
        entry_type: 'action',
        summary: `Step ${i} of work`,
        file_path: `src/step${i}.ts`,
      });
    }

    // Another agent adds room-level context after the checkpoint.
    const srvInter2 = startServer({ BRAIN_ROOM: '/interplay-test' });
    await initServer(srvInter2.send, srvInter2.notify);
    await callTool(srvInter2.send, 'register', { name: 'agent-collab' });
    await callTool(srvInter2.send, 'context_push', {
      entry_type: 'discovery',
      summary: 'Collaborator found a shared contract mismatch',
      file_path: 'src/shared/contracts.ts',
    });

    // checkpoint also pushes a 'checkpoint' type entry to the ledger
    const summaryInter = await callTool(srvInter.send, 'context_summary', {});
    ok('checkpoint creates ledger entry too (type=checkpoint)',
      summaryInter.by_type.checkpoint >= 1);
    ok('total entries = 5 pre + 1 checkpoint + 3 post + 1 collaborator = 10',
      summaryInter.total_entries === 10);

    // Restore — should include recent activity (entries since checkpoint)
    const restoreInter = await callTool(srvInter.send, 'checkpoint_restore', {});
    ok('checkpoint_restore includes recent_activity', restoreInter.recent_activity.length > 0);

    // The recent_activity should include entries from AFTER the checkpoint
    const recentSummaries = restoreInter.recent_activity.map(e => e.summary);
    ok('recent_activity includes post-checkpoint entries',
      recentSummaries.some(s => s.includes('Step 8')) ||
      recentSummaries.some(s => s.includes('Step 7')) ||
      recentSummaries.some(s => s.includes('Step 6'))
    );
    ok('recent_activity excludes pre-checkpoint entries',
      !recentSummaries.some(s => s.includes('Step 1 of work')));
    ok('recent_activity includes collaborator updates in the same room',
      recentSummaries.some(s => s.includes('shared contract mismatch')));

    srvInter2.proc.kill();
    await new Promise(r => setTimeout(r, 500));

    srvInter.proc.kill();
    await new Promise(r => setTimeout(r, 500));

    // ══════════════════════════════════════════════════════════════════════
    //  9. STRESS TEST — high-volume context under load
    // ══════════════════════════════════════════════════════════════════════

    header('9. Stress — 100 context entries + summary + restore');

    const srvStress = startServer({ BRAIN_ROOM: '/stress-test' });
    await initServer(srvStress.send, srvStress.notify);
    await callTool(srvStress.send, 'register', { name: 'agent-stress' });

    const entryTypes = ['action', 'discovery', 'decision', 'error', 'file_change'];
    const startTime = Date.now();

    // Push 100 entries
    for (let i = 0; i < 100; i++) {
      await callTool(srvStress.send, 'context_push', {
        entry_type: entryTypes[i % entryTypes.length],
        summary: `Stress entry ${i}: ${entryTypes[i % entryTypes.length]}`,
        file_path: `src/module${i % 10}.ts`,
        tags: JSON.stringify([`batch-${Math.floor(i / 10)}`]),
      });
    }

    const pushDuration = Date.now() - startTime;
    ok(`100 entries pushed in ${pushDuration}ms`, pushDuration < 30000);

    // Summary should aggregate all 100
    const stressSummary = await callTool(srvStress.send, 'context_summary', {});
    ok('stress: summary counts 100 entries', stressSummary.total_entries === 100);
    ok('stress: 20 actions counted', stressSummary.by_type.action === 20);
    ok('stress: 20 discoveries counted', stressSummary.by_type.discovery === 20);
    ok('stress: 10 unique files tracked', stressSummary.files_touched.length === 10);

    // Checkpoint mid-stress
    await callTool(srvStress.send, 'checkpoint', {
      current_task: 'Stress test',
      files_touched: JSON.stringify(stressSummary.files_touched),
      decisions: JSON.stringify(['Pushed 100 entries']),
      progress_summary: '100 entries processed',
      next_steps: JSON.stringify(['Verify recovery']),
    });

    // Kill and recover
    srvStress.proc.kill();
    await new Promise(r => setTimeout(r, 500));

    const srvStress2 = startServer({ BRAIN_ROOM: '/stress-test' });
    await initServer(srvStress2.send, srvStress2.notify);
    await callTool(srvStress2.send, 'register', { name: 'agent-stress-revived' });

    const stressRestore = await callTool(srvStress2.send, 'checkpoint_restore', {});
    ok('stress recovery: checkpoint found after restart', stressRestore.found === true);
    ok('stress recovery: state intact', stressRestore.state.progress_summary === '100 entries processed');

    const stressSummary2 = await callTool(srvStress2.send, 'context_summary', {});
    ok('stress recovery: all 100 entries + checkpoint entry survive restart',
      stressSummary2.total_entries === 101); // 100 + 1 checkpoint entry

    // Filter by file on high-volume data
    const byFile = await callTool(srvStress2.send, 'context_get', {
      file_path: 'src/module0.ts',
      limit: 50,
    });
    ok('stress: file filter works on 100 entries', byFile.count === 10);

    srvStress2.proc.kill();
    await new Promise(r => setTimeout(r, 500));

    // ══════════════════════════════════════════════════════════════════════
    //  10. MEMORY + CONTEXT COMBINED RECOVERY
    // ══════════════════════════════════════════════════════════════════════

    header('10. Combined recovery — checkpoint + context + memory all survive');

    const srvCombo = startServer({ BRAIN_ROOM: '/combo-test' });
    await initServer(srvCombo.send, srvCombo.notify);
    await callTool(srvCombo.send, 'register', { name: 'agent-combo' });

    // Store memories
    await callTool(srvCombo.send, 'remember', {
      key: 'api-pattern',
      content: 'All endpoints use /api/v2 prefix with rate limiting',
      category: 'architecture',
    });
    await callTool(srvCombo.send, 'remember', {
      key: 'deploy-gotcha',
      content: 'Must run migrations before deploying — deploy script does NOT auto-migrate',
      category: 'gotcha',
    });

    // Push context
    await callTool(srvCombo.send, 'context_push', {
      entry_type: 'action',
      summary: 'Refactored /api/v2/users endpoint',
      file_path: 'src/routes/users.ts',
    });
    await callTool(srvCombo.send, 'context_push', {
      entry_type: 'error',
      summary: 'Migration failed — missing column user.avatar_url',
      file_path: 'migrations/003.sql',
    });

    // Save checkpoint
    await callTool(srvCombo.send, 'checkpoint', {
      current_task: 'Refactoring user API',
      files_touched: JSON.stringify(['src/routes/users.ts', 'migrations/003.sql']),
      decisions: JSON.stringify(['Keep backwards compat for /api/v1']),
      progress_summary: 'Users endpoint refactored, migration needs fixing',
      blockers: JSON.stringify(['Migration 003 adds avatar_url but column already exists in some envs']),
      next_steps: JSON.stringify(['Fix migration to be idempotent', 'Test in staging']),
    });

    // Kill — full "amnesia"
    srvCombo.proc.kill();
    await new Promise(r => setTimeout(r, 500));

    // Revive — brand new session, same DB
    const srvCombo2 = startServer({ BRAIN_ROOM: '/combo-test' });
    await initServer(srvCombo2.send, srvCombo2.notify);
    await callTool(srvCombo2.send, 'register', { name: 'agent-combo-revived' });

    // Full recovery protocol: checkpoint → context → memory
    const comboRestore = await callTool(srvCombo2.send, 'checkpoint_restore', {});
    ok('combo: checkpoint restored', comboRestore.found === true);
    ok('combo: knows about blocker',
      comboRestore.state.blockers.some(b => b.includes('avatar_url')));
    ok('combo: knows next steps',
      comboRestore.state.next_steps.includes('Fix migration to be idempotent'));

    const comboErrors = await callTool(srvCombo2.send, 'context_get', { entry_type: 'error' });
    ok('combo: error context survives', comboErrors.count === 1 &&
      comboErrors.entries[0].summary.includes('Migration failed'));

    const comboMemory = await callTool(srvCombo2.send, 'recall', { category: 'gotcha' });
    ok('combo: gotcha memory survives',
      comboMemory.count === 1 && comboMemory.memories[0].content.includes('auto-migrate'));

    const archMemory = await callTool(srvCombo2.send, 'recall', { category: 'architecture' });
    ok('combo: architecture memory survives',
      archMemory.count === 1 && archMemory.memories[0].content.includes('/api/v2'));

    srvCombo2.proc.kill();
    await new Promise(r => setTimeout(r, 500));

    // ══════════════════════════════════════════════════════════════════════
    //  11. COMPACT MODE — TOKEN SAVINGS
    // ══════════════════════════════════════════════════════════════════════

    header('11. Compact Mode — token savings measurement');

    // Start two servers: one normal, one compact
    const srvNorm = startServer({ BRAIN_ROOM: '/norm-test' });
    const srvComp = startServer({ BRAIN_ROOM: '/comp-test', BRAIN_COMPACT: '1' });
    await initServer(srvNorm.send, srvNorm.notify);
    await initServer(srvComp.send, srvComp.notify);
    await callTool(srvNorm.send, 'register', { name: 'agent-norm' });
    await callTool(srvComp.send, 'register', { name: 'agent-comp' });

    // Helper to measure raw response size
    async function rawCall(send, name, args = {}) {
      const result = await send('tools/call', { name, arguments: args });
      return result.content?.[0]?.text || '';
    }

    // Measure write ops
    let normBytes = 0;
    let compBytes = 0;

    // context_push
    let r1 = await rawCall(srvNorm.send, 'context_push', {
      entry_type: 'action', summary: 'Test action for measurement',
      detail: 'Detailed description of the action', file_path: 'src/test.ts',
    });
    let r2 = await rawCall(srvComp.send, 'context_push', {
      entry_type: 'action', summary: 'Test action for measurement',
      detail: 'Detailed description of the action', file_path: 'src/test.ts',
    });
    normBytes += r1.length;
    compBytes += r2.length;

    // checkpoint
    r1 = await rawCall(srvNorm.send, 'checkpoint', {
      current_task: 'Building user authentication system',
      files_touched: JSON.stringify(['src/auth.ts', 'src/middleware.ts', 'src/routes/login.ts']),
      decisions: JSON.stringify(['Using JWT', 'httpOnly cookies', 'refresh token rotation']),
      progress_summary: '3/5 auth routes complete',
      next_steps: JSON.stringify(['Add rate limiting', 'Add CSRF protection']),
    });
    r2 = await rawCall(srvComp.send, 'checkpoint', {
      current_task: 'Building user authentication system',
      files_touched: JSON.stringify(['src/auth.ts', 'src/middleware.ts', 'src/routes/login.ts']),
      decisions: JSON.stringify(['Using JWT', 'httpOnly cookies', 'refresh token rotation']),
      progress_summary: '3/5 auth routes complete',
      next_steps: JSON.stringify(['Add rate limiting', 'Add CSRF protection']),
    });
    normBytes += r1.length;
    compBytes += r2.length;

    // remember
    r1 = await rawCall(srvNorm.send, 'remember', {
      key: 'auth-pattern', content: 'JWT with refresh tokens in httpOnly cookies',
      category: 'architecture',
    });
    r2 = await rawCall(srvComp.send, 'remember', {
      key: 'auth-pattern', content: 'JWT with refresh tokens in httpOnly cookies',
      category: 'architecture',
    });
    normBytes += r1.length;
    compBytes += r2.length;

    // set
    r1 = await rawCall(srvNorm.send, 'set', { key: 'shared-context', value: 'some shared data' });
    r2 = await rawCall(srvComp.send, 'set', { key: 'shared-context', value: 'some shared data' });
    normBytes += r1.length;
    compBytes += r2.length;

    // pulse
    r1 = await rawCall(srvNorm.send, 'pulse', { status: 'working', progress: 'editing auth.ts' });
    r2 = await rawCall(srvComp.send, 'pulse', { status: 'working', progress: 'editing auth.ts' });
    normBytes += r1.length;
    compBytes += r2.length;

    // post
    r1 = await rawCall(srvNorm.send, 'post', { content: 'Auth module complete' });
    r2 = await rawCall(srvComp.send, 'post', { content: 'Auth module complete' });
    normBytes += r1.length;
    compBytes += r2.length;

    // Now measure read ops
    // recall
    r1 = await rawCall(srvNorm.send, 'recall', {});
    r2 = await rawCall(srvComp.send, 'recall', {});
    normBytes += r1.length;
    compBytes += r2.length;

    // context_get
    r1 = await rawCall(srvNorm.send, 'context_get', {});
    r2 = await rawCall(srvComp.send, 'context_get', {});
    normBytes += r1.length;
    compBytes += r2.length;

    // context_summary
    r1 = await rawCall(srvNorm.send, 'context_summary', {});
    r2 = await rawCall(srvComp.send, 'context_summary', {});
    normBytes += r1.length;
    compBytes += r2.length;

    // checkpoint_restore
    r1 = await rawCall(srvNorm.send, 'checkpoint_restore', {});
    r2 = await rawCall(srvComp.send, 'checkpoint_restore', {});
    normBytes += r1.length;
    compBytes += r2.length;

    // get
    r1 = await rawCall(srvNorm.send, 'get', { key: 'shared-context' });
    r2 = await rawCall(srvComp.send, 'get', { key: 'shared-context' });
    normBytes += r1.length;
    compBytes += r2.length;

    const savings = Math.round((1 - compBytes / normBytes) * 100);
    console.log(`\n  Normal mode: ${normBytes} bytes across 11 tool calls`);
    console.log(`  Compact mode: ${compBytes} bytes across 11 tool calls`);
    console.log(`  Savings: ${savings}% fewer bytes (≈ tokens)\n`);

    ok('compact mode reduces response size', compBytes < normBytes);
    ok(`savings >= 25% (got ${savings}%)`, savings >= 25);

    // Verify compact responses still contain essential data
    const compRestore = JSON.parse(await rawCall(srvComp.send, 'checkpoint_restore', {}));
    ok('compact checkpoint_restore still has state', compRestore.found === true && compRestore.state);
    ok('compact checkpoint_restore still has recent activity', Array.isArray(compRestore.recent));

    const compRecall = JSON.parse(await rawCall(srvComp.send, 'recall', {}));
    ok('compact recall still has memories', compRecall.count >= 1 && compRecall.memories.length >= 1);
    ok('compact recall memories have key+content', compRecall.memories[0].key && compRecall.memories[0].content);

    const compCtx = JSON.parse(await rawCall(srvComp.send, 'context_get', {}));
    ok('compact context_get still has entries', compCtx.count >= 1 && compCtx.entries.length >= 1);
    ok('compact context_get entries have summary', compCtx.entries[0].s !== undefined); // compact uses 's' for summary

    // Test runtime toggle
    const srvToggle = startServer({ BRAIN_ROOM: '/toggle-test' });
    await initServer(srvToggle.send, srvToggle.notify);
    await callTool(srvToggle.send, 'register', { name: 'agent-toggle' });

    // Default: not compact
    await callTool(srvToggle.send, 'context_push', {
      entry_type: 'action', summary: 'Before compact',
    });
    const beforeCompact = await rawCall(srvToggle.send, 'context_get', {});

    // Toggle compact on
    const toggle = await callTool(srvToggle.send, 'compact', { enabled: true });
    ok('compact toggle works', toggle.c === 1 || toggle.compact === true);

    // Same query, now compact
    const afterCompact = await rawCall(srvToggle.send, 'context_get', {});
    ok('runtime compact toggle shrinks responses', afterCompact.length < beforeCompact.length);

    // Toggle back off
    await callTool(srvToggle.send, 'compact', { enabled: false });
    const afterOff = await rawCall(srvToggle.send, 'context_get', {});
    ok('compact toggle off restores verbose', afterOff.length >= beforeCompact.length);

    srvNorm.proc.kill();
    srvComp.proc.kill();
    srvToggle.proc.kill();

  } catch (err) {
    console.error('\n  FATAL:', err.message);
    console.error(err.stack);
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${totalPass} passed, ${totalFail} failed out of ${totalPass + totalFail} tests`);
  if (failures.length > 0) {
    console.log(`\n  Failed:`);
    for (const f of failures) console.log(`    ✗ ${f}`);
  } else {
    console.log(`\n  All tests passed!`);
  }
  console.log(`${'═'.repeat(60)}\n`);

  // Cleanup
  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(DB_PATH + '-wal'); } catch {}
  try { unlinkSync(DB_PATH + '-shm'); } catch {}

  process.exit(totalFail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
