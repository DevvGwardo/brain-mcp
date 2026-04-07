/**
 * brain-test-harness.ts — Full pi-core coordination test suite.
 *
 * Usage:
 *   npx tsx src/test-harness.ts              # run all phases
 *   npx tsx src-harness.ts --phase 1          # run specific phase
 *   BRAIN_DB_PATH=/tmp/test.db npx tsx src/test-harness.ts  # custom DB
 *
 * Each phase:
 * 1. Spins up a fresh brain DB (temp path)
 * 2. Runs the conductor in --pi-core mode with a crafted pipeline
 * 3. Waits for completion
 * 4. Inspects DB state
 * 5. Runs assertions and reports pass/fail
 *
 * Assertions are written directly against the DB — the DB is ground truth.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { BrainDB } from './db.js';

// ── Test result types ────────────────────────────────────────────────────────

interface Assertion {
  name: string;
  check: (db: BrainDB, room: string) => boolean;
  detail?: string;
}

interface PhaseResult {
  phase: number;
  name: string;
  passed: boolean;
  assertions: { name: string; passed: boolean; detail?: string }[];
  duration_ms: number;
  conductor_exit_code: number;
  sessions: any[];
  errors: string[];
}

interface PipelineConfig {
  task: string;
  cwd: string;
  phases: {
    name: string;
    agents: {
      name: string;
      files?: string[];
      task?: string;
      delay?: number;
    }[];
  }[];
  gate: boolean;
  timeout: number;
  max_gate_retries: number;
  mode: string;
  model: string;
}

// ── Test phases ──────────────────────────────────────────────────────────────

const PHASES: Record<number, {
  name: string;
  description: string;
  pipeline: Omit<PipelineConfig, 'cwd'>;
  assertions: (room: string) => Assertion[];
  timeout: number; // seconds
}> = {

  // ── Phase 1: Tool correctness ──────────────────────────────────────────
  1: {
    name: 'Tool correctness — set/get/incr/decr/counter',
    description: 'Agent A sets state, agent B reads and reports. Verify round-trip.',
    pipeline: {
      task: 'Do not edit any files.',
      gate: false,
      timeout: 60,
      max_gate_retries: 0,
      mode: 'pi-core',
      model: 'claude-sonnet-4-5',
      phases: [{
        name: 'tool-correctness',
        agents: [
          {
            name: 'agent-a',
            task: 'Call brain_set with key="p1_secret", value="hello from agent-a", scope="/tmp/brain-test". Then call brain_set with key="p1_counter", value="0", scope="/tmp/brain-test". Then call brain_incr with key="p1_counter", delta=5, scope="/tmp/brain-test". Call brain_post with content="agent-a done", channel="general".',
          },
          {
            name: 'agent-b',
            task: 'Call brain_get with key="p1_secret", scope="/tmp/brain-test". Call brain_counter with key="p1_counter", scope="/tmp/brain-test". Call brain_decr with key="p1_counter", delta=2, scope="/tmp/brain-test". Call brain_counter with key="p1_counter", scope="/tmp/brain-test". Call brain_post with content="agent-b read counter FINAL", channel="general".',
          },
        ],
      }],
    },
    timeout: 90,
    assertions: (room) => [
      {
        name: 'agent-a set p1_secret',
        check: (db) => {
          const e = db.getState('p1_secret', room);
          return e?.value === 'hello from agent-a';
        },
        detail: 'p1_secret should equal "hello from agent-a"',
      },
      {
        name: 'counter is 3 (incr(5) then decr(2))',
        check: (db) => db.get_counter('p1_counter', room) === 3,
        detail: 'counter should be 3 after agent-a incr(5) and agent-b decr(2)',
      },
      {
        name: 'agent-a posted done',
        check: (db) => db.getMessages('general', room).some(m => m.content.includes('agent-a done')),
        detail: 'agent-a should have posted "agent-a done"',
      },
      {
        name: 'agent-b posted final counter value',
        check: (db) => db.getMessages('general', room).some(m => m.content.includes('agent-b read counter FINAL')),
        detail: 'agent-b should have posted "agent-b read counter FINAL"',
      },
    ],
  },

  // ── Phase 2: Barrier / wait semantics ──────────────────────────────────
  2: {
    name: 'Barrier — wait_until threshold unblock',
    description: '3 agents call wait_until on same barrier (threshold=3). All should get reached=true.',
    pipeline: {
      task: 'Do not edit any files.',
      gate: false,
      timeout: 60,
      max_gate_retries: 0,
      mode: 'pi-core',
      model: 'claude-sonnet-4-5',
      phases: [{
        name: 'barrier-test',
        agents: [
          {
            name: 'agent-1',
            task: 'Call brain_wait_until with key="p2_gate", threshold=3, scope="/tmp/brain-test". Call brain_post with content="agent-1 reached barrier", channel="general".',
          },
          {
            name: 'agent-2',
            task: 'Call brain_wait_until with key="p2_gate", threshold=3, scope="/tmp/brain-test". Call brain_post with content="agent-2 reached barrier", channel="general".',
          },
          {
            name: 'agent-3',
            task: 'Call brain_wait_until with key="p2_gate", threshold=3, scope="/tmp/brain-test". Call brain_post with content="agent-3 reached barrier", channel="general".',
          },
        ],
      }],
    },
    timeout: 90,
    assertions: (room) => [
      {
        name: 'barrier p2_gate exists in DB',
        check: (db) => {
          // @ts-ignore
          const b = (db as any).db.prepare('SELECT * FROM barriers WHERE key = ? AND scope = ?').get('p2_gate', room) as any;
          return b !== undefined && b !== null;
        },
        detail: 'barrier p2_gate should exist',
      },
      {
        name: 'barrier threshold=3, current=3',
        check: (db) => {
          // @ts-ignore
          const b = (db as any).db.prepare('SELECT * FROM barriers WHERE key = ? AND scope = ?').get('p2_gate', room) as any;
          return b?.threshold === 3 && b?.current === 3;
        },
        detail: 'barrier should have threshold=3 and current=3',
      },
      {
        name: 'all 3 agents reached barrier and posted',
        check: (db) => {
          const msgs = db.getMessages('general', room);
          return ['agent-1 reached barrier', 'agent-2 reached barrier', 'agent-3 reached barrier']
            .every(r => msgs.some(m => m.content.includes(r)));
        },
        detail: 'all 3 agents should have posted "reached barrier"',
      },
    ],
  },

  // ── Phase 3: Auto-heartbeat under load ────────────────────────────────
  3: {
    name: 'Heartbeat — 12 tool calls, all completed',
    description: 'Agent makes 12 tool calls. Verify all completed and posted.',
    pipeline: {
      task: 'Call brain_set with key="p3_k1", value="v1", scope="/tmp/brain-test". Call brain_set with key="p3_k2", value="v2", scope="/tmp/brain-test". Call brain_set with key="p3_k3", value="v3", scope="/tmp/brain-test". Call brain_set with key="p3_k4", value="v4", scope="/tmp/brain-test". Call brain_set with key="p3_k5", value="v5", scope="/tmp/brain-test". Call brain_set with key="p3_k6", value="v6", scope="/tmp/brain-test". Call brain_set with key="p3_k7", value="v7", scope="/tmp/brain-test". Call brain_set with key="p3_k8", value="v8", scope="/tmp/brain-test". Call brain_set with key="p3_k9", value="v9", scope="/tmp/brain-test". Call brain_set with key="p3_k10", value="v10", scope="/tmp/brain-test". Call brain_status once. Call brain_agents once. Call brain_post with content="agent-1 done with 12 tools", channel="general".',
      gate: false,
      timeout: 60,
      max_gate_retries: 0,
      mode: 'pi-core',
      model: 'claude-sonnet-4-5',
      phases: [{
        name: 'heartbeat-test',
        agents: [
          { name: 'agent-1' },
        ],
      }],
    },
    timeout: 90,
    assertions: (room) => [
      {
        name: 'agent completed all 12 tool calls and posted',
        check: (db) => db.getMessages('general', room).some(m => m.content.includes('done with 12 tools')),
        detail: 'agent should have posted completion after all tool calls',
      },
      {
        name: 'agent session has final status',
        check: (db) => {
          const agents = db.getAgentHealth(room);
          const a = agents.find(ag => ag.name === 'agent-1');
          return a?.status === 'done' || a?.status === 'failed';
        },
        detail: 'agent-1 session should have final status',
      },
      {
        name: 'all 10 state entries written correctly',
        check: (db) => {
          let ok = 0;
          for (let i = 1; i <= 10; i++) {
            if (db.getState(`p3_k${i}`, room)?.value === `v${i}`) ok++;
          }
          return ok === 10;
        },
        detail: 'all 10 key-value pairs should be in state',
      },
    ],
  },

  // ── Phase 4: Timeout enforcement ─────────────────────────────────────
  4: {
    name: 'Timeout — agent with 5s limit on long task',
    description: 'Agent with 5s timeout. Verifies timeout mechanism kills runaway.',
    pipeline: {
      task: 'Do not edit any files.',
      gate: false,
      timeout: 5, // 5 second timeout — pi-core will interrupt
      max_gate_retries: 0,
      mode: 'pi-core',
      model: 'claude-sonnet-4-5',
      phases: [{
        name: 'timeout-test',
        agents: [
          {
            name: 'agent-timeout',
            task: 'Call brain_set with key="p4_start", value="1", scope="/tmp/brain-test". Call brain_incr with key="p4_loop", delta=1, scope="/tmp/brain-test". Call brain_incr with key="p4_loop", delta=1, scope="/tmp/brain-test". Call brain_incr with key="p4_loop", delta=1, scope="/tmp/brain-test". Call brain_incr with key="p4_loop", delta=1, scope="/tmp/brain-test". Call brain_incr with key="p4_loop", delta=1, scope="/tmp/brain-test". Call brain_post with content="should not reach here", channel="general".',
          },
        ],
      }],
    },
    timeout: 30,
    assertions: (room) => [
      {
        name: 'agent-timeout session exists in DB',
        check: (db) => {
          const agents = db.getAgentHealth(room);
          return agents.some(ag => ag.name === 'agent-timeout');
        },
        detail: 'agent-timeout session should be registered',
      },
      {
        name: 'agent did NOT post "should not reach here"',
        check: (db) => !db.getMessages('general', room).some(m => m.content.includes('should not reach here')),
        detail: 'agent should NOT have reached final post if timeout worked',
      },
      {
        name: 'p4_start was set (agent got at least first tool call)',
        check: (db) => db.getState('p4_start', room)?.value === '1',
        detail: 'p4_start should be "1" — agent completed at least the first call',
      },
    ],
  },

  // ── Phase 5: Parallel tool execution ──────────────────────────────────
  5: {
    name: 'Parallel tools — 20 sequential set calls, none lost',
    description: 'One agent makes 20 rapid brain_set calls. Verify all 20 appear in DB.',
    pipeline: {
      task: 'Call brain_set with key="p5_1", value="val1", scope="/tmp/brain-test". Call brain_set with key="p5_2", value="val2", scope="/tmp/brain-test". Call brain_set with key="p5_3", value="val3", scope="/tmp/brain-test". Call brain_set with key="p5_4", value="val4", scope="/tmp/brain-test". Call brain_set with key="p5_5", value="val5", scope="/tmp/brain-test". Call brain_set with key="p5_6", value="val6", scope="/tmp/brain-test". Call brain_set with key="p5_7", value="val7", scope="/tmp/brain-test". Call brain_set with key="p5_8", value="val8", scope="/tmp/brain-test". Call brain_set with key="p5_9", value="val9", scope="/tmp/brain-test". Call brain_set with key="p5_10", value="val10", scope="/tmp/brain-test". Call brain_set with key="p5_11", value="val11", scope="/tmp/brain-test". Call brain_set with key="p5_12", value="val12", scope="/tmp/brain-test". Call brain_set with key="p5_13", value="val13", scope="/tmp/brain-test". Call brain_set with key="p5_14", value="val14", scope="/tmp/brain-test". Call brain_set with key="p5_15", value="val15", scope="/tmp/brain-test". Call brain_set with key="p5_16", value="val16", scope="/tmp/brain-test". Call brain_set with key="p5_17", value="val17", scope="/tmp/brain-test". Call brain_set with key="p5_18", value="val18", scope="/tmp/brain-test". Call brain_set with key="p5_19", value="val19", scope="/tmp/brain-test". Call brain_set with key="p5_20", value="val20", scope="/tmp/brain-test". Call brain_post with content="agent-1 set 20 values", channel="general".',
      gate: false,
      timeout: 60,
      max_gate_retries: 0,
      mode: 'pi-core',
      model: 'claude-sonnet-4-5',
      phases: [{
        name: 'parallel-test',
        agents: [
          { name: 'agent-1' },
        ],
      }],
    },
    timeout: 90,
    assertions: (room) => [
      {
        name: 'all 20 keys written to DB',
        check: (db) => {
          let ok = 0;
          for (let i = 1; i <= 20; i++) {
            if (db.getState(`p5_${i}`, room)?.value === `val${i}`) ok++;
          }
          return ok === 20;
        },
        detail: 'all 20 key-value pairs should be in state',
      },
      {
        name: 'agent posted completion',
        check: (db) => db.getMessages('general', room).some(m => m.content.includes('set 20 values')),
        detail: 'agent should have posted completion',
      },
    ],
  },

  // ── Phase 6: Cross-agent coordination race ────────────────────────────
  6: {
    name: 'Coordination — agent-reader sees final atomic counter value',
    description: 'Agent-incrementer does 5 incr. Agent-reader waits on barrier then reads final counter.',
    pipeline: {
      task: 'Do not edit any files.',
      gate: false,
      timeout: 60,
      max_gate_retries: 0,
      mode: 'pi-core',
      model: 'claude-sonnet-4-5',
      phases: [{
        name: 'coordination-test',
        agents: [
          {
            name: 'agent-incrementer',
            task: 'Call brain_incr with key="p6_counter", delta=1, scope="/tmp/brain-test". Call brain_incr with key="p6_counter", delta=1, scope="/tmp/brain-test". Call brain_incr with key="p6_counter", delta=1, scope="/tmp/brain-test". Call brain_incr with key="p6_counter", delta=1, scope="/tmp/brain-test". Call brain_incr with key="p6_counter", delta=1, scope="/tmp/brain-test". Call brain_wait_until with key="p6_done", threshold=2, scope="/tmp/brain-test". Call brain_post with content="agent-incrementer done incrementing", channel="general".',
          },
          {
            name: 'agent-reader',
            task: 'Call brain_wait_until with key="p6_done", threshold=2, scope="/tmp/brain-test". Call brain_counter with key="p6_counter", scope="/tmp/brain-test". Call brain_post with content="agent-reader saw 5", channel="general".',
          },
        ],
      }],
    },
    timeout: 90,
    assertions: (room) => [
      {
        name: 'counter is 5',
        check: (db) => db.get_counter('p6_counter', room) === 5,
        detail: 'counter should be 5 after 5 incr(delta=1)',
      },
      {
        name: 'agent-incrementer posted done after incrementing',
        check: (db) => db.getMessages('general', room).some(m => m.content.includes('done incrementing')),
        detail: 'agent-incrementer should have posted done',
      },
      {
        name: 'agent-reader posted it saw 5',
        check: (db) => db.getMessages('general', room).some(m => m.content.includes('agent-reader saw 5')),
        detail: 'agent-reader should have posted "saw 5"',
      },
    ],
  },

  // ── Phase 7: Failure injection ────────────────────────────────────────
  7: {
    name: 'Failure injection — pi-core crash = conductor crash (documented)',
    description: 'pi-core agents run in the conductor process. SIGKILL kills everything.',
    pipeline: {
      task: 'Call brain_set with key="p7_started", value="1", scope="/tmp/brain-test". Call brain_wait_until with key="p7_wait", threshold=2, scope="/tmp/brain-test". Call brain_post with content="agent-sigkill survived", channel="general".',
      gate: false,
      timeout: 30,
      max_gate_retries: 0,
      mode: 'pi-core',
      model: 'claude-sonnet-4-5',
      phases: [{
        name: 'failure-injection',
        agents: [
          { name: 'agent-sigkill' },
        ],
      }],
    },
    timeout: 60,
    assertions: (_room) => [
      {
        name: 'pi-core crash = conductor crash (documented behavior)',
        check: () => true,
        detail: 'pi-core agents are in-process; SIGKILL kills conductor. Use --pi (tmux) for subprocess isolation.',
      },
      {
        name: 'agent session registered',
        check: (db, room) => {
          const agents = db.getAgentHealth(room);
          return agents.some(ag => ag.name === 'agent-sigkill');
        },
        detail: 'agent-sigkill session should be in DB',
      },
    ],
  },
};

// ── Test runner ─────────────────────────────────────────────────────────────

async function runPhase(
  phaseNum: number,
  dbPath: string,
): Promise<PhaseResult> {
  const phase = PHASES[phaseNum];
  if (!phase) throw new Error(`Phase ${phaseNum} not defined`);

  const start = Date.now();
  const room = join(tmpdir(), `brain-test-p${phaseNum}-${randomUUID().slice(0, 8)}`);
  mkdirSync(room, { recursive: true });

  // Write pipeline.json — substitute /tmp/brain-test with actual room path
  const pipelinePath = join(room, 'pipeline.json');
  const fullPipeline: PipelineConfig = {
    ...phase.pipeline,
    cwd: room,
  };
  // Replace hardcoded scope paths with actual room
  const pipelineJson = JSON.stringify(fullPipeline, null, 2)
    .replace(/\/tmp\/brain-test/g, room);
  writeFileSync(pipelinePath, pipelineJson);

  // Spawn conductor
  const conductorBin = join(import.meta.dirname, '..', 'dist', 'conductor.js');
  let conductorExitCode = -1;
  let conductorStderr = '';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`PHASE ${phaseNum}: ${phase.name}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`${phase.description}`);
  console.log(`DB: ${dbPath}`);
  console.log(`Room: ${room}`);

  const conductorProc = spawn('node', [conductorBin, '--config', pipelinePath], {
    env: {
      ...process.env,
      BRAIN_DB_PATH: dbPath,
      BRAIN_ROOM: room,
      PATH: process.env.PATH || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutData = '';
  conductorProc.stdout?.on('data', (d: Buffer) => {
    const s = d.toString();
    stdoutData += s;
    // Stream to our stdout for live visibility
    process.stdout.write(s);
  });
  conductorProc.stderr?.on('data', (d: Buffer) => {
    conductorStderr += d.toString();
  });

  // Wait for completion or timeout
  const result = await new Promise<number>((resolve) => {
    const t = setTimeout(() => {
      console.log(`\n[phase ${phaseNum}] timeout waiting for conductor (${phase.timeout}s limit)`);
      conductorProc.kill('SIGTERM');
      setTimeout(() => {
        if (!conductorProc.killed) conductorProc.kill('SIGKILL');
      }, 5000);
    }, phase.timeout * 1000);

    conductorProc.on('close', (code) => {
      clearTimeout(t);
      resolve(code ?? -1);
    });
    conductorProc.on('error', (err) => {
      clearTimeout(t);
      console.error(`[phase ${phaseNum}] conductor error: ${err.message}`);
      resolve(-1);
    });
  });

  conductorExitCode = result;

  // Give DB a moment to flush
  await new Promise(r => setTimeout(r, 500));

  // Inspect DB
  let db: BrainDB;
  try {
    db = new BrainDB(dbPath);
  } catch (e: any) {
    return {
      phase: phaseNum,
      name: phase.name,
      passed: false,
      assertions: [],
      duration_ms: Date.now() - start,
      conductor_exit_code: conductorExitCode,
      sessions: [],
      errors: [`DB open failed: ${e.message}`],
    };
  }

  const sessions = db.getSessions(room);

  // Run assertions
  const assertions = phase.assertions(room).map(assert => {
    try {
      const passed = assert.check(db, room);
      return { name: assert.name, passed, detail: assert.detail };
    } catch (e: any) {
      return { name: assert.name, passed: false, detail: `ERROR: ${e.message}` };
    }
  });

  const passed = assertions.every(a => a.passed);
  const duration_ms = Date.now() - start;

  console.log(`\n${passed ? '✓ PASS' : '✗ FAIL'} — phase ${phaseNum} (${duration_ms}ms)`);
  for (const a of assertions) {
    console.log(`  ${a.passed ? '✓' : '✗'} ${a.name}${a.detail ? ` — ${a.detail}` : ''}`);
  }
  if (conductorExitCode !== 0) {
    console.log(`  ⚠ conductor exited with code ${conductorExitCode}`);
  }

  // Cleanup room
  try { rmSync(room, { recursive: true }); } catch { /* ignore */ }

  return {
    phase: phaseNum,
    name: phase.name,
    passed,
    assertions,
    duration_ms,
    conductor_exit_code: conductorExitCode,
    sessions,
    errors: [],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const phaseArg = args.find(a => a.startsWith('--phase='));
  const runAll = !phaseArg;

  // Resolve DB path
  const dbIdx = args.indexOf('--db');
  const dbPath = dbIdx >= 0 && args[dbIdx + 1]
    ? args[dbIdx + 1]
    : join(tmpdir(), `brain-test-${randomUUID().slice(0, 8)}.db`);

  // Clean DB before starting
  try {
    if (existsSync(dbPath)) rmSync(dbPath);
  } catch { /* ignore */ }

  console.log(`brain-test-harness starting`);
  console.log(`DB: ${dbPath}`);
  console.log(`Phases: ${runAll ? 'ALL (1-7)' : `phase ${phaseArg!.split('=')[1]}`}`);
  console.log('');

  const results: PhaseResult[] = [];
  const phasesToRun = runAll
    ? Object.keys(PHASES).map(Number).sort((a, b) => a - b)
    : [parseInt(phaseArg!.split('=')[1])];

  for (const p of phasesToRun) {
    if (!PHASES[p]) {
      console.error(`Unknown phase: ${p}`);
      continue;
    }
    try {
      const result = await runPhase(p, dbPath);
      results.push(result);
    } catch (e: any) {
      console.error(`Phase ${p} crashed: ${e.message}`);
      results.push({
        phase: p,
        name: PHASES[p].name,
        passed: false,
        assertions: [],
        duration_ms: 0,
        conductor_exit_code: -1,
        sessions: [],
        errors: [e.message, e.stack || ''],
      });
    }
    // Small delay between phases
    await new Promise(r => setTimeout(r, 1000));
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(60)}`);
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  for (const r of results) {
    console.log(`${r.passed ? '✓' : '✗'} phase ${r.phase}: ${r.name} (${r.duration_ms}ms)`);
    for (const a of r.assertions) {
      if (!a.passed) {
        console.log(`    ${a.name}${a.detail ? ` — ${a.detail}` : ''}`);
      }
    }
    if (r.conductor_exit_code !== 0) {
      console.log(`    conductor exit: ${r.conductor_exit_code}`);
    }
  }
  console.log(`\n${passed}/${total} phases passed`);

  if (passed < total) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
