#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { basename, join } from 'node:path';
import { execSync, exec as execCb } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

server.tool(
  'brain_clear',
  'Clear all brain data — messages, state, claims, sessions. Use this to reset the brain for a fresh start.',
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
//  Session Orchestration
// ═══════════════════════════════════════

server.tool(
  'brain_wake',
  'Spawn a NEW Claude Code session to handle a task. Opens as a visible split pane (side-by-side) by default so you can watch it work, or as a new tmux tab. Posts the task to the brain, then launches an interactive Claude session that picks it up.',
  {
    task: z.string().describe('The full task description for the new session to execute'),
    name: z.string().optional().describe('Name for the new agent session (default: "agent-<timestamp>")'),
    layout: z.enum(['vertical', 'horizontal', 'tiled', 'window']).optional().describe('"vertical" = stacked top/bottom (DEFAULT). "horizontal" = side by side. "tiled" = auto-grid. "window" = new tmux tab.'),
  },
  async ({ task, name, layout }) => {
    const sid = ensureSession();
    const agentName = name || `agent-${Date.now()}`;
    const tmuxName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const spawnLayout = layout || 'horizontal';

    // Verify we're inside tmux
    try {
      execSync('tmux display-message -p ""', { stdio: 'ignore' });
    } catch {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Not inside a tmux session. brain_wake requires tmux.' }) }],
        isError: true,
      };
    }

    // Post the task to the brain for audit trail
    const taskId = db.postMessage('tasks', room, sid, sessionName, task);

    // Build the prompt with the task embedded directly — no need to read from brain
    const prompt = [
      'You have brain MCP tools available (brain_register, brain_sessions, brain_post, brain_read, brain_dm, brain_inbox, brain_set, brain_get, brain_claim, brain_release, brain_claims, brain_wake).',
      '',
      `IMPORTANT: Use brain_claim before editing any file, and brain_release when done. This prevents conflicts with other agents.`,
      '',
      `Your name: "${agentName}"`,
      `Assigned by: "${sessionName}"`,
      '',
      `YOUR TASK:`,
      task,
      '',
      `WHEN DONE:`,
      `1. Call brain_register with name "${agentName}" (if not already registered)`,
      `2. Call brain_post to announce what you accomplished`,
      `3. Release all claimed files with brain_release`,
    ].join('\n');

    // Write prompt to temp file
    const ts = Date.now();
    const promptFile = join(tmpdir(), `brain-prompt-${ts}.txt`);
    const bufferName = `brain-${ts}`;
    writeFileSync(promptFile, prompt);

    try {
      let target: string;

      if (spawnLayout === 'window') {
        // New tmux tab — interactive claude session
        execSync(`tmux new-window -n "${tmuxName}" "cd '${room}' && claude --dangerously-skip-permissions"`);
        target = tmuxName;
      } else {
        // Split pane — visible side by side, interactive claude session
        const splitFlag = spawnLayout === 'horizontal' ? '-h' : '-v';
        const paneId = execSync(
          `tmux split-window ${splitFlag} -P -F '#{pane_id}' "cd '${room}' && claude --dangerously-skip-permissions"`
        ).toString().trim();

        // Apply the best layout for multiple panes
        if (spawnLayout === 'tiled') {
          execSync('tmux select-layout tiled');
        } else if (spawnLayout === 'vertical') {
          execSync('tmux select-layout even-vertical');
        } else {
          execSync('tmux select-layout even-horizontal');
        }

        target = paneId;
      }

      // Write a watcher script that:
      // 1. Waits for claude to initialize
      // 2. Pastes the prompt
      // 3. Monitors for completion (❯ prompt)
      // 4. Sends /exit to close cleanly
      const watcherFile = join(tmpdir(), `brain-watch-${ts}.sh`);
      const watcherContent = `#!/bin/bash
TARGET="${target}"
PROMPT="${promptFile}"
BUFFER="${bufferName}"

# Phase 1: Wait for Claude Code to be READY (not just started)
# Poll until the pane shows the input prompt (❯ in UTF-8: 0xe2 0x9d 0xaf)
READY=0
for i in $(seq 1 60); do
  sleep 2
  tmux display-message -t "$TARGET" -p "" 2>/dev/null || exit 0
  CONTENT=$(tmux capture-pane -t "$TARGET" -p 2>/dev/null)
  if echo "$CONTENT" | LC_ALL=C grep -qF $'\\xe2\\x9d\\xaf' 2>/dev/null; then
    READY=1
    break
  fi
  # Fallback: also check for common Claude Code ready indicators
  if echo "$CONTENT" | grep -q "high effort\\|bypass perm\\|accept edits" 2>/dev/null; then
    READY=1
    break
  fi
done

if [ $READY -eq 0 ]; then
  # Last resort: just wait a flat 15 seconds
  sleep 15
fi

# Phase 2: Paste the prompt
tmux load-buffer -b "$BUFFER" "$PROMPT"
tmux paste-buffer -b "$BUFFER" -t "$TARGET"
sleep 0.5
tmux send-keys -t "$TARGET" Enter
tmux delete-buffer -b "$BUFFER" 2>/dev/null
rm -f "$PROMPT"

# Phase 3: Watch for completion using content stability detection
# Claude Code constantly updates spinner/status while working.
# When idle, content stops changing. 15s stable = done.
sleep 30
PREV_HASH=""
STABLE=0
for i in $(seq 1 240); do
  sleep 5
  tmux display-message -t "$TARGET" -p "" 2>/dev/null || break
  HASH=$(tmux capture-pane -t "$TARGET" -p 2>/dev/null | md5 2>/dev/null || tmux capture-pane -t "$TARGET" -p 2>/dev/null | md5sum 2>/dev/null | cut -d' ' -f1)
  if [ "$HASH" = "$PREV_HASH" ]; then
    STABLE=$((STABLE + 1))
    if [ $STABLE -ge 3 ]; then
      sleep 2
      tmux send-keys -t "$TARGET" "/exit" Enter
      sleep 5
      tmux display-message -t "$TARGET" -p "" 2>/dev/null && tmux kill-pane -t "$TARGET" 2>/dev/null
      break
    fi
  else
    STABLE=0
  fi
  PREV_HASH="$HASH"
done
rm -f "${watcherFile}"
`;
      writeFileSync(watcherFile, watcherContent, { mode: 0o755 });

      // Fire-and-forget the watcher in the background
      execCb(`bash "${watcherFile}" &`, () => {});

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
            taskId,
            layout: spawnLayout,
            message: `Spawned "${agentName}" — ${layoutDesc[spawnLayout]}.`,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      try { execSync(`rm -f "${promptFile}"`); } catch { /* cleanup */ }
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
