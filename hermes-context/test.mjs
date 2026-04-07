#!/usr/bin/env node
/**
 * hermes-context e2e test suite — exercises context_set, context_get,
 * context_delete, context_list, context_search, and context_clear tools
 * via JSON-RPC over stdio.
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), `hermes-context-test-${Date.now()}`);
mkdirSync(TEST_DIR, { recursive: true });

let reqId = 1;

function startServer() {
  const proc = spawn(
    'node',
    ['dist/index.js'],
    {
      env: { ...process.env, HERMES_CONTEXT_DIR: TEST_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

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
  console.log('Starting hermes-context test server...\n');
  const { proc, send, notify } = startServer();

  try {
    // Initialize
    const initResult = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hermes-context-test', version: '1.0' },
    });
    notify('notifications/initialized', {});
    await new Promise((r) => setTimeout(r, 200));
    console.log(
      `Server initialized: ${initResult.serverInfo?.name} v${initResult.serverInfo?.version}\n`
    );

    // List tools
    const toolList = await send('tools/list', {});
    const toolNames = toolList.tools.map((t) => t.name);
    console.log(`Tools loaded: ${toolNames.join(', ')}\n`);

    // ── 1. Tool Registration ──
    console.log('=== Tool Registration ===');
    ok('context_set registered', toolNames.includes('context_set'));
    ok('context_get registered', toolNames.includes('context_get'));
    ok('context_delete registered', toolNames.includes('context_delete'));
    ok('context_list registered', toolNames.includes('context_list'));
    ok('context_search registered', toolNames.includes('context_search'));
    ok('context_clear registered', toolNames.includes('context_clear'));

    // ── 2. context_set — basic store ──
    console.log('\n=== Context Set ===');

    const set1 = await callTool(send, 'context_set', {
      key: 'auth-pattern',
      value:
        'JWT with refresh tokens stored in httpOnly cookies. Middleware in src/auth.ts.',
      tags: ['auth', 'architecture'],
    });
    ok('context_set stores entry', set1.ok && set1.key === 'auth-pattern');
    ok('context_set reports created: true for new key', set1.created === true);
    ok('context_set returns tags', Array.isArray(set1.tags) && set1.tags.includes('auth'));

    const set2 = await callTool(send, 'context_set', {
      key: 'db-gotcha',
      value:
        'users table has a soft-delete column "deleted_at" — always filter by deleted_at IS NULL.',
      tags: ['database', 'gotcha'],
    });
    ok('context_set stores second entry', set2.ok && set2.key === 'db-gotcha');

    // Overwrite existing key (upsert)
    const setUpdate = await callTool(send, 'context_set', {
      key: 'auth-pattern',
      value: 'UPDATED: JWT middleware moved to src/auth/middleware.ts',
      tags: ['auth', 'architecture', 'updated'],
    });
    ok('context_set updates existing entry', setUpdate.ok && setUpdate.updated === true);
    ok('context_set marks existing as not created', setUpdate.created === false);
    ok('context_set merges tags on update', setUpdate.tags.includes('updated'));

    // Set without tags
    const setNoTags = await callTool(send, 'context_set', {
      key: 'simple-key',
      value: 'A simple value with no tags',
    });
    ok('context_set works without tags', setNoTags.ok && setNoTags.key === 'simple-key');
    ok('context_set defaults tags to empty array', Array.isArray(setNoTags.tags));

    // ── 3. context_get ──
    console.log('\n=== Context Get ===');

    const getByKey = await callTool(send, 'context_get', { key: 'auth-pattern' });
    ok('context_get retrieves by key', getByKey.ok && getByKey.key === 'auth-pattern');
    ok('context_get returns stored value', getByKey.value.includes('UPDATED'));
    ok('context_get returns created_at', typeof getByKey.created_at === 'string');
    ok('context_get returns updated_at', typeof getByKey.updated_at === 'string');
    ok('context_get returns tags', Array.isArray(getByKey.tags));

    // Get non-existent key
    const getMissing = await callTool(send, 'context_get', { key: 'nonexistent-key-xyz' });
    ok('context_get returns ok:false for missing key', getMissing.ok === false);
    ok('context_get returns error message for missing key', getMissing.error === 'Key not found');

    // ── 4. context_list ──
    console.log('\n=== Context List ===');

    const listAll = await callTool(send, 'context_list', {});
    ok('context_list returns count', typeof listAll.count === 'number');
    ok('context_list returns entries array', Array.isArray(listAll.entries));
    ok('context_list includes our entries', listAll.entries.length >= 3);

    // List with tag filter (tag is a string, not array)
    const listByTag = await callTool(send, 'context_list', { tag: 'gotcha' });
    ok('context_list filters by tag', listByTag.count >= 1);
    ok('context_list filtered entries all have gotcha tag', listByTag.entries.every((e) => e.tags.includes('gotcha')));

    // List with limit
    const listLimited = await callTool(send, 'context_list', { limit: 2 });
    ok('context_list respects limit', listLimited.entries.length <= 2);

    // ── 5. context_search ──
    console.log('\n=== Context Search ===');

    const searchUpdated = await callTool(send, 'context_search', { pattern: 'UPDATED' });
    ok('context_search finds by value substring', searchUpdated.count >= 1);
    ok('context_search results match pattern', searchUpdated.pattern === 'UPDATED');
    ok('context_search returns matching entries', searchUpdated.entries.length >= 1);
    ok('searched entries contain pattern in key or value', searchUpdated.entries.every(
      (e) => e.key.toLowerCase().includes('updated') || e.value.toLowerCase().includes('updated')
    ));

    const searchMiddleware = await callTool(send, 'context_search', { pattern: 'middleware' });
    ok('context_search finds auth-pattern by value keyword', searchMiddleware.count >= 1);
    ok('search result contains middleware', searchMiddleware.entries.some((e) => e.value.includes('middleware')));

    const searchGotcha = await callTool(send, 'context_search', { pattern: 'gotcha' });
    ok('context_search finds by key substring', searchGotcha.count >= 1);
    ok('search results include db-gotcha', searchGotcha.entries.some((e) => e.key === 'db-gotcha'));

    // Search with limit — push several entries first
    for (let i = 0; i < 5; i++) {
      await callTool(send, 'context_set', { key: `search-limit-${i}`, value: `value ${i}`, tags: ['search-test'] });
    }
    const searchLimited = await callTool(send, 'context_search', { pattern: 'search-limit', limit: 3 });
    ok('context_search respects limit', searchLimited.entries.length <= 3);

    // ── 6. context_delete ──
    console.log('\n=== Context Delete ===');

    const deleteOk = await callTool(send, 'context_delete', { key: 'simple-key' });
    ok('context_delete returns ok: true', deleteOk.ok === true);
    ok('context_delete reports deleted: true for existing key', deleteOk.deleted === true);

    const deleteMissing = await callTool(send, 'context_delete', { key: 'nonexistent-key-xyz' });
    ok('context_delete returns ok: true even for missing key', deleteMissing.ok === true);
    ok('context_delete reports deleted: false for missing key', deleteMissing.deleted === false);

    // Verify deletion
    const getAfterDelete = await callTool(send, 'context_get', { key: 'simple-key' });
    ok('context_delete actually removes entry', getAfterDelete.ok === false);

    // ── 7. context_clear ──
    console.log('\n=== Context Clear ===');

    // Attempt clear without confirm
    const clearNoConfirm = await callTool(send, 'context_clear', { confirm: false });
    ok('context_clear rejects confirm: false', clearNoConfirm.ok === false);
    ok('context_clear returns error message', clearNoConfirm.error === 'confirm must be true');

    // Do clear with confirm: true
    const clearAll = await callTool(send, 'context_clear', { confirm: true });
    ok('context_clear returns ok: true', clearAll.ok === true);
    ok('context_clear returns cleared count', typeof clearAll.cleared === 'number');

    // Verify context is empty
    const listAfterClear = await callTool(send, 'context_list', {});
    ok('context_clear actually empties the store', listAfterClear.count === 0);

    // ── 8. Schema validation ──
    console.log('\n=== Schema Validation ===');

    const setSchema = toolList.tools.find((t) => t.name === 'context_set');
    const setProps = Object.keys(setSchema?.inputSchema?.properties || {});
    ok('context_set has key param', setProps.includes('key'));
    ok('context_set has value param', setProps.includes('value'));
    ok('context_set has optional tags param', setProps.includes('tags'));

    const getSchema = toolList.tools.find((t) => t.name === 'context_get');
    const getProps = Object.keys(getSchema?.inputSchema?.properties || {});
    ok('context_get has key param', getProps.includes('key'));

    const searchSchema = toolList.tools.find((t) => t.name === 'context_search');
    const searchProps = Object.keys(searchSchema?.inputSchema?.properties || {});
    ok('context_search has pattern param', searchProps.includes('pattern'));

    const clearSchema = toolList.tools.find((t) => t.name === 'context_clear');
    const clearProps = Object.keys(clearSchema?.inputSchema?.properties || {});
    ok('context_clear has confirm param', clearProps.includes('confirm'));

    // ── Summary ──
    console.log(`\n${'═'.repeat(50)}`);
    console.log(
      `  ${passed.length} passed, ${failed.length} failed out of ${passed.length + failed.length} tests`
    );
    if (failed.length > 0) {
      console.log(`\n  Failed:`);
      for (const f of failed) console.log(`    ✗ ${f}`);
    } else {
      console.log(`\n  All tests passed!`);
    }
    console.log(`${'═'.repeat(50)}\n`);
  } finally {
    proc.kill();
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
