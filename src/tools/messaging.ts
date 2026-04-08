/**
 * Messaging Tools
 * - post: Post a message to a channel
 * - read: Read messages from a channel
 * - dm: Send a direct message to another session
 * - inbox: Read direct messages sent to or from this session
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainDB } from '../db.js';

interface MessagingToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  getSessionId: () => string | null;
  getSessionName: () => string;
}

export function registerMessagingTools(
  server: McpServer,
  options: MessagingToolsOptions,
) {
  const { db, room, ensureSession, getSessionId, getSessionName } = options;

  // Schema coercion helpers
  const cNum = () => z.preprocess(
    (v: unknown) => typeof v === 'string' && (v as string).trim() !== '' ? Number(v) : v,
    z.number(),
  );

  // Write-op acknowledgement helper
  const ack = (extra?: Record<string, unknown>): { content: [{ type: 'text'; text: string }] } => {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...extra }) }] };
  };

  // Standard reply helper
  const reply = (data: unknown): { content: [{ type: 'text'; text: string }] } => {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  };

  // ── post ──────────────────────────────────────────────────────────────────────
  server.tool(
    'post',
    'Post a message to a channel. All sessions in the same working directory (room) can read it.',
    {
      content: z.string().describe('Message content'),
      channel: z.string().optional().describe('Channel name (default: "general")'),
    },
    async ({ content, channel }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      const ch = channel || 'general';
      const id = db.postMessage(ch, room, sid, sessionName, content);
      return ack({ messageId: id });
    }
  );

  // ── read ─────────────────────────────────────────────────────────────────────
  server.tool(
    'read',
    'Read messages from a channel. Use since_id to poll for only new messages since your last read.',
    {
      channel: z.string().optional().describe('Channel name (default: "general")'),
      since_id: cNum().optional().describe('Only return messages with ID greater than this (for polling)'),
      limit: cNum().optional().describe('Max messages to return (default: 50)'),
    },
    async ({ channel, since_id, limit }) => {
      ensureSession();
      const messages = db.getMessages(channel || 'general', room, since_id, limit);
      return reply(messages);
    }
  );

  // ── dm ───────────────────────────────────────────────────────────────────────
  server.tool(
    'dm',
    'Send a direct message to another session. Works across rooms. Target by session name or ID.',
    {
      to: z.string().describe('Target session name or ID'),
      content: z.string().describe('Message content'),
    },
    async ({ to, content }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      // Resolve name → ID if needed
      let targetId = to;
      const sessions = db.getSessions();
      const byName = sessions.find(s => s.name === to);
      if (byName) targetId = byName.id;
      // Validate target session exists
      const targetExists = sessions.some(s => s.id === targetId);
      if (!targetExists) {
        return reply({ ok: false, error: `Target session '${to}' not found. No active session with that name or ID.`, target: targetId });
      }
      const id = db.sendDM(sid, sessionName, targetId, content);
      return ack({ to: targetId, messageId: id });
    }
  );

  // ── inbox ────────────────────────────────────────────────────────────────────
  server.tool(
    'inbox',
    'Read direct messages sent to or from this session. Use since_id for polling.',
    {
      since_id: cNum().optional().describe('Only return messages with ID greater than this'),
    },
    async ({ since_id }) => {
      const sid = ensureSession();
      const messages = db.getInbox(sid, since_id);
      return reply(messages);
    }
  );
}
