/**
 * Claims (Resource Coordination) Tools
 * - claim: Claim exclusive access to a resource
 * - release: Release a previously claimed resource
 * - claims: List all active resource claims
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainDB } from '../db.js';

interface ClaimsToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  getSessionId: () => string | null;
  getSessionName: () => string;
}

export function registerClaimsTools(
  server: McpServer,
  options: ClaimsToolsOptions,
) {
  const { db, room, ensureSession, getSessionId, getSessionName } = options;

  // Schema coercion helpers
  const cNum = () => z.preprocess(
    (v: unknown) => typeof v === 'string' && (v as string).trim() !== '' ? Number(v) : v,
    z.number(),
  );

  // Standard reply helper
  const reply = (data: unknown, compactData?: unknown): { content: [{ type: 'text'; text: string }] } => {
    const payload = compactData !== undefined ? compactData : data;
    const text = JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text' as const, text }] };
  };

  // ── claim ────────────────────────────────────────────────────────────────────
  server.tool(
    'claim',
    'Claim exclusive access to a resource (file, task, etc.). Prevents other sessions from claiming it. Use TTL for auto-release.',
    {
      resource: z.string().describe('Resource identifier (e.g. file path, task name, "src/api/routes.ts")'),
      ttl: cNum().optional().describe('Auto-release after this many seconds (prevents zombie claims)'),
    },
    async ({ resource, ttl }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      const result = db.claim(resource, sid, sessionName, room, ttl);
      return reply(result, result.claimed ? { ok: 1 } : { no: result.owner });
    }
  );

  // ── release ─────────────────────────────────────────────────────────────────
  server.tool(
    'release',
    'Release a previously claimed resource so other sessions can claim it.',
    {
      resource: z.string().describe('Resource identifier to release'),
    },
    async ({ resource }) => {
      const sid = ensureSession();
      const released = db.release(resource, sid);
      return reply({ released, resource }, { ok: released ? 1 : 0 });
    }
  );

  // ── claims ───────────────────────────────────────────────────────────────────
  server.tool(
    'claims',
    'List all active resource claims. See what resources are locked and by whom.',
    {
      current_room: z.boolean().optional().describe('Only show claims in the current room'),
    },
    async ({ current_room }) => {
      ensureSession();
      const claims = db.getClaims(current_room ? room : undefined);
      return reply(claims);
    }
  );
}
