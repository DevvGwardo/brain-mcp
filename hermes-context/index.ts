#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

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

// ── Context Storage ────────────────────────────────────────────────────────────
interface ContextEntry {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
  tags: string[];
}

interface HermesContextDB {
  entries: Map<string, ContextEntry>;
  save: () => void;
  load: () => void;
}

function createContextDB(): HermesContextDB {
  const dbPath = join(homedir(), '.hermes', 'context', 'context.json');

  const db: HermesContextDB = {
    entries: new Map(),

    save() {
      try {
        const dir = dirname(dbPath);
        const data = JSON.stringify(Array.from(db.entries.values()), null, 2);
        writeFileSync(dbPath, data, 'utf-8');
      } catch (err) {
        console.error('Failed to save context DB:', err);
      }
    },

    load() {
      try {
        if (existsSync(dbPath)) {
          const raw = readFileSync(dbPath, 'utf-8');
          const arr: ContextEntry[] = JSON.parse(raw);
          db.entries = new Map(arr.map(e => [e.key, e]));
        }
      } catch (err) {
        console.error('Failed to load context DB:', err);
      }
    },
  };

  return db;
}

const db = createContextDB();
db.load();

// ── MCP Server ─────────────────────────────────────────────────────────────────
const server = new McpServer(
  {
    name: 'hermes-context',
    version: '1.0.0',
  },
  {
    instructions: `Hermes Context MCP — Persistent Context Storage for Multi-Agent Systems

This server provides a simple key-value store for context that persists across sessions.
Use it to share state, configuration, and notes between different agents.

WHEN TO USE THESE TOOLS:
- When you need to store configuration or state that other agents can read
- When you want to share context between sessions without a database
- When tracking shared variables across agent interactions
- When storing prompts, system instructions, or reusable templates

TOOLS:
- context_set — Store a key-value pair with optional tags
- context_get — Retrieve a value by key
- context_delete — Remove a context entry
- context_list — List all context entries, optionally filtered by tag
- context_search — Search context entries by key or value pattern
- context_clear — Clear all context entries (use with caution)

TAGS:
Use tags to organize context entries (e.g., "config", "prompt", "memory", "state").
List context by tag to find related entries quickly.`,
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Context Tools
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  'context_set',
  'Store a context entry. Overwrites if key already exists.',
  {
    key: z.string().describe('Unique key for this context entry'),
    value: z.string().describe('Value to store'),
    tags: z.array(z.string()).optional().describe('Tags for organization (e.g. ["config", "memory"])'),
  },
  async ({ key, value, tags }) => {
    const now = new Date().toISOString();
    const existing = db.entries.get(key);

    const entry: ContextEntry = {
      key,
      value,
      created_at: existing?.created_at || now,
      updated_at: now,
      tags: tags || existing?.tags || [],
    };

    db.entries.set(key, entry);
    db.save();

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          key,
          created: !existing,
          updated: !!existing,
          tags: entry.tags,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'context_get',
  'Retrieve a context entry by key.',
  {
    key: z.string().describe('Key to look up'),
  },
  async ({ key }) => {
    const entry = db.entries.get(key);

    if (!entry) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Key not found' }, null, 2) }],
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          key: entry.key,
          value: entry.value,
          created_at: entry.created_at,
          updated_at: entry.updated_at,
          tags: entry.tags,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'context_delete',
  'Delete a context entry by key.',
  {
    key: z.string().describe('Key to delete'),
  },
  async ({ key }) => {
    const existed = db.entries.has(key);
    db.entries.delete(key);

    if (existed) {
      db.save();
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ok: true, deleted: existed }, null, 2),
      }],
    };
  }
);

server.tool(
  'context_list',
  'List all context entries, optionally filtered by tag.',
  {
    tag: z.string().optional().describe('Only show entries with this tag'),
    limit: cNum().optional().describe('Max entries to return (default: 100)'),
  },
  async ({ tag, limit }) => {
    const maxLimit = limit || 100;
    let entries = Array.from(db.entries.values());

    if (tag) {
      entries = entries.filter(e => e.tags.includes(tag));
    }

    entries = entries
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, maxLimit);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          count: entries.length,
          entries: entries.map(e => ({
            key: e.key,
            value: e.value,
            created_at: e.created_at,
            updated_at: e.updated_at,
            tags: e.tags,
          })),
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'context_search',
  'Search context entries by key or value pattern.',
  {
    pattern: z.string().describe('Search pattern (matched as substring in key or value)'),
    limit: cNum().optional().describe('Max entries to return (default: 50)'),
  },
  async ({ pattern, limit }) => {
    const maxLimit = limit || 50;
    const lowerPattern = pattern.toLowerCase();

    const matches = Array.from(db.entries.values())
      .filter(e =>
        e.key.toLowerCase().includes(lowerPattern) ||
        e.value.toLowerCase().includes(lowerPattern)
      )
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, maxLimit);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          count: matches.length,
          pattern,
          entries: matches.map(e => ({
            key: e.key,
            value: e.value,
            created_at: e.created_at,
            updated_at: e.updated_at,
            tags: e.tags,
          })),
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'context_clear',
  'Clear all context entries. Use with caution.',
  {
    confirm: z.boolean().describe('Must be true to confirm clearing all entries'),
  },
  async ({ confirm }) => {
    if (!confirm) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: false, error: 'confirm must be true' }, null, 2),
        }],
      };
    }

    const count = db.entries.size;
    db.entries.clear();
    db.save();

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ok: true, cleared: count }, null, 2),
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
