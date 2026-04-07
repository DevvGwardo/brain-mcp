/**
 * Identity & Discovery Tools
 * - register: Register or rename this session
 * - sessions: List all active sessions
 * - status: Show this session's info and room stats
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainDB } from '../db.js';

type IsolationMode = 'shared' | 'snapshot';

interface IdentityToolsOptions {
  db: BrainDB;
  room: string;
  roomLabel: string;
  sessionId: string | null;
  sessionName: string;
  ensureSession: () => string;
  getSessionId: () => string | null;
  setSessionId: (id: string) => void;
  setSessionName: (name: string) => void;
}

export function registerIdentityTools(
  server: McpServer,
  options: IdentityToolsOptions,
) {
  const { db, room, roomLabel, ensureSession, getSessionId, setSessionId, setSessionName } = options;

  // Schema coercion helpers (reused from index.ts)
  const cBool = () => z.preprocess(
    (v: unknown) => {
      if (typeof v !== 'string') return v;
      const s = (v as string).toLowerCase().trim();
      if (s === 'true' || s === '1' || s === 'yes') return true;
      if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
      return v;
    },
    z.boolean(),
  );

  // Helper to format tool responses (compact mode aware)
  const reply = (data: unknown, compactData?: unknown): { content: [{ type: 'text'; text: string }] } => {
    const payload = compactData !== undefined ? compactData : data;
    const text = JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text' as const, text }] };
  };

  // ── register ─────────────────────────────────────────────────────────────────
  server.tool(
    'register',
    'Register or rename this session. Call this first to set a meaningful name for coordination with other sessions.',
    {
      name: z.string().describe('Display name for this session (e.g. "frontend-worker", "reviewer", "architect")'),
    },
    async ({ name }) => {
      setSessionName(name);
      const sid = getSessionId();
      if (sid) {
        db.updateSessionName(sid, name);
      } else {
        const newId = db.registerSession(name, room);
        setSessionId(newId);
      }
      return reply({ sessionId: getSessionId(), name, room, roomLabel }, { ok: 1, name });
    }
  );

  // ── sessions ───────────────────────────────────────────────────────────────────
  server.tool(
    'sessions',
    'List all active sessions. See who else is connected and their session IDs for DMs.',
    {
      all_rooms: cBool().optional().describe('Show sessions from ALL rooms, not just the current working directory'),
    },
    async ({ all_rooms }) => {
      ensureSession();
      const sessions = db.getSessions(all_rooms ? undefined : room);
      return reply(sessions);
    }
  );

  // ── status ────────────────────────────────────────────────────────────────────
  server.tool(
    'status',
    'Show this session\'s info, current room, and count of active sessions.',
    async () => {
      const sid = ensureSession();
      const self = db.getSession(sid);
      const allSessions = db.getSessions();
      const roomSessions = db.getSessions(room);
      return reply(
        { self, room, roomLabel, sessions: { total: allSessions.length, inRoom: roomSessions.length } },
        { name: self?.name, room: roomLabel, agents: roomSessions.length },
      );
    }
  );
}
