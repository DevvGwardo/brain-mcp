#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import { createContextDB } from '../context-db.js';

// ── Schema helpers ─────────────────────────────────────────────────────────────
const cNum = () => z.preprocess(
  (v) => typeof v === 'string' && v.trim() !== '' ? Number(v) : v,
  z.number(),
);
const cBool = () => z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    const s = v.toLowerCase().trim();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
    return v;
  },
  z.boolean(),
);

// ── Initialize ─────────────────────────────────────────────────────────────────

const dbPath = process.env.BRAIN_DB_PATH;
const db = createContextDB({ dbPath, useSqlite: true });

// ── MCP Server ─────────────────────────────────────────────────────────────────
const server = new McpServer(
  {
    name: 'hermes-context',
    version: '1.0.0',
  },
  {
    instructions: `Hermes Context MCP — Context & Session Management for Multi-Agent Systems

This server provides 12 tools for managing context, sessions, skills, memory, and project activity.

TOOLS:
1. journal_search — Search journal entries by content pattern or role
2. journal_latest — Get latest journal entries for a session
3. session_history — Get session history for a room
4. skill_search — Search registered skills by name, category, or alias
5. skill_read — Read a skill's full details by name or ID
6. memory_search — Search persistent memory entries
7. memory_write — Write a persistent memory entry
8. context_status — Show context system status and statistics
9. evo_status — Show evolutionary/learning status
10. project_activity — Show recent project activity via git
11. git_log — Show git commit history
12. session_search — Search sessions by name or status

All tools operate on the shared brain.db SQLite database.`,
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool 1: journal_search
// ═══════════════════════════════════════════════════════════════════════════════
server.tool(
  'journal_search',
  'Search journal entries by content pattern, role, or session.',
  {
    session_id: z.string().optional().describe('Session ID to search within'),
    pattern: z.string().optional().describe('Content pattern to search for in previews'),
    role: z.enum(['user', 'assistant', 'system', 'tool']).optional().describe('Filter by role'),
    limit: cNum().optional().describe('Max entries to return (default: 50)'),
  },
  async ({ session_id, pattern, role, limit }) => {
    const maxLimit = Math.min(limit || 50, 200);
    let entries = session_id ? db.getJournal(session_id) : [];

    if (role) {
      entries = entries.filter(e => e.role === role);
    }
    if (pattern) {
      const lower = pattern.toLowerCase();
      entries = entries.filter(e => e.content_preview.toLowerCase().includes(lower));
    }

    entries = entries.slice(-maxLimit);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          count: entries.length,
          session_id: session_id || 'all',
          pattern: pattern || null,
          role: role || null,
          entries: entries.map(e => ({
            id: e.id,
            session_id: e.session_id,
            turn_index: e.turn_index,
            role: e.role,
            content_preview: e.content_preview,
            token_count: e.token_count,
            created_at: e.created_at,
          })),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool 2: journal_latest
// ═══════════════════════════════════════════════════════════════════════════════
server.tool(
  'journal_latest',
  'Get the latest journal entries for a session.',
  {
    session_id: z.string().describe('Session ID to get latest entries for'),
    limit: cNum().optional().describe('Number of recent entries to return (default: 10)'),
  },
  async ({ session_id, limit }) => {
    const maxLimit = Math.min(limit || 10, 100);
    const allEntries = db.getJournal(session_id);
    const latest = allEntries.slice(-maxLimit);
    const stats = db.getJournalStats(session_id);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          session_id,
          total_turns: stats.total_turns,
          entries: latest.map(e => ({
            id: e.id,
            turn_index: e.turn_index,
            role: e.role,
            content_preview: e.content_preview,
            token_count: e.token_count,
            created_at: e.created_at,
          })),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool 3: session_history
// ═══════════════════════════════════════════════════════════════════════════════
server.tool(
  'session_history',
  'Get session history for the current room or a specific room.',
  {
    room: z.string().optional().describe('Room/workspace path (defaults to current working directory)'),
    status: z.enum(['idle', 'working', 'done', 'failed']).optional().describe('Filter by session status'),
    limit: cNum().optional().describe('Max sessions to return (default: 50)'),
  },
  async ({ room, status, limit }) => {
    const targetRoom = room || process.cwd();
    const maxLimit = Math.min(limit || 50, 200);
    let sessions = db.getSessionsByRoom(targetRoom);

    if (status) {
      sessions = sessions.filter(s => s.status === status);
    }

    sessions = sessions
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, maxLimit);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          room: targetRoom,
          count: sessions.length,
          sessions: sessions.map(s => ({
            id: s.id,
            name: s.name,
            status: s.status,
            progress: s.progress,
            turn_count: s.turn_count,
            last_turn_at: s.last_turn_at,
            created_at: s.created_at,
            updated_at: s.updated_at,
          })),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool 4: skill_search
// ═══════════════════════════════════════════════════════════════════════════════
server.tool(
  'skill_search',
  'Search registered skills by name, category, alias, or enabled state.',
  {
    query: z.string().optional().describe('Search query for name or aliases'),
    category: z.string().optional().describe('Filter by category'),
    enabled: cBool().optional().describe('Filter by enabled state'),
    limit: cNum().optional().describe('Max skills to return (default: 50)'),
  },
  async ({ query, category, enabled, limit }) => {
    const maxLimit = Math.min(limit || 50, 200);
    let skills = db.getAllSkills({ enabled });

    if (category) {
      skills = skills.filter(s => s.category === category);
    }
    if (query) {
      const lower = query.toLowerCase();
      skills = skills.filter(s =>
        s.name.toLowerCase().includes(lower) ||
        s.aliases.some(a => a.toLowerCase().includes(lower)) ||
        s.description.toLowerCase().includes(lower)
      );
    }

    skills = skills.slice(0, maxLimit);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          count: skills.length,
          query: query || null,
          category: category || null,
          enabled: enabled ?? null,
          skills: skills.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            enabled: s.enabled,
            aliases: s.aliases,
            category: s.category,
            file_path: s.file_path,
            created_at: s.created_at,
            updated_at: s.updated_at,
          })),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool 5: skill_read
// ═══════════════════════════════════════════════════════════════════════════════
server.tool(
  'skill_read',
  'Read a skill\'s full details by name, alias, or ID.',
  {
    name_or_id: z.string().describe('Skill name, alias, or ID to look up'),
  },
  async ({ name_or_id }) => {
    let skill = db.getSkillByName(name_or_id);
    if (!skill) {
      skill = db.getSkillByAlias(name_or_id);
    }
    if (!skill) {
      skill = db.getSkill(name_or_id);
    }

    if (!skill) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: false, error: 'Skill not found' }, null, 2),
        }],
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          skill: {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            enabled: skill.enabled,
            aliases: skill.aliases,
            category: skill.category,
            file_path: skill.file_path,
            created_at: skill.created_at,
            updated_at: skill.updated_at,
          },
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool 6: memory_search
// ═══════════════════════════════════════════════════════════════════════════════
server.tool(
  'memory_search',
  'Search persistent memory entries for a room.',
  {
    room: z.string().optional().describe('Room/workspace path (defaults to cwd)'),
    query: z.string().optional().describe('Search pattern for key or content'),
    category: z.string().optional().describe('Filter by category'),
    limit: cNum().optional().describe('Max entries to return (default: 20)'),
  },
  async ({ room, query, category, limit }) => {
    const targetRoom = room || process.cwd();
    const maxLimit = Math.min(limit || 20, 100);
    const entries = db.recallMemory(targetRoom, query, category, maxLimit);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          count: entries.length,
          room: targetRoom,
          query: query || null,
          category: category || null,
          entries: entries.map(e => ({
            id: e.id,
            key: e.key,
            content: e.content,
            category: e.category,
            created_by: e.created_by,
            access_count: e.access_count,
            last_accessed: e.last_accessed,
            created_at: e.created_at,
            updated_at: e.updated_at,
          })),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool 7: memory_write
// ═══════════════════════════════════════════════════════════════════════════════
server.tool(
  'memory_write',
  'Write a persistent memory entry.',
  {
    room: z.string().optional().describe('Room/workspace path (defaults to cwd)'),
    key: z.string().describe('Unique key for this memory entry'),
    content: z.string().describe('Content to store'),
    category: z.string().optional().describe('Category (default: "general")'),
    created_by: z.string().optional().describe('Creator identifier (default: "hermes-context")'),
  },
  async ({ room, key, content, category, created_by }) => {
    const targetRoom = room || process.cwd();
    const id = db.storeMemory({
      room: targetRoom,
      key,
      content,
      category: category || 'general',
      created_by: created_by || 'hermes-context',
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          id,
          room: targetRoom,
          key,
          category: category || 'general',
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool 8: context_status
// ═══════════════════════════════════════════════════════════════════════════════
server.tool(
  'context_status',
  'Show context system status and statistics.',
  async () => {
    // Get all sessions and skills for stats
    const allSkills = db.getAllSkills();
    const enabledSkills = allSkills.filter(s => s.enabled);
    const categories = [...new Set(allSkills.map(s => s.category))];

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          database: {
            path: dbPath || '~/.claude/brain/brain.db',
            type: 'SQLite (WAL mode)',
          },
          skills: {
            total: allSkills.length,
            enabled: enabledSkills.length,
            categories,
          },
          memory: {
            note: 'Memory requires SQLite - check BRAIN_DB_PATH',
          },
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool 9: evo_status
// ═══════════════════════════════════════════════════════════════════════════════
server.tool(
  'evo_status',
  'Show evolutionary/learning status from context snapshots.',
  {
    session_id: z.string().optional().describe('Session ID to check'),
    limit: cNum().optional().describe('Number of recent snapshots to consider (default: 5)'),
  },
  async ({ session_id, limit }) => {
    const maxLimit = Math.min(limit || 5, 20);
    const targetSessionId = session_id || '';

    let snapshots: Awaited<ReturnType<typeof db.getSnapshots>> = [];
    if (targetSessionId) {
      snapshots = db.getSnapshots(targetSessionId, maxLimit);
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          session_id: targetSessionId || 'not specified',
          snapshots_count: snapshots.length,
          snapshots: snapshots.map(s => ({
            id: s.id,
            summary: s.summary,
            turns_start: s.turns_start,
            turns_end: s.turns_end,
            token_count: s.token_count,
            created_at: s.created_at,
          })),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool 10: project_activity
// ═══════════════════════════════════════════════════════════════════════════════
server.tool(
  'project_activity',
  'Show recent project activity via git (last changed files and commit stats).',
  {
    path: z.string().optional().describe('Project path (defaults to cwd)'),
    days: cNum().optional().describe('Number of days to look back (default: 7)'),
  },
  async ({ path, days }) => {
    const targetPath = path || process.cwd();
    const lookbackDays = days || 7;

    try {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - lookbackDays);
      const sinceStr = sinceDate.toISOString().split('T')[0];

      const logCmd = `git log --since="${sinceStr}" --oneline --stat --format="%h %s" -20`;
      const logOutput = execSync(logCmd, {
        cwd: targetPath,
        encoding: 'utf-8',
        timeout: 10000,
      });

      const fileCmd = `git log --since="${sinceStr}" --oneline --name-only -10`;
      const fileOutput = execSync(fileCmd, {
        cwd: targetPath,
        encoding: 'utf-8',
        timeout: 10000,
      });

      // Extract unique changed files
      const files = new Set<string>();
      const fileLines = fileOutput.split('\n').filter(l => l.match(/^[^\s]/) && !l.match(/^[a-f0-9]{7}/));
      fileLines.forEach(f => files.add(f.trim()));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            path: targetPath,
            days: lookbackDays,
            since: sinceStr,
            commit_count: logOutput.split('\n').filter(l => l.match(/^[a-f0-9]{7}/)).length,
            commits: logOutput.split('\n').filter(l => l.match(/^[a-f0-9]{7}/)).slice(0, 20),
            changed_files: Array.from(files).slice(0, 50),
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: 'Failed to get git info',
            detail: err instanceof Error ? err.message : String(err),
          }, null, 2),
        }],
      };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool 11: git_log
// ═══════════════════════════════════════════════════════════════════════════════
server.tool(
  'git_log',
  'Show git commit history for a repository.',
  {
    path: z.string().optional().describe('Repository path (defaults to cwd)'),
    limit: cNum().optional().describe('Number of commits to show (default: 20)'),
    format: z.string().optional().describe('Log format: short (oneline), medium (with author), full (default)'),
  },
  async ({ path, limit, format }) => {
    const targetPath = path || process.cwd();
    const maxLimit = Math.min(limit || 20, 100);
    const logFormat = format === 'full' ? '--format=fuller' : format === 'medium' ? '--format="%h %an %s"' : '--oneline';

    try {
      const cmd = `git log ${logFormat} -${maxLimit}`;
      const output = execSync(cmd, {
        cwd: targetPath,
        encoding: 'utf-8',
        timeout: 10000,
      });

      const commits = output.split('\n').filter(l => l.trim());

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            path: targetPath,
            format: format || 'short',
            count: commits.length,
            commits,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: 'Failed to get git log',
            detail: err instanceof Error ? err.message : String(err),
          }, null, 2),
        }],
      };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool 12: session_search
// ═══════════════════════════════════════════════════════════════════════════════
server.tool(
  'session_search',
  'Search sessions by name, status, or room.',
  {
    query: z.string().optional().describe('Search query for session name'),
    room: z.string().optional().describe('Filter by room/workspace'),
    status: z.enum(['idle', 'working', 'done', 'failed']).optional().describe('Filter by status'),
    limit: cNum().optional().describe('Max sessions to return (default: 50)'),
  },
  async ({ query, room, status, limit }) => {
    const targetRoom = room || process.cwd();
    const maxLimit = Math.min(limit || 50, 200);
    let sessions = db.getSessionsByRoom(targetRoom);

    if (status) {
      sessions = sessions.filter(s => s.status === status);
    }
    if (query) {
      const lower = query.toLowerCase();
      sessions = sessions.filter(s => s.name.toLowerCase().includes(lower));
    }

    sessions = sessions
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, maxLimit);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          count: sessions.length,
          room: targetRoom,
          query: query || null,
          status: status || null,
          sessions: sessions.map(s => ({
            id: s.id,
            name: s.name,
            room: s.room,
            status: s.status,
            progress: s.progress,
            turn_count: s.turn_count,
            last_turn_at: s.last_turn_at,
            created_at: s.created_at,
            updated_at: s.updated_at,
          })),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Start Server
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Hermes Context MCP server failed to start:', err);
  process.exit(1);
});