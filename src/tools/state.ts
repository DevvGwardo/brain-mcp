/**
 * State (KV Store) Tools
 * - set: Set a key-value pair in shared state
 * - get: Get a value from shared state
 * - keys: List all keys in a scope
 * - delete: Delete a key from shared state
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainDB } from '../db.js';

interface StateToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  getSessionId: () => string | null;
  getSessionName: () => string;
}

export function registerStateTools(
  server: McpServer,
  options: StateToolsOptions,
) {
  const { db, room, ensureSession, getSessionId, getSessionName } = options;

  // Reply helper (compact-aware)
  const reply = (data: unknown, compactData?: unknown): { content: [{ type: 'text'; text: string }] } => {
    const payload = compactData !== undefined ? compactData : data;
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
  };

  // Write-op acknowledgement helper
  const ack = (): { content: [{ type: 'text'; text: string }] } => {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
  };

  // ── set ─────────────────────────────────────────────────────────────────────
  server.tool(
    'set',
    'Set a key-value pair in the shared state store. Visible to all sessions in the same scope.',
    {
      key: z.string().describe('State key'),
      value: z.string().describe('Value to store (use JSON strings for complex data)'),
      scope: z.string().optional().describe('Scope: defaults to current room. Use "global" for cross-room state.'),
    },
    async ({ key, value, scope }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      const s = scope || room;
      db.setState(key, s, value, sid, sessionName);
      return ack();
    }
  );

  // ── get ─────────────────────────────────────────────────────────────────────
  server.tool(
    'get',
    'Get a value from the shared state store.',
    {
      key: z.string().describe('State key to read'),
      scope: z.string().optional().describe('Scope (default: current room)'),
    },
    async ({ key, scope }) => {
      ensureSession();
      const s = scope || room;
      const entry = db.getState(key, s);
      if (!entry) return reply({ found: false, key }, { v: null });
      return reply(
        { found: true, key, value: entry.value, updated_by: entry.updated_by_name, updated_at: entry.updated_at },
        { v: entry.value },
      );
    }
  );

  // ── keys ────────────────────────────────────────────────────────────────────
  server.tool(
    'keys',
    'List all keys in the shared state store for a given scope.',
    {
      scope: z.string().optional().describe('Scope (default: current room)'),
    },
    async ({ scope }) => {
      ensureSession();
      const s = scope || room;
      const keys = db.getKeys(s);
      return reply({ scope: s, keys });
    }
  );

  // ── delete ──────────────────────────────────────────────────────────────────
  server.tool(
    'delete',
    'Delete a key from the shared state store.',
    {
      key: z.string().describe('State key to delete'),
      scope: z.string().optional().describe('Scope (default: current room)'),
    },
    async ({ key, scope }) => {
      ensureSession();
      const s = scope || room;
      const deleted = db.deleteState(key, s);
      return reply({ deleted, key, scope: s });
    }
  );
}
