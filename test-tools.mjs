#!/usr/bin/env node
/**
 * Quick integration test — spawns brain-mcp and exercises new tools via JSON-RPC.
 * MCP SDK 1.29 uses newline-delimited JSON (not Content-Length framing).
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';

const DB_PATH = join(tmpdir(), `brain-test-${Date.now()}.db`);
let reqId = 1;

function startServer() {
  const proc = spawn('node', ['dist/index.js'], {
    env: { ...process.env, BRAIN_DB_PATH: DB_PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();

  // Read newline-delimited JSON from stdout
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
    if (s) console.error('  [stderr]', s);
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
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    proc.stdin.write(msg);
  }

  return { proc, send, notify };
}

async function callTool(send, name, args = {}) {
  const result = await send('tools/call', { name, arguments: args });
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : result;
}

// ── Tests ──

const passed = [];
const failed = [];

function ok(name, condition, detail = '') {
  if (condition) {
    passed.push(name);
    console.log(`  ✓ ${name}`);
  } else {
    failed.push(name);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function run() {
  console.log('Starting brain-mcp test server...\n');
  const { proc, send, notify } = startServer();

  try {
    // Initialize
    const initResult = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
    notify('notifications/initialized', {});
    await new Promise(r => setTimeout(r, 200));
    console.log(`Server initialized: ${initResult.serverInfo?.name} v${initResult.serverInfo?.version}\n`);

    // List tools
    const toolList = await send('tools/list', {});
    const toolNames = toolList.tools.map(t => t.name);
    console.log(`Tools loaded: ${toolNames.length}\n`);

    // ── 1. Check new tools exist ──
    console.log('=== Tool Registration ===');
    ok('brain_remember registered', toolNames.includes('brain_remember'));
    ok('brain_recall registered', toolNames.includes('brain_recall'));
    ok('brain_forget registered', toolNames.includes('brain_forget'));
    ok('brain_plan registered', toolNames.includes('brain_plan'));
    ok('brain_plan_next registered', toolNames.includes('brain_plan_next'));
    ok('brain_plan_update registered', toolNames.includes('brain_plan_update'));
    ok('brain_plan_status registered', toolNames.includes('brain_plan_status'));
    ok('brain_respawn registered', toolNames.includes('brain_respawn'));
    ok('brain_auto_gate registered', toolNames.includes('brain_auto_gate'));
    ok('brain_metrics registered', toolNames.includes('brain_metrics'));
    ok('brain_metric_record registered', toolNames.includes('brain_metric_record'));

    // Check brain_wake has new params
    const wakeSchema = toolList.tools.find(t => t.name === 'brain_wake');
    const wakeProps = Object.keys(wakeSchema?.inputSchema?.properties || {});
    ok('brain_wake has model param', wakeProps.includes('model'));
    ok('brain_wake has timeout param', wakeProps.includes('timeout'));
    ok('brain_wake has cli param', wakeProps.includes('cli'));
    const layoutEnum = wakeSchema?.inputSchema?.properties?.layout?.enum || [];
    ok('brain_wake supports headless layout', layoutEnum.includes('headless'));

    console.log('\n=== Register Session ===');
    const reg = await callTool(send, 'brain_register', { name: 'test-lead' });
    ok('register session', reg.sessionId && reg.name === 'test-lead');

    // ── 2. Memory ──
    console.log('\n=== Persistent Memory ===');
    const mem1 = await callTool(send, 'brain_remember', {
      key: 'auth-pattern',
      content: 'This project uses JWT with refresh tokens stored in httpOnly cookies. The middleware is in src/auth.ts.',
      category: 'architecture',
    });
    ok('brain_remember stores memory', mem1.ok && mem1.id);

    const mem2 = await callTool(send, 'brain_remember', {
      key: 'db-gotcha',
      content: 'The users table has a soft-delete column "deleted_at" — always filter by deleted_at IS NULL.',
      category: 'gotcha',
    });
    ok('brain_remember stores second memory', mem2.ok && mem2.id);

    const recall1 = await callTool(send, 'brain_recall', { query: 'auth' });
    ok('brain_recall finds auth memory', recall1.count >= 1 && recall1.memories.some(m => m.key === 'auth-pattern'));

    const recall2 = await callTool(send, 'brain_recall', { category: 'gotcha' });
    ok('brain_recall filters by category', recall2.count >= 1 && recall2.memories[0].category === 'gotcha');

    const recall3 = await callTool(send, 'brain_recall', {});
    ok('brain_recall lists all memories', recall3.count >= 2);
    ok('brain_recall shows categories', recall3.categories.length >= 2);

    // Update existing memory (upsert by key)
    await callTool(send, 'brain_remember', {
      key: 'auth-pattern',
      content: 'UPDATED: JWT + refresh tokens in httpOnly cookies. Middleware moved to src/auth/middleware.ts.',
      category: 'architecture',
    });
    const recall4 = await callTool(send, 'brain_recall', { query: 'UPDATED' });
    ok('upsert updates existing memory', recall4.count >= 1 && recall4.memories[0].content.includes('UPDATED'));

    const forget = await callTool(send, 'brain_forget', { key: 'db-gotcha' });
    ok('brain_forget removes memory', forget.removed === true);

    const recall5 = await callTool(send, 'brain_recall', { category: 'gotcha' });
    ok('forgotten memory is gone', recall5.count === 0);

    // ── 3. Task DAG ──
    console.log('\n=== Task DAG ===');
    const plan = await callTool(send, 'brain_plan', {
      tasks: [
        { name: 'define-types', description: 'Define TypeScript interfaces for the API' },
        { name: 'implement-api', description: 'Implement the REST endpoints', depends_on: ['define-types'] },
        { name: 'implement-db', description: 'Implement database queries', depends_on: ['define-types'] },
        { name: 'write-tests', description: 'Write integration tests', depends_on: ['implement-api', 'implement-db'] },
      ],
    });
    ok('brain_plan creates plan', plan.plan_id && plan.total_tasks === 4);
    ok('only root task is ready', plan.ready_now.length === 1 && plan.ready_now[0].name === 'define-types');

    const planId = plan.plan_id;

    // Get next tasks
    const next1 = await callTool(send, 'brain_plan_next', { plan_id: planId });
    ok('brain_plan_next returns ready tasks', next1.ready_tasks.length === 1);
    ok('plan progress counts correct', next1.plan_progress.ready === 1 && next1.plan_progress.pending === 3);

    // Start the first task
    const typesTask = plan.tasks.find(t => t.name === 'define-types');
    await callTool(send, 'brain_plan_update', {
      task_id: typesTask.id, status: 'running', agent_name: 'types-agent',
    });

    const status1 = await callTool(send, 'brain_plan_status', { plan_id: planId });
    ok('running task tracked', status1.running === 1);

    // Complete first task — should unlock api and db
    await callTool(send, 'brain_plan_update', {
      task_id: typesTask.id, status: 'done', result: 'Types defined in src/types.ts',
    });

    const next2 = await callTool(send, 'brain_plan_next', { plan_id: planId });
    ok('completing task unlocks dependents', next2.ready_tasks.length === 2);
    const readyNames = next2.ready_tasks.map(t => t.name).sort();
    ok('correct tasks unlocked', readyNames[0] === 'implement-api' && readyNames[1] === 'implement-db');

    // Complete both parallel tasks
    const apiTask = plan.tasks.find(t => t.name === 'implement-api');
    const dbTask = plan.tasks.find(t => t.name === 'implement-db');
    await callTool(send, 'brain_plan_update', { task_id: apiTask.id, status: 'done', result: 'API done' });
    await callTool(send, 'brain_plan_update', { task_id: dbTask.id, status: 'done', result: 'DB done' });

    const next3 = await callTool(send, 'brain_plan_next', { plan_id: planId });
    ok('all parents done unlocks final task', next3.ready_tasks.length === 1 && next3.ready_tasks[0].name === 'write-tests');

    // Complete final task
    const testTask = plan.tasks.find(t => t.name === 'write-tests');
    await callTool(send, 'brain_plan_update', { task_id: testTask.id, status: 'done', result: 'Tests pass' });

    const finalStatus = await callTool(send, 'brain_plan_status', { plan_id: planId });
    ok('all tasks done', finalStatus.done === 4 && finalStatus.total === 4);

    // Test failure cascade
    console.log('\n=== Failure Cascade ===');
    const plan2 = await callTool(send, 'brain_plan', {
      tasks: [
        { name: 'step-a', description: 'First step' },
        { name: 'step-b', description: 'Depends on A', depends_on: ['step-a'] },
        { name: 'step-c', description: 'Depends on B', depends_on: ['step-b'] },
      ],
    });
    const stepA = plan2.tasks.find(t => t.name === 'step-a');
    await callTool(send, 'brain_plan_update', { task_id: stepA.id, status: 'failed', result: 'Crashed' });

    const status2 = await callTool(send, 'brain_plan_status', { plan_id: plan2.plan_id });
    const skipped = status2.tasks.filter(t => t.status === 'skipped');
    ok('failure cascades — both dependents skipped', status2.failed === 1 && skipped.length === 2);

    // List all plans
    const allPlans = await callTool(send, 'brain_plan_status', {});
    ok('brain_plan_status lists all plans', allPlans.plans.length >= 2);

    // ── 4. Agent Metrics ──
    console.log('\n=== Agent Metrics ===');
    const metric1 = await callTool(send, 'brain_metric_record', {
      agent_name: 'worker-1', outcome: 'success',
      task_description: 'Implement auth middleware',
      duration_seconds: 120, gate_passes: 2, tsc_errors: 3, files_changed: 4,
    });
    ok('brain_metric_record stores metric', metric1.ok && metric1.metric_id);

    await callTool(send, 'brain_metric_record', {
      agent_name: 'worker-1', outcome: 'success',
      duration_seconds: 90, gate_passes: 1, tsc_errors: 0, files_changed: 2,
    });
    await callTool(send, 'brain_metric_record', {
      agent_name: 'worker-2', outcome: 'failed',
      duration_seconds: 300, gate_passes: 5, tsc_errors: 12,
    });

    const metrics = await callTool(send, 'brain_metrics', {});
    ok('brain_metrics returns summary', metrics.summary.length === 2);
    const w1 = metrics.summary.find(s => s.agent_name === 'worker-1');
    ok('summary tracks success count', w1 && w1.total_tasks === 2 && w1.successes === 2);

    const w2metrics = await callTool(send, 'brain_metrics', { agent_name: 'worker-2' });
    ok('brain_metrics filters by agent', w2metrics.metrics.length === 1 && w2metrics.metrics[0].outcome === 'failed');

    // ── 5. brain_wake schema validation ──
    console.log('\n=== brain_wake Schema ===');
    ok('wake has 6 params', wakeProps.length === 6);
    ok('wake layouts: horizontal/vertical/tiled/window/headless',
      layoutEnum.length === 5 &&
      layoutEnum.includes('headless') &&
      layoutEnum.includes('horizontal') &&
      layoutEnum.includes('tiled'));

    // ── 6. Respawn (missing agent) ──
    console.log('\n=== Auto-Recovery ===');
    const respawn = await callTool(send, 'brain_respawn', { agent_name: 'nonexistent-agent' });
    ok('brain_respawn handles missing agent gracefully', respawn.ok === false);

    // ── 7. Verify original tools still work ──
    console.log('\n=== Original Tools ===');
    const status = await callTool(send, 'brain_status', {});
    ok('brain_status works', status.self && status.room);

    const agents = await callTool(send, 'brain_agents', {});
    ok('brain_agents works', agents.total >= 1);

    // Set/get state
    await callTool(send, 'brain_set', { key: 'test-key', value: 'test-value' });
    const state = await callTool(send, 'brain_get', { key: 'test-key' });
    ok('brain_set/get works', state.found && state.value === 'test-value');

    // Claim/release
    const claim = await callTool(send, 'brain_claim', { resource: 'src/test.ts' });
    ok('brain_claim works', claim.claimed === true);
    const release = await callTool(send, 'brain_release', { resource: 'src/test.ts' });
    ok('brain_release works', release.released === true);

    // Post/read
    await callTool(send, 'brain_post', { content: 'hello from test' });
    const msgs = await callTool(send, 'brain_read', {});
    ok('brain_post/read works', msgs.length >= 1 && msgs.some(m => m.content === 'hello from test'));

    // ── Summary ──
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  ${passed.length} passed, ${failed.length} failed out of ${passed.length + failed.length} tests`);
    if (failed.length > 0) {
      console.log(`\n  Failed:`);
      for (const f of failed) console.log(`    ✗ ${f}`);
    } else {
      console.log(`\n  All tests passed!`);
    }
    console.log(`${'═'.repeat(50)}\n`);

  } finally {
    proc.kill();
    try { unlinkSync(DB_PATH); } catch {}
    try { unlinkSync(DB_PATH + '-wal'); } catch {}
    try { unlinkSync(DB_PATH + '-shm'); } catch {}
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
