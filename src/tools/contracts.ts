/**
 * Contracts Tools
 * - contract_set: Publish interface contracts
 * - contract_get: Read published contracts
 * - contract_check: Validate all contracts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainDB } from '../db.js';

interface ContractsToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  getSessionId: () => string | null;
  getSessionName: () => string;
}

export function registerContractsTools(
  server: McpServer,
  options: ContractsToolsOptions,
) {
  const { db, room, ensureSession, getSessionName } = options;

  // Schema coercion helpers
  const cArr = <T extends z.ZodTypeAny>(item: T) => z.preprocess(
    (v: unknown) => {
      if (typeof v !== 'string') return v;
      try {
        const parsed = JSON.parse(v as string);
        return Array.isArray(parsed) ? parsed : v;
      } catch {
        return v;
      }
    },
    z.array(item),
  );

  // ── contract_set ───────────────────────────────────────────────────────────
  server.tool(
    'contract_set',
    `Publish interface contracts for functions your module provides or expects from other modules.
Call this AFTER writing/modifying a file to declare what it exports (provides),
and BEFORE calling cross-module functions to declare what you need (expects).
This lets the system catch param mismatches, missing functions, and type errors between agents.

Two input shapes are accepted:
  1. Single entry:  {module, name, kind, signature}
  2. Batch:         {entries: [{module, name, kind, signature}, ...]}`,
    {
      entries: cArr(z.object({
        module: z.string(),
        name: z.string(),
        kind: z.enum(['provides', 'expects']),
        signature: z.string(),
      })).optional().describe('Array of contract entries to publish (for batch mode)'),
      module: z.string().optional().describe('File path (single-entry mode, e.g. "src/ui.ts")'),
      name: z.string().optional().describe('Function or type name (single-entry mode)'),
      kind: z.enum(['provides', 'expects']).optional().describe('"provides" or "expects" (single-entry mode)'),
      signature: z.string().optional().describe('JSON signature e.g. {"params":["party: Party"],"returns":"void"} (single-entry mode)'),
    },
    async ({ entries, module, name, kind, signature }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      const allEntries = entries ? [...entries] : [];
      if (module && name && kind && signature) {
        allEntries.push({ module, name, kind, signature });
      }
      if (allEntries.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            ok: false,
            error: 'Provide either a single {module,name,kind,signature} or entries:[...].',
          }) }],
        };
      }
      const count = db.setContractBatch(allEntries, sid, sessionName, room);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, published: count }) }],
      };
    }
  );

  // ── contract_get ───────────────────────────────────────────────────────────
  server.tool(
    'contract_get',
    'Read published contracts. See what functions other agents provide or expect. Use this to align your code with their interfaces.',
    {
      module: z.string().optional().describe('Filter by module path (e.g. "src/ui.ts")'),
      kind: z.enum(['provides', 'expects']).optional().describe('Filter by kind'),
    },
    async ({ module, kind }) => {
      ensureSession();
      const contracts = db.getContracts(room, module, kind);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(contracts, null, 2) }],
      };
    }
  );

  // ── contract_check ─────────────────────────────────────────────────────────
  server.tool(
    'contract_check',
    `Validate all contracts in the room. Finds: missing functions (expected but no provider),
param count mismatches, param type mismatches, return type mismatches.
Call this periodically or before marking your task as done.
Returns an array of mismatches — empty array means all contracts are satisfied.`,
    async () => {
      ensureSession();
      const mismatches = db.validateContracts(room);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            valid: mismatches.length === 0,
            mismatch_count: mismatches.length,
            mismatches,
          }, null, 2),
        }],
      };
    }
  );
}
