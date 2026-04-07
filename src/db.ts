import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { EmbeddingProvider } from './embeddings.js';

export type SessionStatus = 'idle' | 'working' | 'done' | 'failed';

export interface Session {
  id: string;
  name: string;
  pid: number;
  cwd: string;
  room: string;
  metadata: string | null;
  status: SessionStatus;
  progress: string | null;
  created_at: string;
  last_heartbeat: string;
  exit_code: number | null;
}

export interface AgentHealth {
  id: string;
  name: string;
  status: SessionStatus;
  progress: string | null;
  last_heartbeat: string;
  heartbeat_age_seconds: number;
  is_stale: boolean;
  claims: string[];
}

export interface Message {
  id: number;
  channel: string;
  room: string;
  sender_id: string;
  sender_name: string;
  content: string;
  metadata: string | null;
  created_at: string;
}

export interface DirectMessage {
  id: number;
  from_id: string;
  from_name: string;
  to_id: string;
  content: string;
  metadata: string | null;
  created_at: string;
}

export interface StateEntry {
  key: string;
  scope: string;
  value: string;
  updated_by: string;
  updated_by_name: string;
  updated_at: string;
}

export interface Claim {
  resource: string;
  owner_id: string;
  owner_name: string;
  room: string;
  expires_at: string | null;
  claimed_at: string;
}

export interface ContractEntry {
  module: string;
  name: string;
  kind: 'provides' | 'expects';
  signature: string;
  agent_id: string;
  agent_name: string;
  room: string;
  updated_at: string;
}

export interface ContractMismatch {
  name: string;
  expected_by: string;
  expected_module: string;
  expected_signature: string;
  provided_by: string | null;
  provided_module: string | null;
  provided_signature: string | null;
  issue: 'missing' | 'param_count' | 'param_type' | 'return_type';
  detail: string;
}

// ── Persistent Memory ──

export interface MemoryEntry {
  id: string;
  room: string;
  key: string;
  content: string;
  category: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  access_count: number;
  last_accessed: string | null;
}

// ── Task DAG ──

export type TaskStatus = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'skipped';

export interface TaskNode {
  id: string;
  room: string;
  plan_id: string;
  name: string;
  description: string;
  agent_name: string | null;
  agent_id: string | null;
  status: TaskStatus;
  depends_on: string; // JSON array of task IDs
  result: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface PlanSummary {
  plan_id: string;
  total: number;
  pending: number;
  ready: number;
  running: number;
  done: number;
  failed: number;
  tasks: TaskNode[];
}

// ── Agent Metrics ──

export interface AgentMetric {
  id: number;
  room: string;
  agent_name: string;
  agent_id: string | null;
  model: string | null;
  task_description: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  gate_passes: number;
  tsc_errors: number;
  contract_mismatches: number;
  files_changed: number;
  outcome: string;
  created_at: string;
}

export interface MetricsSummary {
  agent_name: string;
  total_tasks: number;
  successes: number;
  failures: number;
  avg_duration_seconds: number | null;
  avg_gate_passes: number | null;
  avg_tsc_errors: number | null;
}

export interface ModelMetricRow {
  model: string;
  total_tasks: number;
  successes: number;
  failures: number;
  success_rate: number;
  avg_duration: number | null;
  avg_gate_passes: number | null;
  avg_tsc_errors: number | null;
}

// ── Context Ledger ──

export type ContextEntryType = 'action' | 'discovery' | 'decision' | 'error' | 'file_change' | 'checkpoint';

export interface ContextEntry {
  id: number;
  room: string;
  session_id: string;
  agent_name: string;
  entry_type: ContextEntryType;
  summary: string;
  detail: string | null;
  file_path: string | null;
  tags: string; // JSON array
  created_at: string;
}

export interface Checkpoint {
  id: string;
  room: string;
  session_id: string;
  agent_name: string;
  state: string; // JSON
  created_at: string;
}

export class BrainDB {
  private db: Database.Database;
  public readonly events = new EventEmitter();
  private embeddingProvider: EmbeddingProvider | null = null;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || join(homedir(), '.claude', 'brain', 'brain.db');
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pid INTEGER,
        cwd TEXT,
        room TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        last_heartbeat TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        room TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS direct_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL,
        from_name TEXT NOT NULL,
        to_id TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS state (
        key TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'default',
        value TEXT,
        updated_by TEXT NOT NULL,
        updated_by_name TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (key, scope)
      );

      CREATE TABLE IF NOT EXISTS claims (
        resource TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        room TEXT NOT NULL,
        expires_at TEXT,
        claimed_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('provides', 'expects')),
        signature TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        room TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(module, name, kind, room)
      );

      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        created_by TEXT,
        created_by_name TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT
      );

      CREATE TABLE IF NOT EXISTS task_graph (
        id TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        agent_name TEXT,
        agent_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','running','done','failed','skipped')),
        depends_on TEXT NOT NULL DEFAULT '[]',
        result TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        agent_id TEXT,
        task_description TEXT,
        started_at TEXT,
        completed_at TEXT,
        duration_seconds REAL,
        gate_passes INTEGER NOT NULL DEFAULT 0,
        tsc_errors INTEGER NOT NULL DEFAULT 0,
        contract_mismatches INTEGER NOT NULL DEFAULT 0,
        files_changed INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL DEFAULT 'unknown',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, room, id);
      CREATE INDEX IF NOT EXISTS idx_dm_to ON direct_messages(to_id, id);
      CREATE INDEX IF NOT EXISTS idx_dm_from ON direct_messages(from_id, id);
      CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room);
      CREATE INDEX IF NOT EXISTS idx_claims_expires ON claims(expires_at);
      CREATE INDEX IF NOT EXISTS idx_contracts_room ON contracts(room, kind);
      CREATE TABLE IF NOT EXISTS context_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        entry_type TEXT NOT NULL CHECK(entry_type IN ('action','discovery','decision','error','file_change','checkpoint')),
        summary TEXT NOT NULL,
        detail TEXT,
        file_path TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memory_room_key ON memory(room, key);
      CREATE INDEX IF NOT EXISTS idx_memory_room_cat ON memory(room, category);
      CREATE INDEX IF NOT EXISTS idx_task_graph_room ON task_graph(room, plan_id);
      CREATE INDEX IF NOT EXISTS idx_task_graph_status ON task_graph(room, status);
      CREATE INDEX IF NOT EXISTS idx_metrics_room ON agent_metrics(room);
      CREATE INDEX IF NOT EXISTS idx_context_room ON context_ledger(room, session_id, id);
      CREATE INDEX IF NOT EXISTS idx_context_type ON context_ledger(room, entry_type);
      CREATE INDEX IF NOT EXISTS idx_context_file ON context_ledger(room, file_path);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_room ON checkpoints(room, session_id);

      CREATE TABLE IF NOT EXISTS barriers (
        key TEXT NOT NULL,
        scope TEXT NOT NULL,
        threshold INTEGER NOT NULL,
        current INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (key, scope)
      );

      CREATE TABLE IF NOT EXISTS barrier_members (
        barrier_key TEXT NOT NULL,
        barrier_scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        checked_in_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (barrier_key, barrier_scope, session_id)
      );

      CREATE TABLE IF NOT EXISTS task_results (
        task_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        result TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Add status + progress columns (safe to re-run)
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN progress TEXT`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN last_seen_dm_id INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }

    // Add exit_code column to sessions
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN exit_code INTEGER"); } catch { /* already exists */ }

    // Add embedding column to memory
    try { this.db.exec("ALTER TABLE memory ADD COLUMN embedding BLOB"); } catch { /* already exists */ }

    // Add model column to agent_metrics
    try { this.db.exec("ALTER TABLE agent_metrics ADD COLUMN model TEXT"); } catch { /* already exists */ }

    // Add priority column to task_graph
    try { this.db.exec("ALTER TABLE task_graph ADD COLUMN priority INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }

    // Register cosine_similarity function for vector search
    this.db.function('cosine_similarity', { deterministic: true }, (a: unknown, b: unknown) => {
      if (!a || !b || !(a instanceof Buffer) || !(b instanceof Buffer)) return null;
      const va = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
      const vb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
      if (va.length !== vb.length) return null;
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < va.length; i++) {
        dot += va[i] * vb[i];
        normA += va[i] * va[i];
        normB += vb[i] * vb[i];
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      return denom === 0 ? 0 : dot / denom;
    });
  }

  // ── Atomic Counters ──

  incr(key: string, scope: string, delta: number = 1): { old_value: number; new_value: number } {
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO state (key, scope, value, updated_by, updated_by_name, updated_at)
         VALUES (?, ?, ?, 'system', 'atomic-ops', datetime('now'))
         ON CONFLICT(key, scope) DO UPDATE SET
           value = CAST(value AS INTEGER) + ?,
           updated_by = excluded.updated_by,
           updated_by_name = excluded.updated_by_name,
           updated_at = datetime('now')`
      ).run(key, scope, String(delta), delta);
      const row = this.db.prepare('SELECT value FROM state WHERE key = ? AND scope = ?').get(key, scope) as { value: string };
      const newValue = parseInt(row.value, 10) || 0;
      return { old_value: newValue - delta, new_value: newValue };
    });
    return tx();
  }

  decr(key: string, scope: string, delta: number = 1): { old_value: number; new_value: number } {
    return this.incr(key, scope, -delta);
  }

  get_counter(key: string, scope: string): number {
    const entry = this.db.prepare('SELECT value FROM state WHERE key = ? AND scope = ?').get(key, scope) as { value: string } | undefined;
    return entry ? parseInt(entry.value, 10) || 0 : 0;
  }

  // ── Barriers ──

  wait_on(key: string, scope: string, threshold: number, owner_id: string, owner_name: string): { reached: boolean; current: number; threshold: number; already_checked_in: boolean } {
    const tx = this.db.transaction(() => {
      // Upsert barrier — first caller's threshold wins
      this.db.prepare(
        `INSERT INTO barriers (key, scope, threshold, current, created_by)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(key, scope) DO NOTHING`
      ).run(key, scope, threshold, owner_id);

      // Check if this session already checked in
      const alreadyIn = this.db.prepare(
        'SELECT 1 FROM barrier_members WHERE barrier_key = ? AND barrier_scope = ? AND session_id = ?'
      ).get(key, scope, owner_id);

      if (!alreadyIn) {
        this.db.prepare(
          'INSERT INTO barrier_members (barrier_key, barrier_scope, session_id) VALUES (?, ?, ?)'
        ).run(key, scope, owner_id);
        this.db.prepare(
          'UPDATE barriers SET current = current + 1 WHERE key = ? AND scope = ?'
        ).run(key, scope);
      }

      const barrier = this.db.prepare('SELECT * FROM barriers WHERE key = ? AND scope = ?').get(key, scope) as any;
      return {
        reached: barrier.current >= barrier.threshold,
        current: barrier.current,
        threshold: barrier.threshold,
        already_checked_in: !!alreadyIn,
      };
    });
    return tx();
  }

  get_barrier(key: string, scope: string): { key: string; scope: string; threshold: number; current: number; members: string[] } | null {
    const b = this.db.prepare('SELECT * FROM barriers WHERE key = ? AND scope = ?').get(key, scope) as any;
    if (!b) return null;
    const members = this.db.prepare(
      'SELECT session_id FROM barrier_members WHERE barrier_key = ? AND barrier_scope = ?'
    ).all(key, scope) as { session_id: string }[];
    return { key: b.key, scope: b.scope, threshold: b.threshold, current: b.current, members: members.map(m => m.session_id) };
  }

  barrier_reset(key: string, scope: string): { deleted: boolean } {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM barrier_members WHERE barrier_key = ? AND barrier_scope = ?').run(key, scope);
      const changes = this.db.prepare('DELETE FROM barriers WHERE key = ? AND scope = ?').run(key, scope).changes;
      return { deleted: changes > 0 };
    });
    return tx();
  }

  // ── Task Results ──

  set_task_result(task_id: string, plan_id: string, result: string): void {
    this.db.prepare('INSERT OR REPLACE INTO task_results (task_id, plan_id, result, created_at) VALUES (?, ?, ?, datetime(\'now\'))').run(task_id, plan_id, result);
  }

  get_task_result(task_id: string): string | null {
    const r = this.db.prepare('SELECT result FROM task_results WHERE task_id = ?').get(task_id) as { result: string } | undefined;
    return r?.result || null;
  }

  // ── Session Management ──

  registerSession(name: string, room: string, metadata?: string, id: string = randomUUID()): string {
    this.db.prepare(
      `INSERT INTO sessions (id, name, pid, cwd, room, metadata)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         pid = excluded.pid,
         cwd = excluded.cwd,
         room = excluded.room,
         metadata = excluded.metadata`
    ).run(id, name, process.pid, process.cwd(), room, metadata || null);
    return id;
  }

  removeSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM claims WHERE owner_id = ?').run(id);
  }

  releaseAllClaims(ownerId: string): number {
    return this.db.prepare('DELETE FROM claims WHERE owner_id = ?').run(ownerId).changes;
  }

  heartbeat(id: string): boolean {
    return this.db.prepare(
      "UPDATE sessions SET last_heartbeat = datetime('now') WHERE id = ?"
    ).run(id).changes > 0;
  }

  pulse(id: string, status: SessionStatus, progress?: string): boolean {
    const ok = this.db.prepare(
      `UPDATE sessions SET last_heartbeat = datetime('now'), status = ?, progress = ? WHERE id = ?`
    ).run(status, progress || null, id).changes > 0;
    if (ok) this.events.emit('pulse', { id, status, progress });
    return ok;
  }

  /** Remove sessions with no heartbeat for over 5 minutes and their orphaned claims. */
  pruneStaleSessions(): number {
    const result = this.db.prepare(
      `DELETE FROM sessions WHERE last_heartbeat < datetime('now', '-5 minutes')`
    ).run();
    if (result.changes > 0) {
      // Clean up orphaned claims from deleted sessions
      this.db.prepare(
        `DELETE FROM claims WHERE owner_id NOT IN (SELECT id FROM sessions)`
      ).run();
    }
    return result.changes;
  }

  getAgentHealth(room?: string): AgentHealth[] {
    this.pruneStaleSessions();
    this.pruneClaims();
    const filter = room ? `WHERE room = ?` : ``;
    const params = room ? [room] : [];

    const sessions = this.db.prepare(
      `SELECT *, CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER) AS heartbeat_age_seconds
       FROM sessions ${filter} ORDER BY created_at`
    ).all(...params) as Array<Session & { heartbeat_age_seconds: number }>;

    const allClaims = this.db.prepare('SELECT resource, owner_id FROM claims').all() as Array<{ resource: string; owner_id: string }>;
    const claimsByOwner = new Map<string, string[]>();
    for (const c of allClaims) {
      const list = claimsByOwner.get(c.owner_id) || [];
      list.push(c.resource);
      claimsByOwner.set(c.owner_id, list);
    }

    return sessions.map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      progress: s.progress,
      last_heartbeat: s.last_heartbeat,
      heartbeat_age_seconds: s.heartbeat_age_seconds,
      is_stale: s.heartbeat_age_seconds > 60,
      claims: claimsByOwner.get(s.id) || [],
    }));
  }

  updateSessionName(id: string, name: string): void {
    this.db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
  }

  getSession(id: string): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  }

  getSessions(room?: string): Session[] {
    this.pruneStaleSessions();
    if (room) {
      return this.db.prepare(
        "SELECT * FROM sessions WHERE room = ? AND last_heartbeat > datetime('now', '-5 minutes') ORDER BY created_at"
      ).all(room) as Session[];
    }
    return this.db.prepare(
      "SELECT * FROM sessions WHERE last_heartbeat > datetime('now', '-5 minutes') ORDER BY created_at"
    ).all() as Session[];
  }

  set_exit_code(session_id: string, exit_code: number): void {
    this.db.prepare('UPDATE sessions SET exit_code = ? WHERE id = ?').run(exit_code, session_id);
  }

  // ── Channel Messaging ──

  postMessage(
    channel: string, room: string,
    senderId: string, senderName: string,
    content: string, metadata?: string
  ): number {
    const result = this.db.prepare(
      'INSERT INTO messages (channel, room, sender_id, sender_name, content, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(channel, room, senderId, senderName, content, metadata || null);
    this.events.emit('message', { channel, room, sender_name: senderName, content });
    return Number(result.lastInsertRowid);
  }

  getMessages(channel: string, room: string, sinceId?: number, limit?: number): Message[] {
    return this.db.prepare(
      'SELECT * FROM messages WHERE channel = ? AND room = ? AND id > ? ORDER BY id ASC LIMIT ?'
    ).all(channel, room, sinceId || 0, limit || 50) as Message[];
  }

  // ── Direct Messages ──

  sendDM(fromId: string, fromName: string, toId: string, content: string, metadata?: string): number {
    const result = this.db.prepare(
      'INSERT INTO direct_messages (from_id, from_name, to_id, content, metadata) VALUES (?, ?, ?, ?, ?)'
    ).run(fromId, fromName, toId, content, metadata || null);
    return Number(result.lastInsertRowid);
  }

  getInbox(sessionId: string, sinceId?: number): DirectMessage[] {
    return this.db.prepare(
      'SELECT * FROM direct_messages WHERE (to_id = ? OR from_id = ?) AND id > ? ORDER BY id ASC'
    ).all(sessionId, sessionId, sinceId || 0) as DirectMessage[];
  }

  consumeInbox(sessionId: string, limit = 50): DirectMessage[] {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT last_seen_dm_id FROM sessions WHERE id = ?'
      ).get(sessionId) as { last_seen_dm_id: number } | undefined;
      if (!row) return [];
      const messages = this.db.prepare(
        'SELECT * FROM direct_messages WHERE to_id = ? AND id > ? ORDER BY id ASC LIMIT ?'
      ).all(sessionId, row.last_seen_dm_id, limit) as DirectMessage[];
      const lastSeen = messages.length ? messages[messages.length - 1].id : row.last_seen_dm_id;
      this.db.prepare('UPDATE sessions SET last_seen_dm_id = ? WHERE id = ?').run(lastSeen, sessionId);
      return messages;
    });
    return tx();
  }

  // ── Shared State ──

  setState(
    key: string, scope: string, value: string,
    updatedBy: string, updatedByName: string
  ): void {
    this.db.prepare(
      `INSERT INTO state (key, scope, value, updated_by, updated_by_name, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(key, scope) DO UPDATE SET
         value = excluded.value,
         updated_by = excluded.updated_by,
         updated_by_name = excluded.updated_by_name,
         updated_at = excluded.updated_at`
    ).run(key, scope, value, updatedBy, updatedByName);
  }

  getState(key: string, scope: string): StateEntry | undefined {
    return this.db.prepare(
      'SELECT * FROM state WHERE key = ? AND scope = ?'
    ).get(key, scope) as StateEntry | undefined;
  }

  getKeys(scope: string): string[] {
    const rows = this.db.prepare(
      'SELECT key FROM state WHERE scope = ?'
    ).all(scope) as Array<{ key: string }>;
    return rows.map(r => r.key);
  }

  deleteState(key: string, scope: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM state WHERE key = ? AND scope = ?'
    ).run(key, scope);
    return result.changes > 0;
  }

  // ── Resource Claims (Mutex) ──

  private pruneClaims(): void {
    this.db.prepare(
      `DELETE FROM claims
       WHERE
         (expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now'))
         OR owner_id NOT IN (
           SELECT id
           FROM sessions
           WHERE last_heartbeat > datetime('now', '-90 seconds')
         )`
    ).run();
  }

  claim(
    resource: string, ownerId: string, ownerName: string,
    room: string, ttlSeconds?: number
  ): { claimed: boolean; owner?: string } {
    // Wrap in transaction to prevent check-then-act race condition
    const tx = this.db.transaction(() => {
      this.pruneClaims();

      const existing = this.db.prepare(
        'SELECT * FROM claims WHERE resource = ?'
      ).get(resource) as Claim | undefined;

      if (existing && existing.owner_id !== ownerId) {
        return { claimed: false, owner: existing.owner_name };
      }

      this.db.prepare(
        `INSERT INTO claims (resource, owner_id, owner_name, room, expires_at)
         VALUES (
           ?, ?, ?, ?,
           CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '+' || ? || ' seconds') END
         )
         ON CONFLICT(resource) DO UPDATE SET
           owner_id = excluded.owner_id,
           owner_name = excluded.owner_name,
           room = excluded.room,
           expires_at = excluded.expires_at,
           claimed_at = datetime('now')`
      ).run(resource, ownerId, ownerName, room, ttlSeconds ?? null, ttlSeconds ?? null);

      return { claimed: true };
    });

    return tx();
  }

  release(resource: string, ownerId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM claims WHERE resource = ? AND owner_id = ?'
    ).run(resource, ownerId);
    return result.changes > 0;
  }

  getClaims(room?: string): Claim[] {
    this.pruneClaims();
    if (room) {
      return this.db.prepare('SELECT * FROM claims WHERE room = ?').all(room) as Claim[];
    }
    return this.db.prepare('SELECT * FROM claims').all() as Claim[];
  }

  // ── Contracts ──

  setContract(
    module: string, name: string, kind: 'provides' | 'expects',
    signature: string, agentId: string, agentName: string, room: string
  ): void {
    this.db.prepare(
      `INSERT INTO contracts (module, name, kind, signature, agent_id, agent_name, room, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(module, name, kind, room) DO UPDATE SET
         signature = excluded.signature,
         agent_id = excluded.agent_id,
         agent_name = excluded.agent_name,
         updated_at = excluded.updated_at`
    ).run(module, name, kind, signature, agentId, agentName, room);
  }

  setContractBatch(
    entries: Array<{ module: string; name: string; kind: 'provides' | 'expects'; signature: string }>,
    agentId: string, agentName: string, room: string
  ): number {
    const tx = this.db.transaction(() => {
      let count = 0;
      for (const e of entries) {
        this.setContract(e.module, e.name, e.kind, e.signature, agentId, agentName, room);
        count++;
      }
      return count;
    });
    return tx();
  }

  getContracts(room: string, module?: string, kind?: 'provides' | 'expects'): ContractEntry[] {
    let sql = 'SELECT * FROM contracts WHERE room = ?';
    const params: (string)[] = [room];
    if (module) { sql += ' AND module = ?'; params.push(module); }
    if (kind) { sql += ' AND kind = ?'; params.push(kind); }
    sql += ' ORDER BY module, name';
    return this.db.prepare(sql).all(...params) as ContractEntry[];
  }

  validateContracts(room: string): ContractMismatch[] {
    // Find all 'expects' entries and cross-reference against 'provides'
    const expects = this.db.prepare(
      `SELECT * FROM contracts WHERE room = ? AND kind = 'expects' ORDER BY name`
    ).all(room) as ContractEntry[];

    const provides = this.db.prepare(
      `SELECT * FROM contracts WHERE room = ? AND kind = 'provides' ORDER BY name`
    ).all(room) as ContractEntry[];

    // Build lookup: name → provider
    const providerMap = new Map<string, ContractEntry>();
    for (const p of provides) {
      providerMap.set(p.name, p);
    }

    const mismatches: ContractMismatch[] = [];

    for (const exp of expects) {
      const prov = providerMap.get(exp.name);

      if (!prov) {
        mismatches.push({
          name: exp.name,
          expected_by: exp.agent_name,
          expected_module: exp.module,
          expected_signature: exp.signature,
          provided_by: null,
          provided_module: null,
          provided_signature: null,
          issue: 'missing',
          detail: `"${exp.name}" expected by ${exp.agent_name} (${exp.module}) but no agent provides it`,
        });
        continue;
      }

      // Parse signatures and compare
      try {
        const expSig = JSON.parse(exp.signature);
        const provSig = JSON.parse(prov.signature);

        // Check param count
        const expParams = expSig.params || [];
        const provParams = provSig.params || [];
        if (expParams.length !== provParams.length) {
          mismatches.push({
            name: exp.name,
            expected_by: exp.agent_name,
            expected_module: exp.module,
            expected_signature: exp.signature,
            provided_by: prov.agent_name,
            provided_module: prov.module,
            provided_signature: prov.signature,
            issue: 'param_count',
            detail: `${exp.agent_name} expects ${expParams.length} params, ${prov.agent_name} provides ${provParams.length}`,
          });
          continue;
        }

        // Check param types (string comparison)
        for (let i = 0; i < expParams.length; i++) {
          const expType = (expParams[i] as string).replace(/^\w+:\s*/, ''); // strip name prefix
          const provType = (provParams[i] as string).replace(/^\w+:\s*/, '');
          if (expType !== provType) {
            mismatches.push({
              name: exp.name,
              expected_by: exp.agent_name,
              expected_module: exp.module,
              expected_signature: exp.signature,
              provided_by: prov.agent_name,
              provided_module: prov.module,
              provided_signature: prov.signature,
              issue: 'param_type',
              detail: `Param ${i}: ${exp.agent_name} expects "${expType}", ${prov.agent_name} provides "${provType}"`,
            });
          }
        }

        // Check return type
        if (expSig.returns && provSig.returns && expSig.returns !== provSig.returns) {
          mismatches.push({
            name: exp.name,
            expected_by: exp.agent_name,
            expected_module: exp.module,
            expected_signature: exp.signature,
            provided_by: prov.agent_name,
            provided_module: prov.module,
            provided_signature: prov.signature,
            issue: 'return_type',
            detail: `${exp.agent_name} expects return "${expSig.returns}", ${prov.agent_name} returns "${provSig.returns}"`,
          });
        }
      } catch {
        // If signatures aren't valid JSON, do string comparison
        if (exp.signature !== prov.signature) {
          mismatches.push({
            name: exp.name,
            expected_by: exp.agent_name,
            expected_module: exp.module,
            expected_signature: exp.signature,
            provided_by: prov.agent_name,
            provided_module: prov.module,
            provided_signature: prov.signature,
            issue: 'param_type',
            detail: `Signature mismatch (raw): expected "${exp.signature}", provided "${prov.signature}"`,
          });
        }
      }
    }

    return mismatches;
  }

  clearContracts(room: string): number {
    return this.db.prepare('DELETE FROM contracts WHERE room = ?').run(room).changes;
  }

  // ── Persistent Memory ──

  storeMemory(
    room: string, key: string, content: string, category: string,
    createdBy: string, createdByName: string
  ): string {
    // Upsert by room+key — same key overwrites
    const existing = this.db.prepare(
      'SELECT id FROM memory WHERE room = ? AND key = ?'
    ).get(room, key) as { id: string } | undefined;

    let id: string;
    if (existing) {
      this.db.prepare(
        `UPDATE memory SET content = ?, category = ?, updated_at = datetime('now'),
         created_by = ?, created_by_name = ? WHERE id = ?`
      ).run(content, category, createdBy, createdByName, existing.id);
      id = existing.id;
    } else {
      id = randomUUID();
      this.db.prepare(
        `INSERT INTO memory (id, room, key, content, category, created_by, created_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, room, key, content, category, createdBy, createdByName);
    }

    this.events.emit('memory', { id, key, category });

    // Fire-and-forget: embed asynchronously if provider is available
    if (this.embeddingProvider) {
      const text = `${key} ${content}`;
      this.embeddingProvider.embed(text)
        .then(embedding => this.storeMemoryEmbedding(id, embedding))
        .catch(() => { /* embedding failed — memory still stored without it */ });
    }

    return id;
  }

  async recallMemory(room: string, query?: string, category?: string, limit = 20): Promise<MemoryEntry[]> {
    // Try semantic search first if provider is available and query given
    if (query && this.embeddingProvider) {
      try {
        const queryEmbedding = await this.embeddingProvider.embed(query);
        const semanticResults = this.semanticRecall(room, queryEmbedding, category, limit);

        if (semanticResults.length > 0) {
          // Also get LIKE results for hybrid merge
          const likeResults = this.recallMemoryLike(room, query, category, limit);

          // Merge: deduplicate by id, weight semantic similarity + frequency
          const seen = new Set<string>();
          const merged: Array<MemoryEntry & { _score: number }> = [];

          for (let i = 0; i < semanticResults.length; i++) {
            const r = semanticResults[i];
            seen.add(r.id);
            merged.push({ ...r, _score: (r.similarity ?? 0) * 0.7 + (1 - i / semanticResults.length) * 0.3 });
          }
          for (let i = 0; i < likeResults.length; i++) {
            const r = likeResults[i];
            if (seen.has(r.id)) continue;
            seen.add(r.id);
            merged.push({ ...r, _score: 0.3 * (1 - i / likeResults.length) });
          }

          merged.sort((a, b) => b._score - a._score);
          return merged.slice(0, limit).map(({ _score, ...rest }) => rest);
        }
      } catch {
        // Embedding failed — fall through to LIKE search
      }
    }

    return this.recallMemoryLike(room, query, category, limit);
  }

  /** Original LIKE-based recall — used as fallback and for hybrid merging. */
  recallMemoryLike(room: string, query?: string, category?: string, limit = 20): MemoryEntry[] {
    let sql = 'SELECT * FROM memory WHERE room = ?';
    const params: (string | number)[] = [room];

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    if (query) {
      sql += ' AND (key LIKE ? OR content LIKE ?)';
      const pattern = `%${query}%`;
      params.push(pattern, pattern);
    }

    sql += ' ORDER BY access_count DESC, updated_at DESC LIMIT ?';
    params.push(limit);

    const results = this.db.prepare(sql).all(...params) as MemoryEntry[];

    // Touch accessed entries
    if (results.length > 0) {
      const ids = results.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(
        `UPDATE memory SET access_count = access_count + 1, last_accessed = datetime('now')
         WHERE id IN (${placeholders})`
      ).run(...ids);
    }

    return results;
  }

  getMemoryByKey(room: string, key: string): MemoryEntry | undefined {
    return this.db.prepare(
      'SELECT * FROM memory WHERE room = ? AND key = ?'
    ).get(room, key) as MemoryEntry | undefined;
  }

  forgetMemory(id: string): boolean {
    return this.db.prepare('DELETE FROM memory WHERE id = ?').run(id).changes > 0;
  }

  forgetMemoryByKey(room: string, key: string): boolean {
    return this.db.prepare('DELETE FROM memory WHERE room = ? AND key = ?').run(room, key).changes > 0;
  }

  listMemoryCategories(room: string): Array<{ category: string; count: number }> {
    return this.db.prepare(
      'SELECT category, COUNT(*) as count FROM memory WHERE room = ? GROUP BY category ORDER BY count DESC'
    ).all(room) as Array<{ category: string; count: number }>;
  }

  // ── Embedding Support ──

  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
  }

  getEmbeddingProvider(): EmbeddingProvider | null {
    return this.embeddingProvider;
  }

  storeMemoryEmbedding(id: string, embedding: Float32Array): void {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db.prepare('UPDATE memory SET embedding = ? WHERE id = ?').run(buf, id);
  }

  semanticRecall(
    room: string, queryEmbedding: Float32Array,
    category?: string, limit = 10,
  ): Array<MemoryEntry & { similarity: number }> {
    const queryBuf = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
    let sql = `SELECT *, cosine_similarity(embedding, ?) as similarity
               FROM memory WHERE room = ? AND embedding IS NOT NULL`;
    const params: (Buffer | string | number)[] = [queryBuf, room];
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    sql += ' ORDER BY similarity DESC LIMIT ?';
    params.push(limit);
    const results = this.db.prepare(sql).all(...params) as Array<MemoryEntry & { similarity: number }>;

    // Touch accessed entries
    if (results.length > 0) {
      const ids = results.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(
        `UPDATE memory SET access_count = access_count + 1, last_accessed = datetime('now')
         WHERE id IN (${placeholders})`
      ).run(...ids);
    }

    return results;
  }

  // ── Task DAG ──

  createPlan(
    room: string,
    tasks: Array<{ name: string; description: string; depends_on?: string[]; agent_name?: string }>
  ): { plan_id: string; tasks: TaskNode[] } {
    const planId = randomUUID();
    const taskIds = new Map<string, string>(); // name → id

    // First pass: assign IDs
    for (const t of tasks) {
      taskIds.set(t.name, randomUUID());
    }

    const tx = this.db.transaction(() => {
      const created: TaskNode[] = [];
      for (const t of tasks) {
        const id = taskIds.get(t.name)!;
        // Resolve dependency names to IDs
        const depIds = (t.depends_on || []).map(depName => {
          const depId = taskIds.get(depName);
          if (!depId) throw new Error(`Unknown dependency: "${depName}" in task "${t.name}"`);
          return depId;
        });

        // A task with no deps starts as 'ready'
        const status: TaskStatus = depIds.length === 0 ? 'ready' : 'pending';

        this.db.prepare(
          `INSERT INTO task_graph (id, room, plan_id, name, description, agent_name, status, depends_on)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, room, planId, t.name, t.description || '', t.agent_name || null, status, JSON.stringify(depIds));

        created.push({
          id, room, plan_id: planId, name: t.name, description: t.description || '',
          agent_name: t.agent_name || null, agent_id: null, status,
          depends_on: JSON.stringify(depIds), result: null,
          created_at: new Date().toISOString(), started_at: null, completed_at: null,
        });
      }
      return created;
    });

    const created = tx();
    return { plan_id: planId, tasks: created };
  }

  getReadyTasks(room: string, planId: string): TaskNode[] {
    return this.db.prepare(
      `SELECT * FROM task_graph WHERE room = ? AND plan_id = ? AND status = 'ready' ORDER BY priority DESC, created_at`
    ).all(room, planId) as TaskNode[];
  }

  updateTaskNode(
    taskId: string, status: TaskStatus,
    agentId?: string, agentName?: string, result?: string
  ): void {
    const tx = this.db.transaction(() => {
      const updates: string[] = ['status = ?'];
      const params: (string | null)[] = [status];

      if (status === 'running') {
        updates.push("started_at = datetime('now')");
      }
      if (status === 'done' || status === 'failed') {
        updates.push("completed_at = datetime('now')");
      }
      if (agentId) { updates.push('agent_id = ?'); params.push(agentId); }
      if (agentName) { updates.push('agent_name = ?'); params.push(agentName); }
      if (result !== undefined) { updates.push('result = ?'); params.push(result || null); }

      params.push(taskId);
      this.db.prepare(`UPDATE task_graph SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      // If task completed, check if any dependent tasks are now ready
      if (status === 'done') {
        const task = this.db.prepare('SELECT * FROM task_graph WHERE id = ?').get(taskId) as TaskNode;
        if (task) {
          // Find all tasks in the same plan that depend on this one
          const allTasks = this.db.prepare(
            `SELECT * FROM task_graph WHERE room = ? AND plan_id = ? AND status = 'pending'`
          ).all(task.room, task.plan_id) as TaskNode[];

          for (const t of allTasks) {
            const deps: string[] = JSON.parse(t.depends_on);
            if (!deps.includes(taskId)) continue;

            // Check if ALL dependencies are done
            const allDepsDone = deps.every(depId => {
              const dep = this.db.prepare('SELECT status FROM task_graph WHERE id = ?').get(depId) as { status: string } | undefined;
              return dep?.status === 'done';
            });

            if (allDepsDone) {
              this.db.prepare(`UPDATE task_graph SET status = 'ready' WHERE id = ?`).run(t.id);
            }
          }
        }
      }

      // If task failed, mark all dependents as skipped
      if (status === 'failed') {
        const task = this.db.prepare('SELECT * FROM task_graph WHERE id = ?').get(taskId) as TaskNode;
        if (task) {
          this.cascadeSkip(task.room, task.plan_id, taskId);
        }
      }
    });
    tx();
  }

  private cascadeSkip(room: string, planId: string, failedId: string): void {
    const allTasks = this.db.prepare(
      `SELECT * FROM task_graph WHERE room = ? AND plan_id = ? AND status IN ('pending', 'ready')`
    ).all(room, planId) as TaskNode[];

    for (const t of allTasks) {
      const deps: string[] = JSON.parse(t.depends_on);
      if (deps.includes(failedId)) {
        this.db.prepare(`UPDATE task_graph SET status = 'skipped', completed_at = datetime('now') WHERE id = ?`).run(t.id);
        this.cascadeSkip(room, planId, t.id);
      }
    }
  }

  getPlanStatus(room: string, planId: string): PlanSummary {
    const tasks = this.db.prepare(
      'SELECT * FROM task_graph WHERE room = ? AND plan_id = ? ORDER BY created_at'
    ).all(room, planId) as TaskNode[];

    return {
      plan_id: planId,
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      ready: tasks.filter(t => t.status === 'ready').length,
      running: tasks.filter(t => t.status === 'running').length,
      done: tasks.filter(t => t.status === 'done').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      tasks,
    };
  }

  getPlans(room: string): Array<{ plan_id: string; task_count: number; done: number; failed: number }> {
    return this.db.prepare(
      `SELECT plan_id,
              COUNT(*) as task_count,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM task_graph WHERE room = ? GROUP BY plan_id ORDER BY MIN(created_at) DESC`
    ).all(room) as Array<{ plan_id: string; task_count: number; done: number; failed: number }>;
  }

  // ── Agent Metrics ──

  recordMetric(
    room: string, agentName: string, agentId: string | null,
    data: {
      model?: string;
      task_description?: string;
      started_at?: string;
      completed_at?: string;
      duration_seconds?: number;
      gate_passes?: number;
      tsc_errors?: number;
      contract_mismatches?: number;
      files_changed?: number;
      outcome?: string;
    }
  ): number {
    const result = this.db.prepare(
      `INSERT INTO agent_metrics (room, agent_name, agent_id, model, task_description, started_at, completed_at,
       duration_seconds, gate_passes, tsc_errors, contract_mismatches, files_changed, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      room, agentName, agentId, data.model || null,
      data.task_description || null, data.started_at || null, data.completed_at || null,
      data.duration_seconds ?? null, data.gate_passes ?? 0, data.tsc_errors ?? 0,
      data.contract_mismatches ?? 0, data.files_changed ?? 0, data.outcome || 'unknown'
    );
    this.events.emit('metric', { agent_name: agentName, outcome: data.outcome });
    return Number(result.lastInsertRowid);
  }

  getMetrics(room: string, agentName?: string, limit = 50): AgentMetric[] {
    if (agentName) {
      return this.db.prepare(
        'SELECT * FROM agent_metrics WHERE room = ? AND agent_name = ? ORDER BY created_at DESC LIMIT ?'
      ).all(room, agentName, limit) as AgentMetric[];
    }
    return this.db.prepare(
      'SELECT * FROM agent_metrics WHERE room = ? ORDER BY created_at DESC LIMIT ?'
    ).all(room, limit) as AgentMetric[];
  }

  getMetricsSummary(room: string): MetricsSummary[] {
    return this.db.prepare(
      `SELECT
         agent_name,
         COUNT(*) as total_tasks,
         SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
         SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) as failures,
         AVG(duration_seconds) as avg_duration_seconds,
         AVG(gate_passes) as avg_gate_passes,
         AVG(tsc_errors) as avg_tsc_errors
       FROM agent_metrics WHERE room = ? GROUP BY agent_name ORDER BY total_tasks DESC`
    ).all(room) as MetricsSummary[];
  }

  getModelMetrics(room: string): ModelMetricRow[] {
    return this.db.prepare(
      `SELECT
         model,
         COUNT(*) as total_tasks,
         SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
         SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) as failures,
         ROUND(1.0 * SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) / COUNT(*), 3) as success_rate,
         AVG(duration_seconds) as avg_duration,
         AVG(gate_passes) as avg_gate_passes,
         AVG(tsc_errors) as avg_tsc_errors
       FROM agent_metrics WHERE room = ? AND model IS NOT NULL GROUP BY model ORDER BY total_tasks DESC`
    ).all(room) as ModelMetricRow[];
  }

  // ── Context Ledger ──

  pushContext(
    room: string, sessionId: string, agentName: string,
    entryType: ContextEntryType, summary: string,
    detail?: string, filePath?: string, tags?: string[]
  ): number {
    const result = this.db.prepare(
      `INSERT INTO context_ledger (room, session_id, agent_name, entry_type, summary, detail, file_path, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(room, sessionId, agentName, entryType, summary, detail || null, filePath || null, JSON.stringify(tags || []));
    return Number(result.lastInsertRowid);
  }

  getContext(
    room: string, options?: {
      session_id?: string;
      entry_type?: ContextEntryType;
      file_path?: string;
      since_id?: number;
      limit?: number;
    }
  ): ContextEntry[] {
    let sql = 'SELECT * FROM context_ledger WHERE room = ?';
    const params: (string | number)[] = [room];

    if (options?.session_id) { sql += ' AND session_id = ?'; params.push(options.session_id); }
    if (options?.entry_type) { sql += ' AND entry_type = ?'; params.push(options.entry_type); }
    if (options?.file_path) { sql += ' AND file_path = ?'; params.push(options.file_path); }
    if (options?.since_id) { sql += ' AND id > ?'; params.push(options.since_id); }

    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(options?.limit || 50);

    return this.db.prepare(sql).all(...params) as ContextEntry[];
  }

  getContextSummary(room: string, sessionId?: string): {
    total: number;
    by_type: Record<string, number>;
    recent: ContextEntry[];
    files_touched: string[];
  } {
    const filter = sessionId ? 'AND session_id = ?' : '';
    const params: (string)[] = sessionId ? [room, sessionId] : [room];

    const total = (this.db.prepare(
      `SELECT COUNT(*) as count FROM context_ledger WHERE room = ? ${filter}`
    ).get(...params) as { count: number }).count;

    const byType = this.db.prepare(
      `SELECT entry_type, COUNT(*) as count FROM context_ledger WHERE room = ? ${filter} GROUP BY entry_type`
    ).all(...params) as Array<{ entry_type: string; count: number }>;

    const recent = this.db.prepare(
      `SELECT * FROM context_ledger WHERE room = ? ${filter} ORDER BY id DESC LIMIT 20`
    ).all(...params) as ContextEntry[];

    const files = this.db.prepare(
      `SELECT file_path FROM context_ledger WHERE room = ? ${filter} AND file_path IS NOT NULL GROUP BY file_path ORDER BY MAX(id) DESC`
    ).all(...params) as Array<{ file_path: string }>;

    return {
      total,
      by_type: Object.fromEntries(byType.map(r => [r.entry_type, r.count])),
      recent,
      files_touched: files.map(f => f.file_path),
    };
  }

  // ── Checkpoints ──

  saveCheckpoint(
    room: string, sessionId: string, agentName: string,
    state: {
      current_task: string;
      files_touched: string[];
      decisions: string[];
      progress_summary: string;
      blockers: string[];
      next_steps: string[];
    }
  ): string {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO checkpoints (id, room, session_id, agent_name, state) VALUES (?, ?, ?, ?, ?)`
    ).run(id, room, sessionId, agentName, JSON.stringify(state));
    return id;
  }

  restoreCheckpoint(room: string, sessionId?: string): Checkpoint | undefined {
    if (sessionId) {
      return this.db.prepare(
        'SELECT * FROM checkpoints WHERE room = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(room, sessionId) as Checkpoint | undefined;
    }
    return this.db.prepare(
      'SELECT * FROM checkpoints WHERE room = ? ORDER BY created_at DESC LIMIT 1'
    ).get(room) as Checkpoint | undefined;
  }

  getCheckpoints(room: string, sessionId?: string, limit = 10): Checkpoint[] {
    if (sessionId) {
      return this.db.prepare(
        'SELECT * FROM checkpoints WHERE room = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?'
      ).all(room, sessionId, limit) as Checkpoint[];
    }
    return this.db.prepare(
      'SELECT * FROM checkpoints WHERE room = ? ORDER BY created_at DESC LIMIT ?'
    ).all(room, limit) as Checkpoint[];
  }

  clear(): Record<string, number> {
    const messages = this.db.prepare('DELETE FROM messages').run().changes;
    const dms = this.db.prepare('DELETE FROM direct_messages').run().changes;
    const state = this.db.prepare('DELETE FROM state').run().changes;
    const claims = this.db.prepare('DELETE FROM claims').run().changes;
    const contracts = this.db.prepare('DELETE FROM contracts').run().changes;
    const sessions = this.db.prepare('DELETE FROM sessions').run().changes;
    const memory = this.db.prepare('DELETE FROM memory').run().changes;
    const task_graph = this.db.prepare('DELETE FROM task_graph').run().changes;
    const agent_metrics = this.db.prepare('DELETE FROM agent_metrics').run().changes;
    const context_ledger = this.db.prepare('DELETE FROM context_ledger').run().changes;
    const checkpoints = this.db.prepare('DELETE FROM checkpoints').run().changes;
    return { messages, dms, state, claims, contracts, sessions, memory, task_graph, agent_metrics, context_ledger, checkpoints };
  }

  close(): void {
    this.db.close();
  }
}
