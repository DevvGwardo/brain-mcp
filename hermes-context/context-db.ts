/**
 * hermes-context — Context DB Layer
 *
 * Lightweight context caching layer for hermes-agent context management:
 *   - Session caching (in-memory + optional SQLite persistence)
 *   - Skill index (skill manifest, enabled/disabled state, aliases)
 *   - Journal index caching (conversation digest, turn tracking)
 *   - Optional SQLite for persistent memory / context snapshots
 *
 * Shares the same brain.db file as brain-mcp and hermes/db.py so all
 * three processes coexist on the same SQLite WAL.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ── Types ────────────────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'working' | 'done' | 'failed';

export interface CachedSession {
  id: string;
  name: string;
  room: string;
  status: SessionStatus;
  progress: string | null;
  turn_count: number;
  last_turn_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  aliases: string[];   // JSON array
  category: string;
  file_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface JournalEntry {
  id: number;
  session_id: string;
  room: string;
  turn_index: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content_hash: string; // SHA-like digest for dedup
  content_preview: string; // first 200 chars
  token_count: number;
  created_at: string;
}

export interface ContextSnapshot {
  id: string;
  session_id: string;
  room: string;
  summary: string;
  turns_start: number;
  turns_end: number;
  token_count: number;
  created_at: string;
}

export interface MemoryEntry {
  id: string;
  room: string;
  key: string;
  content: string;
  category: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  access_count: number;
  last_accessed: string | null;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = join(homedir(), '.claude', 'brain', 'brain.db');

// ── ContextDB ─────────────────────────────────────────────────────────────────

export class ContextDB {
  private db: Database.Database | null = null;
  private useSqlite: boolean;
  private dbPath: string;

  // In-memory caches (always available, even without SQLite)
  private sessionCache = new Map<string, CachedSession>();
  private skillCache = new Map<string, SkillEntry>();
  private journalCache = new Map<string, JournalEntry[]>(); // session_id → entries
  private snapshotCache = new Map<string, ContextSnapshot[]>(); // session_id → snapshots

  // Dirty tracking for writes that need flushing
  private dirtySessions = new Set<string>();
  private dirtySkills = new Set<string>();

  constructor(options: { dbPath?: string; useSqlite?: boolean } = {}) {
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    this.useSqlite = options.useSqlite ?? true;
    if (this.useSqlite) {
      this.initSqlite();
    }
  }

  // ── SQLite Initialization ────────────────────────────────────────────────────

  private initSqlite(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    this.loadCaches();
  }

  private migrate(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ctx_sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        room TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        progress TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        last_turn_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ctx_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        aliases TEXT NOT NULL DEFAULT '[]',
        category TEXT NOT NULL DEFAULT 'general',
        file_path TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ctx_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        room TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content_preview TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ctx_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        room TEXT NOT NULL,
        summary TEXT NOT NULL,
        turns_start INTEGER NOT NULL,
        turns_end INTEGER NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ctx_memory (
        id TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        created_by TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_ctx_sessions_room ON ctx_sessions(room);
      CREATE INDEX IF NOT EXISTS idx_ctx_sessions_updated ON ctx_sessions(updated_at);
      CREATE INDEX IF NOT EXISTS idx_ctx_skills_name ON ctx_skills(name);
      CREATE INDEX IF NOT EXISTS idx_ctx_skills_enabled ON ctx_skills(enabled);
      CREATE INDEX IF NOT EXISTS idx_ctx_journal_session ON ctx_journal(session_id, turn_index);
      CREATE INDEX IF NOT EXISTS idx_ctx_journal_hash ON ctx_journal(session_id, content_hash);
      CREATE INDEX IF NOT EXISTS idx_ctx_snapshots_session ON ctx_snapshots(session_id);
      CREATE INDEX IF NOT EXISTS idx_ctx_memory_room_key ON ctx_memory(room, key);
      CREATE INDEX IF NOT EXISTS idx_ctx_memory_room_cat ON ctx_memory(room, category);
    `);
  }

  private loadCaches(): void {
    if (!this.db) return;

    // Load sessions
    const sessions = this.db.prepare('SELECT * FROM ctx_sessions').all() as CachedSession[];
    for (const s of sessions) {
      this.sessionCache.set(s.id, s);
    }

    // Load skills
    const skills = this.db.prepare('SELECT * FROM ctx_skills').all() as SkillEntry[];
    for (const sk of skills) {
      sk.aliases = JSON.parse(sk.aliases as unknown as string);
      sk.enabled = Boolean(sk.enabled);
      this.skillCache.set(sk.id, sk);
    }

    // Load journal entries grouped by session
    const journalRows = this.db.prepare('SELECT * FROM ctx_journal ORDER BY session_id, turn_index').all() as JournalEntry[];
    for (const j of journalRows) {
      const existing = this.journalCache.get(j.session_id) || [];
      existing.push(j);
      this.journalCache.set(j.session_id, existing);
    }

    // Load snapshots grouped by session
    const snapshotRows = this.db.prepare('SELECT * FROM ctx_snapshots ORDER BY session_id, turns_start').all() as ContextSnapshot[];
    for (const sn of snapshotRows) {
      const existing = this.snapshotCache.get(sn.session_id) || [];
      existing.push(sn);
      this.snapshotCache.set(sn.session_id, existing);
    }
  }

  // ── Session Caching ──────────────────────────────────────────────────────────

  upsertSession(session: {
    id: string;
    name: string;
    room: string;
    status?: SessionStatus;
    progress?: string | null;
  }): CachedSession {
    const now = new Date().toISOString();
    const existing = this.sessionCache.get(session.id);

    const entry: CachedSession = {
      id: session.id,
      name: session.name,
      room: session.room,
      status: session.status || existing?.status || 'idle',
      progress: session.progress !== undefined ? session.progress : existing?.progress || null,
      turn_count: existing?.turn_count || 0,
      last_turn_at: existing?.last_turn_at || null,
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    this.sessionCache.set(entry.id, entry);
    this.dirtySessions.add(entry.id);

    if (this.db && this.useSqlite) {
      this.flushSession(entry);
    }

    return entry;
  }

  getSession(id: string): CachedSession | undefined {
    return this.sessionCache.get(id);
  }

  getSessionsByRoom(room: string): CachedSession[] {
    return Array.from(this.sessionCache.values()).filter(s => s.room === room);
  }

  updateSessionStatus(id: string, status: SessionStatus, progress?: string): CachedSession | undefined {
    const s = this.sessionCache.get(id);
    if (!s) return undefined;
    s.status = status;
    if (progress !== undefined) s.progress = progress;
    s.updated_at = new Date().toISOString();
    this.dirtySessions.add(id);
    if (this.db && this.useSqlite) {
      this.flushSession(s);
    }
    return s;
  }

  incrementTurn(sessionId: string): CachedSession | undefined {
    const s = this.sessionCache.get(sessionId);
    if (!s) return undefined;
    s.turn_count += 1;
    s.last_turn_at = new Date().toISOString();
    s.updated_at = s.last_turn_at;
    this.dirtySessions.add(sessionId);
    if (this.db && this.useSqlite) {
      this.flushSession(s);
    }
    return s;
  }

  deleteSession(id: string): boolean {
    this.sessionCache.delete(id);
    this.journalCache.delete(id);
    this.snapshotCache.delete(id);
    this.dirtySessions.delete(id);
    if (this.db && this.useSqlite) {
      this.db.prepare('DELETE FROM ctx_sessions WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM ctx_journal WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM ctx_snapshots WHERE session_id = ?').run(id);
    }
    return true;
  }

  private flushSession(s: CachedSession): void {
    if (!this.db) return;
    this.db.prepare(`
      INSERT INTO ctx_sessions (id, name, room, status, progress, turn_count, last_turn_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        room = excluded.room,
        status = excluded.status,
        progress = excluded.progress,
        turn_count = excluded.turn_count,
        last_turn_at = excluded.last_turn_at,
        updated_at = excluded.updated_at
    `).run(s.id, s.name, s.room, s.status, s.progress, s.turn_count, s.last_turn_at, s.created_at, s.updated_at);
    this.dirtySessions.delete(s.id);
  }

  // ── Skill Index ──────────────────────────────────────────────────────────────

  registerSkill(skill: {
    id?: string;
    name: string;
    description?: string;
    enabled?: boolean;
    aliases?: string[];
    category?: string;
    file_path?: string | null;
  }): SkillEntry {
    const id = skill.id || randomUUID();
    const now = new Date().toISOString();
    const existing = this.skillCache.get(id);

    const entry: SkillEntry = {
      id,
      name: skill.name,
      description: skill.description || '',
      enabled: skill.enabled ?? existing?.enabled ?? true,
      aliases: skill.aliases || existing?.aliases || [],
      category: skill.category || existing?.category || 'general',
      file_path: skill.file_path !== undefined ? skill.file_path : existing?.file_path || null,
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    this.skillCache.set(id, entry);
    this.dirtySkills.add(id);

    if (this.db && this.useSqlite) {
      this.flushSkill(entry);
    }

    return entry;
  }

  getSkill(id: string): SkillEntry | undefined {
    return this.skillCache.get(id);
  }

  getSkillByName(name: string): SkillEntry | undefined {
    return Array.from(this.skillCache.values()).find(
      s => s.name.toLowerCase() === name.toLowerCase()
    );
  }

  getSkillByAlias(alias: string): SkillEntry | undefined {
    const lower = alias.toLowerCase();
    return Array.from(this.skillCache.values()).find(
      s => s.aliases.map(a => a.toLowerCase()).includes(lower)
    );
  }

  getAllSkills(options?: { enabled?: boolean; category?: string }): SkillEntry[] {
    let skills = Array.from(this.skillCache.values());
    if (options?.enabled !== undefined) {
      skills = skills.filter(s => s.enabled === options.enabled);
    }
    if (options?.category) {
      skills = skills.filter(s => s.category === options.category);
    }
    return skills;
  }

  setSkillEnabled(id: string, enabled: boolean): SkillEntry | undefined {
    const s = this.skillCache.get(id);
    if (!s) return undefined;
    s.enabled = enabled;
    s.updated_at = new Date().toISOString();
    this.dirtySkills.add(id);
    if (this.db && this.useSqlite) {
      this.flushSkill(s);
    }
    return s;
  }

  updateSkillAliases(id: string, aliases: string[]): SkillEntry | undefined {
    const s = this.skillCache.get(id);
    if (!s) return undefined;
    s.aliases = aliases;
    s.updated_at = new Date().toISOString();
    this.dirtySkills.add(id);
    if (this.db && this.useSqlite) {
      this.flushSkill(s);
    }
    return s;
  }

  deleteSkill(id: string): boolean {
    this.skillCache.delete(id);
    this.dirtySkills.delete(id);
    if (this.db && this.useSqlite) {
      this.db.prepare('DELETE FROM ctx_skills WHERE id = ?').run(id);
    }
    return true;
  }

  private flushSkill(s: SkillEntry): void {
    if (!this.db) return;
    this.db.prepare(`
      INSERT INTO ctx_skills (id, name, description, enabled, aliases, category, file_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        enabled = excluded.enabled,
        aliases = excluded.aliases,
        category = excluded.category,
        file_path = excluded.file_path,
        updated_at = excluded.updated_at
    `).run(
      s.id, s.name, s.description, s.enabled ? 1 : 0,
      JSON.stringify(s.aliases), s.category, s.file_path,
      s.created_at, s.updated_at
    );
    this.dirtySkills.delete(s.id);
  }

  // ── Journal Index Caching ────────────────────────────────────────────────────

  appendJournalEntry(entry: {
    session_id: string;
    room: string;
    role: JournalEntry['role'];
    content_hash: string;
    content_preview: string;
    token_count?: number;
  }): JournalEntry {
    const journal = this.journalCache.get(entry.session_id) || [];
    const turn_index = journal.length;
    const now = new Date().toISOString();

    const je: JournalEntry = {
      id: 0, // assigned by SQLite auto-increment
      session_id: entry.session_id,
      room: entry.room,
      turn_index,
      role: entry.role,
      content_hash: entry.content_hash,
      content_preview: entry.content_preview.slice(0, 200),
      token_count: entry.token_count || 0,
      created_at: now,
    };

    journal.push(je);
    this.journalCache.set(entry.session_id, journal);

    if (this.db && this.useSqlite) {
      const result = this.db.prepare(`
        INSERT INTO ctx_journal (session_id, room, turn_index, role, content_hash, content_preview, token_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(je.session_id, je.room, je.turn_index, je.role, je.content_hash, je.content_preview, je.token_count);
      je.id = Number(result.lastInsertRowid);
    }

    return je;
  }

  getJournal(sessionId: string, fromTurn?: number, limit?: number): JournalEntry[] {
    const journal = this.journalCache.get(sessionId) || [];
    const start = fromTurn || 0;
    const end = limit ? start + limit : journal.length;
    return journal.slice(start, end);
  }

  getJournalByHash(sessionId: string, contentHash: string): JournalEntry | undefined {
    const journal = this.journalCache.get(sessionId) || [];
    return journal.find(j => j.content_hash === contentHash);
  }

  getJournalStats(sessionId: string): {
    total_turns: number;
    total_tokens: number;
    by_role: Record<string, number>;
  } {
    const journal = this.journalCache.get(sessionId) || [];
    const by_role: Record<string, number> = {};
    let total_tokens = 0;

    for (const j of journal) {
      by_role[j.role] = (by_role[j.role] || 0) + 1;
      total_tokens += j.token_count;
    }

    return {
      total_turns: journal.length,
      total_tokens,
      by_role,
    };
  }

  clearJournal(sessionId: string): boolean {
    this.journalCache.delete(sessionId);
    if (this.db && this.useSqlite) {
      this.db.prepare('DELETE FROM ctx_journal WHERE session_id = ?').run(sessionId);
    }
    return true;
  }

  // ── Context Snapshots ────────────────────────────────────────────────────────

  saveSnapshot(snapshot: {
    session_id: string;
    room: string;
    summary: string;
    turns_start: number;
    turns_end: number;
    token_count?: number;
  }): ContextSnapshot {
    const id = randomUUID();
    const now = new Date().toISOString();

    const cs: ContextSnapshot = {
      id,
      session_id: snapshot.session_id,
      room: snapshot.room,
      summary: snapshot.summary,
      turns_start: snapshot.turns_start,
      turns_end: snapshot.turns_end,
      token_count: snapshot.token_count || 0,
      created_at: now,
    };

    const existing = this.snapshotCache.get(snapshot.session_id) || [];
    existing.push(cs);
    // Keep only last 10 snapshots per session
    if (existing.length > 10) {
      existing.shift();
    }
    this.snapshotCache.set(snapshot.session_id, existing);

    if (this.db && this.useSqlite) {
      this.db.prepare(`
        INSERT INTO ctx_snapshots (id, session_id, room, summary, turns_start, turns_end, token_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(cs.id, cs.session_id, cs.room, cs.summary, cs.turns_start, cs.turns_end, cs.token_count);
    }

    return cs;
  }

  getSnapshots(sessionId: string, limit = 10): ContextSnapshot[] {
    const snapshots = this.snapshotCache.get(sessionId) || [];
    return snapshots.slice(-limit);
  }

  getLatestSnapshot(sessionId: string): ContextSnapshot | undefined {
    const snapshots = this.snapshotCache.get(sessionId) || [];
    return snapshots[snapshots.length - 1];
  }

  // ── Optional Memory (SQLite-only) ────────────────────────────────────────────

  storeMemory(memory: {
    room: string;
    key: string;
    content: string;
    category?: string;
    created_by: string;
  }): string {
    if (!this.db || !this.useSqlite) {
      // Fallback: generate an ID but don't persist
      return randomUUID();
    }

    const existing = this.db.prepare(
      'SELECT id FROM ctx_memory WHERE room = ? AND key = ?'
    ).get(memory.room, memory.key) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE ctx_memory SET content = ?, category = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(memory.content, memory.category || 'general', existing.id);
      return existing.id;
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO ctx_memory (id, room, key, content, category, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, memory.room, memory.key, memory.content, memory.category || 'general', memory.created_by);
    return id;
  }

  recallMemory(room: string, query?: string, category?: string, limit = 20): MemoryEntry[] {
    if (!this.db || !this.useSqlite) return [];

    let sql = 'SELECT * FROM ctx_memory WHERE room = ?';
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

    if (results.length > 0) {
      const ids = results.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`
        UPDATE ctx_memory SET access_count = access_count + 1, last_accessed = datetime('now')
        WHERE id IN (${placeholders})
      `).run(...ids);
    }

    return results;
  }

  forgetMemory(room: string, key: string): boolean {
    if (!this.db || !this.useSqlite) return false;
    const result = this.db.prepare('DELETE FROM ctx_memory WHERE room = ? AND key = ?').run(room, key);
    return result.changes > 0;
  }

  // ── Flush & Close ─────────────────────────────────────────────────────────────

  /** Flush all dirty in-memory entries to SQLite. */
  flush(): void {
    if (!this.db || !this.useSqlite) return;

    for (const id of this.dirtySessions) {
      const s = this.sessionCache.get(id);
      if (s) this.flushSession(s);
    }

    for (const id of this.dirtySkills) {
      const sk = this.skillCache.get(id);
      if (sk) this.flushSkill(sk);
    }
  }

  close(): void {
    this.flush();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createContextDB(options?: { dbPath?: string; useSqlite?: boolean }): ContextDB {
  return new ContextDB(options);
}
