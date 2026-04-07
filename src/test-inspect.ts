/**
 * brain-inspect — Dump full brain DB state as structured JSON.
 * Usage: npx tsx src/test-inspect.ts [--db <path>]
 */

import { BrainDB } from './db.js';

const dbPath = process.env.BRAIN_DB_PATH || process.argv.find(a => a === '--db') ? process.argv[process.argv.indexOf('--db') + 1] : undefined;

const db = new BrainDB(dbPath);

// Dump everything we can observe from the outside
function inspect(room?: string) {
  const state: any = {
    timestamp: new Date().toISOString(),
    db_path: dbPath || 'default',
    sessions: room ? db.getSessions(room) : db.getSessions(),
    state_entries: [] as any[],
    barriers: [] as any[],
    messages: [] as any[],
    contracts: [] as any[],
  };

  // Collect all scopes (rooms) from sessions
  const rooms = new Set<string>();
  for (const s of state.sessions) rooms.add(s.room);

  for (const r of rooms) {
    for (const key of db.getKeys(r)) {
      const entry = db.getState(key, r);
      if (entry) state.state_entries.push({ ...entry, room: r });
    }
    // @ts-ignore
    const barrierRows = (db as any).db.prepare('SELECT * FROM barriers WHERE scope = ?').all(r) as any[];
    for (const b of barrierRows) state.barriers.push({ ...b, room: r });
    const msgRows = db.getMessages('general', r);
    for (const m of msgRows) state.messages.push(m);
    for (const c of db.getContracts(r)) state.contracts.push(c);
  }

  return state;
}

const output = inspect();
console.log(JSON.stringify(output, null, 2));
