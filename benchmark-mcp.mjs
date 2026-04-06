#!/usr/bin/env node
/**
 * MCP Tool Latency Benchmark
 * Direct stdio JSON-RPC — no SDK dependency.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function main() {
  return new Promise((resolveMain, rejectMain) => {
    const proc = spawn('node', ['dist/index.js'], {
      cwd: '/Users/devgwardo/brain-mcp',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const pending = new Map();
    let buffer = '';

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        if (!raw.trim()) continue;
        try {
          const msg = JSON.parse(raw);
          const resolvers = pending.get(msg.id);
          if (resolvers) {
            pending.delete(msg.id);
            clearTimeout(resolvers.timeout);
            resolvers.resolve(msg);
          }
        } catch {}
      }
    });

    proc.on('error', rejectMain);

    const call = (method, params = {}) => {
      return new Promise((resolve, reject) => {
        const id = randomUUID().slice(0, 8);
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timeout`));
        }, 5000);
        pending.set(id, { resolve, timeout });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    };

    // Initialize
    call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'benchmark', version: '1.0' }
    }).then(() => {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      setTimeout(runBench, 300);
    }).catch(rejectMain);

    async function runBench() {
      const tools = ['brain_status', 'brain_sessions', 'brain_keys', 'brain_claims', 'brain_metrics'];
      const callsPerTool = 30;

      console.log(`\n═══ MCP Tool Layer (stdio JSON-RPC, ${callsPerTool} calls each) ═══\n`);

      for (const tool of tools) {
        const times = [];
        for (let i = 0; i < callsPerTool; i++) {
          const start = performance.now();
          try {
            await call('tools/call', { name: tool, arguments: {} });
            times.push(performance.now() - start);
          } catch (e) {
            times.push(performance.now() - start);
          }
          await new Promise(r => setTimeout(r, 20));
        }

        if (times.length > 0) {
          times.sort((a, b) => a - b);
          const avg = times.reduce((a, b) => a + b, 0) / times.length;
          const p50 = times[Math.floor(times.length * 0.5)];
          const p95 = times[Math.floor(times.length * 0.95)];
          const min = times[0];
          const max = times[times.length - 1];
          console.log(
            `  ${tool.padEnd(25)} avg: ${avg.toFixed(1).padStart(6)}ms  ` +
            `p50: ${p50.toFixed(1).padStart(5)}ms  p95: ${p95.toFixed(1).padStart(5)}ms  ` +
            `min: ${min.toFixed(1).padStart(5)}ms  max: ${max.toFixed(1).padStart(5)}ms`
          );
        }
      }

      proc.kill();
      console.log('\n  note: includes JSON-RPC framing + stdio IPC + tool execution + SQLite query\n');
      resolveMain();
    }
  });
}

main().then(() => process.exit(0)).catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
