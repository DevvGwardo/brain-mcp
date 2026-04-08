/**
 * Context Ledger Tools
 * - context_push: Record an entry to the context ledger
 * - context_get: Read back context ledger entries
 * - context_summary: Get condensed overview of context
 * - checkpoint: Save a snapshot of working state
 * - checkpoint_restore: Restore a saved checkpoint
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainDB } from '../db.js';

interface ContextToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  getSessionId: () => string | null;
  getSessionName: () => string;
}

export function registerContextTools(
  server: McpServer,
  options: ContextToolsOptions,
) {
  const { db, room, ensureSession, getSessionName } = options;

  // Schema coercion helpers
  const cNum = () => z.preprocess(
    (v: unknown) => typeof v === 'string' && (v as string).trim() !== '' ? Number(v) : v,
    z.number(),
  );
  const cArr = <T extends z.ZodTypeAny>(item: T) => z.preprocess(
    (v: unknown) => {
      if (typeof v !== 'string') return v;
      try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : v;
      } catch {
        return v;
      }
    },
    z.array(item),
  );

  // Reply helper
  const reply = (data: unknown): { content: [{ type: 'text'; text: string }] } => {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  };

  // Write-op acknowledgement helper
  const ack = (extra?: Record<string, unknown>): { content: [{ type: 'text'; text: string }] } => {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...extra }) }] };
  };

  // ── context_push ──────────────────────────────────────────────────────────
  server.tool(
    'context_push',
    `Record what you just did, learned, or decided. This is your external long-term memory.
When your context window compresses and you forget earlier work, the ledger still has it.
Call this after every significant action — it's cheap and saves you from losing track.`,
    {
      entry_type: z.enum(['action', 'discovery', 'decision', 'error', 'file_change']).describe(
        'What kind of entry: action (did something), discovery (learned something), decision (chose an approach), error (hit a problem), file_change (modified a file)'
      ),
      summary: z.string().describe('One-line summary of what happened (e.g. "Added error handling to deploy route", "Found that auth middleware requires session token")'),
      detail: z.string().optional().describe('Full detail — code snippets, reasoning, exact changes. Be verbose here, this is your recovery insurance.'),
      file_path: z.string().optional().describe('Relevant file path (e.g. "src/app/api/deploy/route.ts")'),
      tags: cArr(z.string()).optional().describe('Tags for filtering (e.g. ["error-handling", "api", "deploy"])'),
    },
    async ({ entry_type, summary, detail, file_path, tags }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      const id = db.pushContext(room, sid, sessionName, entry_type, summary, detail, file_path, tags);
      return ack({ id });
    }
  );

  // ── context_get ───────────────────────────────────────────────────────────
  server.tool(
    'context_get',
    `Read back your context ledger — everything you've done, learned, and decided.
Use this when you feel lost, after context compression, or to review what happened.
Filter by type, file, or session to get exactly what you need.`,
    {
      entry_type: z.enum(['action', 'discovery', 'decision', 'error', 'file_change', 'checkpoint']).optional().describe('Filter by entry type'),
      file_path: z.string().optional().describe('Filter by file path'),
      session_id: z.string().optional().describe('Filter by session (default: all sessions in room)'),
      since_id: cNum().optional().describe('Only entries after this ID'),
      limit: cNum().optional().describe('Max entries to return (default: 50)'),
    },
    async ({ entry_type, file_path, session_id, since_id, limit }) => {
      ensureSession();
      const entries = db.getContext(room, { entry_type, file_path, session_id, since_id, limit });
      const data = {
        count: entries.length,
        entries: entries.map(e => ({
          id: e.id, type: e.entry_type, summary: e.summary,
          detail: e.detail, file: e.file_path, agent: e.agent_name,
          at: e.created_at,
        })),
      };
      return reply(data);
    }
  );

  // ── context_summary ───────────────────────────────────────────────────────
  server.tool(
    'context_summary',
    `Get a condensed overview of all context: what's been done, which files were touched,
how many actions/discoveries/decisions/errors. Use this to quickly re-orient after a break
or context compression.`,
    {
      session_id: z.string().optional().describe('Filter to a specific session'),
    },
    async ({ session_id }) => {
      ensureSession();
      const summary = db.getContextSummary(room, session_id);
      const data = {
        total_entries: summary.total,
        by_type: summary.by_type,
        files_touched: summary.files_touched,
        recent: summary.recent.map(e => ({
          id: e.id, type: e.entry_type, summary: e.summary,
          file: e.file_path, at: e.created_at,
        })),
      };
      return reply(data);
    }
  );

  // ── checkpoint ────────────────────────────────────────────────────────────
  server.tool(
    'checkpoint',
    `Save a snapshot of your current working state. This is your insurance policy against
context loss. Call this every 10-15 tool calls, or before starting a complex sub-task.
If you later lose track of what you're doing, brain_checkpoint_restore brings it all back.`,
    {
      current_task: z.string().describe('What you are currently working on'),
      files_touched: cArr(z.string()).describe('Files you have read or modified so far'),
      decisions: cArr(z.string()).describe('Key decisions you have made (e.g. "Using try/catch wrapper pattern", "Keeping existing validation logic")'),
      progress_summary: z.string().describe('Where you are in the overall task (e.g. "3/7 routes done, deploy and instances complete, chat routes next")'),
      blockers: cArr(z.string()).optional().describe('Anything blocking progress'),
      next_steps: cArr(z.string()).describe('What you plan to do next, in order'),
    },
    async ({ current_task, files_touched, decisions, progress_summary, blockers, next_steps }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      const checkpointEntryId = db.pushContext(
        room,
        sid,
        sessionName,
        'checkpoint',
        `Checkpoint: ${progress_summary}`,
        JSON.stringify({ current_task, decisions, next_steps }),
      );
      const id = db.saveCheckpoint(room, sid, sessionName, {
        current_task, files_touched, decisions, progress_summary,
        blockers: blockers || [], next_steps,
      }, checkpointEntryId);
      return ack({ checkpoint_id: id });
    }
  );

  // ── checkpoint_restore ────────────────────────────────────────────────────
  server.tool(
    'checkpoint_restore',
    `Restore your last saved checkpoint. Use this when you've lost context, feel confused
about what you were doing, or after a long conversation compression.
Returns your last known state: current task, files touched, decisions made, progress, and next steps.`,
    {
      session_id: z.string().optional().describe('Restore a specific session\'s checkpoint (default: latest in room)'),
    },
    async ({ session_id }) => {
      ensureSession();
      const checkpoint = db.restoreCheckpoint(room, session_id);
      if (!checkpoint) {
        return reply(
          { found: false, message: 'No checkpoint found. Use context_get to review the ledger instead.' },
        );
      }
      const state = JSON.parse(checkpoint.state);
      const recentContext = checkpoint.ledger_entry_id
        ? db.getContext(room, { since_id: checkpoint.ledger_entry_id, limit: 10, order: 'asc' })
        : db.getContext(room, { since_created_at: checkpoint.created_at, limit: 10, order: 'asc' });
      const data = {
        found: true,
        checkpoint_id: checkpoint.id,
        agent: checkpoint.agent_name,
        saved_at: checkpoint.created_at,
        state,
        recent_activity: recentContext.map(e => ({
          type: e.entry_type, summary: e.summary, file: e.file_path,
        })),
      };
      return reply(data);
    }
  );
}
