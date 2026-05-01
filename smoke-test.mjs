import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const SERVER = '/Users/devgwardo/brain-mcp/dist/index.js';

class MCPClient {
  constructor(proc) {
    this.proc = proc;
    this.pending = new Map();
    this.buf = '';
    proc.stdout.on('data', d => {
      this.buf += d.toString();
      const lines = this.buf.split('\n');
      this.buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && this.pending.has(msg.id)) {
            this.pending.get(msg.id)(msg);
            this.pending.delete(msg.id);
          }
        } catch {}
      }
    });
    proc.stderr.on('data', () => {});
  }
  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = randomUUID();
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ error: { message: 'timeout' } }); } }, 5000);
    });
  }
  async callTool(name, args = {}) {
    const res = await this.send('tools/call', { name, arguments: args });
    if (res.error) return { ok: false, error: res.error };
    return { ok: true, data: res.result };
  }
  close() { this.proc.stdin.end(); }
}

let passed = 0, failed = 0;
const results = [];

function report(name, ok, detail = '') {
  if (ok) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name} ${detail}`); }
}

try {
  const proc = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new MCPClient(proc);

  // Initialize
  const init = await client.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0' }
  });
  report('initialize', !!init.result, init.error?.message || '');
  await client.send('initialized');

  // 1. Register session
  const reg = await client.callTool('register', { name: 'smoke-test-agent' });
  report('register', reg.ok, JSON.stringify(reg.error || ''));

  // 2. Pulse
  const pulse = await client.callTool('pulse', { status: 'working', progress: 'testing brain-mcp' });
  report('pulse', pulse.ok, JSON.stringify(pulse.error || ''));

  // 3. Status
  const status = await client.callTool('status');
  report('status', status.ok, JSON.stringify(status.error || ''));

  // 4. Sessions list
  const sessions = await client.callTool('sessions');
  report('sessions', sessions.ok, JSON.stringify(sessions.error || ''));

  // 5. State: set
  const setRes = await client.callTool('set', { key: 'smoke-test-key', value: 'hello-world' });
  report('state.set', setRes.ok, JSON.stringify(setRes.error || ''));

  // 6. State: get
  const getRes = await client.callTool('get', { key: 'smoke-test-key' });
  const getOk = getRes.ok && JSON.stringify(getRes.data).includes('hello-world');
  report('state.get', getOk, JSON.stringify(getRes));

  // 7. State: keys
  const keysRes = await client.callTool('keys');
  report('state.keys', keysRes.ok, JSON.stringify(keysRes.error || ''));

  // 8. State: delete
  const delRes = await client.callTool('delete', { key: 'smoke-test-key' });
  report('state.delete', delRes.ok, JSON.stringify(delRes.error || ''));

  // 9. Channels: post
  const postRes = await client.callTool('post', { content: 'smoke test message', channel: 'smoke-test' });
  report('channels.post', postRes.ok, JSON.stringify(postRes.error || ''));

  // 10. Channels: read
  const readRes = await client.callTool('read', { channel: 'smoke-test', limit: 5 });
  report('channels.read', readRes.ok, JSON.stringify(readRes.error || ''));

  // 11. Locking: claim
  const claimRes = await client.callTool('claim', { resource: 'smoke-test-file.txt', ttl: 60 });
  report('locking.claim', claimRes.ok, JSON.stringify(claimRes.error || ''));

  // 12. Locking: claims list
  const claimsRes = await client.callTool('claims');
  report('locking.claims', claimsRes.ok, JSON.stringify(claimsRes.error || ''));

  // 13. Locking: release
  const releaseRes = await client.callTool('release', { resource: 'smoke-test-file.txt' });
  report('locking.release', releaseRes.ok, JSON.stringify(releaseRes.error || ''));

  // 14. Agents list
  const agentsRes = await client.callTool('agents');
  report('agents', agentsRes.ok, JSON.stringify(agentsRes.error || ''));

  // 15. Contracts: set
  const contractSet = await client.callTool('contract_set', {
    module: 'smoke-test.ts',
    name: 'testFunc',
    kind: 'provides',
    signature: { params: ['x: number'], returns: 'string' }
  });
  report('contract.set', contractSet.ok, JSON.stringify(contractSet.error || ''));

  // 16. Contracts: get
  const contractGet = await client.callTool('contract_get', { module: 'smoke-test.ts' });
  report('contract.get', contractGet.ok, JSON.stringify(contractGet.error || ''));

  // 17. Planning: plan
  const planRes = await client.callTool('plan', {
    tasks: [
      { name: 'task-a', description: 'First task' },
      { name: 'task-b', description: 'Second task', depends_on: ['task-a'] }
    ]
  });
  report('plan', planRes.ok, JSON.stringify(planRes.error || ''));

  // 18. Planning: plan_status
  const planStatus = await client.callTool('plan_status');
  report('plan_status', planStatus.ok, JSON.stringify(planStatus.error || ''));

  // 19. DM
  const dmRes = await client.callTool('dm', { to: 'smoke-test-agent', content: 'ping' });
  report('dm', dmRes.ok, JSON.stringify(dmRes.error || ''));

  // 20. Inbox
  const inboxRes = await client.callTool('inbox');
  report('inbox', inboxRes.ok, JSON.stringify(inboxRes.error || ''));

  // Cleanup
  client.close();
  proc.kill();
} catch (err) {
  report('FATAL', false, err.message);
}

// Report
console.log('\n=== brain-mcp smoke test ===\n');
results.forEach(r => console.log(r));
console.log(`\n  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
