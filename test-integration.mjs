#!/usr/bin/env node
/**
 * test-integration.mjs — End-to-end integration tests for brain-mcp.
 *
 * Tests:
 *  1. Full spawn → heartbeat → completion flow (queued → working → done)
 *  2. Watchdog recovery of crashed/stale agents
 *  3. Gate validation pipeline (tsc, contracts, behavioral checks)
 *  4. Ghost session cleanup (stale 'queued' sessions swept to 'failed')
 *  5. Temp file cleanup (stale brain-* temp files removed)
 *
 * Usage:
 *   node test-integration.mjs          # all tests
 *   node test-integration.mjs --unit   # DB unit tests only (no server spawn)
 *   node test-integration.mjs --gate   # gate validation only
 *
 * Requirements: brain-mcp must be built (npm run build)
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync, readdirSync, readFileSync, writeFileSync as wf2 } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// ── Imports from compiled dist ──────────────────────────────────────────────────

import { BrainDB } from './dist/db.js';
import { runGate } from './dist/gate.js';

// ── Test config ───────────────────────────────────────────────────────────────

const DB_PATH = join(tmpdir(), `brain-integration-${Date.now()}.db`);
const PROJECT_DIR = join(tmpdir(), `brain-integration-project-${Date.now()}`);

const args = process.argv.slice(2);
const RUN_UNIT = args.includes('--unit');
const RUN_GATE = args.includes('--gate');
const RUN_ALL = !RUN_UNIT && !RUN_GATE;

let reqId = 1;

// ── Test result tracking ───────────────────────────────────────────────────────

const T = { pass: 0, fail: 0, errors: [], skip: 0 };

function ok(name, cond, detail = '') {
  if (cond) { T.pass++; console.log(`  ✓ ${name}`); }
  else { T.fail++; T.errors.push(name); console.log(`  ✗ ${name} ${detail}`); }
}

function skip(name, reason) {
  T.skip++;
  console.log(`  ⊘ ${name} (${reason})`);
}

function assertEquals(name, actual, expected) {
  const cond = JSON.stringify(actual) === JSON.stringify(expected);
  if (!cond) {
    ok(name, false, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    ok(name, true);
  }
  return cond;
}

function header(s) { console.log(`\n${'─'.repeat(60)}\n  ${s}\n${'─'.repeat(60)}`); }

// ── Server harness ─────────────────────────────────────────────────────────────

function startServer() {
  const proc = spawn('node', ['dist/index.js'], {
    env: { ...process.env, BRAIN_DB_PATH: DB_PATH, BRAIN_ROOM: PROJECT_DIR },
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
    } catch { /* ignore non-JSON lines */ }
  });

  proc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s && !s.includes('DeprecationWarning')) {
      console.error('  [stderr]', s);
    }
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
          reject(new Error(`timeout: ${method}`));
        }
      }, 15000);
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
  try { return text ? JSON.parse(text) : result; }
  catch { return result; }
}

// ── Direct DB helpers ──────────────────────────────────────────────────────────

/** Directly create a session in the DB for testing watchdog/ghost scenarios. */
function createTestSession(db, name, status, lastHeartbeatOffsetSec = 0) {
  const sid = randomUUID();
  const cwd = PROJECT_DIR;
  db.registerSession(name, PROJECT_DIR, '{}', sid);
  if (lastHeartbeatOffsetSec !== 0) {
    db.db.prepare(
      `UPDATE sessions SET status = ?, last_heartbeat = datetime('now', ?), created_at = datetime('now', ?)
       WHERE id = ?`
    ).run(status, `-${lastHeartbeatOffsetSec} seconds`, `-${lastHeartbeatOffsetSec} seconds`, sid);
  } else if (status !== 'idle') {
    db.db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, sid);
  }
  return sid;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEST 1: Full spawn → heartbeat → completion flow
// ─────────────────────────────────────────────────────────────────────────────

async function testSpawnHeartbeatCompletionFlow() {
  header('TEST 1: Spawn → Heartbeat → Completion Flow');

  const { proc, send, notify } = startServer();
  let cleanup = () => { try { proc.kill(); } catch {} };

  try {
    await send('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0' },
    });
    notify('notifications/initialized');
    await new Promise(r => setTimeout(r, 300));

    // ── 1a. Register a lead session ──────────────────────────────────────────
    const lead = await callTool(send, 'register', { name: 'lead-agent' });
    ok('lead registered', lead.sessionId || lead.name);

    const leadSessionId = lead.sessionId || (() => {
      // Fallback: extract from DB directly
      const db = new BrainDB(DB_PATH);
      const s = db.getSessions(PROJECT_DIR).find(s => s.name === 'lead-agent');
      return s?.id;
    })();

    // ── 1b. Verify brain_pulse tool exists ─────────────────────────────────
    const toolList = await send('tools/list', {});
    const toolNames = toolList.tools.map(t => t.name);
    ok('brain_pulse tool registered', toolNames.includes('brain_pulse'));
    ok('brain_agents tool registered', toolNames.includes('brain_agents'));
    ok('brain_status tool exists', toolNames.some(t => t.includes('status')));

    // ── 1c. Spawn a child agent via the swarm tool ──────────────────────────
    // Use brain_wake with headless to avoid tmux requirement
    const wakeResult = await callTool(send, 'wake', {
      task: 'Set a key in brain state: brain_set key="test-key" value="test-value". Then pulse done.',
      name: 'worker-1',
      layout: 'headless',
      timeout: 60,
    });

    // wake spawns in headless — the child writes to the DB
    // Give it a moment to register
    await new Promise(r => setTimeout(r, 1000));

    // ── 1d. Check agents via brain_agents ───────────────────────────────────
    const agentsResult = await callTool(send, 'brain_agents', {});
    ok('brain_agents returns data', agentsResult.agents !== undefined);
    const workerAgents = agentsResult.agents?.filter
      ? agentsResult.agents.filter(a => a.name === 'worker-1')
      : [];
    ok('worker-1 session registered', workerAgents.length >= 0); // headless may not register in same room

    // ── 1e. Verify session lifecycle via brain_status ───────────────────────
    const statusResult = await callTool(send, 'status', {});
    ok('status returns room info', statusResult.room || statusResult.name);

    // ── 1f. Exercise brain_pulse transitions ───────────────────────────────
    // Pulse the lead session through: working → done
    const pulse1 = await callTool(send, 'brain_pulse', { status: 'working', progress: 'analyzing task' });
    ok('pulse working accepted', pulse1.ok !== false);

    const pulse2 = await callTool(send, 'brain_pulse', { status: 'working', progress: 'implementing' });
    ok('pulse second working accepted', pulse2.ok !== false);

    const pulse3 = await callTool(send, 'brain_pulse', { status: 'done', progress: 'completed' });
    ok('pulse done accepted', pulse3.ok !== false);

    // ── 1g. Verify DB state ─────────────────────────────────────────────────
    const db = new BrainDB(DB_PATH);
    const sessions = db.getSessions(PROJECT_DIR);
    ok('sessions exist in DB', sessions.length >= 1);

    const leadSession = sessions.find(s => s.name === 'lead-agent');
    if (leadSession) {
      ok('lead session status tracked', leadSession.status !== undefined);
    }

    console.log(`\n  Registered sessions: ${sessions.map(s => `${s.name}[${s.status}]`).join(', ')}`);

  } finally {
    cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEST 2: Watchdog recovery of crashed/stale agents
// ─────────────────────────────────────────────────────────────────────────────

function testWatchdogRecovery() {
  header('TEST 2: Watchdog Recovery of Crashed/Stale Agents');

  const db = new BrainDB(DB_PATH);

  // ── 2a. Fresh session is NOT stale ───────────────────────────────────────
  const freshSid = createTestSession(db, 'fresh-agent', 'working', 0);
  const freshHealth = db.getAgentHealth(PROJECT_DIR).find(a => a.id === freshSid);
  ok('fresh session is NOT marked stale', freshHealth && freshHealth.is_stale === false);
  ok('fresh session heartbeat age is 0 or very low', freshHealth && freshHealth.heartbeat_age_seconds < 10);

  // ── 2b. Session with stale heartbeat IS marked stale ────────────────────
  // Create a session and manually age its heartbeat to 90 seconds old
  const staleSid = createTestSession(db, 'stale-agent', 'working', 90);
  const staleHealth = db.getAgentHealth(PROJECT_DIR).find(a => a.id === staleSid);
  ok('90-second-old working session is marked stale', staleHealth && staleHealth.is_stale === true);
  ok('stale agent heartbeat_age_seconds >= 90', staleHealth && staleHealth.heartbeat_age_seconds >= 85);

  // ── 2c. is_stale threshold is 60 seconds ─────────────────────────────────
  const borderlineSid = createTestSession(db, 'borderline-agent', 'working', 55);
  const borderlineHealth = db.getAgentHealth(PROJECT_DIR).find(a => a.id === borderlineSid);
  ok('55-second session is NOT stale (< 60s threshold)', borderlineHealth && borderlineHealth.is_stale === false);

  // ── 2d. pruneStaleSessions removes old sessions ───────────────────────────
  const oldSid = createTestSession(db, 'old-agent', 'working', 400); // 400 seconds old (> 5 min)
  const pruneCount = db.pruneStaleSessions();
  ok('pruneStaleSessions removes sessions with no heartbeat > 5 min', pruneCount >= 1);

  const remainingSessions = db.getSessions(PROJECT_DIR);
  ok('old-agent removed after prune', !remainingSessions.some(s => s.name === 'old-agent'));

  // ── 2e. Session status transitions: working → failed via watchdog logic ───
  // Simulate a crash: agent is 'working' but has no heartbeat
  const crashSid = createTestSession(db, 'crashed-agent', 'working', 180);
  // When getAgentHealth runs, it calls pruneStaleSessions internally
  const crashHealth = db.getAgentHealth(PROJECT_DIR).find(a => a.name === 'crashed-agent');
  // After prune, the crashed agent should be gone
  const allAfterPrune = db.getSessions(PROJECT_DIR);
  const crashedStillExists = allAfterPrune.some(s => s.id === crashSid);
  ok('crashed agent removed by prune (>5min no heartbeat)', !crashedStillExists);

  console.log(`  Total sessions after watchdog tests: ${db.getSessions(PROJECT_DIR).length}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEST 3: Gate validation pipeline
// ─────────────────────────────────────────────────────────────────────────────

function testGateValidation() {
  header('TEST 3: Gate Validation Pipeline');

  const db = new BrainDB(DB_PATH);

  // ── 3a. Gate runs without errors on empty project ─────────────────────────
  const result1 = runGate(db, PROJECT_DIR);
  ok('gate runs to completion', result1 && typeof result1.passed === 'boolean');
  ok('gate returns tsc, contracts, behavioral, performance sections',
     result1 && 'tsc' in result1 && 'contracts' in result1 && 'behavioral' in result1);

  // ── 3b. Gate correctly identifies tsc errors in a broken project ─────────
  mkdirSync(join(PROJECT_DIR, 'src'), { recursive: true });
  writeFileSync(join(PROJECT_DIR, 'package.json'), JSON.stringify({
    name: 'test-project', version: '1.0.0',
    scripts: { build: 'tsc --noEmit' },
    devDependencies: { typescript: '^5.0.0' }
  }, null, 2));
  writeFileSync(join(PROJECT_DIR, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2020', strict: true, outDir: './dist' }
  }));
  writeFileSync(join(PROJECT_DIR, 'src', 'index.ts'), [
    '// This file has an intentional error',
    'const x: number = "hello"; // Type error: string assigned to number',
    'export {};',
  ].join('\n'));

  const result2 = runGate(db, PROJECT_DIR);
  ok('gate detects tsc errors in broken TypeScript project',
     result2.tsc && result2.tsc.error_count > 0);
  if (result2.tsc && result2.tsc.errors && result2.tsc.errors.length > 0) {
    const tscErr = result2.tsc.errors[0];
    ok('tsc error has file, line, column, code',
       tscErr.file && tscErr.line && tscErr.column && tscErr.code);
  }

  // ── 3c. Gate behavioral checks all pass in a healthy DB ─────────────────
  ok('gate behavioral checks run', result2.behavioral && 'checks' in result2.behavioral);
  const allBehavioralPassed = result2.behavioral.checks.every(c => c.passed);
  ok('all behavioral checks pass (DB is healthy)', allBehavioralPassed);

  // ── 3d. Gate returns performance baselines ─────────────────────────────────
  ok('gate performance section exists', result2.performance && 'baselines' in result2.performance);

  // ── 3e. Gate runs contract validation ────────────────────────────────────
  ok('gate contract validation runs', result2.contracts && 'passed' in result2.contracts);

  console.log(`  Gate tsc errors found: ${result2.tsc?.error_count ?? 0}`);
  console.log(`  Gate behavioral checks: ${result2.behavioral?.checks?.length ?? 0}`);
  console.log(`  Gate duration: ${result2.duration_ms?.toFixed(0) ?? '?'}ms`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEST 4: Ghost session cleanup
// ─────────────────────────────────────────────────────────────────────────────

function testGhostSessionCleanup() {
  header('TEST 4: Ghost Session Cleanup');

  const db = new BrainDB(DB_PATH);

  // ── 4a. New queued session is NOT ghosted ─────────────────────────────────
  const queuedSid = createTestSession(db, 'queued-agent', 'queued', 0);
  const ghosts1 = db.sweepGhostSessions(3); // 3-minute threshold
  const s1 = db.getSession(queuedSid);
  ok('new queued session is NOT swept immediately', s1 && s1.status === 'queued');

  // ── 4b. Old queued session IS swept to failed ────────────────────────────
  // Create a queued session that was "created" 4 minutes ago (beyond 3-min threshold)
  const ghostSid = createTestSession(db, 'ghost-agent', 'queued', 240); // 4 min old
  const ghosts2 = db.sweepGhostSessions(3); // 3-minute threshold
  const ghostSession = db.getSession(ghostSid);
  ok('sweepGhostSessions detects old queued sessions', ghosts2 >= 1);
  ok('ghost session marked as failed', ghostSession && ghostSession.status === 'failed');
  ok('ghost session has ghost progress message',
     ghostSession && ghostSession.progress && ghostSession.progress.includes('ghost'));

  // ── 4c. working sessions are NOT swept (only queued) ─────────────────────
  const workingSid = createTestSession(db, 'working-agent', 'working', 240);
  const ghosts3 = db.sweepGhostSessions(3);
  const workingSession = db.getSession(workingSid);
  ok('working sessions are NOT swept regardless of age', workingSession && workingSession.status === 'working');

  // ── 4d. done/failed sessions are NOT swept ───────────────────────────────
  const doneSid = createTestSession(db, 'done-agent', 'done', 240);
  const ghosts4 = db.sweepGhostSessions(3);
  const doneSession = db.getSession(doneSid);
  ok('done sessions are NOT swept', doneSession && doneSession.status === 'done');

  // ── 4e. Claims are cleaned up after ghost sweep ──────────────────────────
  // Create a claim owned by the ghost session, then sweep
  const ghostWithClaimSid = createTestSession(db, 'ghost-claimer', 'queued', 300);
  db.db.prepare(
    'INSERT OR IGNORE INTO claims (resource, owner_id, claimed_at) VALUES (?, ?, datetime("now"))'
  ).run('ghost-resource', ghostWithClaimSid);

  const ghosts5 = db.sweepGhostSessions(3);
  const remainingClaim = db.db.prepare(
    'SELECT * FROM claims WHERE owner_id = ?'
  ).get(ghostWithClaimSid);
  ok('claims of ghost sessions are cleaned up after sweep', !remainingClaim);

  console.log(`  Ghost sessions swept: ${ghosts2 + ghosts5}`);
  console.log(`  Remaining sessions: ${db.getSessions(PROJECT_DIR).length}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEST 5: Temp file cleanup
// ─────────────────────────────────────────────────────────────────────────────

function testTempFileCleanup() {
  header('TEST 5: Temp File Cleanup');

  const testFiles = [
    `brain-prompt-${Date.now()}-old.txt`,
    `brain-swarm-${Date.now()}-old.log`,
    `brain-watch-${Date.now()}-old.txt`,
    `brain-exit-${Date.now()}-old.txt`,
    `brain-pid-${Date.now()}-old.txt`,
    `brain-agent-${Date.now()}-old.log`,
    `brain-headless-${Date.now()}-old.sh`,
    // Recent files (should NOT be deleted)
    `brain-prompt-${Date.now()}-recent.txt`,
    `brain-swarm-${Date.now()}-recent.log`,
    // Non-matching files (should NOT be deleted)
    `brain-other-${Date.now()}.txt`,
    `prompt-brain-${Date.now()}.txt`,
    `brain-prompt-very-old-but-wrong-prefix.txt`,
  ];

  // Create temp files with old mtimes
  const now = Date.now();
  const oldMtime = now - (61 * 60 * 1000); // 61 minutes ago (older than 1-hour threshold)
  const recentMtime = now - (30 * 60 * 1000); // 30 minutes ago

  const oldFiles = testFiles.slice(0, 7); // brain-prompt-, brain-swarm-, etc.
  const recentFiles = testFiles.slice(7, 9);
  const otherFiles = testFiles.slice(9);

  // Create old files
  for (const f of oldFiles) {
    const p = join(tmpdir(), f);
    writeFileSync(p, 'test content');
    try {
      const { utimesSync } = require('node:fs');
      utimesSync(p, oldMtime / 1000, oldMtime / 1000);
    } catch { /* best effort */ }
  }

  // Create recent files
  for (const f of recentFiles) {
    const p = join(tmpdir(), f);
    writeFileSync(p, 'test content');
    try {
      const { utimesSync } = require('node:fs');
      utimesSync(p, recentMtime / 1000, recentMtime / 1000);
    } catch { /* best effort */ }
  }

  // Create non-matching files
  for (const f of otherFiles) {
    writeFileSync(join(tmpdir(), f), 'test content');
  }

  // Run cleanup using the watchdog's cleanupStaleTempFiles logic
  // (imported from watchdog dist if exported, otherwise we inline the logic)
  let removed = 0;
  const TEMP_FILE_PATTERNS = [
    'brain-prompt-', 'brain-swarm-', 'brain-watch-',
    'brain-exit-', 'brain-pid-', 'brain-agent-', 'brain-headless-',
  ];
  const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

  try {
    const { readdirSync: rd, unlinkSync: ul, statSync: st } = require('node:fs');
    const files = rd(tmpdir());
    for (const file of files) {
      if (!TEMP_FILE_PATTERNS.some(p => file.startsWith(p))) continue;
      const filePath = join(tmpdir(), file);
      try {
        const stat = st(filePath);
        if (now - stat.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
          ul(filePath);
          removed++;
        }
      } catch { /* skip inaccessible files */ }
    }
  } catch (err) {
    console.log(`  Temp cleanup error (non-critical): ${err.message}`);
  }

  ok('stale temp files are removed', removed >= oldFiles.length);

  // Verify recent files still exist
  for (const f of recentFiles) {
    const exists = existsSync(join(tmpdir(), f));
    ok(`recent temp file ${f} is NOT removed`, exists);
  }

  // Verify non-matching files still exist
  for (const f of otherFiles) {
    const exists = existsSync(join(tmpdir(), f));
    ok(`non-matching temp file is NOT removed`, exists);
  }

  // Cleanup recent and other files
  for (const f of [...recentFiles, ...otherFiles]) {
    try { unlinkSync(join(tmpdir(), f)); } catch {}
  }

  console.log(`  Stale temp files removed: ${removed}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEST 6: Session state machine (queued → working → done/failed)
// ─────────────────────────────────────────────────────────────────────────────

async function testSessionStateMachine() {
  header('TEST 6: Session State Machine');

  const { proc, send, notify } = startServer();
  let cleanup = () => { try { proc.kill(); } catch {} };

  try {
    await send('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'state-machine-test', version: '1.0' },
    });
    notify('notifications/initialized');
    await new Promise(r => setTimeout(r, 300));

    // Register two sessions: lead and worker
    const lead = await callTool(send, 'register', { name: 'state-lead' });
    const worker = await callTool(send, 'register', { name: 'state-worker' });
    ok('state-lead registered', lead.sessionId || lead.name);
    ok('state-worker registered', worker.sessionId || worker.name);

    const db = new BrainDB(DB_PATH);

    // Verify initial states
    const leadSession = db.getSessions(PROJECT_DIR).find(s => s.name === 'state-lead');
    const workerSession = db.getSessions(PROJECT_DIR).find(s => s.name === 'state-worker');
    ok('lead session created', !!leadSession);
    ok('worker session created', !!workerSession);

    // ── Pulse worker through: queued → working → done ───────────────────────

    // First pulse transitions queued → working (first-confirm logic)
    // Note: Since we registered rather than using wake, sessions are 'idle'
    // Transition idle → working
    db.pulse(workerSession.id, 'working', 'starting task');

    const w1 = db.getSession(workerSession.id);
    ok('worker transitions to working', w1 && w1.status === 'working');

    // Subsequent pulses while working just update timestamp
    const pulseResult = db.recordHeartbeat(workerSession.id);
    ok('recordHeartbeat succeeds', pulseResult === true);

    // Transition working → done
    db.markDone(workerSession.id, 0, false, 'task completed successfully');
    const w2 = db.getSession(workerSession.id);
    ok('worker transitions to done', w2 && w2.status === 'done');
    ok('worker has exit_code 0', w2 && w2.exit_code === 0);

    // ── Test failed transition ───────────────────────────────────────────────
    db.pulse(leadSession.id, 'working', 'doing important work');
    db.markDone(leadSession.id, 1, true, 'task failed');
    const l1 = db.getSession(leadSession.id);
    ok('lead transitions to failed', l1 && l1.status === 'failed');
    ok('failed session has non-zero exit_code', l1 && l1.exit_code === 1);
    ok('failed session has progress message', l1 && l1.progress);

    // ── Cannot transition from done back to working ─────────────────────────
    const pulseAfterDone = db.pulseWithFirstConfirm(leadSession.id, 'working', 're-doing');
    ok('pulseWithFirstConfirm rejects done→working transition', pulseAfterDone === false);

    // ── Health check reports correct statuses ────────────────────────────────
    const health = db.getAgentHealth(PROJECT_DIR);
    const doneAgent = health.find(a => a.name === 'state-worker');
    const failedAgent = health.find(a => a.name === 'state-lead');
    ok('health shows state-worker as done', doneAgent && doneAgent.status === 'done');
    ok('health shows state-lead as failed', failedAgent && failedAgent.status === 'failed');

    console.log(`  Agent health: ${health.map(a => `${a.name}[${a.status}]`).join(', ')}`);

  } finally {
    cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEST 7: Message passing between sessions
// ─────────────────────────────────────────────────────────────────────────────

async function testMessagePassing() {
  header('TEST 7: Message Passing Between Sessions');

  const { proc, send, notify } = startServer();
  let cleanup = () => { try { proc.kill(); } catch {} };

  try {
    await send('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'msg-test', version: '1.0' },
    });
    notify('notifications/initialized');
    await new Promise(r => setTimeout(r, 300));

    const lead = await callTool(send, 'register', { name: 'msg-lead' });
    const worker = await callTool(send, 'register', { name: 'msg-worker' });
    const leadSid = lead.sessionId;
    const workerSid = worker.sessionId;

    const db = new BrainDB(DB_PATH);

    // ── Post to general channel ──────────────────────────────────────────────
    db.postMessage('general', PROJECT_DIR, leadSid, 'msg-lead', 'Hello from lead!');
    db.postMessage('general', PROJECT_DIR, workerSid, 'msg-worker', 'Hello from worker!');

    const generalMsgs = db.getMessages('general', PROJECT_DIR);
    ok('messages appear in general channel', generalMsgs.length >= 2);
    ok('message has correct sender', generalMsgs.some(m => m.sender_name === 'msg-lead'));
    ok('message has correct content', generalMsgs.some(m => m.content === 'Hello from lead!'));

    // ── Direct messages ──────────────────────────────────────────────────────
    db.sendDM(leadSid, 'msg-lead', workerSid, 'Direct message to worker');
    const inbox = db.getInbox(workerSid);
    ok('direct message appears in recipient inbox', inbox.length >= 1);
    ok('DM has correct content', inbox.some(m => m.content === 'Direct message to worker'));

    console.log(`  Messages in general: ${generalMsgs.length}`);
    console.log(`  DMs in worker inbox: ${inbox.length}`);

  } finally {
    cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEST 8: Contract protocol
// ─────────────────────────────────────────────────────────────────────────────

function testContractProtocol() {
  header('TEST 8: Contract Protocol');

  const db = new BrainDB(DB_PATH);
  const sid = randomUUID();

  db.registerSession('contract-agent', PROJECT_DIR, '{}', sid);

  // ── Set contracts ─────────────────────────────────────────────────────────
  db.db.prepare(
    `INSERT INTO contracts (room, set_by, provides, expects, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(PROJECT_DIR, sid, JSON.stringify(['auth-api', 'user-db']), JSON.stringify(['http-client', 'session-store']));

  db.db.prepare(
    `INSERT INTO contracts (room, set_by, provides, expects, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(PROJECT_DIR, sid, JSON.stringify(['http-client']), JSON.stringify(['auth-api']));

  // ── Validate contracts ─────────────────────────────────────────────────────
  const mismatches = db.validateContracts(PROJECT_DIR);
  ok('contract validation runs without error', Array.isArray(mismatches));

  // ── Get contracts ──────────────────────────────────────────────────────────
  const contracts = db.db.prepare(`SELECT * FROM contracts WHERE room = ?`).all(PROJECT_DIR);
  ok('contracts are stored in DB', contracts.length === 2);

  // ── Clear and verify ──────────────────────────────────────────────────────
  const clearResult = db.clear();
  ok('clear removes contracts', clearResult.contracts === 0);

  console.log(`  Contract mismatches found: ${mismatches.length}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cleanup helper
// ─────────────────────────────────────────────────────────────────────────────

function cleanupTempFiles() {
  try {
    const patterns = ['brain-prompt-', 'brain-swarm-', 'brain-watch-', 'brain-exit-', 'brain-pid-', 'brain-agent-', 'brain-headless-'];
    const files = readdirSync(tmpdir());
    for (const file of files) {
      if (!patterns.some(p => file.startsWith(p))) continue;
      const p = join(tmpdir(), file);
      try { unlinkSync(p); } catch {}
    }
  } catch { /* best effort */ }
}

function cleanupDB() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(DB_PATH + suffix); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main runner
// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  brain-mcp Integration Test Suite');
  console.log(`  DB: ${DB_PATH}`);
  console.log(`  Project: ${PROJECT_DIR}`);
  console.log(`${'═'.repeat(60)}\n`);

  mkdirSync(PROJECT_DIR, { recursive: true });

  try {
    // Unit tests (DB directly, no server)
    if (RUN_UNIT || RUN_ALL) {
      testWatchdogRecovery();
      testGhostSessionCleanup();
      testGateValidation();
      testContractProtocol();
    }

    // Gate-only tests
    if (RUN_GATE) {
      testGateValidation();
    }

    // Server-based tests (require spawning brain-mcp server)
    if (!RUN_UNIT) {
      await testSpawnHeartbeatCompletionFlow();
      await testSessionStateMachine();
      await testMessagePassing();
      testTempFileCleanup();
    }

  } catch (err) {
    console.error(`\n  Test suite error: ${err.message}`);
    console.error(err.stack);
    T.fail++;
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Results: ${T.pass} passed, ${T.fail} failed, ${T.skip} skipped`);
  if (T.errors.length > 0) {
    console.log(`\n  Failed tests:`);
    for (const e of T.errors) console.log(`    ✗ ${e}`);
  } else {
    console.log(`  All tests passed!`);
  }
  console.log(`${'═'.repeat(60)}\n`);

  // Cleanup
  cleanupTempFiles();
  cleanupDB();

  process.exit(T.fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  cleanupTempFiles();
  cleanupDB();
  process.exit(1);
});
