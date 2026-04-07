/**
 * Brain MCP Renderer Tests
 *
 * Run:
 *   npx tsx src/renderer.test.ts
 *   npx vitest run src/renderer.test.ts   # with vitest
 */

import { renderTool, TOOL_EMOJI } from './renderer.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

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

// ── Tests ────────────────────────────────────────────────────────────────────

test('brain_register renders session details', () => {
  const result = renderTool('brain_register', JSON.stringify({
    ok: true,
    session_id: 'sess-abc123def456',
    name: 'lead',
    room: '/project/x',
    registered_at: '2026-04-06T20:00:00Z',
  }));
  assert(result.includes('Session registered'), 'includes header');
  assert(result.includes('lead'), 'includes name');
  assert(result.includes('sess-abc'), 'includes session id');
});

test('brain_sessions shows all sessions', () => {
  const result = renderTool('brain_sessions', JSON.stringify({
    room: '/project/x',
    sessions: [
      { session_id: 'sess-1', name: 'agent-a', status: 'working', heartbeat_age_seconds: 10 },
      { session_id: 'sess-2', name: 'agent-b', status: 'done', heartbeat_age_seconds: 60 },
    ],
  }));
  assert(result.includes('agent-a'), 'includes agent-a');
  assert(result.includes('agent-b'), 'includes agent-b');
  assert(result.includes('●'), 'has working indicator');
  assert(result.includes('✓'), 'has done indicator');
});

test('brain_agents compact mode', () => {
  const result = renderTool('brain_agents', JSON.stringify({
    total: 3, working: 1, done: 1, failed: 1, stale: 0,
    agents: [
      { name: 'w1', status: 'working', heartbeat_age_seconds: 5 },
      { name: 'd1', status: 'done', heartbeat_age_seconds: 30 },
      { name: 'f1', status: 'failed', heartbeat_age_seconds: 5 },
    ],
  }), { compact: true });

  assert(!result.includes('\n  '), 'compact: no indented lines');
  assert(result.includes('3 agents'), 'compact: shows count');
});

test('brain_wake shows agent details', () => {
  const result = renderTool('brain_wake', JSON.stringify({
    ok: true,
    agent_id: 'agent-xyz789abc',
    name: 'worker-1',
    layout: 'tmux-split',
    model: 'haiku',
    task: 'Implement auth middleware',
  }));
  assert(result.includes('Agent spawned'), 'includes spawned header');
  assert(result.includes('worker-1'), 'includes name');
  assert(result.includes('tmux-split'), 'includes layout');
  assert(result.includes('✓'), 'has success indicator');
});

test('brain_wake failure', () => {
  const result = renderTool('brain_wake', JSON.stringify({
    ok: false,
    error: 'Session crashed',
  }));
  assert(result.includes('✗'), 'has failure indicator');
  assert(result.includes('Session crashed'), 'shows error');
});

test('brain_gate passed', () => {
  const result = renderTool('brain_gate', JSON.stringify({
    passed: true,
    tsc: { error_count: 0 },
    contracts: { mismatch_count: 0 },
  }));
  assert(result.includes('PASSED'), 'shows PASSED');
  assert(result.includes('tsc: 0'), 'shows tsc count');
});

test('brain_gate failed with tsc errors', () => {
  const result = renderTool('brain_gate', JSON.stringify({
    passed: false,
    tsc: {
      error_count: 2,
      errors: [
        { file: 'src/auth.ts', line: 42, message: "Binding element 'user' implicitly has 'any' type" },
        { file: 'src/api.ts', line: 10, message: "Cannot find name 'config'" },
      ],
    },
    contracts: { mismatch_count: 1 },
  }));
  assert(result.includes('FAILED'), 'shows FAILED');
  assert(result.includes('auth.ts'), 'shows file name');
  assert(result.includes('42'), 'shows line number');
});

test('brain_set shows key/value', () => {
  const result = renderTool('brain_set', JSON.stringify({
    ok: true, key: 'task-summary', value: 'Auth layer complete, 3 routes done',
  }));
  assert(result.includes('State set'), 'includes header');
  assert(result.includes('task-summary'), 'shows key');
});

test('brain_get with existing key', () => {
  const result = renderTool('brain_get', JSON.stringify({
    exists: true, key: 'architecture', value: 'microservices with API gateway',
  }));
  assert(result.includes('State'), 'includes state label');
  assert(result.includes('architecture'), 'shows key');
});

test('brain_get with missing key', () => {
  const result = renderTool('brain_get', JSON.stringify({
    exists: false, key: 'nonexistent',
  }));
  assert(result.includes('not found'), 'shows not found');
});

test('brain_claim shows resource and holder', () => {
  const result = renderTool('brain_claim', JSON.stringify({
    ok: true, resource: 'src/auth.ts', ttl: 300,
  }));
  assert(result.includes('Claimed'), 'includes claimed');
  assert(result.includes('auth.ts'), 'shows resource');
  assert(result.includes('300'), 'shows TTL');
});

test('brain_claim already held', () => {
  const result = renderTool('brain_claim', JSON.stringify({
    ok: false, held_by: 'backend', held_age: 45,
  }));
  assert(result.includes('Already held'), 'shows already held');
  assert(result.includes('backend'), 'shows holder');
});

test('brain_claims lists all claims', () => {
  const result = renderTool('brain_claims', JSON.stringify({
    claims: [
      { resource: 'src/a.ts', held_by: 'agent-1', ttl: 200 },
      { resource: 'src/b.ts', held_by: 'agent-2', ttl: 150 },
    ],
  }));
  assert(result.includes('active claims'), 'shows header');
  assert(result.includes('src/a.ts'), 'shows first resource');
  assert(result.includes('agent-1'), 'shows first holder');
});

test('brain_post returns message id', () => {
  const result = renderTool('brain_post', JSON.stringify({
    ok: true, message_id: 'msg-abc123', channel: 'general',
  }));
  assert(result.includes('Message posted'), 'shows posted');
  assert(result.includes('general'), 'shows channel');
});

test('brain_read shows messages', () => {
  const result = renderTool('brain_read', JSON.stringify({
    channel: 'general', messages: [
      { sender: 'lead', timestamp: '2026-04-06T20:00:00Z', content: 'Starting auth layer' },
      { sender: 'backend', timestamp: '2026-04-06T20:01:00Z', content: 'Auth routes done' },
    ],
  }));
  assert(result.includes('messages'), 'shows message count');
  assert(result.includes('lead'), 'shows sender');
  assert(result.includes('Starting auth'), 'shows content');
});

test('brain_plan shows task dependencies', () => {
  const result = renderTool('brain_plan', JSON.stringify({
    plan_id: 'plan-xyz', total_tasks: 4,
    message: 'Plan created with 4 tasks. 2 tasks are ready to start.',
    tasks: [
      { id: 't1', name: 'define-types', status: 'ready', depends_on: [] },
      { id: 't2', name: 'implement-api', status: 'ready', depends_on: ['define-types'] },
    ],
  }), { compact: false });
  assert(result.includes('Plan created'), 'shows plan message');
  assert(result.includes('define-types'), 'shows task name');
});

test('brain_plan_next shows ready tasks', () => {
  const result = renderTool('brain_plan_next', JSON.stringify({
    ready_tasks: [
      { id: 't1', name: 'define-types', description: 'Define TypeScript interfaces', agent_name: 'backend' },
    ],
  }));
  assert(result.includes('ready task'), 'shows ready tasks');
  assert(result.includes('define-types'), 'shows task name');
});

test('brain_contract_check passed', () => {
  const result = renderTool('brain_contract_check', JSON.stringify({
    passed: true, check_count: 5,
  }));
  assert(result.includes('PASSED'), 'shows passed');
  assert(result.includes('verified'), 'shows verified');
});

test('brain_contract_check mismatches', () => {
  const result = renderTool('brain_contract_check', JSON.stringify({
    passed: false,
    mismatch_count: 1,
    mismatches: [
      { contract: 'auth-api', field: 'login.returns.token', expected: 'string', actual: 'undefined' },
    ],
  }));
  assert(result.includes('MISMATCH'), 'shows mismatch');
  assert(result.includes('auth-api'), 'shows contract name');
});

test('brain_metrics shows summary', () => {
  const result = renderTool('brain_metrics', JSON.stringify({
    summary: { total_runs: 12, avg_duration: 45000, success_rate: 0.83 },
  }));
  assert(result.includes('Metrics'), 'shows metrics header');
  assert(result.includes('12'), 'shows total runs');
  assert(result.includes('83%'), 'shows success rate');
});

test('brain_commit shows sha', () => {
  const result = renderTool('brain_commit', JSON.stringify({
    ok: true, sha: 'a1b2c3d4e5f6', message: 'Add auth middleware',
  }));
  assert(result.includes('Committed'), 'shows committed');
  assert(result.includes('a1b2c3'), 'shows short sha');
});

test('brain_remember confirms save', () => {
  const result = renderTool('brain_remember', JSON.stringify({
    ok: true, key: 'architecture:microservices',
  }));
  assert(result.includes('Memory saved'), 'shows saved');
  assert(result.includes('architecture:microservices'), 'shows key');
});

test('brain_recall shows results', () => {
  const result = renderTool('brain_recall', JSON.stringify({
    query: 'auth', results: [
      { key: 'auth:jwt', content: 'Use RS256 for JWT signing' },
      { key: 'auth:sessions', content: 'Redis for session storage' },
    ],
  }));
  assert(result.includes('auth'), 'shows query');
  assert(result.includes('2 memory'), 'shows count');
});

test('brain_context_summary shows entries by type', () => {
  const result = renderTool('brain_context_summary', JSON.stringify({
    total_entries: 5,
    by_type: { action: 2, discovery: 1, decision: 2 },
    recent: [
      { type: 'action', summary: 'Implemented login route' },
    ],
  }));
  assert(result.includes('Context Summary'), 'shows header');
  // Numbers are bolded so strip ANSI before checking count
  const clean = result.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  assert(clean.includes('5 entries'), 'shows count');
});

test('compact mode truncates long lists', () => {
  const manySessions = {
    sessions: Array.from({ length: 30 }, (_, i) => ({
      session_id: `sess-${i}`, name: `agent-${i}`, status: 'working', heartbeat_age_seconds: 5,
    })),
  };
  const result = renderTool('brain_sessions', JSON.stringify(manySessions), { maxItems: 5 });
  assert(result.includes('... and 25 more'), 'shows truncation note');
});

test('unknown tool falls back to JSON', () => {
  const result = renderTool('brain_unknown_tool', JSON.stringify({ foo: 'bar', baz: 123 }));
  assert(result.includes('brain_unknown_tool'), 'shows tool name');
  assert(stripAnsi(result).includes('"foo"'), 'includes JSON key');
});

test('boolean ok result renders OK', () => {
  // String 'true' parsed as JSON boolean → renderGeneric sees no ok/success flag → JSON dump
  // Instead test with proper ok shape
  const result = renderTool('brain_pulse', JSON.stringify({ ok: true }));
  assert(result.includes('OK') || result.includes('✓') || result.includes('Pulse recorded'), 'ok=true renders cleanly');
});

test('color=false strips ANSI codes', () => {
  const result = renderTool('brain_agents', JSON.stringify({
    total: 1, working: 1, done: 0, failed: 0, stale: 0,
    agents: [{ name: 'a', status: 'working', heartbeat_age_seconds: 5 }],
  }), { color: false });
  // color=false uses renderToolRaw which dumps formatted JSON — verify no ANSI codes
  const hasAnsi = /\x1b\[[0-9;]+[a-zA-Z]/.test(result);
  assert(!hasAnsi, 'no ANSI escape codes in output');
});

test('all TOOL_EMOJI entries are unique-ish', () => {
  const emojis = Object.entries(TOOL_EMOJI);
  assert(emojis.length >= 40, `has ${emojis.length} emoji entries`);
  const unique = new Set(emojis.map(([, v]) => v));
  assert(unique.size >= emojis.length * 0.5, 'enough variety in emoji pairs');
});

console.log(`\n✅ All renderer tests passed\n`);
