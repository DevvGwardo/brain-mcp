/**
 * Persistent Memory Tools
 * - remember: Store knowledge that persists across sessions
 * - recall: Search persistent memory for stored knowledge
 * - forget: Remove a memory by key
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainDB } from '../db.js';

interface MemoryToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  getSessionId: () => string | null;
  getSessionName: () => string;
}

export function registerMemoryTools(
  server: McpServer,
  options: MemoryToolsOptions,
) {
  const { db, room, ensureSession, getSessionName } = options;

  // Schema coercion helpers
  const cNum = () => z.preprocess(
    (v: unknown) => typeof v === 'string' && (v as string).trim() !== '' ? Number(v) : v,
    z.number(),
  );

  // Reply helper
  const reply = (data: unknown): { content: [{ type: 'text'; text: string }] } => {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  };

  // Write-op acknowledgement helper
  const ack = (extra?: Record<string, unknown>): { content: [{ type: 'text'; text: string }] } => {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...extra }) }] };
  };

  // ── remember ──────────────────────────────────────────────────────────────
  server.tool(
    'remember',
    `Store knowledge that persists across sessions. Use this to record discoveries about the codebase,
architectural decisions, patterns found, or anything future agents should know.
Unlike brain_set (ephemeral shared state), memories survive brain_clear and are searchable.`,
    {
      key: z.string().describe('Short descriptive key (e.g. "auth-middleware-pattern", "api-rate-limits", "db-schema-quirk")'),
      content: z.string().describe('The knowledge to store. Be specific and actionable — future agents will read this.'),
      category: z.string().optional().describe('Category for organization: "architecture", "pattern", "gotcha", "decision", "dependency", "config" (default: "general")'),
    },
    async ({ key, content, category }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      const id = db.storeMemory(room, key, content, category || 'general', sid, sessionName);
      return ack({ id });
    }
  );

  // ── recall ────────────────────────────────────────────────────────────────
  server.tool(
    'recall',
    `Search persistent memory for knowledge stored by previous agents or sessions.
Always check memory at the start of a task — previous agents may have discovered something relevant.`,
    {
      query: z.string().optional().describe('Search term to match against key and content (optional — omit to list all)'),
      category: z.string().optional().describe('Filter by category'),
      limit: cNum().optional().describe('Max results (default: 20)'),
    },
    async ({ query, category, limit }) => {
      ensureSession();
      const memories = await db.recallMemory(room, query, category, limit);
      const categories = db.listMemoryCategories(room);
      const data = {
        count: memories.length,
        categories,
        memories: memories.map(m => ({
          id: m.id, key: m.key, content: m.content,
          category: m.category, access_count: m.access_count,
          created_by: m.created_by_name, updated_at: m.updated_at,
        })),
      };
      return reply(data);
    }
  );

  // ── forget ────────────────────────────────────────────────────────────────
  server.tool(
    'forget',
    'Remove a memory by key. Use when knowledge is outdated or wrong.',
    {
      key: z.string().describe('Memory key to remove'),
    },
    async ({ key }) => {
      ensureSession();
      const removed = db.forgetMemoryByKey(room, key);
      return reply({ removed, key });
    }
  );
}
