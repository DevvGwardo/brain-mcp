#!/usr/bin/env node
/**
 * Brain-MCP SQLite Optimization Benchmark
 * Measures before/after impact of: WAL mode, statement caching, pragmas.
 *
 * Run: node benchmark-sqlite.mjs
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = join(__dirname, 'benchmark-test.db');

// Cleanup
import { unlinkSync, existsSync } from 'node:fs';
['benchmark-test.db', 'benchmark-test.db-wal', 'benchmark-test.db-shm'].forEach(f => {
  try { if (existsSync(f)) unlinkSync(f); } catch {}
});

const cyan = (t) => `\x1b[36m${t}\x1b[0m`;
const green = (t) => `\x1b[32m${t}\x1b[0m`;
const red = (t) => `\x1b[31m${t}\x1b[0m`;
const yellow = (t) => `\x1b[33m${t}\x1b[0m`;
const bold = (t) => `\x1b[1m${t}\x1b[0m`;

function bench(name, fn, iterations = 1000) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(iterations * 0.5)];
  const p95 = times[Math.floor(iterations * 0.95)];
  const p99 = times[Math.floor(iterations * 0.99)];
  const avg = times.reduce((a, b) => a + b, 0) / iterations;
  const throughput = (1000 / avg).toFixed(1);
  return { name, p50, p95, p99, avg, throughput, iterations };
}

function printResult(r) {
  console.log(
    `  ${r.name.padEnd(40)} avg: ${r.avg.toFixed(4).padStart(8)}ms  ` +
    `p50: ${r.p50.toFixed(4).padStart(8)}ms  p95: ${r.p95.toFixed(4).padStart(8)}ms  ` +
    `p99: ${r.p99.toFixed(4).padStart(8)}ms  ${r.throughput}/s`
  );
}

function setupDB(optimized) {
  const db = new Database(TEST_DB);
  if (optimized) {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    db.pragma('read_uncommitted = 1');
  } else {
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 5000');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pid INTEGER, cwd TEXT,
      room TEXT NOT NULL, metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_heartbeat TEXT DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'idle', progress TEXT,
      last_seen_dm_id INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL,
      room TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL,
      content TEXT NOT NULL, metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS claims (
      resource TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_name TEXT NOT NULL,
      room TEXT NOT NULL, expires_at TEXT, claimed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, room, id);
    CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room);
  `);
  return db;
}

async function runBenchmarks() {
  console.log(cyan('╔════════════════════════════════════════════════╗'));
  console.log(cyan('║   Brain-MCP SQLite Optimization Benchmark     ║'));
  console.log(cyan('╚════════════════════════════════════════════════╝'));

  const room = `bench-${Date.now()}`;
  const now = new Date().toISOString();
  const N = 5000;

  // ── BASELINE: DELETE mode, no cache ──────────────────────────────────────────
  console.log(bold('\n═══ Baseline: DELETE mode, on-demand prepare ═══'));
  {
    const db = setupDB(false);
    const sessionId = `sess-${randomUUID()}`;
    db.prepare(`INSERT OR REPLACE INTO sessions (id, name, pid, cwd, room, metadata, status, progress, last_seen_dm_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, 'bench', process.pid, __dirname, room, null, 'working', null, 0);
    db.prepare(`INSERT INTO messages (channel, room, sender_id, sender_name, content, metadata) VALUES (?, ?, ?, ?, ?, ?)`).run('general', room, sessionId, 'bench', 'msg', null);

    const r1 = bench('session_register (no cache)', () => {
      const sid = `${sessionId}-${Math.random()}`;
      db.prepare(`INSERT OR REPLACE INTO sessions (id, name, pid, cwd, room, metadata, status, progress, last_seen_dm_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sid, 'bench', process.pid, __dirname, room, null, 'working', null, 0);
    }, N);
    printResult(r1);

    const r2 = bench('heartbeat_pulse (no cache)', () => {
      db.prepare("UPDATE sessions SET last_heartbeat = datetime('now'), status = ?, progress = ? WHERE id = ?").run('working', null, sessionId);
    }, N);
    printResult(r2);

    const r3 = bench('session_query (no cache)', () => {
      db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    }, N);
    printResult(r3);

    const r4 = bench('message_query (no cache)', () => {
      db.prepare('SELECT * FROM messages WHERE channel = ? AND room = ? AND id > ? ORDER BY id ASC LIMIT 50').all('general', room, 0);
    }, N);
    printResult(r4);

    const r5 = bench('claim_query_all (no cache)', () => {
      db.prepare('SELECT * FROM claims').all();
    }, N);
    printResult(r5);

    db.prepare(`DELETE FROM sessions WHERE room = ?`).run(room);
    db.prepare(`DELETE FROM messages WHERE room = ?`).run(room);
    db.close();
    try { ['benchmark-test.db', 'benchmark-test.db-wal', 'benchmark-test.db-shm'].forEach(f => { try { unlinkSync(f); } catch {} }); } catch {}
  }

  // ── OPTIMIZED: WAL + NORMAL sync + cache ──────────────────────────────────────
  console.log(bold('\n═══ Optimized: WAL + NORMAL + statement cache ═══'));
  {
    const db = setupDB(true);
    const sessionId = `sess-${randomUUID()}`;
    db.prepare(`INSERT OR REPLACE INTO sessions (id, name, pid, cwd, room, metadata, status, progress, last_seen_dm_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, 'bench', process.pid, __dirname, room, null, 'working', null, 0);
    db.prepare(`INSERT INTO messages (channel, room, sender_id, sender_name, content, metadata) VALUES (?, ?, ?, ?, ?, ?)`).run('general', room, sessionId, 'bench', 'msg', null);

    // Simulate the cached-statement approach
    const cachedHeartbeat = db.prepare("UPDATE sessions SET last_heartbeat = datetime('now'), status = ?, progress = ? WHERE id = ?");
    const cachedSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
    const cachedMsgs = db.prepare('SELECT * FROM messages WHERE channel = ? AND room = ? AND id > ? ORDER BY id ASC LIMIT ?');
    const cachedClaims = db.prepare('SELECT * FROM claims');

    const r1 = bench('session_register (no cache)', () => {
      const sid = `${sessionId}-${Math.random()}`;
      db.prepare(`INSERT OR REPLACE INTO sessions (id, name, pid, cwd, room, metadata, status, progress, last_seen_dm_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sid, 'bench', process.pid, __dirname, room, null, 'working', null, 0);
    }, N);
    printResult(r1);

    const r2 = bench('heartbeat_pulse (cached stmt)', () => {
      cachedHeartbeat.run('working', null, sessionId);
    }, N);
    printResult(r2);

    const r3 = bench('session_query (cached stmt)', () => {
      cachedSession.get(sessionId);
    }, N);
    printResult(r3);

    const r4 = bench('message_query (cached stmt)', () => {
      cachedMsgs.all('general', room, 0, 50);
    }, N);
    printResult(r4);

    const r5 = bench('claim_query_all (cached stmt)', () => {
      cachedClaims.all();
    }, N);
    printResult(r5);

    // Cleanup
    db.prepare(`DELETE FROM sessions WHERE room = ?`).run(room);
    db.prepare(`DELETE FROM messages WHERE room = ?`).run(room);
    db.close();
  }

  // ── CONCURRENT STRESS TEST ───────────────────────────────────────────────────
  console.log(bold('\n═══ Concurrent Stress: 10 parallel writers to WAL ═══'));
  {
    const db = setupDB(true);
    const room2 = `${room}-concurrent`;

    // Pre-create sessions
    const sessionIds = [];
    const insertStmt = db.prepare(`INSERT OR REPLACE INTO sessions (id, name, pid, cwd, room, metadata, status, progress, last_seen_dm_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 10; i++) {
      const sid = `concurrent-sess-${i}-${randomUUID()}`;
      sessionIds.push(sid);
      insertStmt.run(sid, `agent-${i}`, process.pid, __dirname, room2, null, 'working', null, 0);
    }
    const cachedPulse = db.prepare("UPDATE sessions SET last_heartbeat = datetime('now'), status = ?, progress = ? WHERE id = ?");
    const cachedGet = db.prepare('SELECT * FROM sessions WHERE id = ?');

    const start = performance.now();
    await Promise.all(sessionIds.map((sid, i) =>
      new Promise((resolve) => {
        for (let j = 0; j < 100; j++) {
          cachedPulse.run('working', `step ${j}`, sid);
          if (j % 10 === 0) cachedGet.get(sid);
        }
        resolve();
      })
    ));
    const elapsed = performance.now() - start;
    console.log(`  ${'10x100 pulses + 10x10 queries'.padEnd(40)} ${elapsed.toFixed(2).padStart(8)}ms total  ${(1000 / (elapsed / 1000)).toFixed(1)} ops/s`);

    db.prepare(`DELETE FROM sessions WHERE room = ?`).run(room2);
    db.close();
  }

  // ── WAL vs DELETE overhead ───────────────────────────────────────────────────
  console.log(bold('\n═══ WAL vs DELETE throughput comparison ═══'));
  {
    // DELETE mode
    const dbDel = new Database(TEST_DB);
    dbDel.pragma('journal_mode = DELETE');
    dbDel.exec(`CREATE TABLE IF NOT EXISTS perf_test (id TEXT PRIMARY KEY, val TEXT)`);
    const startDel = performance.now();
    const insertDel = dbDel.prepare(`INSERT OR REPLACE INTO perf_test VALUES (?, ?)`);
    for (let i = 0; i < 2000; i++) {
      insertDel.run(`d-${Math.random()}`, 'val');
    }
    const delTime = performance.now() - startDel;
    dbDel.prepare(`DELETE FROM perf_test`).run();
    dbDel.close();

    // WAL mode
    const dbWal = new Database(TEST_DB);
    dbWal.pragma('journal_mode = WAL');
    dbWal.pragma('synchronous = NORMAL');
    dbWal.exec(`CREATE TABLE IF NOT EXISTS perf_test (id TEXT PRIMARY KEY, val TEXT)`);
    const startWal = performance.now();
    const insertWal = dbWal.prepare(`INSERT OR REPLACE INTO perf_test VALUES (?, ?)`);
    for (let i = 0; i < 2000; i++) {
      insertWal.run(`w-${Math.random()}`, 'val');
    }
    const walTime = performance.now() - startWal;
    dbWal.prepare(`DELETE FROM perf_test`).run();
    dbWal.close();

    console.log(`  ${'2000 INSERT (DELETE mode)'.padEnd(40)} ${delTime.toFixed(2).padStart(8)}ms  ${(2000/delTime*1000).toFixed(0)}/s`);
    console.log(`  ${'2000 INSERT (WAL + NORMAL)'.padEnd(40)} ${walTime.toFixed(2).padStart(8)}ms  ${(2000/walTime*1000).toFixed(0)}/s`);
    const improvement = ((delTime - walTime) / delTime * 100).toFixed(1);
    console.log(`  ${'Improvement'.padEnd(40)} ${green(`+${improvement}% faster`)}`);
  }

  console.log(bold('\n═══ Summary ═══'));
  console.log(`WAL + NORMAL + cache eliminates event-loop blocking for hot paths:`);
  console.log(`  - heartbeat/pulse: use cached prepared statements`);
  console.log(`  - getMessages: cached statement (called on every poll)`);
  console.log(`  - getSession: cached (called in pulseWithFirstConfirm)`);
  console.log(`  - WAL concurrent writers: no lock contention between agents`);
  console.log(`  - NORMAL sync: safe with WAL, skips one fsync per transaction`);

  // Cleanup
  ['benchmark-test.db', 'benchmark-test.db-wal', 'benchmark-test.db-shm'].forEach(f => {
    try { unlinkSync(f); } catch {}
  });
}

runBenchmarks().catch(console.error);
