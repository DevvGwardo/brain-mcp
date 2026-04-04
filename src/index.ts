#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { basename } from 'node:path';
import { BrainDB } from './db.js';

// ── Initialize ──

const db = new BrainDB(process.env.BRAIN_DB_PATH);
const room = process.env.BRAIN_ROOM || process.cwd();
const roomLabel = basename(room);

let sessionId: string | null = null;
let sessionName = process.env.BRAIN_SESSION_NAME || `session-${process.pid}`;

function ensureSession(): string {
  if (!sessionId) {
    sessionId = db.registerSession(sessionName, room);
  }
  db.heartbeat(sessionId);
  return sessionId;
}

// ── Cleanup on exit ──

function cleanup() {
  if (sessionId) {
    try { db.removeSession(sessionId); } catch { /* best effort */ }
  }
  try { db.close(); } catch { /* best effort */ }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// ── MCP Server ──

const server = new McpServer({
  name: 'brain',
  version: '1.0.0',
});

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
