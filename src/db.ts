import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface Session {
  id: string;
  name: string;
  pid: number;
  cwd: string;
  room: string;
  metadata: string | null;
  created_at: string;
  last_heartbeat: string;
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

export class BrainDB {
  private db: Database.Database;

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

      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, room, id);
      CREATE INDEX IF NOT EXISTS idx_dm_to ON direct_messages(to_id, id);
      CREATE INDEX IF NOT EXISTS idx_dm_from ON direct_messages(from_id, id);
      CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room);
    `);
  }

  // ── Session Management ──

  registerSession(name: string, room: string, metadata?: string): string {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO sessions (id, name, pid, cwd, room, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, name, process.pid, process.cwd(), room, metadata || null);
    return id;
  }

  removeSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM claims WHERE owner_id = ?').run(id);
  }

  heartbeat(id: string): void {
    this.db.prepare(
      "UPDATE sessions SET last_heartbeat = datetime('now') WHERE id = ?"
    ).run(id);
  }

  updateSessionName(id: string, name: string): void {
    this.db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
  }

  getSession(id: string): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  }

  getSessions(room?: string): Session[] {
    if (room) {
      return this.db.prepare(
        "SELECT * FROM sessions WHERE room = ? AND last_heartbeat > datetime('now', '-5 minutes') ORDER BY created_at"
      ).all(room) as Session[];
    }
    return this.db.prepare(
      "SELECT * FROM sessions WHERE last_heartbeat > datetime('now', '-5 minutes') ORDER BY created_at"
    ).all() as Session[];
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

  claim(
    resource: string, ownerId: string, ownerName: string,
    room: string, ttlSeconds?: number
  ): { claimed: boolean; owner?: string } {
    // Clean expired claims first
    this.db.prepare(
      "DELETE FROM claims WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
    ).run();

    const existing = this.db.prepare(
      'SELECT * FROM claims WHERE resource = ?'
    ).get(resource) as Claim | undefined;

    if (existing && existing.owner_id !== ownerId) {
      return { claimed: false, owner: existing.owner_name };
    }

    const expiresAt = ttlSeconds
      ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
      : null;

    this.db.prepare(
      `INSERT INTO claims (resource, owner_id, owner_name, room, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(resource) DO UPDATE SET
         owner_id = excluded.owner_id,
         owner_name = excluded.owner_name,
         expires_at = excluded.expires_at,
         claimed_at = datetime('now')`
    ).run(resource, ownerId, ownerName, room, expiresAt);

    return { claimed: true };
  }

  release(resource: string, ownerId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM claims WHERE resource = ? AND owner_id = ?'
    ).run(resource, ownerId);
    return result.changes > 0;
  }

  getClaims(room?: string): Claim[] {
    this.db.prepare(
      "DELETE FROM claims WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
    ).run();
    if (room) {
      return this.db.prepare('SELECT * FROM claims WHERE room = ?').all(room) as Claim[];
    }
    return this.db.prepare('SELECT * FROM claims').all() as Claim[];
  }

  clear(): Record<string, number> {
    const messages = this.db.prepare('DELETE FROM messages').run().changes;
    const dms = this.db.prepare('DELETE FROM direct_messages').run().changes;
    const state = this.db.prepare('DELETE FROM state').run().changes;
    const claims = this.db.prepare('DELETE FROM claims').run().changes;
    const sessions = this.db.prepare('DELETE FROM sessions').run().changes;
    return { messages, dms, state, claims, sessions };
  }

  close(): void {
    this.db.close();
  }
}
