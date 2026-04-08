/**
 * Heartbeat Tools
 * - pulse: Report progress and stay alive
 * - agents: Check health of all agents in the room
 * - respawn: Respawn a failed or stale agent
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainDB } from '../db.js';

interface HeartbeatToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  getSessionId: () => string | null;
  getSessionName: () => string;
  compactMode: boolean;
  startLeadWatchdog: (sid: string) => void;
  renderTool: (name: string, data: string, opts: { color: boolean }) => string;
}

export function registerHeartbeatTools(
  server: McpServer,
  options: HeartbeatToolsOptions,
) {
  const { db, room, ensureSession, getSessionName, compactMode, startLeadWatchdog, renderTool } = options;

  // Schema coercion helpers
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

  // Reply helper (supports compact mode and renderer)
  function reply(data: any, compactData?: any, rendererName?: string): { content: [{ type: 'text'; text: string }] } {
    if (!compactMode && rendererName) {
      return {
        content: [{
          type: 'text' as const,
          text: renderTool(rendererName, JSON.stringify(data), { color: true }),
        }],
      };
    }
    const payload = compactMode && compactData !== undefined ? compactData : data;
    const text = compactMode ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text' as const, text }] };
  }

  // ── pulse ──────────────────────────────────────────────────────────────────
  server.tool(
    'pulse',
    'Report your progress and stay alive. Call this every few tool calls to let the lead know you are working. Returns any pending DMs so you stay in sync.',
    {
      status: z.enum(['working', 'done', 'failed']).describe('Current status: working (still going), done (task complete), failed (hit a blocker)'),
      progress: z.string().optional().describe('Short progress note (e.g. "editing src/api.ts", "tests passing", "blocked on type error")'),
    },
    async ({ status, progress }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      // pulseWithFirstConfirm ensures 'queued' sessions only transition to 'working'
      // on the first confirmed heartbeat from the agent — not at pre-registration time.
      if (!db.pulseWithFirstConfirm(sid, status, progress)) {
        // Session missing (e.g. crash cleanup) — re-register as 'queued' (not 'working')
        db.registerSession(sessionName, room, undefined, sid);
        db.pulseWithFirstConfirm(sid, status, progress);
      }
      // Auto-consume unread DMs so agents stay coordinated without extra calls
      const pending = db.consumeInbox(sid);
      const dm = pending.length > 0 ? pending : undefined;
      return reply(
        { ok: true, status, progress, pending_messages: dm },
        dm ? { ok: 1, dm: dm.map(m => `${m.from_name}: ${m.content}`) } : { ok: 1 },
      );
    }
  );

  // ── agents ─────────────────────────────────────────────────────────────────
  server.tool(
    'agents',
    'Check health of all agents in the room. Shows status, last heartbeat age, progress, and held claims. Use this to monitor spawned agents.',
    {
      include_stale: cBool().optional().describe('Include agents that stopped heartbeating (default: true)'),
    },
    async ({ include_stale }) => {
      ensureSession();
      const agents = db.getAgentHealth(room);
      const filtered = (include_stale !== false) ? agents : agents.filter(a => !a.is_stale);
      const agentSummary = {
        total: filtered.length,
        working: filtered.filter(a => a.status === 'working' && !a.is_stale).length,
        done: filtered.filter(a => a.status === 'done').length,
        failed: filtered.filter(a => a.status === 'failed').length,
        stale: filtered.filter(a => a.is_stale).length,
        agents: filtered,
      };
      // Compact: just name+status, drop all the detail
      return reply(
        agentSummary,
        {
          ...agentSummary,
          agents: filtered.map(a => ({ n: a.name, s: a.status, p: a.progress })),
        },
        'brain_agents',
      );
    }
  );

  // ── respawn ────────────────────────────────────────────────────────────────
  server.tool(
    'respawn',
    `Respawn a failed or stale agent with context about what it accomplished before failing.
Reads the original task, the agent's posts, claims, and progress to brief the replacement.
The replacement agent picks up where the failed one left off.`,
    {
      agent_name: z.string().describe('Name of the failed/stale agent to respawn'),
      extra_context: z.string().optional().describe('Additional instructions for the replacement (e.g. "the error was in line 42")'),
      layout: z.enum(['vertical', 'horizontal', 'tiled', 'window', 'headless']).optional().describe('Layout for the new agent (default: headless)'),
      model: z.string().optional().describe('Model override for the replacement agent'),
    },
    async ({ agent_name, extra_context, layout, model }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      startLeadWatchdog(sid);

      // Find the failed agent
      const agents = db.getAgentHealth(room);
      const failed = agents.find(a => a.name === agent_name);
      if (!failed) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `Agent "${agent_name}" not found` }) }],
          isError: true,
        };
      }

      // Gather context from the failed agent
      const session = db.getSession(failed.id);
      const metadata = session?.metadata ? JSON.parse(session.metadata) : {};
      const originalTaskId = metadata.task_id;

      // Read the original task
      let originalTask = '';
      if (originalTaskId) {
        const taskMessages = db.getMessages('tasks', room, originalTaskId - 1, 1);
        if (taskMessages.length > 0) originalTask = taskMessages[0].content;
      }

      // Read what the failed agent posted
      const agentPosts = db.getMessages('general', room).filter(m => m.sender_id === failed.id);
      const lastProgress = failed.progress || 'unknown';

      // Build replacement prompt with recovery context
      const recoveryContext = [
        `RECOVERY CONTEXT: You are replacing agent "${agent_name}" which ${failed.status === 'failed' ? 'failed' : 'became stale'}.`,
        `Previous agent's last known progress: "${lastProgress}"`,
        failed.claims.length > 0 ? `Files the previous agent was working on: ${failed.claims.join(', ')}` : '',
        agentPosts.length > 0 ? `Messages from the previous agent:\n${agentPosts.map(p => `  - ${p.content}`).join('\n')}` : '',
        extra_context ? `\nADDITIONAL INSTRUCTIONS: ${extra_context}` : '',
        '',
        'Pick up where they left off. Check the current state of their files before making changes.',
      ].filter(Boolean).join('\n');

      const fullTask = originalTask
        ? `${recoveryContext}\n\nORIGINAL TASK:\n${originalTask}`
        : `${recoveryContext}\n\nContinue the work that "${agent_name}" was doing.`;

      // Release the failed agent's claims so the replacement can claim them
      if (failed.id) {
        db.releaseAllClaims(failed.id);
      }

      // Record metric for the failed agent
      db.recordMetric(room, agent_name, failed.id, {
        task_description: originalTask.slice(0, 200),
        outcome: 'failed',
        started_at: session?.created_at,
      });

      // Spawn replacement (reuse brain_wake logic by posting to tasks and spawning)
      const replacementName = `${agent_name}-r${Date.now() % 10000}`;

      // We need to call brain_wake programmatically — but since we're in the same server,
      // we can just do the spawn directly. For simplicity, return the info and let the lead call brain_wake.
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            message: `Recovery context built for "${agent_name}". Call brain_wake with the task below to spawn the replacement.`,
            replacement_name: replacementName,
            replacement_task: fullTask,
            suggested_layout: layout || 'headless',
            suggested_model: model || metadata.model || null,
            released_claims: failed.claims,
          }, null, 2),
        }],
      };
    }
  );
}
