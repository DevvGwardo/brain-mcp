/**
 * Brain Autopilot — automatic protocol handling for LLMs.
 *
 * Problems this solves:
 * 1. LLMs forget to pulse → marked stale → lead thinks they crashed
 * 2. LLMs forget to claim → two agents edit the same file → conflict
 * 3. LLMs forget to release → files locked forever
 * 4. LLMs forget contracts → integration gate fails with cryptic errors
 * 5. LLMs forget checkpoint → lose all progress on context compression
 * 6. 49 tools overwhelm tool selection → LLM picks wrong tool or hallucinates
 * 7. Hermes sees "mcp_brain_brain_pulse" (double prefix) → tool call fails
 *
 * Solution: One meta-tool "brain" with an action parameter.
 * Auto-pulse, auto-claim, auto-release, auto-checkpoint.
 * Spawned agents get a 5-line prompt instead of 40+.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrainDB, SessionStatus } from './db.js';

const cNum = () => z.preprocess(
  (v) => typeof v === 'string' && v.trim() !== '' ? Number(v) : v,
  z.number(),
);

// ── Types ──────────────────────────────────────────────────────────────────

interface AutopilotState {
  sessionId: string;
  sessionName: string;
  room: string;
  toolCallCount: number;
  claimedFiles: Set<string>;
  lastCheckpoint: number; // tool call count at last checkpoint
}

// ── The single meta-tool ───────────────────────────────────────────────────

const ACTIONS = [
  'post',        // Post a message to the team
  'read',        // Read messages from a channel
  'dm',          // DM another agent
  'set',         // Set shared state
  'get',         // Get shared state
  'edit',        // Declare you're editing a file (auto-claims + auto-pulses)
  'done_file',   // Done editing a file (auto-releases)
  'status',      // Check what's going on (agents, claims, messages)
  'remember',    // Store knowledge for future agents
  'recall',      // Search past knowledge
  'done',        // Mark yourself as done (auto-releases all, auto-checks contracts, auto-posts)
  'failed',      // Mark yourself as failed with reason
  'help',        // Show available actions
] as const;

type Action = typeof ACTIONS[number];

export function registerAutopilot(
  server: McpServer,
  db: BrainDB,
  room: string,
  getSessionId: () => string,
  getSessionName: () => string,
): void {
  const state: AutopilotState = {
    sessionId: '',
    sessionName: '',
    room,
    toolCallCount: 0,
    claimedFiles: new Set(),
    lastCheckpoint: 0,
  };

  function ensureState() {
    state.sessionId = getSessionId();
    state.sessionName = getSessionName();
  }

  function autoPulse(progress?: string) {
    ensureState();
    state.toolCallCount++;
    db.pulse(state.sessionId, 'working', progress || `tool call #${state.toolCallCount}`);

    // Auto-checkpoint every 12 tool calls
    if (state.toolCallCount - state.lastCheckpoint >= 12) {
      state.lastCheckpoint = state.toolCallCount;
      db.saveCheckpoint(room, state.sessionId, state.sessionName, {
        current_task: progress || 'working',
        files_touched: [...state.claimedFiles],
        decisions: [],
        progress_summary: `${state.toolCallCount} tool calls, ${state.claimedFiles.size} files claimed`,
        blockers: [],
        next_steps: [],
      });
    }
  }

  function consumeDMs(): string | undefined {
    ensureState();
    const pending = db.consumeInbox(state.sessionId);
    if (pending.length > 0) {
      return `\n📬 PENDING DMs:\n${pending.map(m => `  [${m.from_name}]: ${m.content}`).join('\n')}`;
    }
    return undefined;
  }

  const toolDescription = `Multi-agent coordination — one tool for everything.

Actions:
  post     — Post a message to the team (content, channel?)
  read     — Read team messages (channel?, limit?)
  dm       — DM an agent (to, content)
  set      — Set shared state (key, value)
  get      — Get shared state (key)
  edit     — Start editing a file (file) — auto-locks it
  done_file — Done editing a file (file) — auto-unlocks it
  status   — See all agents, claims, and recent messages
  remember — Save knowledge for future agents (key, content, category?)
  recall   — Search past knowledge (query?, category?)
  done     — Mark task complete (summary) — auto-unlocks all files, posts summary
  failed   — Mark task failed (reason)
  help     — Show this help

For Hermes/MiniMax or any weaker tool caller: prefer this single tool instead of many low-level calls.
Make exactly one tool call per assistant message. Wait for the result, then decide the next call.

Heartbeats, file locking, checkpoints are ALL AUTOMATIC. Just do your work.`;

  const toolSchema = {
    action: z.enum(ACTIONS).describe('What to do'),
    content: z.string().optional().describe('Message content (for post, dm, remember)'),
    key: z.string().optional().describe('Key name (for set, get, remember)'),
    value: z.string().optional().describe('Value (for set)'),
    query: z.string().optional().describe('Search query (for recall, read)'),
    channel: z.string().optional().describe('Channel name (for post, read)'),
    to: z.string().optional().describe('Target agent name (for dm)'),
    file: z.string().optional().describe('File path (for edit, done_file)'),
    category: z.string().optional().describe('Category (for remember, recall)'),
    summary: z.string().optional().describe('Summary (for done)'),
    reason: z.string().optional().describe('Reason (for failed)'),
    limit: cNum().optional().describe('Max results (for read, recall)'),
  };

  const toolHandler = async ({ action, content, key, value, query, channel, to, file, category, summary, reason, limit }: any) => {
      ensureState();
      autoPulse(`brain:${action}`);
      const dms = consumeDMs();

      let result: any;

      switch (action as Action) {
        case 'post': {
          if (!content) return err('content is required for post', dms);
          const id = db.postMessage(channel || 'general', room, state.sessionId, state.sessionName, content);
          result = { ok: true, messageId: id, channel: channel || 'general' };
          break;
        }

        case 'read': {
          const msgs = db.getMessages(channel || 'general', room, undefined, limit || 20);
          result = { messages: msgs.map(m => ({ from: m.sender_name, content: m.content, at: m.created_at })) };
          break;
        }

        case 'dm': {
          if (!to || !content) return err('to and content are required for dm', dms);
          const sessions = db.getSessions();
          const target = sessions.find(s => s.name === to);
          if (!target) return err(`Agent "${to}" not found`, dms);
          db.sendDM(state.sessionId, state.sessionName, target.id, content);
          result = { ok: true, to };
          break;
        }

        case 'set': {
          if (!key || value === undefined) return err('key and value are required for set', dms);
          db.setState(key, room, value, state.sessionId, state.sessionName);
          result = { ok: true, key };
          break;
        }

        case 'get': {
          if (!key) return err('key is required for get', dms);
          const entry = db.getState(key, room);
          result = entry ? { found: true, value: entry.value, updated_by: entry.updated_by_name } : { found: false };
          break;
        }

        case 'edit': {
          if (!file) return err('file is required for edit', dms);
          const claim = db.claim(file, state.sessionId, state.sessionName, room, 600); // 10 min TTL
          if (!claim.claimed) {
            result = { locked: true, owner: claim.owner, message: `File locked by ${claim.owner}. DM them or wait.` };
          } else {
            state.claimedFiles.add(file);
            result = { ok: true, file, message: 'File claimed. Edit freely.' };
          }
          break;
        }

        case 'done_file': {
          if (!file) return err('file is required for done_file', dms);
          db.release(file, state.sessionId);
          state.claimedFiles.delete(file);
          result = { ok: true, file, message: 'File released.' };
          break;
        }

        case 'status': {
          const agents = db.getAgentHealth(room);
          const claims = db.getClaims(room);
          const recent = db.getMessages('general', room, undefined, 5);
          const keys = db.getKeys(room).slice(0, 20);
          result = {
            agents: agents.map(a => ({ name: a.name, status: a.status, progress: a.progress, stale: a.is_stale })),
            claims: claims.map(c => ({ file: c.resource, owner: c.owner_name })),
            state_keys: keys,
            recent_messages: recent.map(m => ({ from: m.sender_name, content: m.content.slice(0, 100) })),
          };
          break;
        }

        case 'remember': {
          if (!key || !content) return err('key and content are required for remember', dms);
          const id = db.storeMemory(room, key, content, category || 'general', state.sessionId, state.sessionName);
          result = { ok: true, id, key };
          break;
        }

        case 'recall': {
          const memories = await db.recallMemory(room, query, category, limit || 10);
          result = {
            count: memories.length,
            memories: memories.map(m => ({ key: m.key, content: m.content, category: m.category })),
          };
          break;
        }

        case 'done': {
          // Auto-release all claimed files
          for (const f of state.claimedFiles) {
            db.release(f, state.sessionId);
          }
          state.claimedFiles.clear();

          // Auto-check contracts
          const mismatches = db.validateContracts(room);

          // Post summary
          const msg = summary || 'Task complete.';
          db.postMessage('general', room, state.sessionId, state.sessionName, `✅ DONE: ${msg}`);
          db.pulse(state.sessionId, 'done', msg);

          result = {
            ok: true,
            summary: msg,
            files_released: true,
            contract_mismatches: mismatches.length,
            mismatches: mismatches.length > 0 ? mismatches.slice(0, 5).map(m => m.detail) : undefined,
          };
          break;
        }

        case 'failed': {
          // Auto-release all claimed files
          for (const f of state.claimedFiles) {
            db.release(f, state.sessionId);
          }
          state.claimedFiles.clear();

          const msg = reason || 'Unknown failure';
          db.postMessage('general', room, state.sessionId, state.sessionName, `❌ FAILED: ${msg}`);
          db.pulse(state.sessionId, 'failed', msg);

          result = { ok: true, reason: msg, files_released: true };
          break;
        }

        case 'help': {
          result = {
            actions: ACTIONS.map(a => a),
            tip: 'Prefer one brain/control tool call at a time. For a quick overview, use action="status".',
          };
          break;
        }

        default:
          return err(`Unknown action: ${action}`, dms);
      }

      // Append any pending DMs to the response
      const text = JSON.stringify(result, null, 2) + (dms || '');
      return { content: [{ type: 'text' as const, text }] };
    };

  server.tool(
    'brain',
    toolDescription,
    toolSchema,
    toolHandler,
  );

  server.tool(
    'control',
    `${toolDescription}

Alias of the "brain" meta-tool with a less ambiguous name for Hermes/MiniMax clients.`,
    toolSchema,
    toolHandler,
  );
}

function err(message: string, dms?: string) {
  const text = JSON.stringify({ error: message }) + (dms || '');
  return { content: [{ type: 'text' as const, text }], isError: true };
}

// ── Minimal prompt for spawned agents ──────────────────────────────────────

/**
 * Generate a minimal prompt for spawned agents that use the brain meta-tool.
 * This replaces the 40+ line protocol dump with 8 lines.
 */
export interface MinimalAgentPromptOptions {
  files?: string[];
  role?: string;
  acceptance?: string[];
  dependsOn?: string[];
  workspacePath?: string;
}

export function minimalAgentPrompt(
  agentName: string,
  task: string,
  options?: string[] | MinimalAgentPromptOptions,
): string {
  const normalized: MinimalAgentPromptOptions = Array.isArray(options)
    ? { files: options }
    : (options || {});
  const fileScope = normalized.files?.length
    ? `Your files: ${normalized.files.join(', ')}. Call brain(action="edit", file=...) before editing each one.`
    : '';
  const roleLine = normalized.role ? `Your role: ${normalized.role}.` : '';
  const depsLine = normalized.dependsOn?.length
    ? `Inputs to respect: ${normalized.dependsOn.join(', ')}. Read shared state/messages before duplicating their work.`
    : '';
  const workspaceLine = normalized.workspacePath ? `Working directory: ${normalized.workspacePath}.` : '';
  const acceptanceLine = normalized.acceptance?.length
    ? `Success criteria:\n${normalized.acceptance.map((item) => `- ${item}`).join('\n')}`
    : '';

  return [
    `You are "${agentName}", a focused coding agent.`,
    roleLine,
    workspaceLine,
    `You have one coordination tool: brain(action, ...). Use brain(action="help") to see all actions.`,
    fileScope,
    depsLine,
    '',
    `YOUR TASK: ${task}`,
    acceptanceLine ? `\n${acceptanceLine}` : '',
    '',
    `When done: brain(action="done", summary="what you did")`,
    `If stuck: brain(action="failed", reason="what went wrong")`,
    `Heartbeats, file locking, and checkpoints happen automatically.`,
  ].filter(Boolean).join('\n');
}
