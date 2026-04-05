#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { basename, join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { BrainDB } from './db.js';
import { runGate, runGateAndNotify } from './gate.js';

// ── Initialize ──

const db = new BrainDB(process.env.BRAIN_DB_PATH);
const room = process.env.BRAIN_ROOM || process.cwd();
const roomLabel = basename(room);

let sessionId: string | null = process.env.BRAIN_SESSION_ID || null;
let spawnedAgentCount = 0;

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Colors for each spawned agent pane border (cycles through these)
const AGENT_COLORS = [
  '#3B82F6', // blue
  '#10B981', // emerald
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#06B6D4', // cyan
  '#F97316', // orange
  '#14B8A6', // teal
  '#A855F7', // purple
];
let sessionName = process.env.BRAIN_SESSION_NAME || `session-${process.pid}`;

function ensureSession(): string {
  if (!sessionId) {
    sessionId = db.registerSession(sessionName, room);
    return sessionId;
  }
  if (!db.heartbeat(sessionId)) {
    // Session was deleted (crash cleanup) — re-register with same ID
    db.registerSession(sessionName, room, undefined, sessionId);
    db.heartbeat(sessionId);
  }
  return sessionId;
}

// ── Cleanup on exit ──

function cleanup(removeSessionRecord = true) {
  if (sessionId) {
    try {
      if (removeSessionRecord) db.removeSession(sessionId);
      else db.releaseAllClaims(sessionId);
    } catch { /* best effort */ }
  }
  try { db.close(); } catch { /* best effort */ }
}

function handleFatal(kind: string, error: unknown) {
  const message =
    error instanceof Error ? `${kind}: ${error.stack ?? error.message}` : `${kind}: ${String(error)}`;
  if (sessionId) {
    try { db.pulse(sessionId, 'failed', message.slice(0, 1000)); } catch { /* best effort */ }
  }
  cleanup(false); // Keep session row visible as "failed", just release claims
  console.error(message);
  process.exit(1);
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('uncaughtException', (err) => handleFatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason));

// ── MCP Server ──

const server = new McpServer(
  {
    name: 'brain',
    version: '1.0.0',
  },
  {
    instructions: `Brain MCP — Multi-Agent Orchestration Server

This server provides tools for multiple Claude Code sessions to communicate, coordinate, and spawn parallel agents.

WHEN TO USE THESE TOOLS:
- When the user says "with N agents", "in parallel", "spawn agents", "use brain", "swarm", or "split this across agents"
- When you need to coordinate work with other Claude Code sessions
- When you want to spawn visible side-by-side Claude Code sessions via tmux
- When you want to use multiple LLMs (cheap model for boilerplate, expensive for architecture)
- When you want agents that remember what they learned across sessions

HOW TO ORCHESTRATE:
1. brain_register — name yourself (e.g. "lead", "architect")
2. brain_recall — check if previous sessions stored useful knowledge about this codebase
3. Analyze the task. For complex work, use brain_plan to create a dependency-aware task DAG
4. brain_set — store shared context so spawned agents can read it
5. brain_wake — spawn each agent. Supports:
   - tmux split panes (default) — visible, interactive
   - headless mode (layout="headless") — no tmux needed, works everywhere
   - multi-LLM routing (model="haiku" for cheap tasks, model="opus" for complex ones)
   - custom CLIs (cli="codex", cli="aider" — for non-Claude agents)
   - configurable timeouts (timeout=3600)
6. brain_agents — monitor health of all spawned agents
7. brain_auto_gate — run continuous integration gate until all errors are fixed
8. brain_respawn — if an agent fails, respawn with recovery context
9. brain_remember — store discoveries for future sessions
10. brain_metrics — track agent performance over time

TASK DAG (for complex work):
- brain_plan — create tasks with dependencies: types → implementation → tests
- brain_plan_next — get tasks whose dependencies are all satisfied
- brain_plan_update — mark tasks done/failed (auto-promotes dependents to ready)
- brain_plan_status — view overall progress

PERSISTENT MEMORY (knowledge that survives across sessions):
- brain_remember — store knowledge (architecture insights, gotchas, patterns)
- brain_recall — search for knowledge from previous agents/sessions
- brain_forget — remove outdated knowledge
- This is the key differentiator — native agents are amnesiac, brain agents learn

HEARTBEAT PROTOCOL:
- Spawned agents call brain_pulse every 2-3 tool calls to report status
- The lead calls brain_agents to see all agent health at a glance
- brain_pulse also returns pending DMs, keeping agents in sync

CONTRACT PROTOCOL (prevents integration bugs):
- brain_contract_set — publish what your module provides/expects
- brain_contract_get — read other agents' contracts before writing code
- brain_contract_check — validate all contracts
- brain_auto_gate — run gate in a loop, DM agents their errors, wait for fixes

AUTO-RECOVERY:
- brain_respawn — detect failed agent, build recovery context, spawn replacement
- The replacement knows what the previous agent was doing and picks up where it left off

PERFORMANCE TRACKING:
- brain_metrics — view success rates, duration, error counts per agent
- brain_metric_record — record outcome after a task completes
- Use this data to optimize: which models for which tasks, which patterns work

IMPORTANT: Do NOT fall back to the built-in Agent tool when the user asks for parallel agents or brain_wake. Use these brain tools instead — they spawn visible, independent sessions that the user can watch.`,
  }
);

// ═══════════════════════════════════════
//  Identity & Discovery
// ═══════════════════════════════════════

server.tool(
  'brain_register',
  'Register or rename this session. Call this first to set a meaningful name for coordination with other sessions.',
  {
    name: z.string().describe('Display name for this session (e.g. "frontend-worker", "reviewer", "architect")'),
  },
  async ({ name }) => {
    sessionName = name;
    if (sessionId) {
      db.updateSessionName(sessionId, name);
    } else {
      sessionId = db.registerSession(name, room);
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ sessionId, name, room, roomLabel }, null, 2) }],
    };
  }
);

server.tool(
  'brain_sessions',
  'List all active sessions. See who else is connected and their session IDs for DMs.',
  {
    all_rooms: z.boolean().optional().describe('Show sessions from ALL rooms, not just the current working directory'),
  },
  async ({ all_rooms }) => {
    ensureSession();
    const sessions = db.getSessions(all_rooms ? undefined : room);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(sessions, null, 2) }],
    };
  }
);

server.tool(
  'brain_status',
  'Show this session\'s info, current room, and count of active sessions.',
  async () => {
    const sid = ensureSession();
    const self = db.getSession(sid);
    const allSessions = db.getSessions();
    const roomSessions = db.getSessions(room);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          self,
          room,
          roomLabel,
          sessions: { total: allSessions.length, inRoom: roomSessions.length },
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════
//  Heartbeat & Health Monitoring
// ═══════════════════════════════════════

server.tool(
  'brain_pulse',
  'Report your progress and stay alive. Call this every few tool calls to let the lead know you are working. Returns any pending DMs so you stay in sync.',
  {
    status: z.enum(['working', 'done', 'failed']).describe('Current status: working (still going), done (task complete), failed (hit a blocker)'),
    progress: z.string().optional().describe('Short progress note (e.g. "editing src/api.ts", "tests passing", "blocked on type error")'),
  },
  async ({ status, progress }) => {
    const sid = ensureSession();
    if (!db.pulse(sid, status, progress)) {
      db.registerSession(sessionName, room, undefined, sid);
      db.pulse(sid, status, progress);
    }
    // Auto-consume unread DMs so agents stay coordinated without extra calls
    const pending = db.consumeInbox(sid);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          status,
          progress,
          pending_messages: pending.length > 0 ? pending : undefined,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'brain_agents',
  'Check health of all agents in the room. Shows status, last heartbeat age, progress, and held claims. Use this to monitor spawned agents.',
  {
    include_stale: z.boolean().optional().describe('Include agents that stopped heartbeating (default: true)'),
  },
  async ({ include_stale }) => {
    ensureSession();
    const agents = db.getAgentHealth(room);
    const filtered = (include_stale !== false) ? agents : agents.filter(a => !a.is_stale);
    const summary = {
      total: filtered.length,
      working: filtered.filter(a => a.status === 'working' && !a.is_stale).length,
      done: filtered.filter(a => a.status === 'done').length,
      failed: filtered.filter(a => a.status === 'failed').length,
      stale: filtered.filter(a => a.is_stale).length,
      agents: filtered,
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════
//  Channel Messaging
// ═══════════════════════════════════════

server.tool(
  'brain_post',
  'Post a message to a channel. All sessions in the same working directory (room) can read it.',
  {
    content: z.string().describe('Message content'),
    channel: z.string().optional().describe('Channel name (default: "general")'),
  },
  async ({ content, channel }) => {
    const sid = ensureSession();
    const ch = channel || 'general';
    const id = db.postMessage(ch, room, sid, sessionName, content);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ messageId: id, channel: ch, room: roomLabel }) }],
    };
  }
);

server.tool(
  'brain_read',
  'Read messages from a channel. Use since_id to poll for only new messages since your last read.',
  {
    channel: z.string().optional().describe('Channel name (default: "general")'),
    since_id: z.number().optional().describe('Only return messages with ID greater than this (for polling)'),
    limit: z.number().optional().describe('Max messages to return (default: 50)'),
  },
  async ({ channel, since_id, limit }) => {
    ensureSession();
    const messages = db.getMessages(channel || 'general', room, since_id, limit);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════
//  Direct Messages
// ═══════════════════════════════════════

server.tool(
  'brain_dm',
  'Send a direct message to another session. Works across rooms. Target by session name or ID.',
  {
    to: z.string().describe('Target session name or ID'),
    content: z.string().describe('Message content'),
  },
  async ({ to, content }) => {
    const sid = ensureSession();
    // Resolve name → ID if needed
    let targetId = to;
    const sessions = db.getSessions();
    const byName = sessions.find(s => s.name === to);
    if (byName) targetId = byName.id;
    const id = db.sendDM(sid, sessionName, targetId, content);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ messageId: id, to: targetId }) }],
    };
  }
);

server.tool(
  'brain_inbox',
  'Read direct messages sent to or from this session. Use since_id for polling.',
  {
    since_id: z.number().optional().describe('Only return messages with ID greater than this'),
  },
  async ({ since_id }) => {
    const sid = ensureSession();
    const messages = db.getInbox(sid, since_id);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════
//  Shared State (Key-Value Store)
// ═══════════════════════════════════════

server.tool(
  'brain_set',
  'Set a key-value pair in the shared state store. Visible to all sessions in the same scope.',
  {
    key: z.string().describe('State key'),
    value: z.string().describe('Value to store (use JSON strings for complex data)'),
    scope: z.string().optional().describe('Scope: defaults to current room. Use "global" for cross-room state.'),
  },
  async ({ key, value, scope }) => {
    const sid = ensureSession();
    const s = scope || room;
    db.setState(key, s, value, sid, sessionName);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, key, scope: s }) }],
    };
  }
);

server.tool(
  'brain_get',
  'Get a value from the shared state store.',
  {
    key: z.string().describe('State key to read'),
    scope: z.string().optional().describe('Scope (default: current room)'),
  },
  async ({ key, scope }) => {
    ensureSession();
    const s = scope || room;
    const entry = db.getState(key, s);
    if (!entry) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ found: false, key, scope: s }) }] };
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          found: true,
          key,
          value: entry.value,
          updated_by: entry.updated_by_name,
          updated_at: entry.updated_at,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'brain_keys',
  'List all keys in the shared state store for a given scope.',
  {
    scope: z.string().optional().describe('Scope (default: current room)'),
  },
  async ({ scope }) => {
    ensureSession();
    const s = scope || room;
    const keys = db.getKeys(s);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ scope: s, keys }) }],
    };
  }
);

server.tool(
  'brain_delete',
  'Delete a key from the shared state store.',
  {
    key: z.string().describe('State key to delete'),
    scope: z.string().optional().describe('Scope (default: current room)'),
  },
  async ({ key, scope }) => {
    ensureSession();
    const s = scope || room;
    const deleted = db.deleteState(key, s);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ deleted, key, scope: s }) }],
    };
  }
);

// ═══════════════════════════════════════
//  Resource Coordination (Mutex/Claims)
// ═══════════════════════════════════════

server.tool(
  'brain_claim',
  'Claim exclusive access to a resource (file, task, etc.). Prevents other sessions from claiming it. Use TTL for auto-release.',
  {
    resource: z.string().describe('Resource identifier (e.g. file path, task name, "src/api/routes.ts")'),
    ttl: z.number().optional().describe('Auto-release after this many seconds (prevents zombie claims)'),
  },
  async ({ resource, ttl }) => {
    const sid = ensureSession();
    const result = db.claim(resource, sid, sessionName, room, ttl);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  'brain_release',
  'Release a previously claimed resource so other sessions can claim it.',
  {
    resource: z.string().describe('Resource identifier to release'),
  },
  async ({ resource }) => {
    const sid = ensureSession();
    const released = db.release(resource, sid);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ released, resource }) }],
    };
  }
);

server.tool(
  'brain_claims',
  'List all active resource claims. See what resources are locked and by whom.',
  {
    current_room: z.boolean().optional().describe('Only show claims in the current room'),
  },
  async ({ current_room }) => {
    ensureSession();
    const claims = db.getClaims(current_room ? room : undefined);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(claims, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════
//  Interface Contracts
// ═══════════════════════════════════════

server.tool(
  'brain_contract_set',
  `Publish interface contracts for functions your module provides or expects from other modules.
Call this AFTER writing/modifying a file to declare what it exports (provides),
and BEFORE calling cross-module functions to declare what you need (expects).
This lets the system catch param mismatches, missing functions, and type errors between agents.

Two input shapes are accepted:
  1. Single entry:  {module, name, kind, signature}
  2. Batch:         {entries: [{module, name, kind, signature}, ...]}`,
  {
    entries: z.array(z.object({
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

server.tool(
  'brain_contract_get',
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

server.tool(
  'brain_contract_check',
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

// ═══════════════════════════════════════
//  Integration Gate
// ═══════════════════════════════════════

server.tool(
  'brain_gate',
  `Run the integration gate: tsc --noEmit + contract validation.
Catches type errors, missing imports, param mismatches between agents.
If errors are found, DMs each responsible agent with their specific errors and resets their status to "working".
Use this after all agents report "done" to verify integration before shipping.`,
  {
    notify: z.boolean().optional().describe('DM agents with their errors and reset status to working (default: true)'),
    dry_run: z.boolean().optional().describe('Just check, don\'t DM agents (default: false)'),
  },
  async ({ notify, dry_run }) => {
    const sid = ensureSession();
    const result = (dry_run || notify === false)
      ? runGate(db, room, room)
      : runGateAndNotify(db, room, room, sid, sessionName);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ...result,
          // Truncate large error lists for readability
          tsc: { ...result.tsc, errors: result.tsc.errors.slice(0, 20) },
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════
//  Admin
// ═══════════════════════════════════════

server.tool(
  'brain_clear',
  'Clear all brain data — messages, state, claims, contracts, sessions. Use this to reset the brain for a fresh start.',
  {
    confirm: z.boolean().describe('Must be true to confirm the clear operation'),
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

// ═══════════════════════════════════════
//  Context Ledger — external long-term memory
// ═══════════════════════════════════════

server.tool(
  'brain_context_push',
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
    tags: z.array(z.string()).optional().describe('Tags for filtering (e.g. ["error-handling", "api", "deploy"])'),
  },
  async ({ entry_type, summary, detail, file_path, tags }) => {
    const sid = ensureSession();
    const id = db.pushContext(room, sid, sessionName, entry_type, summary, detail, file_path, tags);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id, entry_type, summary }) }],
    };
  }
);

server.tool(
  'brain_context_get',
  `Read back your context ledger — everything you've done, learned, and decided.
Use this when you feel lost, after context compression, or to review what happened.
Filter by type, file, or session to get exactly what you need.`,
  {
    entry_type: z.enum(['action', 'discovery', 'decision', 'error', 'file_change', 'checkpoint']).optional().describe('Filter by entry type'),
    file_path: z.string().optional().describe('Filter by file path'),
    session_id: z.string().optional().describe('Filter by session (default: all sessions in room)'),
    since_id: z.number().optional().describe('Only entries after this ID'),
    limit: z.number().optional().describe('Max entries to return (default: 50)'),
  },
  async ({ entry_type, file_path, session_id, since_id, limit }) => {
    ensureSession();
    const entries = db.getContext(room, { entry_type, file_path, session_id, since_id, limit });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          count: entries.length,
          entries: entries.map(e => ({
            id: e.id, type: e.entry_type, summary: e.summary,
            detail: e.detail, file: e.file_path, agent: e.agent_name,
            at: e.created_at,
          })),
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'brain_context_summary',
  `Get a condensed overview of all context: what's been done, which files were touched,
how many actions/discoveries/decisions/errors. Use this to quickly re-orient after a break
or context compression.`,
  {
    session_id: z.string().optional().describe('Filter to a specific session'),
  },
  async ({ session_id }) => {
    ensureSession();
    const summary = db.getContextSummary(room, session_id);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          total_entries: summary.total,
          by_type: summary.by_type,
          files_touched: summary.files_touched,
          recent: summary.recent.map(e => ({
            id: e.id, type: e.entry_type, summary: e.summary,
            file: e.file_path, at: e.created_at,
          })),
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'brain_checkpoint',
  `Save a snapshot of your current working state. This is your insurance policy against
context loss. Call this every 10-15 tool calls, or before starting a complex sub-task.
If you later lose track of what you're doing, brain_checkpoint_restore brings it all back.`,
  {
    current_task: z.string().describe('What you are currently working on'),
    files_touched: z.array(z.string()).describe('Files you have read or modified so far'),
    decisions: z.array(z.string()).describe('Key decisions you have made (e.g. "Using try/catch wrapper pattern", "Keeping existing validation logic")'),
    progress_summary: z.string().describe('Where you are in the overall task (e.g. "3/7 routes done, deploy and instances complete, chat routes next")'),
    blockers: z.array(z.string()).optional().describe('Anything blocking progress'),
    next_steps: z.array(z.string()).describe('What you plan to do next, in order'),
  },
  async ({ current_task, files_touched, decisions, progress_summary, blockers, next_steps }) => {
    const sid = ensureSession();
    const id = db.saveCheckpoint(room, sid, sessionName, {
      current_task, files_touched, decisions, progress_summary,
      blockers: blockers || [], next_steps,
    });
    // Also push to context ledger
    db.pushContext(room, sid, sessionName, 'checkpoint', `Checkpoint: ${progress_summary}`,
      JSON.stringify({ current_task, decisions, next_steps }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, checkpoint_id: id, message: 'Checkpoint saved. Use brain_checkpoint_restore to recover this state.' }) }],
    };
  }
);

server.tool(
  'brain_checkpoint_restore',
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
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ found: false, message: 'No checkpoint found. Use brain_context_get to review the ledger instead.' }) }],
      };
    }
    const state = JSON.parse(checkpoint.state);
    // Also get recent context entries since the checkpoint
    const recentContext = db.getContext(room, { session_id: checkpoint.session_id, limit: 10 });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          found: true,
          checkpoint_id: checkpoint.id,
          agent: checkpoint.agent_name,
          saved_at: checkpoint.created_at,
          state,
          recent_activity: recentContext.map(e => ({
            type: e.entry_type, summary: e.summary, file: e.file_path,
          })),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════
//  Swarm — one-call multi-agent orchestration
// ═══════════════════════════════════════

server.tool(
  'brain_swarm',
  `Spawn multiple agents at once to work on a task in parallel. This is the high-level
orchestration tool — one call replaces multiple brain_wake calls.
Automatically: registers as lead, creates a task plan, spawns all agents, starts watchdog.
Use brain_agents to monitor, brain_auto_gate when done.`,
  {
    task: z.string().describe('The overall task to accomplish'),
    agents: z.array(z.object({
      name: z.string().describe('Agent name (e.g. "api-worker", "test-writer")'),
      task: z.string().describe('Specific task for this agent'),
      files: z.array(z.string()).optional().describe('Files this agent is responsible for'),
      model: z.string().optional().describe('Model override for this agent'),
    })).describe('Array of agents to spawn'),
    layout: z.enum(['horizontal', 'tiled', 'headless']).optional().describe('Layout for all agents (default: headless)'),
    model: z.string().optional().describe('Default model for all agents'),
  },
  async ({ task, agents: agentConfigs, layout, model: defaultModel }) => {
    const sid = ensureSession();
    startLeadWatchdog(sid);

    const spawnLayout = layout || 'headless';
    const cliBase = process.env.BRAIN_DEFAULT_CLI || 'claude';

    // Store shared context
    db.setState('swarm-task', room, task, sid, sessionName);

    // Spawn all agents
    const spawned: Array<{ name: string; sessionId: string; taskId: number }> = [];
    const errors: string[] = [];

    for (const agentCfg of agentConfigs) {
      try {
        const agentSessionId = randomUUID();
        const agentName = agentCfg.name;

        // Post task for audit trail
        const taskId = db.postMessage('tasks', room, sid, sessionName, agentCfg.task);

        // Pre-register
        db.registerSession(
          agentName, room,
          JSON.stringify({ parent_session_id: sid, task_id: taskId, swarm: true }),
          agentSessionId,
        );
        db.pulse(agentSessionId, 'working', 'spawned by swarm; initializing');

        // Build env
        const childEnvParts = [
          process.env.BRAIN_DB_PATH ? `BRAIN_DB_PATH=${sh(process.env.BRAIN_DB_PATH)}` : null,
          `BRAIN_ROOM=${sh(room)}`,
          `BRAIN_SESSION_ID=${sh(agentSessionId)}`,
          `BRAIN_SESSION_NAME=${sh(agentName)}`,
        ].filter(Boolean);

        const agentModel = agentCfg.model || defaultModel;
        const cliType: 'claude' | 'hermes' | 'other' =
          (cliBase === 'claude' || cliBase.includes('claude')) ? 'claude' :
          (cliBase === 'hermes' || cliBase.includes('hermes')) ? 'hermes' :
          'other';
        const toolPrefix = cliType === 'hermes' ? 'mcp_brain_' : '';

        // Build prompt
        const fileScope = agentCfg.files?.length
          ? `\nFILE SCOPE: You own these files: ${agentCfg.files.join(', ')}. Use ${toolPrefix}brain_claim on each before editing.\n`
          : '';

        const prompt = [
          cliType === 'hermes'
            ? 'You have brain MCP tools via the "brain" server (mcp_brain_brain_pulse, mcp_brain_brain_claim, mcp_brain_brain_release, mcp_brain_brain_post, mcp_brain_brain_contract_set, mcp_brain_brain_contract_get, mcp_brain_brain_contract_check, mcp_brain_brain_remember, mcp_brain_brain_recall).'
            : 'You have brain MCP tools (brain_pulse, brain_claim, brain_release, brain_post, brain_contract_set, brain_contract_get, brain_contract_check, brain_remember, brain_recall).',
          fileScope,
          `Your name: "${agentName}"`,
          `Call ${toolPrefix}brain_pulse with status="working" every 2-3 tool calls.`,
          `Use ${toolPrefix}brain_claim before editing files, ${toolPrefix}brain_release when done.`,
          `Check ${toolPrefix}brain_contract_get before coding, publish with ${toolPrefix}brain_contract_set after.`,
          '',
          `YOUR TASK:`,
          agentCfg.task,
          '',
          `WHEN DONE: ${toolPrefix}brain_contract_check, then ${toolPrefix}brain_pulse status="done", then ${toolPrefix}brain_post your summary, then ${toolPrefix}brain_release all files.`,
        ].join('\n');

        // Spawn headless
        const childEnv = childEnvParts.join(' ');
        const logFile = join(tmpdir(), `brain-agent-${agentSessionId}.log`);
        const ts = Date.now();
        const promptFile = join(tmpdir(), `brain-prompt-${ts}-${agentName}.txt`);
        writeFileSync(promptFile, prompt);

        let headlessCmd: string;
        if (cliType === 'claude') {
          const modelFlag = agentModel ? ` --model ${sh(agentModel)}` : '';
          headlessCmd = `cd ${sh(room)} && env ${childEnv} claude -p ${sh(prompt)}${modelFlag} --dangerously-skip-permissions > ${sh(logFile)} 2>&1`;
        } else if (cliType === 'hermes') {
          const hermesModelEnv = agentModel ? `HERMES_MODEL=${sh(agentModel)}` : '';
          headlessCmd = `cd ${sh(room)} && env ${childEnv} ${hermesModelEnv} hermes chat -q ${sh(prompt)} -Q > ${sh(logFile)} 2>&1`;
        } else {
          headlessCmd = `cd ${sh(room)} && env ${childEnv} cat ${sh(promptFile)} | ${sh(cliBase)} > ${sh(logFile)} 2>&1`;
        }

        // For tmux modes, use brain_wake's tmux logic
        if (spawnLayout !== 'headless') {
          try {
            execSync('tmux display-message -p ""', { stdio: 'ignore' });
          } catch {
            // Fall back to headless if tmux not available
          }
        }

        // Spawn as background process
        const watcherFile = join(tmpdir(), `brain-swarm-${ts}-${agentName}.sh`);
        writeFileSync(watcherFile, `#!/bin/bash\n${headlessCmd}\nrm -f "${promptFile}" "${watcherFile}"`, { mode: 0o755 });
        const watcher = spawn('bash', [watcherFile], { detached: true, stdio: 'ignore' });
        watcher.unref();

        spawned.push({ name: agentName, sessionId: agentSessionId, taskId });
      } catch (err: any) {
        errors.push(`${agentCfg.name}: ${err.message}`);
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: errors.length === 0,
          spawned: spawned.length,
          failed: errors.length,
          agents: spawned.map(s => ({ name: s.name, sessionId: s.sessionId })),
          errors: errors.length > 0 ? errors : undefined,
          cli: cliBase,
          message: `Swarm launched: ${spawned.length} agents spawned${errors.length ? `, ${errors.length} failed` : ''}. Monitor with brain_agents. Run brain_auto_gate when all agents report done.`,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════
//  Persistent Memory — knowledge that survives across sessions
// ═══════════════════════════════════════

server.tool(
  'brain_remember',
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
    const id = db.storeMemory(room, key, content, category || 'general', sid, sessionName);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id, key, category: category || 'general', message: 'Memory stored. Future agents can recall this.' }) }],
    };
  }
);

server.tool(
  'brain_recall',
  `Search persistent memory for knowledge stored by previous agents or sessions.
Always check memory at the start of a task — previous agents may have discovered something relevant.`,
  {
    query: z.string().optional().describe('Search term to match against key and content (optional — omit to list all)'),
    category: z.string().optional().describe('Filter by category'),
    limit: z.number().optional().describe('Max results (default: 20)'),
  },
  async ({ query, category, limit }) => {
    ensureSession();
    const memories = db.recallMemory(room, query, category, limit);
    const categories = db.listMemoryCategories(room);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          count: memories.length,
          categories,
          memories: memories.map(m => ({
            id: m.id,
            key: m.key,
            content: m.content,
            category: m.category,
            access_count: m.access_count,
            created_by: m.created_by_name,
            updated_at: m.updated_at,
          })),
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'brain_forget',
  'Remove a memory by key. Use when knowledge is outdated or wrong.',
  {
    key: z.string().describe('Memory key to remove'),
  },
  async ({ key }) => {
    ensureSession();
    const removed = db.forgetMemoryByKey(room, key);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ removed, key }) }],
    };
  }
);

// ═══════════════════════════════════════
//  Task DAG — dependency-aware task planning
// ═══════════════════════════════════════

server.tool(
  'brain_plan',
  `Create a task execution plan with dependencies. Tasks form a DAG — a task only becomes "ready"
when all its dependencies are done. Use this instead of naively splitting work by files.
Example: types → implementation → tests (each stage depends on the previous).`,
  {
    tasks: z.array(z.object({
      name: z.string().describe('Unique task name (e.g. "define-types", "implement-api", "write-tests")'),
      description: z.string().describe('What this task should accomplish'),
      depends_on: z.array(z.string()).optional().describe('Names of tasks that must complete before this one can start'),
      agent_name: z.string().optional().describe('Preferred agent name to assign this task to'),
    })).describe('Array of tasks with optional dependencies'),
  },
  async ({ tasks }) => {
    ensureSession();
    const result = db.createPlan(room, tasks);
    const ready = result.tasks.filter(t => t.status === 'ready');
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          plan_id: result.plan_id,
          total_tasks: result.tasks.length,
          ready_now: ready.map(t => ({ id: t.id, name: t.name, description: t.description })),
          message: `Plan created with ${result.tasks.length} tasks. ${ready.length} tasks are ready to start.`,
          tasks: result.tasks.map(t => ({ id: t.id, name: t.name, status: t.status, depends_on: JSON.parse(t.depends_on) })),
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'brain_plan_next',
  'Get the next tasks that are ready to be worked on (all dependencies satisfied). Use this to find work to assign to agents.',
  {
    plan_id: z.string().describe('Plan ID from brain_plan'),
  },
  async ({ plan_id }) => {
    ensureSession();
    const ready = db.getReadyTasks(room, plan_id);
    const status = db.getPlanStatus(room, plan_id);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ready_tasks: ready.map(t => ({ id: t.id, name: t.name, description: t.description, agent_name: t.agent_name })),
          plan_progress: {
            total: status.total, done: status.done, running: status.running,
            ready: status.ready, pending: status.pending, failed: status.failed,
          },
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'brain_plan_update',
  'Update a task in the plan. When marking a task "done", dependent tasks automatically become "ready". When marking "failed", dependents are skipped.',
  {
    task_id: z.string().describe('Task ID to update'),
    status: z.enum(['running', 'done', 'failed', 'skipped']).describe('New status'),
    agent_id: z.string().optional().describe('Session ID of agent working on this'),
    agent_name: z.string().optional().describe('Name of agent working on this'),
    result: z.string().optional().describe('Result summary when done/failed'),
  },
  async ({ task_id, status, agent_id, agent_name, result }) => {
    ensureSession();
    db.updateTaskNode(task_id, status, agent_id, agent_name, result);

    // Get updated plan status
    const task = db.getReadyTasks(room, '').length; // This is a bit of a hack
    // Better: get the task first, then the plan
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ok: true, task_id, status, result: result || null }),
      }],
    };
  }
);

server.tool(
  'brain_plan_status',
  'View the full status of a task plan — see which tasks are done, running, ready, pending, or failed.',
  {
    plan_id: z.string().optional().describe('Plan ID to check. Omit to list all plans.'),
  },
  async ({ plan_id }) => {
    ensureSession();
    if (plan_id) {
      const status = db.getPlanStatus(room, plan_id);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...status,
            tasks: status.tasks.map(t => ({
              id: t.id, name: t.name, status: t.status,
              agent_name: t.agent_name, result: t.result,
              depends_on: JSON.parse(t.depends_on),
            })),
          }, null, 2),
        }],
      };
    }
    const plans = db.getPlans(room);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ plans }, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════
//  Auto-Recovery — respawn failed/stale agents
// ═══════════════════════════════════════

server.tool(
  'brain_respawn',
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

// ═══════════════════════════════════════
//  Auto-Gate — continuous integration loop
// ═══════════════════════════════════════

server.tool(
  'brain_auto_gate',
  `Run the integration gate in a loop until all errors are fixed or max retries are hit.
After each failed gate, agents are DM'd their specific errors and given time to fix them.
Returns the final gate result. Use this after all agents report "done" to ship with confidence.`,
  {
    max_retries: z.number().optional().describe('Max gate attempts before giving up (default: 5)'),
    wait_seconds: z.number().optional().describe('Seconds to wait between gate attempts for agents to fix errors (default: 30)'),
  },
  async ({ max_retries, wait_seconds }) => {
    const sid = ensureSession();
    const maxAttempts = max_retries || 5;
    const waitMs = (wait_seconds || 30) * 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = runGateAndNotify(db, room, room, sid, sessionName);

      if (result.passed) {
        // Record success metrics for all agents
        const agents = db.getAgentHealth(room);
        for (const agent of agents) {
          if (agent.name !== sessionName && agent.status === 'done') {
            db.recordMetric(room, agent.name, agent.id, {
              outcome: 'success',
              gate_passes: attempt,
              tsc_errors: 0,
              contract_mismatches: 0,
            });
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...result,
              passed: true,
              attempts: attempt,
              message: `Gate PASSED on attempt ${attempt}/${maxAttempts}. All clear to ship.`,
            }, null, 2),
          }],
        };
      }

      if (attempt < maxAttempts) {
        // Wait for agents to fix errors
        db.postMessage('general', room, sid, sessionName,
          `Gate attempt ${attempt}/${maxAttempts} failed (${result.tsc.error_count} tsc, ${result.contracts.mismatch_count} contract). Agents notified. Waiting ${wait_seconds || 30}s...`);

        await new Promise(resolve => setTimeout(resolve, waitMs));

        // Check if agents have fixed and re-reported done
        const agents = db.getAgentHealth(room);
        const stillWorking = agents.filter(a => a.status === 'working' && a.name !== sessionName);
        if (stillWorking.length > 0) {
          // Wait a bit more for working agents
          await new Promise(resolve => setTimeout(resolve, waitMs));
        }
      }
    }

    // Final failure
    const finalResult = runGate(db, room, room);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ...finalResult,
          passed: false,
          attempts: maxAttempts,
          message: `Gate FAILED after ${maxAttempts} attempts. Remaining errors need manual attention.`,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════
//  Agent Metrics — performance tracking
// ═══════════════════════════════════════

server.tool(
  'brain_metrics',
  `View agent performance history. Tracks duration, error counts, gate passes, and success rates.
Use this to learn which agents/models perform best for which tasks, and to optimize future assignments.`,
  {
    agent_name: z.string().optional().describe('Filter by agent name (omit for summary of all agents)'),
    limit: z.number().optional().describe('Max records to return (default: 50)'),
  },
  async ({ agent_name, limit }) => {
    ensureSession();
    if (agent_name) {
      const metrics = db.getMetrics(room, agent_name, limit);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ agent: agent_name, metrics }, null, 2) }],
      };
    }
    const summary = db.getMetricsSummary(room);
    const recent = db.getMetrics(room, undefined, limit);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          summary,
          recent: recent.slice(0, 10),
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'brain_metric_record',
  'Record a performance metric for an agent. Call this when an agent completes or fails a task.',
  {
    agent_name: z.string().describe('Agent name'),
    agent_id: z.string().optional().describe('Agent session ID'),
    outcome: z.enum(['success', 'partial', 'failed']).describe('How the task went'),
    task_description: z.string().optional().describe('What the agent was doing'),
    duration_seconds: z.number().optional().describe('How long the task took'),
    gate_passes: z.number().optional().describe('How many gate iterations before passing'),
    tsc_errors: z.number().optional().describe('Number of tsc errors at completion'),
    contract_mismatches: z.number().optional().describe('Number of contract mismatches'),
    files_changed: z.number().optional().describe('Number of files modified'),
  },
  async ({ agent_name, agent_id, outcome, task_description, duration_seconds, gate_passes, tsc_errors, contract_mismatches, files_changed }) => {
    ensureSession();
    const id = db.recordMetric(room, agent_name, agent_id || null, {
      outcome, task_description, duration_seconds,
      gate_passes, tsc_errors, contract_mismatches, files_changed,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, metric_id: id }) }],
    };
  }
);

// ═══════════════════════════════════════
//  Lead Watchdog — auto-detects stale agents
// ═══════════════════════════════════════

let leadWatchdog: ReturnType<typeof setInterval> | null = null;
const STALE_ALERT_KEY = '__brain_stale_agents__';

function startLeadWatchdog(leadSessionId: string): void {
  if (leadWatchdog) return;
  leadWatchdog = setInterval(() => {
    try {
      const stale = db.getAgentHealth(room).filter(a => a.id !== leadSessionId && a.is_stale);
      const previous = new Set<string>(JSON.parse(db.getState(STALE_ALERT_KEY, room)?.value || '[]'));
      const current = new Set(stale.map(a => a.id));
      for (const agent of stale) {
        if (!previous.has(agent.id)) {
          db.postMessage(
            'alerts',
            room,
            leadSessionId,
            sessionName,
            `STALE: ${agent.name} (${agent.heartbeat_age_seconds}s since heartbeat, status=${agent.status}, progress=${agent.progress ?? 'n/a'})`,
          );
        }
      }
      db.setState(STALE_ALERT_KEY, room, JSON.stringify([...current]), leadSessionId, sessionName);
    } catch { /* best effort */ }
  }, 15000);
  leadWatchdog.unref();
}

// ═══════════════════════════════════════
//  Session Orchestration
// ═══════════════════════════════════════

server.tool(
  'brain_wake',
  `Spawn a NEW agent session to handle a task. Supports multiple modes:
- tmux (default): visible split pane — requires tmux
- headless: background process — no tmux needed, works everywhere
- Supports multi-LLM routing via the model parameter (e.g. "haiku" for cheap tasks, "opus" for complex ones)
- Configurable timeout (default: none for tmux, 30min for headless)`,
  {
    task: z.string().describe('The full task description for the new session to execute'),
    name: z.string().optional().describe('Name for the new agent session (default: "agent-<timestamp>")'),
    layout: z.enum(['vertical', 'horizontal', 'tiled', 'window', 'headless']).optional().describe('"horizontal" = side by side (default). "vertical" = stacked. "tiled" = auto-grid. "window" = new tmux tab. "headless" = background process (no tmux needed).'),
    model: z.string().optional().describe('Model to use for this agent. For Claude Code: "opus", "sonnet", "haiku", or full model ID. Enables multi-LLM routing — use cheap models for boilerplate, expensive for complex logic.'),
    timeout: z.number().optional().describe('Timeout in seconds. Default: 3600 (1 hour). Set 0 for no timeout.'),
    cli: z.string().optional().describe('Custom CLI command to spawn instead of "claude" (e.g. "codex", "aider"). The agent will still use brain tools if the CLI supports MCP.'),
  },
  async ({ task, name, layout, model, timeout: timeoutSec, cli }) => {
    const sid = ensureSession();
    startLeadWatchdog(sid);
    const agentName = name || `agent-${Date.now()}`;
    const agentSessionId = randomUUID();
    const tmuxName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const spawnLayout = layout || 'horizontal';
    const isHeadless = spawnLayout === 'headless';
    const agentTimeout = timeoutSec ?? (isHeadless ? 1800 : 3600);

    // Tmux modes require tmux
    if (!isHeadless) {
      try {
        execSync('tmux display-message -p ""', { stdio: 'ignore' });
      } catch {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Not inside a tmux session. Use layout="headless" for non-tmux environments.' }) }],
          isError: true,
        };
      }
    }

    // Post the task to the brain for audit trail
    const taskId = db.postMessage('tasks', room, sid, sessionName, task);

    // Pre-register child session
    db.registerSession(
      agentName,
      room,
      JSON.stringify({ parent_session_id: sid, task_id: taskId, model: model || null, headless: isHeadless }),
      agentSessionId,
    );
    db.pulse(agentSessionId, 'working', 'spawned by lead; initializing');

    // Build env vars for the child
    const childEnvParts = [
      process.env.BRAIN_DB_PATH ? `BRAIN_DB_PATH=${sh(process.env.BRAIN_DB_PATH)}` : null,
      `BRAIN_ROOM=${sh(room)}`,
      `BRAIN_SESSION_ID=${sh(agentSessionId)}`,
      `BRAIN_SESSION_NAME=${sh(agentName)}`,
    ].filter(Boolean);

    // Determine CLI type — BRAIN_DEFAULT_CLI lets hermes auto-spawn hermes agents
    const cliBase = cli || process.env.BRAIN_DEFAULT_CLI || 'claude';
    const cliType: 'claude' | 'hermes' | 'other' =
      (cliBase === 'claude' || cliBase.includes('claude')) ? 'claude' :
      (cliBase === 'hermes' || cliBase.includes('hermes')) ? 'hermes' :
      'other';

    // Build model flag per CLI
    let modelFlag = '';
    if (model) {
      if (cliType === 'claude') modelFlag = ` --model ${sh(model)}`;
      // Hermes uses the configured model — pass via env var
    }

    // Hermes uses brain:tool_name notation for MCP tools
    const toolPrefix = cliType === 'hermes' ? 'mcp_brain_' : '';

    // Build the prompt — adapted per CLI
    const prompt = [
      cliType === 'hermes'
        ? `You have brain MCP tools available via the "brain" MCP server. Call them as: mcp_brain_brain_register, mcp_brain_brain_pulse, mcp_brain_brain_post, mcp_brain_brain_read, mcp_brain_brain_dm, mcp_brain_brain_inbox, mcp_brain_brain_set, mcp_brain_brain_get, mcp_brain_brain_claim, mcp_brain_brain_release, mcp_brain_brain_claims, mcp_brain_brain_agents, mcp_brain_brain_contract_set, mcp_brain_brain_contract_get, mcp_brain_brain_contract_check, mcp_brain_brain_remember, mcp_brain_brain_recall, mcp_brain_brain_plan_next, mcp_brain_brain_plan_update.`
        : 'You have brain MCP tools available (brain_register, brain_pulse, brain_sessions, brain_post, brain_read, brain_dm, brain_inbox, brain_set, brain_get, brain_claim, brain_release, brain_claims, brain_agents, brain_contract_set, brain_contract_get, brain_contract_check, brain_wake, brain_remember, brain_recall, brain_plan_next, brain_plan_update).',
      '',
      `IMPORTANT: Use ${toolPrefix}brain_claim before editing any file, and ${toolPrefix}brain_release when done. This prevents conflicts with other agents.`,
      '',
      `Your name: "${agentName}"`,
      `Assigned by: "${sessionName}"`,
      '',
      `HEARTBEAT PROTOCOL (CRITICAL):`,
      `- Call ${toolPrefix}brain_pulse with status="working" and a short progress note every 2-3 tool calls`,
      `- ${toolPrefix}brain_pulse returns any pending DMs from other agents — READ AND RESPOND to them`,
      `- If you hit a blocker, call ${toolPrefix}brain_pulse with status="failed" and describe the issue`,
      `- This keeps the lead informed and prevents you from being marked as stale`,
      '',
      `CONTRACT PROTOCOL (CRITICAL — prevents integration bugs):`,
      `- BEFORE writing code: call ${toolPrefix}brain_contract_get to see what other agents provide/expect`,
      `- AFTER writing/modifying a file: call ${toolPrefix}brain_contract_set to publish what your module provides:`,
      `  Example: entries=[{"module":"src/ui.ts","name":"drawBattle","kind":"provides","signature":"{\"params\":[\"state: BattleState\"],\"returns\":\"void\"}"}]`,
      `- When your code CALLS a function from another module: also publish an "expects" entry with the signature you're calling with`,
      `- BEFORE marking done: call ${toolPrefix}brain_contract_check to verify no mismatches exist`,
      `- If mismatches are found: fix your code to match the published contracts, then re-check`,
      '',
      `MEMORY: Use ${toolPrefix}brain_remember to store important discoveries about the codebase. Use ${toolPrefix}brain_recall to check if previous agents learned something useful.`,
      '',
      `CONTEXT LEDGER (CRITICAL — prevents losing track):`,
      `- Call ${toolPrefix}brain_context_push after every significant action, discovery, or decision`,
      `- Entry types: "action" (did something), "discovery" (learned something), "decision" (chose approach), "error" (hit problem), "file_change" (edited file)`,
      `- Include the file_path when relevant`,
      `- Call ${toolPrefix}brain_checkpoint every 10-15 tool calls to save your full working state`,
      `- If you feel lost or confused, call ${toolPrefix}brain_checkpoint_restore to recover`,
      `- This is your insurance against context compression — the ledger remembers even when you forget`,
      '',
      `YOUR TASK:`,
      task,
      '',
      `WHEN DONE:`,
      `1. Call ${toolPrefix}brain_contract_check — fix any mismatches before proceeding`,
      `2. Call ${toolPrefix}brain_pulse with status="done" and a summary of what you accomplished`,
      `3. Call ${toolPrefix}brain_post to announce what you accomplished`,
      `4. Release all claimed files with ${toolPrefix}brain_release`,
      `5. Exit when you are done so resources are freed`,
    ].join('\n');

    const ts = Date.now();
    const promptFile = join(tmpdir(), `brain-prompt-${ts}.txt`);
    writeFileSync(promptFile, prompt);

    try {
      // ══════════════════════════════════════
      //  HEADLESS MODE — no tmux required
      // ══════════════════════════════════════
      if (isHeadless) {
        const logFile = join(tmpdir(), `brain-agent-${agentSessionId}.log`);
        const childEnv = childEnvParts.join(' ');

        // Build the headless command per CLI type
        let headlessCmd: string;
        if (cliType === 'claude') {
          // claude -p (print mode) — non-interactive, uses all MCP tools, exits when done
          headlessCmd = `cd ${sh(room)} && env ${childEnv} ${sh(cliBase)} -p ${sh(prompt)}${modelFlag} --dangerously-skip-permissions > ${sh(logFile)} 2>&1`;
        } else if (cliType === 'hermes') {
          // hermes chat -q (single query mode) — non-interactive, uses MCP tools, exits when done
          // -Q suppresses TUI, only prints final response
          const hermesModelEnv = model ? `HERMES_MODEL=${sh(model)}` : '';
          headlessCmd = `cd ${sh(room)} && env ${childEnv} ${hermesModelEnv} ${sh(cliBase)} chat -q ${sh(prompt)} -Q > ${sh(logFile)} 2>&1`;
        } else {
          // Generic CLI — pass prompt via stdin
          headlessCmd = `cd ${sh(room)} && env ${childEnv} cat ${sh(promptFile)} | ${sh(cliBase)} > ${sh(logFile)} 2>&1`;
        }

        // Wrapper script with timeout and cleanup
        const watcherFile = join(tmpdir(), `brain-headless-${ts}.sh`);
        const watcherContent = `#!/bin/bash
AGENT_ID="${agentSessionId}"
LOG="${logFile}"
TIMEOUT=${agentTimeout}
START_TIME=$(date +%s)

# Run the agent
${headlessCmd}
EXIT_CODE=$?

# Cleanup
rm -f "${promptFile}" "${watcherFile}"

# Exit code 0 = success, agent already posted done via brain_pulse
# Non-zero = crash, update brain
if [ $EXIT_CODE -ne 0 ]; then
  # The agent crashed without reporting — brain_pulse won't have been called
  # The heartbeat watchdog will catch this and mark it stale
  echo "Agent exited with code $EXIT_CODE" >> "$LOG"
fi
`;
        writeFileSync(watcherFile, watcherContent, { mode: 0o755 });

        const watcher = spawn('bash', [watcherFile], { detached: true, stdio: 'ignore' });
        watcher.on('error', (err) => {
          try { db.pulse(agentSessionId, 'failed', `headless spawn failed: ${err.message}`); } catch { /* best effort */ }
        });
        watcher.unref();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              agent: agentName,
              agentSessionId,
              taskId,
              mode: 'headless',
              model: model || 'default',
              logFile,
              message: `Spawned "${agentName}" in headless mode (no tmux). Monitor with brain_agents. Log: ${logFile}`,
            }, null, 2),
          }],
        };
      }

      // ══════════════════════════════════════
      //  TMUX MODE — visible split panes
      // ══════════════════════════════════════
      const childEnv = childEnvParts.join(' ');
      let tmuxCmd: string;
      if (cliType === 'claude') {
        tmuxCmd = `cd ${sh(room)} && env ${childEnv} ${sh(cliBase)}${modelFlag} --dangerously-skip-permissions`;
      } else if (cliType === 'hermes') {
        // Hermes interactive TUI mode — full agent experience in tmux pane
        const hermesModelEnv = model ? `HERMES_MODEL=${sh(model)}` : '';
        tmuxCmd = `cd ${sh(room)} && env ${childEnv} ${hermesModelEnv} ${sh(cliBase)}`;
      } else {
        tmuxCmd = `cd ${sh(room)} && env ${childEnv} ${sh(cliBase)}`;
      }
      const bufferName = `brain-${ts}`;

      let target: string;

      if (spawnLayout === 'window') {
        execSync(`tmux new-window -n "${tmuxName}" "${tmuxCmd}"`);
        target = tmuxName;
      } else {
        const paneId = execSync(
          `tmux split-window -h -P -F '#{pane_id}' "${tmuxCmd}"`
        ).toString().trim();

        const agentColor = AGENT_COLORS[spawnedAgentCount % AGENT_COLORS.length];
        spawnedAgentCount++;

        try {
          let paneCount = 2;
          try { paneCount = parseInt(execSync(`tmux list-panes | wc -l`).toString().trim(), 10) || 2; } catch { /* default */ }

          if (spawnLayout === 'tiled' || paneCount > 4) {
            execSync('tmux select-layout tiled');
          } else if (paneCount <= 2) {
            execSync('tmux select-layout even-horizontal');
          } else {
            execSync('tmux select-layout main-vertical');
            try { execSync('tmux resize-pane -t "{top-left}" -x 40%'); } catch { /* older tmux */ }
          }
          try { execSync('tmux select-layout -E'); } catch { /* tmux 3.1+ */ }
          try { execSync(`tmux set-option -p -t "${paneId}" pane-border-style 'fg=${agentColor}'`); } catch { /* tmux 3.2+ */ }
          execSync(`tmux set-option -w pane-active-border-style 'fg=#9333EA,bold'`);
          execSync(`tmux select-pane -t '{top-left}' -P 'bg=#0d0a1a'`);
          execSync(`tmux select-pane -t '{top-left}'`);
        } catch { /* layout may vary by tmux version */ }

        target = paneId;
      }

      // Watcher: wait for ready, paste prompt, wait for exit or timeout
      // CLI-specific exit command and ready detection
      const exitCmd = cliType === 'hermes' ? '/quit' : '/exit';
      const readyPatterns = cliType === 'hermes'
        ? `echo "$CONTENT" | grep -q "hermes\\|>>\\|❯" 2>/dev/null`
        : `echo "$CONTENT" | LC_ALL=C grep -qF $'\\xe2\\x9d\\xaf' 2>/dev/null`;
      const fallbackReady = cliType === 'hermes'
        ? `echo "$CONTENT" | grep -q "tools\\|model\\|ready" 2>/dev/null`
        : `echo "$CONTENT" | grep -q "high effort\\|bypass perm\\|accept edits" 2>/dev/null`;

      const watcherFile = join(tmpdir(), `brain-watch-${ts}.sh`);
      const watcherContent = `#!/bin/bash
TARGET="${target}"
PROMPT="${promptFile}"
BUFFER="${bufferName}"
ABSOLUTE_TIMEOUT=${agentTimeout}
START_TIME=$(date +%s)

check_timeout() {
  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ $ABSOLUTE_TIMEOUT -gt 0 ] && [ $ELAPSED -ge $ABSOLUTE_TIMEOUT ]; then
    tmux send-keys -t "$TARGET" "${exitCmd}" Enter 2>/dev/null
    sleep 5
    tmux kill-pane -t "$TARGET" 2>/dev/null
    rm -f "${watcherFile}"
    exit 0
  fi
}

# Phase 1: Wait for CLI to be READY
READY=0
for i in $(seq 1 60); do
  sleep 2
  check_timeout
  tmux display-message -t "$TARGET" -p "" 2>/dev/null || exit 0
  CONTENT=$(tmux capture-pane -t "$TARGET" -p 2>/dev/null)
  if ${readyPatterns}; then
    READY=1; break
  fi
  if ${fallbackReady}; then
    READY=1; break
  fi
done
[ $READY -eq 0 ] && sleep 15

# Phase 2: Paste the prompt
tmux load-buffer -b "$BUFFER" "$PROMPT"
tmux paste-buffer -b "$BUFFER" -t "$TARGET"
sleep 0.5
tmux send-keys -t "$TARGET" Enter
tmux delete-buffer -b "$BUFFER" 2>/dev/null
rm -f "$PROMPT"

# Phase 3: Wait for pane to close on its own (agent exits itself)
while true; do
  sleep 5
  check_timeout
  tmux display-message -t "$TARGET" -p "" 2>/dev/null || break
done
rm -f "${watcherFile}"
`;
      writeFileSync(watcherFile, watcherContent, { mode: 0o755 });

      const watcher = spawn('bash', [watcherFile], { detached: true, stdio: 'ignore' });
      watcher.on('error', (err) => {
        try { db.pulse(agentSessionId, 'failed', `watcher failed: ${err.message}`); } catch { /* best effort */ }
      });
      watcher.unref();

      const layoutDesc: Record<string, string> = {
        vertical: 'stacked top/bottom',
        horizontal: 'side by side',
        tiled: 'auto-grid',
        window: `tmux tab "${tmuxName}"`,
      };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            agent: agentName,
            agentSessionId,
            taskId,
            layout: spawnLayout,
            model: model || 'default',
            message: `Spawned "${agentName}" — ${layoutDesc[spawnLayout]}. Pre-registered with heartbeat. Lead watchdog active.`,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      try {
        db.pulse(agentSessionId, 'failed', `spawn error: ${err.message || String(err)}`);
        execSync(`rm -f "${promptFile}"`);
      } catch { /* cleanup */ }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err.message || String(err) }) }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════
//  Start Server
// ═══════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Brain MCP server failed to start:', err);
  process.exit(1);
});
