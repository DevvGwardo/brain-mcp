/**
 * Admin Tools
 * - clear: Clear all brain data
 * - incr: Atomically increment a counter
 * - counter: Get current counter value
 * - compact: Toggle compact response mode
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainDB } from '../db.js';

interface AdminToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  compactMode: boolean;
  setCompactMode: (v: boolean) => void;
}

export function registerAdminTools(
  server: McpServer,
  options: AdminToolsOptions,
) {
  const { db, room, ensureSession, compactMode, setCompactMode } = options;

  // Schema coercion helpers
  const cNum = () => z.preprocess(
    (v: unknown) => typeof v === 'string' && (v as string).trim() !== '' ? Number(v) : v,
    z.number(),
  );
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

  // Reply helper
  const reply = (data: unknown, compactData?: unknown): { content: [{ type: 'text'; text: string }] } => {
    const payload = compactData !== undefined ? compactData : data;
    const text = JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text' as const, text }] };
  };

  // ── clear ────────────────────────────────────────────────────────────────────
  server.tool(
    'clear',
    'Clear all brain data — messages, state, claims, contracts, sessions. Use this to reset the brain for a fresh start.',
    {
      confirm: cBool().describe('Must be true to confirm the clear operation'),
    },
    async ({ confirm }) => {
      if (!confirm) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ cleared: false, reason: 'confirm must be true' }) }] };
      }
      const counts = db.clear();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ cleared: true, ...counts }) }],
      };
    }
  );

  // ── incr ─────────────────────────────────────────────────────────────────────
  server.tool(
    'incr',
    'Atomically increment a numeric counter in shared state. Thread-safe — use for shared counters, progress tracking, or aggregation across agents.',
    {
      key: z.string().describe('Counter key name'),
      delta: cNum().optional().describe('Amount to increment by (default: 1)'),
      scope: z.string().optional().describe('Scope (default: current room)'),
    },
    async ({ key, delta, scope }) => {
      ensureSession();
      const s = scope || room;
      try {
        const result = db.incr(key, s, delta ?? 1);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, key, scope: s, ...result }) }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: e.message }) }] };
      }
    }
  );

  // ── counter ──────────────────────────────────────────────────────────────────
  server.tool(
    'counter',
    'Get the current value of an atomic counter without incrementing.',
    {
      key: z.string().describe('Counter key name'),
      scope: z.string().optional().describe('Scope (default: current room)'),
    },
    async ({ key, scope }) => {
      ensureSession();
      const s = scope || room;
      try {
        const value = db.get_counter(key, s);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ key, scope: s, value }) }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message }) }] };
      }
    }
  );

  // ── compact ─────────────────────────────────────────────────────────────────
  server.tool(
    'compact',
    `Toggle compact response mode to reduce token cost. In compact mode:
- Write operations return {ok:1} instead of echoing data back
- Read operations skip pretty-printing
- Saves 30-80% tokens per tool call, significant over a long session.
Call with enabled=true at the start of a session to save tokens.`,
    {
      enabled: cBool().optional().describe('Enable (true) or disable (false) compact mode. Omit to toggle.'),
    },
    async ({ enabled }) => {
      const newMode = enabled !== undefined ? enabled : !compactMode;
      setCompactMode(newMode);
      return reply({ compact: newMode }, { c: newMode ? 1 : 0 });
    }
  );
}
