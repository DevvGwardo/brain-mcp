#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { basename, dirname, join, resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BrainDB } from './db.js';
import { runGate, runGateAndNotify } from './gate.js';
import { createEmbeddingProvider } from './embeddings.js';
import { TaskRouter } from './router.js';
import { registerAutopilot, minimalAgentPrompt } from './autopilot.js';
import { compileWorkflow } from './workflow.js';
import { spawnWithRecovery, cleanupSpawnTempFiles, freshestMtime, reconcileSessionExit } from './spawn-recovery.js';
import { renderTool } from './renderer.js';
import { createServerLogger } from './server-log.js';
import { registerTmuxSessionRuntime } from './tmux-runtime.js';
import { enqueueDaemonWatch, watcherModeFromEnv } from './agent-watcher.js';
import { SPAWN_TMP_PREFIX } from './constants.js';
import { agentEnvShellPairs } from './agent-env.js';

// ── Schema helpers (string-coercion for transports that stringify params) ──
// Some MCP bridges (e.g. Telegram → Hermes) serialize every tool argument as
// a string. z.number() / z.boolean() / z.array() reject those with
// "Expected X, received string". These helpers accept native types OR
// stringified versions and normalize before validation.
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
    return v; // let z.boolean() raise the error with the original value
  },
  z.boolean(),
);
const cArr = <T extends z.ZodTypeAny>(item: T) => z.preprocess(
  (v) => {
    if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : v;
      } catch {
        return v;
      }
    }
    return v;
  },
  z.array(item),
);

const THINKING_LEVEL_SCHEMA = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional().describe('Reasoning/thinking level for pi-core agents. Default: medium.');

// ── Initialize ──

const db = new BrainDB(process.env.BRAIN_DB_PATH);
const room = process.env.BRAIN_ROOM || process.cwd();
const roomLabel = basename(room);
const serverLog = createServerLogger({ component: 'brain-mcp', room, roomLabel });

// Initialize embedding provider for semantic memory (silent no-op if no API key)
const embeddingProvider = createEmbeddingProvider();
if (embeddingProvider) db.setEmbeddingProvider(embeddingProvider);

// ── Startup temp file cleanup ──
// Remove any stale temp files from previous crashed/killed processes on startup.
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const TEMP_FILE_PATTERNS = [
  SPAWN_TMP_PREFIX,
  'brain-prompt-', 'brain-swarm-', 'brain-watch-',
  'brain-exit-', 'brain-pid-', 'brain-agent-',
];
(function startupTempCleanup() {
  let removed = 0;
  const now = Date.now();
  try {
    const files = readdirSync(tmpdir());
    for (const file of files) {
      if (!TEMP_FILE_PATTERNS.some(p => file.startsWith(p))) continue;
      const filePath = join(tmpdir(), file);
      try {
        const stat = statSync(filePath);
        const mtimeMs = stat.isDirectory() && file.startsWith(SPAWN_TMP_PREFIX)
          ? freshestMtime(filePath, stat.mtimeMs)
          : stat.mtimeMs;
        if (now - mtimeMs > TEMP_FILE_MAX_AGE_MS) {
          if (stat.isDirectory()) {
            rmSync(filePath, { recursive: true, force: true });
          } else {
            unlinkSync(filePath);
          }
          removed++;
        }
      } catch { /* skip inaccessible */ }
    }
  } catch { /* tmpdir may not exist */ }
  if (removed > 0) {
    serverLog.log(`startup cleanup removed ${removed} stale temp file(s)`);
  }
})();

let sessionId: string | null = process.env.BRAIN_SESSION_ID || null;
let spawnedAgentCount = 0;

// ── Ghost session cleanup sweep ──
// Periodically sweep for sessions stuck in 'queued' that never received a heartbeat
// (e.g. spawn process died before the agent could call back). This prevents failed
// spawns from polluting metrics as "active working" sessions.
const GHOST_SWEEP_INTERVAL_MS = 30_000; // every 30 seconds
setInterval(() => {
  try {
    const cleaned = db.sweepGhostSessions(3); // 3-minute threshold for ghosts
    if (cleaned > 0) {
      serverLog.log(`ghost sweep cleaned ${cleaned} stale-queued session(s)`);
    }
  } catch { /* best-effort */ }
}, GHOST_SWEEP_INTERVAL_MS);

// ── Compact mode — reduce token cost of tool responses ──
// Enable via BRAIN_COMPACT=1 env var, or toggle at runtime via the `compact` tool.
// Write ops return {ok:1} instead of echoing back data the agent already knows.
// Read ops skip pretty-printing. Saves 30-80% tokens per tool call.
let compactMode = process.env.BRAIN_COMPACT === '1' || process.env.BRAIN_COMPACT === 'true';

/** Format a tool response. In compact mode, uses terse version if provided. */
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

/** Shorthand for write-op acknowledgements. */
function ack(extra?: Record<string, any>): { content: [{ type: 'text'; text: string }] } {
  return reply({ ok: true, ...extra }, { ok: 1, ...extra });
}

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function compileWorkflowForRoom(
  goal: string,
  options: {
    max_agents?: number;
    mode?: 'claude' | 'py' | 'pi' | 'pi-core';
    available_models?: string[];
    focus_files?: string[];
    auto_route_models?: boolean;
    thinking_level?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  } = {},
) {
  const router = new TaskRouter(db, room);
  return compileWorkflow(goal, {
    cwd: room,
    mode: options.mode,
    max_agents: options.max_agents,
    focus_files: options.focus_files,
    recommendModel: options.auto_route_models === false
      ? undefined
      : (task, role) => {
        const rec = router.routeTask(task, { available_models: options.available_models });
        return {
          model: rec.model,
          confidence: rec.confidence,
          reasoning: `[${role}] ${rec.reasoning}`,
        };
      },
    thinkingLevel: options.thinking_level,
  });
}

type IsolationMode = 'shared' | 'snapshot';

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'agent';
}

function attachTmuxWatcherFinalizer(
  watcher: ReturnType<typeof spawn>,
  sessionId: string,
  stateFile: string,
) {
  watcher.on('error', (err) => {
    try { db.markDone(sessionId, -1, true, `watcher failed: ${err.message}`); } catch { /* best effort */ }
  });
  watcher.on('exit', () => {
    try {
      const raw = existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : '';
      if (raw === 'timeout') {
        reconcileSessionExit(db, sessionId, 124, 'tmux watcher timed out');
      } else if (raw === 'pane_closed' || raw === '') {
        reconcileSessionExit(db, sessionId, 0, 'tmux pane closed');
      }
    } catch { /* best effort */ }
    try { rmSync(dirname(stateFile), { recursive: true, force: true }); } catch { /* best effort */ }
  });
  watcher.unref();
}

function prepareAgentWorkspace(baseCwd: string, agentName: string, isolation: IsolationMode): string {
  if (isolation === 'shared') return baseCwd;

  const isolatedRoot = join(tmpdir(), 'brain-isolated-workspaces');
  mkdirSync(isolatedRoot, { recursive: true });
  const workspacePath = join(isolatedRoot, `${Date.now()}-${sanitizeName(agentName)}`);

  cpSync(baseCwd, workspacePath, {
    recursive: true,
    force: true,
    filter: (src) => {
      const name = basename(src);
      return !['node_modules', '.git', '.DS_Store', '.cron-logs'].includes(name);
    },
  });

  for (const sharedName of ['node_modules', '.venv', 'venv']) {
    const source = join(baseCwd, sharedName);
    const target = join(workspacePath, sharedName);
    if (!existsSync(source) || existsSync(target)) continue;
    const type = lstatSync(source).isDirectory() ? 'dir' : 'file';
    symlinkSync(source, target, type as 'dir' | 'file');
  }

  return workspacePath;
}

function insideTmuxSession(): boolean {
  try {
    execSync('tmux display-message -p ""', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function createDetachedTmuxSession(baseName: string, windowName = 'brain'): {
  sessionName: string;
  windowTarget: string;
  attachCommand: string;
} {
  const sessionName = `brain-${sanitizeName(baseName)}-${Date.now().toString().slice(-6)}`;
  execSync(`tmux new-session -d -s ${sh(sessionName)} -n ${sh(windowName)}`);
  return {
    sessionName,
    windowTarget: `${sessionName}:0`,
    attachCommand: `tmux attach -t ${sessionName}`,
  };
}

function persistCompiledWorkflow(
  sid: string,
  compiled: ReturnType<typeof compileWorkflowForRoom>,
  configPath?: string,
) {
  const plan = db.createPlan(
    room,
    compiled.tasks.map((task) => ({
      name: task.name,
      description: task.description,
      depends_on: task.depends_on,
      agent_name: task.agent_name,
    })),
  );

  const workflowState = {
    plan_id: plan.plan_id,
    applied_at: new Date().toISOString(),
    applied_by: sessionName,
    ...compiled,
  };

  const stateKeys = [
    'workflow:latest',
    `workflow:${plan.plan_id}`,
    `workflow:${plan.plan_id}:config`,
  ];

  db.setState(
    'workflow:latest',
    room,
    JSON.stringify({ plan_id: plan.plan_id, kind: compiled.kind, goal: compiled.goal }),
    sid,
    sessionName,
  );
  db.setState(`workflow:${plan.plan_id}`, room, JSON.stringify(workflowState), sid, sessionName);
  db.setState(`workflow:${plan.plan_id}:config`, room, JSON.stringify(compiled.conductor_config), sid, sessionName);

  for (const phase of compiled.phases) {
    for (const agent of phase.agents) {
      const key = `workflow:${plan.plan_id}:agent:${agent.name}`;
      stateKeys.push(key);
      db.setState(key, room, JSON.stringify(agent), sid, sessionName);
    }
  }

  let writtenConfigPath: string | undefined;
  if (configPath) {
    writtenConfigPath = resolve(room, configPath);
    writeFileSync(writtenConfigPath, `${JSON.stringify(compiled.conductor_config, null, 2)}\n`);
  }

  return {
    plan_id: plan.plan_id,
    ready_tasks: db.getReadyTasks(room, plan.plan_id),
    state_keys: stateKeys,
    config_path: writtenConfigPath,
  };
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
1. register — name yourself (e.g. "lead", "architect")
2. recall — check if previous sessions stored useful knowledge about this codebase
3. Analyze the task. For complex work, use plan to create a dependency-aware task DAG
4. set — store shared context so spawned agents can read it
5. wake — spawn each agent. Supports:
   - tmux split panes (default) — visible, interactive
   - headless mode (layout="headless") — no tmux needed, works everywhere
   - multi-LLM routing (model="haiku" for cheap tasks, model="opus" for complex ones)
   - custom CLIs (cli="codex", cli="aider" — for non-Claude agents)
   - configurable timeouts (timeout=3600)
6. agents — monitor health of all spawned agents
7. auto_gate — run continuous integration gate until all errors are fixed
8. respawn — if an agent fails, respawn with recovery context
9. remember — store discoveries for future sessions
10. brain_metrics — track agent performance over time

TASK DAG (for complex work):
- plan — create tasks with dependencies: types → implementation → tests
- plan_next — get tasks whose dependencies are all satisfied
- plan_update — mark tasks done/failed (auto-promotes dependents to ready)
- plan_status — view overall progress

PERSISTENT MEMORY (knowledge that survives across sessions):
- remember — store knowledge (architecture insights, gotchas, patterns)
- recall — search for knowledge from previous agents/sessions
- forget — remove outdated knowledge
- This is the key differentiator — native agents are amnesiac, brain agents learn

HEARTBEAT PROTOCOL:
- Spawned agents call pulse every 2-3 tool calls to report status
- The lead calls agents to see all agent health at a glance
- pulse also returns pending DMs, keeping agents in sync

CONTRACT PROTOCOL (prevents integration bugs):
- contract_set — publish what your module provides/expects
- contract_get — read other agents' contracts before writing code
- contract_check — validate all contracts
- auto_gate — run gate in a loop, DM agents their errors, wait for fixes

AUTO-RECOVERY:
- respawn — detect failed agent, build recovery context, spawn replacement
- The replacement knows what the previous agent was doing and picks up where it left off

PERFORMANCE TRACKING:
- brain_metrics — view success rates, duration, error counts per agent
- brain_metric_record — record outcome after a task completes
- Use this data to optimize: which models for which tasks, which patterns work

HERMES/MINIMAX TOOL-NAMING RULE:
- Prefer the short tool names above: register, status, sessions, get, set, keys, pulse, agents, plan, wake, claim, release.
- Do NOT prepend "brain_" yourself when calling tools through Hermes. Hermes/MCP adds server namespacing automatically.
- If the client shows names like mcp_brain_status or mcp_brain_get, use those exact names from the picker instead of inventing brain_brain_* forms.

IMPORTANT: When the user asks for parallel agents, visible agent windows, tmux panes, wake, swarm, tmux_wake, or tmux_swarm:
- MUST call this MCP server's wake/swarm tools directly.
- MUST NOT use the client's built-in Agent/delegate/background-agent feature.
- MUST NOT summarize what would happen instead of calling the tool.
- The whole point of wake/swarm is to spawn real external CLI sessions the user can watch in tmux.
- If the user asks for new Claude Code sessions specifically, prefer the explicit aliases claude_code_wake / claude_code_swarm.

SIMPLIFIED INTERFACE: The "control" meta-tool wraps all coordination into one tool call with an action parameter.
Spawned agents should use control(action=...) instead of individual tools. It handles heartbeats, file locking, and checkpoints automatically.`,
  }
);

// Register short MCP tool names by default.
// Legacy `brain_*` aliases can be re-enabled with BRAIN_LEGACY_ALIASES=1 for
// older clients, but they are off by default because Hermes/MiniMax tends to
// overfit them into doubly-prefixed forms like `brain_brain_wake`.
const rawTool = server.tool.bind(server);
const exposeLegacyAliases =
  process.env.BRAIN_LEGACY_ALIASES === '1' ||
  process.env.BRAIN_LEGACY_ALIASES === 'true';
const explicitToolAliases: Record<string, string[]> = {
  wake: ['tmux_wake', 'brain_wake', 'claude_code_wake', 'claude_session_wake'],
  swarm: ['tmux_swarm', 'brain_swarm', 'claude_code_swarm', 'claude_session_swarm'],
};
const _registeredTools = new Set<string>();
(server as any).tool = ((name: string, ...args: any[]) => {
  const brainName = name.startsWith('brain_') ? name : `brain_${name}`;
  const aliases = explicitToolAliases[name] || [];
  if (
    exposeLegacyAliases &&
    !name.startsWith('brain_') &&
    name !== 'control' &&
    !_registeredTools.has(brainName)
  ) {
    (rawTool as any)(brainName, ...args);
  }
  for (const alias of aliases) {
    if (!_registeredTools.has(alias)) {
      (rawTool as any)(alias, ...args);
      _registeredTools.add(alias);
    }
  }
  _registeredTools.add(name);
  if (exposeLegacyAliases && !name.startsWith('brain_') && name !== 'control') {
    _registeredTools.add(brainName);
  }
  (rawTool as any)(name, ...args);
}) as typeof server.tool;

// ═══════════════════════════════════════
//  Autopilot Meta-Tool (simplified interface for LLMs)
// ═══════════════════════════════════════

registerAutopilot(server, db, room, () => ensureSession(), () => sessionName);

// ═══════════════════════════════════════
//  Compact Mode Toggle
// ═══════════════════════════════════════

server.tool(
  'compact',
  `Toggle compact response mode to reduce token cost. In compact mode:
- Write operations return {ok:1} instead of echoing data back
- Read operations skip pretty-printing
- Saves 30-80% tokens per tool call, significant over a long session.
Call with enabled=true at the start of a session to save tokens.`,
  {
    enabled: cBool().optional().describe('Enable (true) or disable (false) compact mode. Omit to toggle.'),
  },
  async ({ enabled }) => {
    compactMode = enabled !== undefined ? enabled : !compactMode;
    return reply({ compact: compactMode }, { c: compactMode ? 1 : 0 });
  }
);

// ═══════════════════════════════════════
//  Metrics & Observability
// ═══════════════════════════════════════

server.tool(
  'brain_metrics',
  `Query agent and spawn metrics for observability. Returns:
- summary: per-agent aggregate (success/fail rates, avg duration, spawn timing)
- history: individual metric records (last N)
- spawn_summary: spawn success/fail rates, avg spawn duration, resource usage
- spawn_history: individual spawn records
- spawn_trend: hourly time-series of spawn activity over the last N hours
- model_metrics: performance breakdown by model
- session_resources: current resource usage for active sessions`,
  {
    view: z.enum(['summary', 'history', 'spawn_summary', 'spawn_history', 'spawn_trend', 'model_metrics', 'session_resources'])
      .optional().describe('Which metrics view to return (default: summary)'),
    agent: z.string().optional().describe('Filter metrics to a specific agent name'),
    limit: cNum().optional().describe('Max records for history views (default: 50)'),
    hours: cNum().optional().describe('Hours for spawn_trend (default: 24)'),
  },
  async ({ view, agent, limit, hours }) => {
    ensureSession();
    const l = limit ?? 50;
    const h = hours ?? 24;

    switch (view) {
      case 'history':
        return reply(db.getMetrics(room, agent, l));
      case 'spawn_summary':
        return reply(db.getSpawnMetricsSummary(room));
      case 'spawn_history':
        return reply(db.getSpawnMetrics(room, agent, l));
      case 'spawn_trend':
        return reply(db.getSpawnTimingTrend(room, h));
      case 'model_metrics':
        return reply(db.getModelMetrics(room));
      case 'session_resources': {
        const sessions = db.getSessions(room);
        return reply(sessions.map((s: any) => ({
          id: s.id, name: s.name, status: s.status,
          spawn_timing_seconds: s.spawn_timing_seconds,
          memory_usage_bytes: s.memory_usage_bytes,
          cpu_usage_percent: s.cpu_usage_percent,
          last_heartbeat: s.last_heartbeat,
        })));
      }
      default: {
        // Default summary: agent task metrics + spawn metrics side by side
        const agentMetrics = db.getMetricsSummary(room);
        const spawnMetrics = db.getSpawnMetricsSummary(room);
        const trend = db.getSpawnTimingTrend(room, h);
        return reply({ agent_metrics: agentMetrics, spawn_metrics: spawnMetrics, spawn_trend: trend });
      }
    }
  }
);

server.tool(
  'brain_metric_record',
  `Record the outcome of an agent task for metrics tracking. Call this when a task completes (success or failure).`,
  {
    agent_name: z.string().describe('Name of the agent that completed the task'),
    agent_id: z.string().optional().describe('Agent session ID'),
    model: z.string().optional().describe('Model used (e.g. claude-sonnet-4-5)'),
    task_description: z.string().optional().describe('What the agent was trying to do'),
    duration_seconds: cNum().optional().describe('How long the task took'),
    gate_passes: cNum().optional().describe('Number of gate passes'),
    tsc_errors: cNum().optional().describe('TypeScript errors at gate'),
    contract_mismatches: cNum().optional().describe('Contract mismatches found'),
    files_changed: cNum().optional().describe('Files modified'),
    outcome: z.enum(['success', 'failed', 'unknown']).optional().describe('Task outcome (default: success)'),
  },
  async (params) => {
    ensureSession();
    const { agent_name, agent_id, model, task_description, duration_seconds,
      gate_passes, tsc_errors, contract_mismatches, files_changed, outcome } = params;
    db.recordMetric(room, agent_name, agent_id ?? null, {
      model, task_description, duration_seconds,
      gate_passes: gate_passes ?? 0, tsc_errors: tsc_errors ?? 0,
      contract_mismatches: contract_mismatches ?? 0,
      files_changed: files_changed ?? 0, outcome: outcome ?? 'success',
    });
    return reply({ ok: 1, agent_name, outcome: outcome ?? 'success' });
  }
);

// ═══════════════════════════════════════
//  Identity & Discovery
// ═══════════════════════════════════════

server.tool(
  'register',
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
    return reply({ sessionId, name, room, roomLabel }, { ok: 1, name });
  }
);

server.tool(
  'sessions',
  'List all active sessions. See who else is connected and their session IDs for DMs.',
  {
    all_rooms: cBool().optional().describe('Show sessions from ALL rooms, not just the current working directory'),
  },
  async ({ all_rooms }) => {
    ensureSession();
    const sessions = db.getSessions(all_rooms ? undefined : room);
    return reply(sessions);
  }
);

server.tool(
  'status',
  'Show this session\'s info, current room, and count of active sessions.',
  async () => {
    const sid = ensureSession();
    const self = db.getSession(sid);
    const allSessions = db.getSessions();
    const roomSessions = db.getSessions(room);
    return reply(
      { self, room, roomLabel, sessions: { total: allSessions.length, inRoom: roomSessions.length } },
      { name: self?.name, room: roomLabel, agents: roomSessions.length },
    );
  }
);

// ═══════════════════════════════════════
//  Heartbeat & Health Monitoring
// ═══════════════════════════════════════

server.tool(
  'pulse',
  'Report your progress and stay alive. Call this every few tool calls to let the lead know you are working. Returns any pending DMs so you stay in sync.',
  {
    status: z.enum(['working', 'done', 'failed']).describe('Current status: working (still going), done (task complete), failed (hit a blocker)'),
    progress: z.string().optional().describe('Short progress note (e.g. "editing src/api.ts", "tests passing", "blocked on type error")'),
  },
  async ({ status, progress }) => {
    const sid = ensureSession();
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

// ═══════════════════════════════════════
//  Channel Messaging
// ═══════════════════════════════════════

server.tool(
  'post',
  'Post a message to a channel. All sessions in the same working directory (room) can read it.',
  {
    content: z.string().describe('Message content'),
    channel: z.string().optional().describe('Channel name (default: "general")'),
  },
  async ({ content, channel }) => {
    const sid = ensureSession();
    const ch = channel || 'general';
    const id = db.postMessage(ch, room, sid, sessionName, content);
    return ack({ messageId: id });
  }
);

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

// ═══════════════════════════════════════
//  Direct Messages
// ═══════════════════════════════════════

server.tool(
  'dm',
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
    return ack({ to: targetId });
  }
);

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

// ═══════════════════════════════════════
//  Shared State (Key-Value Store)
// ═══════════════════════════════════════

server.tool(
  'set',
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
    return ack();
  }
);

server.tool(
  'get',
  'Get a value from the shared state store.',
  {
    key: z.string().describe('State key to read'),
    scope: z.string().optional().describe('Scope (default: current room)'),
  },
  async ({ key, scope }) => {
    ensureSession();
    const s = scope || room;
    const entry = db.getState(key, s);
    if (!entry) return reply({ found: false, key }, { v: null });
    return reply(
      { found: true, key, value: entry.value, updated_by: entry.updated_by_name, updated_at: entry.updated_at },
      { v: entry.value },
    );
  }
);

server.tool(
  'keys',
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
  'delete',
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
//  Atomic Counters
// ═══════════════════════════════════════

server.tool(
  'incr',
  'Atomically increment a numeric counter in shared state. Thread-safe — use for shared counters, progress tracking, or aggregation across agents.',
  {
    key: z.string().describe('Counter key name'),
    delta: cNum().optional().describe('Amount to increment by (default: 1)'),
    scope: z.string().optional().describe('Scope (default: current room)'),
  },
  async ({ key, delta, scope }) => {
    ensureSession();
    const s = scope || room;
    try {
      const result = db.incr(key, s, delta ?? 1);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, key, scope: s, ...result }) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: e.message }) }] };
    }
  }
);

server.tool(
  'counter',
  'Get the current value of an atomic counter without incrementing.',
  {
    key: z.string().describe('Counter key name'),
    scope: z.string().optional().describe('Scope (default: current room)'),
  },
  async ({ key, scope }) => {
    ensureSession();
    const s = scope || room;
    try {
      const counter = db.get_counter(key, s);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ key, scope: s, value: counter.value, found: counter.found }) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message }) }] };
    }
  }
);

// ═══════════════════════════════════════
//  Barriers
// ═══════════════════════════════════════

server.tool(
  'wait_until',
  'Barrier primitive — atomically increment a counter. When current >= threshold, returns reached:true for all callers simultaneously. Use for "wait for N agents to check in" semantics.',
  {
    key: z.string().describe('Barrier identifier (descriptive name)'),
    threshold: cNum().describe('Number of agents that must call before barrier releases'),
    scope: z.string().optional().describe('Scope (default: current room)'),
  },
  async ({ key, threshold, scope }) => {
    ensureSession();
    const s = scope || room;
    try {
      const result = db.wait_on(key, s, threshold, sessionId || 'anon', sessionName);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message }) }] };
    }
  }
);

server.tool(
  'barrier_reset',
  'Reset a barrier — deletes the barrier and all member check-ins so the same key can be reused for a fresh run.',
  {
    key: z.string().describe('Barrier identifier to reset'),
    scope: z.string().optional().describe('Scope (default: current room)'),
  },
  async ({ key, scope }) => {
    ensureSession();
    const s = scope || room;
    try {
      const result = db.barrier_reset(key, s);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, key, scope: s, ...result }) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: e.message }) }] };
    }
  }
);

// ═══════════════════════════════════════
//  Resource Coordination (Mutex/Claims)
// ═══════════════════════════════════════

server.tool(
  'claim',
  'Claim exclusive access to a resource (file, task, etc.). Prevents other sessions from claiming it. Use TTL for auto-release.',
  {
    resource: z.string().describe('Resource identifier (e.g. file path, task name, "src/api/routes.ts")'),
    ttl: cNum().optional().describe('Auto-release after this many seconds (prevents zombie claims)'),
  },
  async ({ resource, ttl }) => {
    const sid = ensureSession();
    const result = db.claim(resource, sid, sessionName, room, ttl);
    return reply(result, result.claimed ? { ok: 1 } : { no: result.owner });
  }
);

server.tool(
  'release',
  'Release a previously claimed resource so other sessions can claim it.',
  {
    resource: z.string().describe('Resource identifier to release'),
  },
  async ({ resource }) => {
    const sid = ensureSession();
    const released = db.release(resource, sid);
    return reply({ released, resource }, { ok: released ? 1 : 0 });
  }
);

server.tool(
  'claims',
  'List all active resource claims. See what resources are locked and by whom.',
  {
    current_room: cBool().optional().describe('Only show claims in the current room'),
  },
  async ({ current_room }) => {
    ensureSession();
    const claims = db.getClaims(current_room ? room : undefined);
    return reply(claims);
  }
);

// ═══════════════════════════════════════
//  Interface Contracts
// ═══════════════════════════════════════

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

// ═══════════════════════════════════════
//  Integration Gate
// ═══════════════════════════════════════

server.tool(
  'gate',
  `Run the integration gate: tsc --noEmit + contract validation.
Catches type errors, missing imports, param mismatches between agents.
If errors are found, DMs each responsible agent with their specific errors and resets their status to "working".
Use this after all agents report "done" to verify integration before shipping.`,
  {
    notify: cBool().optional().describe('DM agents with their errors and reset status to working (default: true)'),
    dry_run: cBool().optional().describe('Just check, don\'t DM agents (default: false)'),
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
  'clear',
  'Clear all brain data — messages, state, claims, contracts, sessions. Use this to reset the brain for a fresh start.',
  {
    confirm: cBool().describe('Must be true to confirm the clear operation'),
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
    const id = db.pushContext(room, sid, sessionName, entry_type, summary, detail, file_path, tags);
    return ack({ id });
  }
);

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
    // Compact: drop detail and agent fields, drop timestamps
    const compact = {
      count: entries.length,
      entries: entries.map(e => ({
        id: e.id, t: e.entry_type, s: e.summary,
        ...(e.file_path ? { f: e.file_path } : {}),
      })),
    };
    return reply(data, compact);
  }
);

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
    // Compact: drop recent entries (agent can call context_get if needed)
    return reply(data, {
      total: summary.total,
      types: summary.by_type,
      files: summary.files_touched,
    });
  }
);

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
        { found: false },
      );
    }
    const state = JSON.parse(checkpoint.state);
    // Also get room-wide context written AFTER the checkpoint so recovery includes
    // what other agents learned while this session was away.
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
    // Compact: keep full state (that's the whole point) but drop metadata
    return reply(data, {
      found: true,
      state,
      recent: recentContext.map(e => ({ t: e.entry_type, s: e.summary })),
    });
  }
);

// ═══════════════════════════════════════
//  Swarm — one-call multi-agent orchestration
// ═══════════════════════════════════════

server.tool(
  'swarm',
  `Spawn multiple external agent sessions at once to work on a task in parallel.
THIS TOOL EXISTS TO CREATE REAL, WATCHABLE CLI SESSIONS.

CRITICAL CLIENT RULES:
- Call this tool directly when the user asks for multiple agents, tmux panes, visible sessions, or live watching.
- Do NOT use the client's built-in Agent/delegate/background-agent feature instead.
- Do NOT silently replace this with any internal orchestration.

Behavior:
- layout="headless": background CLI processes
- layout="horizontal" or "tiled": visible tmux panes in the current tmux session
- if not already in tmux and a visible layout is requested, this tool creates a detached tmux session and returns attachCommand

Automatically: registers as lead, creates a task plan, spawns all agents, starts watchdog.
Use brain_agents to monitor, brain_auto_gate when done.

MiniMax/Claude hint: if the user asks for "tmux_swarm", "brain_swarm", "claude_code_swarm", or "claude_session_swarm", use this tool.`,
  {
    task: z.string().describe('The overall task to accomplish'),
    agents: cArr(z.object({
      name: z.string().describe('Agent name (e.g. "api-worker", "test-writer")'),
      task: z.string().describe('Specific task for this agent'),
      files: cArr(z.string()).optional().describe('Files this agent is responsible for'),
      model: z.string().optional().describe('Model override for this agent'),
      role: z.string().optional().describe('Role template for this agent (e.g. "integration-owner")'),
      acceptance: cArr(z.string()).optional().describe('Success criteria this agent should satisfy before marking done'),
      depends_on: cArr(z.string()).optional().describe('Other agent names whose outputs this agent should respect'),
      isolation: z.enum(['shared', 'snapshot']).optional().describe('Run this agent in the shared workspace or an isolated snapshot (default: shared)'),
    })).describe('Array of agents to spawn'),
    layout: z.enum(['horizontal', 'tiled', 'headless']).optional().describe('Layout for all agents (default: headless)'),
    model: z.string().optional().describe('Default model for all agents'),
    isolation: z.enum(['shared', 'snapshot']).optional().describe('Default workspace isolation for spawned agents (default: shared)'),
  },
  async ({ task, agents: agentConfigs, layout, model: defaultModel, isolation }) => {
    const sid = ensureSession();
    startLeadWatchdog(sid);

    const requestedLayout = layout || 'headless';
    const spawnLayout = requestedLayout;
    const useVisibleTmux = spawnLayout !== 'headless';
    const inTmux = useVisibleTmux ? insideTmuxSession() : false;
    const detachedTmux = useVisibleTmux && !inTmux
      ? createDetachedTmuxSession(`swarm-${roomLabel}`, 'swarm')
      : null;
    const cliBase = process.env.BRAIN_DEFAULT_CLI || 'claude';

    // Store shared context
    db.setState('swarm-task', room, task, sid, sessionName);

    // Spawn all agents
    const spawned: Array<{ name: string; sessionId: string; taskId: number; workspace: string }> = [];
    const errors: string[] = [];

    for (const agentCfg of agentConfigs) {
      try {
        const agentSessionId = randomUUID();
        const agentName = agentCfg.name;
        const workspacePath = prepareAgentWorkspace(room, agentName, agentCfg.isolation || isolation || 'shared');

        // Post task for audit trail
        const taskId = db.postMessage('tasks', room, sid, sessionName, agentCfg.task);

        // Register session in 'queued' state — it will transition to 'working'
        // only when the agent sends its first confirmed pulse via pulseWithFirstConfirm.
        // No direct pulse() call here — leaving it 'queued' so sweepGhostSessions
        // can catch it if the spawn fails before the agent ever heartbeats.
        db.registerSession(
          agentName, room,
          JSON.stringify({ parent_session_id: sid, task_id: taskId, swarm: true, workspace: workspacePath }),
          agentSessionId,
        );
        // Immediately set to 'queued' (not 'working') so the lifecycle is:
        // queued → working (on first agent heartbeat) → done/failed
        db.pulse(agentSessionId, 'queued', `swarm queued; depends_on=${JSON.stringify(agentCfg.depends_on)}`);

        // Build env (explicit allowlist + brain-mcp coords)
        const childEnvParts = agentEnvShellPairs({
          BRAIN_ROOM: room,
          BRAIN_SESSION_ID: agentSessionId,
          BRAIN_SESSION_NAME: agentName,
        });

        const agentModel = agentCfg.model || defaultModel;
        const cliType: 'claude' | 'hermes' | 'other' =
          (cliBase === 'claude' || cliBase.includes('claude')) ? 'claude' :
          (cliBase === 'hermes' || cliBase.includes('hermes')) ? 'hermes' :
          'other';

        // Use minimal autopilot prompt — works for ALL CLIs
        const prompt = minimalAgentPrompt(agentName, agentCfg.task, {
          files: agentCfg.files,
          role: agentCfg.role,
          acceptance: agentCfg.acceptance,
          dependsOn: agentCfg.depends_on,
          workspacePath,
        });

        const childEnv = childEnvParts.join(' ');
        const ts = Date.now();
        const tmpDir = mkdtempSync(join(tmpdir(), SPAWN_TMP_PREFIX));
        const logFile = join(tmpDir, 'agent.log');
        const promptFile = join(tmpDir, 'prompt.txt');
        writeFileSync(promptFile, prompt);

        if (!useVisibleTmux) {
          let headlessCmd: string;
          if (cliType === 'claude') {
            const modelFlag = agentModel ? ` --model ${sh(agentModel)}` : '';
            headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} claude -p${modelFlag} --dangerously-skip-permissions < ${sh(promptFile)} > ${sh(logFile)} 2>&1`;
          } else if (cliType === 'hermes') {
            const hermesModelEnv = agentModel ? `HERMES_MODEL=${sh(agentModel)}` : '';
            headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${hermesModelEnv} hermes chat -q ${sh(prompt)} -Q --yolo > ${sh(logFile)} 2>&1`;
          } else {
            headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} cat ${sh(promptFile)} | ${sh(cliBase)} > ${sh(logFile)} 2>&1`;
          }

          const spawnResult = await spawnWithRecovery(
            db,
            room,
            agentSessionId,
            agentName,
            agentCfg.task,
            headlessCmd,
            logFile,
          );

          if (spawnResult.success) {
            db.setSessionPid(agentSessionId, spawnResult.pid!);
            spawned.push({ name: agentName, sessionId: agentSessionId, taskId, workspace: workspacePath });
          } else {
            const msg = `${agentCfg.name}: spawn failed after ${spawnResult.attempt} attempts — ${spawnResult.error}`;
            errors.push(msg);
            db.pulse(agentSessionId, 'failed', msg);
          }
          continue;
        }

        let tmuxCmd: string;
        if (cliType === 'claude') {
          const modelFlag = agentModel ? ` --model ${sh(agentModel)}` : '';
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} claude${modelFlag} --dangerously-skip-permissions`;
        } else if (cliType === 'hermes') {
          const hermesModelEnv = agentModel ? `HERMES_MODEL=${sh(agentModel)}` : '';
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${hermesModelEnv} hermes --yolo`;
        } else {
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${sh(cliBase)}`;
        }

        let target: string;
        if (detachedTmux && spawned.length === 0) {
          execSync(`tmux rename-window -t ${sh(detachedTmux.windowTarget)} ${sh(agentName)}`);
          execSync(`tmux respawn-pane -k -t ${sh(`${detachedTmux.windowTarget}.0`)} ${sh(tmuxCmd)}`);
          target = execSync(`tmux display-message -p -t ${sh(`${detachedTmux.windowTarget}.0`)} '#{pane_id}'`).toString().trim();
        } else if (detachedTmux) {
          target = execSync(
            `tmux split-window -h -t ${sh(detachedTmux.windowTarget)} -P -F '#{pane_id}' ${sh(tmuxCmd)}`
          ).toString().trim();
        } else {
          target = execSync(
            `tmux split-window -h -P -F '#{pane_id}' ${sh(tmuxCmd)}`
          ).toString().trim();
        }

        try {
          const layoutTarget = detachedTmux?.windowTarget;
          let paneCount = 2;
          if (layoutTarget) {
            try { paneCount = parseInt(execSync(`tmux list-panes -t ${sh(layoutTarget)} | wc -l`).toString().trim(), 10) || 2; } catch { /* default */ }
          } else {
            try { paneCount = parseInt(execSync('tmux list-panes | wc -l').toString().trim(), 10) || 2; } catch { /* default */ }
          }
          const layoutPrefix = layoutTarget ? `tmux select-layout -t ${sh(layoutTarget)}` : 'tmux select-layout';

          if (spawnLayout === 'tiled' || paneCount > 4) {
            execSync(`${layoutPrefix} tiled`);
          } else if (paneCount <= 2) {
            execSync(`${layoutPrefix} even-horizontal`);
          } else {
            execSync(`${layoutPrefix} main-vertical`);
            if (!layoutTarget) {
              try { execSync('tmux resize-pane -t "{top-left}" -x 40%'); } catch { /* older tmux */ }
            }
          }
          if (!layoutTarget) {
            try { execSync('tmux select-layout -E'); } catch { /* tmux 3.1+ */ }
          }
        } catch { /* layout may vary */ }

        const exitCmd = cliType === 'hermes' ? '/quit' : '/exit';
        const bufferName = `brain-${ts}-${sanitizeName(agentName)}`;
        registerTmuxSessionRuntime(db, agentSessionId, target);
        if (watcherModeFromEnv() === 'daemon') {
          const ready = cliType === 'hermes' ? ['hermes', '>>', '❯'] : ['❯'];
          const fallback = cliType === 'hermes'
            ? ['tools', 'model', 'ready']
            : ['high effort', 'bypass perm', 'accept edits'];
          enqueueDaemonWatch(db, {
            pane_id: target,
            session_id: agentSessionId,
            ready_strategy: 'wait',
            ready_markers: ready,
            fallback_markers: fallback,
            exit_command: exitCmd,
            kill_grace_sec: 5,
            timeout_sec: 3600,
            prompt_path: promptFile,
            buffer_name: bufferName,
            finalizer_kind: 'reconcile',
          });
        } else {
          const readyPatterns = cliType === 'hermes'
            ? `echo "$CONTENT" | grep -q "hermes\\|>>\\|❯" 2>/dev/null`
            : `echo "$CONTENT" | LC_ALL=C grep -qF $'\\xe2\\x9d\\xaf' 2>/dev/null`;
          const fallbackReady = cliType === 'hermes'
            ? `echo "$CONTENT" | grep -q "tools\\|model\\|ready" 2>/dev/null`
            : `echo "$CONTENT" | grep -q "high effort\\|bypass perm\\|accept edits" 2>/dev/null`;
          const watcherFile = join(tmpDir, 'watch.sh');
          const watcherStateFile = join(tmpDir, 'watch.state');
          const watcherContent = `#!/bin/bash
TARGET="${target}"
PROMPT="${promptFile}"
BUFFER="${bufferName}"
ABSOLUTE_TIMEOUT=3600
START_TIME=$(date +%s)
STATE_FILE="${watcherStateFile}"

check_timeout() {
  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ $ABSOLUTE_TIMEOUT -gt 0 ] && [ $ELAPSED -ge $ABSOLUTE_TIMEOUT ]; then
    printf '%s\n' "timeout" > "$STATE_FILE"
    tmux send-keys -t "$TARGET" "${exitCmd}" Enter 2>/dev/null
    sleep 5
    tmux kill-pane -t "$TARGET" 2>/dev/null
    exit 0
  fi
}

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

tmux load-buffer -b "$BUFFER" "$PROMPT"
tmux paste-buffer -b "$BUFFER" -t "$TARGET"
sleep 0.5
tmux send-keys -t "$TARGET" Enter
tmux delete-buffer -b "$BUFFER" 2>/dev/null
rm -f "$PROMPT"

while true; do
  sleep 5
  check_timeout
  tmux display-message -t "$TARGET" -p "" 2>/dev/null || break
done
printf '%s\n' "pane_closed" > "$STATE_FILE"
`;
          writeFileSync(watcherFile, watcherContent, { mode: 0o755 });
          const watcher = spawn('bash', [watcherFile], { detached: true, stdio: 'ignore' });
          attachTmuxWatcherFinalizer(watcher, agentSessionId, watcherStateFile);
        }

        spawned.push({ name: agentName, sessionId: agentSessionId, taskId, workspace: workspacePath });
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
          agents: spawned.map((s) => ({ name: s.name, sessionId: s.sessionId, workspace: s.workspace })),
          errors: errors.length > 0 ? errors : undefined,
          cli: cliBase,
          layout: spawnLayout,
          requestedLayout,
          tmuxSession: detachedTmux?.sessionName,
          attachCommand: detachedTmux?.attachCommand,
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
  'remember',
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
    return ack({ id });
  }
);

server.tool(
  'recall',
  `Search persistent memory for knowledge stored by previous agents or sessions.
Always check memory at the start of a task — previous agents may have discovered something relevant.`,
  {
    query: z.string().optional().describe('Search term to match against key and content (optional — omit to list all)'),
    category: z.string().optional().describe('Filter by category'),
    limit: cNum().optional().describe('Max results (default: 20)'),
  },
  async ({ query, category, limit }) => {
    ensureSession();
    const memories = await db.recallMemory(room, query, category, limit);
    const categories = db.listMemoryCategories(room);
    const data = {
      count: memories.length,
      categories,
      memories: memories.map(m => ({
        id: m.id, key: m.key, content: m.content,
        category: m.category, access_count: m.access_count,
        created_by: m.created_by_name, updated_at: m.updated_at,
      })),
    };
    // Compact: drop metadata, keep key+content which is what matters
    return reply(data, {
      count: memories.length,
      categories,
      memories: memories.map(m => ({ key: m.key, content: m.content, cat: m.category })),
    });
  }
);

server.tool(
  'forget',
  'Remove a memory by key. Use when knowledge is outdated or wrong.',
  {
    key: z.string().describe('Memory key to remove'),
  },
  async ({ key }) => {
    ensureSession();
    const removed = db.forgetMemoryByKey(room, key);
    return reply({ removed, key }, { ok: removed ? 1 : 0 });
  }
);

// ═══════════════════════════════════════
//  Task DAG — dependency-aware task planning
// ═══════════════════════════════════════

server.tool(
  'plan',
  `Create a task execution plan with dependencies. Tasks form a DAG — a task only becomes "ready"
when all its dependencies are done. Use this instead of naively splitting work by files.
Example: types → implementation → tests (each stage depends on the previous).`,
  {
    tasks: cArr(z.object({
      name: z.string().describe('Unique task name (e.g. "define-types", "implement-api", "write-tests")'),
      description: z.string().describe('What this task should accomplish'),
      depends_on: cArr(z.string()).optional().describe('Names of tasks that must complete before this one can start'),
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
  'plan_next',
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
  'plan_update',
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
  'plan_status',
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
//  Workflow Compiler — goal -> agent workflow
// ═══════════════════════════════════════

server.tool(
  'workflow_compile',
  `Compile a natural-language goal into a reusable multi-agent workflow.
This is the AutoAgent-style planning layer for brain-mcp: it classifies the goal, chooses
agent roles, assigns file scopes, suggests models, and emits both a task DAG and conductor-ready
pipeline config without spawning anything yet.`,
  {
    goal: z.string().describe('High-level goal to turn into a workflow'),
    max_agents: cNum().optional().describe('Soft cap for the number of agents in the compiled workflow (default: 4, max: 6).'),
    mode: z.enum(['claude', 'py', 'pi', 'pi-core']).optional().describe('Preferred execution mode for the generated conductor config (default: pi-core).'),
    thinking_level: THINKING_LEVEL_SCHEMA,
    available_models: cArr(z.string()).optional().describe('Optional list of models available for auto-routing.'),
    focus_files: cArr(z.string()).optional().describe('Optional file or directory hints to bias scope assignment.'),
    auto_route_models: cBool().optional().describe('Suggest per-agent models using historical metrics when available (default: true).'),
  },
  async ({ goal, max_agents, mode, thinking_level, available_models, focus_files, auto_route_models }) => {
    ensureSession();
    const compiled = compileWorkflowForRoom(goal, {
      max_agents,
      mode,
      thinking_level,
      available_models,
      focus_files,
      auto_route_models,
    });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(compiled, null, 2),
      }],
    };
  }
);

server.tool(
  'workflow_apply',
  `Compile a natural-language goal into a brain plan and persist the workflow metadata.
Writes the compiled workflow into brain state, creates a dependency-aware task DAG, and can
optionally write a conductor JSON config file. Use this when you want a workflow you can execute,
not just preview.`,
  {
    goal: z.string().describe('High-level goal to turn into a workflow'),
    max_agents: cNum().optional().describe('Soft cap for the number of agents in the compiled workflow (default: 4, max: 6).'),
    mode: z.enum(['claude', 'py', 'pi', 'pi-core']).optional().describe('Preferred execution mode for the generated conductor config (default: pi-core).'),
    thinking_level: THINKING_LEVEL_SCHEMA,
    available_models: cArr(z.string()).optional().describe('Optional list of models available for auto-routing.'),
    focus_files: cArr(z.string()).optional().describe('Optional file or directory hints to bias scope assignment.'),
    auto_route_models: cBool().optional().describe('Suggest per-agent models using historical metrics when available (default: true).'),
    config_path: z.string().optional().describe('Optional JSON file path to write the generated conductor config. Relative paths are resolved from the current room.'),
  },
  async ({ goal, max_agents, mode, thinking_level, available_models, focus_files, auto_route_models, config_path }) => {
    const sid = ensureSession();
    const compiled = compileWorkflowForRoom(goal, {
      max_agents,
      mode,
      thinking_level,
      available_models,
      focus_files,
      auto_route_models,
    });
    const persisted = persistCompiledWorkflow(sid, compiled, config_path);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          plan_id: persisted.plan_id,
          workflow_kind: compiled.kind,
          summary: compiled.summary,
          phases: compiled.phases.map((phase) => ({
            name: phase.name,
            parallel: phase.parallel,
            agents: phase.agents.map((agent) => ({
              name: agent.name,
              role: agent.role,
              model: agent.model,
            })),
          })),
          ready_tasks: persisted.ready_tasks.map((task) => ({
            id: task.id,
            name: task.name,
            description: task.description,
            agent_name: task.agent_name,
          })),
          config_path: persisted.config_path,
          state_keys: persisted.state_keys,
          next_steps: [
            `plan_next with plan_id=${persisted.plan_id}`,
            persisted.config_path ? `brain-conductor --config ${persisted.config_path}` : 'Use the stored workflow:* state or conductor config payload to start execution',
            'brain_wake or brain_swarm using the persisted agent task specs if you want manual control',
          ],
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'workflow_run',
  `Compile a goal into a workflow, persist it, and launch the Node conductor in the background.
This is the end-to-end entrypoint for AutoAgent-style orchestration inside brain-mcp.
It writes a conductor config, starts execution, and returns the plan/config/log locations so you can
monitor progress with brain_agents, brain_plan_status, and the log file.`,
  {
    goal: z.string().describe('High-level goal to turn into an executing workflow'),
    max_agents: cNum().optional().describe('Soft cap for the number of agents in the compiled workflow (default: 4, max: 6).'),
    mode: z.enum(['claude', 'py', 'pi', 'pi-core']).optional().describe('Execution mode for the launched conductor (default: pi-core).'),
    thinking_level: THINKING_LEVEL_SCHEMA,
    available_models: cArr(z.string()).optional().describe('Optional list of models available for auto-routing.'),
    focus_files: cArr(z.string()).optional().describe('Optional file or directory hints to bias scope assignment.'),
    auto_route_models: cBool().optional().describe('Suggest per-agent models using historical metrics when available (default: true).'),
    isolation: z.enum(['shared', 'snapshot']).optional().describe('Use the shared workspace or generate isolated snapshot workspaces per agent (default: shared).'),
    config_path: z.string().optional().describe('Optional JSON file path to write the generated conductor config. Relative paths are resolved from the current room.'),
    log_path: z.string().optional().describe('Optional log file path for the launched conductor. Relative paths are resolved from the current room.'),
  },
  async ({ goal, max_agents, mode, thinking_level, available_models, focus_files, auto_route_models, isolation, config_path, log_path }) => {
    const sid = ensureSession();
    startLeadWatchdog(sid);

    if (mode && mode !== 'pi-core') {
      try {
        execSync('tmux display-message -p ""', { stdio: 'ignore' });
      } catch {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'workflow_run with claude/pi/py mode requires tmux. Use mode="pi-core" or run inside tmux.' }) }],
          isError: true,
        };
      }
    }

    const compiled = compileWorkflowForRoom(goal, {
      max_agents,
      mode,
      thinking_level,
      available_models,
      focus_files,
      auto_route_models,
    });

    const isolationMode = isolation || 'shared';
    if (isolationMode === 'snapshot') {
      compiled.conductor_config.phases = compiled.conductor_config.phases.map((phase) => ({
        ...phase,
        agents: phase.agents.map((agent) => ({
          ...agent,
          workspace: prepareAgentWorkspace(room, agent.name, 'snapshot'),
        })),
      }));
    }

    const defaultConfigPath = join(tmpdir(), `brain-workflow-${Date.now()}.json`);
    const persisted = persistCompiledWorkflow(sid, compiled, config_path || defaultConfigPath);
    const configFile = persisted.config_path || resolve(room, config_path || defaultConfigPath);
    const conductorPath = fileURLToPath(new URL('./conductor.js', import.meta.url));
    const logFile = resolve(room, log_path || join(tmpdir(), `brain-workflow-${persisted.plan_id}.log`));
    const logFd = openSync(logFile, 'a');
    const child = spawn('node', [conductorPath, '--config', configFile], {
      cwd: room,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        BRAIN_DB_PATH: process.env.BRAIN_DB_PATH || '',
        BRAIN_ROOM: room,
      },
    });
    closeSync(logFd);
    child.unref();

    const runState = {
      plan_id: persisted.plan_id,
      pid: child.pid,
      config_path: configFile,
      log_path: logFile,
      started_at: new Date().toISOString(),
      mode: compiled.conductor_config.mode,
      isolation: isolationMode,
    };
    db.setState(`workflow:${persisted.plan_id}:run`, room, JSON.stringify(runState), sid, sessionName);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          plan_id: persisted.plan_id,
          workflow_kind: compiled.kind,
          pid: child.pid,
          mode: compiled.conductor_config.mode,
          isolation: isolationMode,
          config_path: configFile,
          log_path: logFile,
          ready_tasks: persisted.ready_tasks.map((task) => ({
            id: task.id,
            name: task.name,
            agent_name: task.agent_name,
          })),
          next_steps: [
            'Use brain_agents to monitor live agent status',
            `Use brain_plan_status with plan_id=${persisted.plan_id} to inspect task progress`,
            `Inspect the conductor log at ${logFile} if execution stalls`,
          ],
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════
//  Auto-Recovery — respawn failed/stale agents
// ═══════════════════════════════════════

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
  'auto_gate',
  `Run the integration gate in a loop until all errors are fixed or max retries are hit.
After each failed gate, agents are DM'd their specific errors and given time to fix them.
Returns the final gate result. Use this after all agents report "done" to ship with confidence.`,
  {
    max_retries: cNum().optional().describe('Max gate attempts before giving up (default: 5)'),
    wait_seconds: cNum().optional().describe('Seconds to wait between gate attempts for agents to fix errors (default: 30)'),
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
  'metrics',
  `View agent performance history. Tracks duration, error counts, gate passes, and success rates.
Use this to learn which agents/models perform best for which tasks, and to optimize future assignments.`,
  {
    agent_name: z.string().optional().describe('Filter by agent name (omit for summary of all agents)'),
    limit: cNum().optional().describe('Max records to return (default: 50)'),
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
  'metric_record',
  'Record a performance metric for an agent. Call this when an agent completes or fails a task.',
  {
    agent_name: z.string().describe('Agent name'),
    agent_id: z.string().optional().describe('Agent session ID'),
    model: z.string().optional().describe('Model used for this task (e.g. "opus", "sonnet", "haiku")'),
    outcome: z.enum(['success', 'partial', 'failed']).describe('How the task went'),
    task_description: z.string().optional().describe('What the agent was doing'),
    duration_seconds: cNum().optional().describe('How long the task took'),
    gate_passes: cNum().optional().describe('How many gate iterations before passing'),
    tsc_errors: cNum().optional().describe('Number of tsc errors at completion'),
    contract_mismatches: cNum().optional().describe('Number of contract mismatches'),
    files_changed: cNum().optional().describe('Number of files modified'),
  },
  async ({ agent_name, agent_id, model, outcome, task_description, duration_seconds, gate_passes, tsc_errors, contract_mismatches, files_changed }) => {
    ensureSession();
    const id = db.recordMetric(room, agent_name, agent_id || null, {
      model, outcome, task_description, duration_seconds,
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
  'wake',
  `Spawn one new external agent session to handle a task.
THIS TOOL EXISTS TO CREATE A REAL, WATCHABLE CLI SESSION.

CRITICAL CLIENT RULES:
- Call this tool directly when the user asks for a new agent session, tmux pane, visible Claude/CLI window, or live watching.
- Do NOT use the client's built-in Agent/delegate/background-agent feature instead.
- Do NOT summarize what would happen instead of calling the tool.

Modes:
- layout="horizontal" (default): visible tmux split pane in the current tmux session
- layout="vertical" | "tiled" | "window": other visible tmux layouts
- layout="headless": background process
- if not already in tmux and a visible layout is requested, this tool creates a detached tmux session and returns attachCommand

Supports multi-LLM routing via the model parameter (e.g. "haiku" for cheap tasks, "opus" for complex ones).
Configurable timeout (default: none for tmux, 30min for headless).

MiniMax/Claude hint: if the user asks for "tmux_wake", "brain_wake", "claude_code_wake", or "claude_session_wake", use this tool.`,
  {
    task: z.string().describe('The full task description for the new session to execute'),
    name: z.string().optional().describe('Name for the new agent session (default: "agent-<timestamp>")'),
    layout: z.enum(['vertical', 'horizontal', 'tiled', 'window', 'headless']).optional().describe('"horizontal" = side by side (default). "vertical" = stacked. "tiled" = auto-grid. "window" = new tmux tab. "headless" = background process (no tmux needed).'),
    files: cArr(z.string()).optional().describe('Optional file scope for the agent'),
    role: z.string().optional().describe('Optional role template to include in the prompt'),
    acceptance: cArr(z.string()).optional().describe('Success criteria the agent should satisfy before marking done'),
    isolation: z.enum(['shared', 'snapshot']).optional().describe('Run in the shared workspace or an isolated snapshot (default: shared)'),
    model: z.string().optional().describe('Model to use for this agent. For Claude Code: "opus", "sonnet", "haiku", or full model ID. Enables multi-LLM routing — use cheap models for boilerplate, expensive for complex logic.'),
    auto_route: cBool().optional().describe('Auto-select the best model based on task complexity and historical metrics. Ignored if model is explicitly set.'),
    timeout: cNum().optional().describe('Timeout in seconds. Default: 3600 (1 hour). Set 0 for no timeout.'),
    cli: z.string().optional().describe('Custom CLI command to spawn instead of "claude" (e.g. "codex", "aider"). The agent will still use brain tools if the CLI supports MCP.'),
  },
  async ({ task, name, layout, files, role, acceptance, isolation, model: modelParam, auto_route, timeout: timeoutSec, cli }) => {
    const sid = ensureSession();
    startLeadWatchdog(sid);
    const agentName = name || `agent-${Date.now()}`;
    const agentSessionId = randomUUID();
    const tmuxName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const requestedLayout = layout || 'horizontal';
    const spawnLayout = requestedLayout;
    const useVisibleTmux = spawnLayout !== 'headless';
    const inTmux = useVisibleTmux ? insideTmuxSession() : false;
    const detachedTmux = useVisibleTmux && !inTmux
      ? createDetachedTmuxSession(agentName, tmuxName)
      : null;
    const isHeadless = spawnLayout === 'headless';
    const agentTimeout = timeoutSec ?? (isHeadless ? 1800 : 3600);
    const workspacePath = prepareAgentWorkspace(room, agentName, isolation || 'shared');

    // Auto-route: pick the best model based on task complexity + metrics
    let model = modelParam;
    if (auto_route && !model) {
      const router = new TaskRouter(db, room);
      const rec = router.routeTask(task);
      model = rec.model;
      db.pushContext(room, sid, sessionName, 'decision',
        `Auto-routed "${agentName}" to model ${model} (confidence: ${rec.confidence}, complexity: ${rec.complexity})`,
        rec.reasoning, undefined, ['auto-route']);
    }

    // Post the task to the brain for audit trail
    const taskId = db.postMessage('tasks', room, sid, sessionName, task);

    // Pre-register child session in 'queued' state — it transitions to 'working'
    // only when the agent sends its first confirmed pulse via pulseWithFirstConfirm.
    db.registerSession(
      agentName,
      room,
      JSON.stringify({ parent_session_id: sid, task_id: taskId, model: model || null, headless: isHeadless, workspace: workspacePath }),
      agentSessionId,
    );
    db.pulse(agentSessionId, 'queued', 'spawn queued; waiting for first heartbeat');

    // Build env vars for the child (explicit allowlist + brain-mcp coords)
    const childEnvParts = agentEnvShellPairs({
      BRAIN_ROOM: room,
      BRAIN_SESSION_ID: agentSessionId,
      BRAIN_SESSION_NAME: agentName,
    });

    // Determine CLI type — BRAIN_DEFAULT_CLI lets hermes auto-spawn hermes agents
    const cliBase = cli || process.env.BRAIN_DEFAULT_CLI || 'claude';
    const cliType: 'claude' | 'hermes' | 'codex' | 'other' =
      (cliBase === 'claude' || cliBase.includes('claude')) ? 'claude' :
      (cliBase === 'hermes' || cliBase.includes('hermes')) ? 'hermes' :
      (cliBase === 'codex' || cliBase.includes('codex')) ? 'codex' :
      'other';

    // Build model flag per CLI
    let modelFlag = '';
    if (model) {
      if (cliType === 'claude') modelFlag = ` --model ${sh(model)}`;
      if (cliType === 'codex') modelFlag = ` --model ${sh(model)}`;
      // Hermes uses the configured model — pass via env var
    }

    // Build the prompt — use minimal autopilot prompt (replaces 40+ line protocol dump)
    // The "control" meta-tool handles heartbeats, file locking, and checkpoints automatically.
    // This works for ALL CLIs — no more transport-specific tool name prefixing.
    const prompt = minimalAgentPrompt(agentName, task, {
      files,
      role,
      acceptance,
      workspacePath,
    });

    const ts = Date.now();
    const tmpDir = mkdtempSync(join(tmpdir(), SPAWN_TMP_PREFIX));
    const promptFile = join(tmpDir, 'prompt.txt');
    writeFileSync(promptFile, prompt);

    try {
      // ══════════════════════════════════════
      //  HEADLESS MODE — no tmux required
      // ══════════════════════════════════════
      if (isHeadless) {
        const logFile = join(tmpDir, 'agent.log');
        const childEnv = childEnvParts.join(' ');

        // Build the headless command per CLI type
        let headlessCmd: string;
        if (cliType === 'claude') {
          // claude -p (print mode) reads prompt from stdin, avoiding ARG_MAX limits.
          headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${sh(cliBase)} -p${modelFlag} --dangerously-skip-permissions < ${sh(promptFile)} > ${sh(logFile)} 2>&1`;
        } else if (cliType === 'hermes') {
          // hermes chat -q (single query mode) — non-interactive, uses MCP tools, exits when done
          // -Q suppresses TUI, only prints final response
          const hermesModelEnv = model ? `HERMES_MODEL=${sh(model)}` : '';
          headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${hermesModelEnv} ${sh(cliBase)} chat -q ${sh(prompt)} -Q > ${sh(logFile)} 2>&1`;
        } else if (cliType === 'codex') {
          // codex exec is the supported non-interactive mode; plain `codex` expects an interactive TTY.
          headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${sh(cliBase)} exec --full-auto --color never${modelFlag} - < ${sh(promptFile)} > ${sh(logFile)} 2>&1`;
        } else {
          // Generic CLI — pass prompt via stdin
          headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} cat ${sh(promptFile)} | ${sh(cliBase)} > ${sh(logFile)} 2>&1`;
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

        // ── Error Recovery Wrapper ─────────────────────────────────────────────
        // Replace: detached:true, stdio:'ignore' — which silently swallows all errors
        // With: spawnWithRecovery which provides error detection, retry w/backoff,
        // pre-spawn checkpoint, and escalation alerts.
        const spawnResult = await spawnWithRecovery(
          db,
          room,
          agentSessionId,
          agentName,
          task,
          headlessCmd,
          logFile,
          () => {
            // onBeforeSpawn callback — nothing extra needed, session already registered
          },
        );

        if (!spawnResult.success) {
          // All retries exhausted — mark failed and return error
          db.pulse(agentSessionId, 'failed', `Spawn exhausted (${spawnResult.attempt} attempts): ${spawnResult.error}`);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `Spawn failed after ${spawnResult.attempt} attempts: ${spawnResult.error}`,
                agent: agentName,
                agentSessionId,
              }),
            }],
            isError: true,
          };
        }

        // Spawn succeeded — log PID and continue
        db.setSessionPid(agentSessionId, spawnResult.pid!);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              agent: agentName,
              agentSessionId,
              taskId,
              mode: 'headless',
              requestedLayout,
              model: model || 'default',
              workspace: workspacePath,
              isolation: isolation || 'shared',
              logFile,
              pid: spawnResult.pid,
              attempts: spawnResult.attempt,
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
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${sh(cliBase)}${modelFlag} --dangerously-skip-permissions`;
        } else if (cliType === 'hermes') {
          // Hermes interactive TUI mode — full agent experience in tmux pane
          const hermesModelEnv = model ? `HERMES_MODEL=${sh(model)}` : '';
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${hermesModelEnv} ${sh(cliBase)}`;
        } else if (cliType === 'codex') {
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${sh(cliBase)} --no-alt-screen${modelFlag}`;
        } else {
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${sh(cliBase)}`;
        }
      const bufferName = `brain-${ts}`;

      let target: string;

      if (detachedTmux) {
        execSync(`tmux respawn-pane -k -t ${sh(`${detachedTmux.windowTarget}.0`)} ${sh(tmuxCmd)}`);
        target = execSync(`tmux display-message -p -t ${sh(`${detachedTmux.windowTarget}.0`)} '#{pane_id}'`).toString().trim();
      } else if (spawnLayout === 'window') {
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
      registerTmuxSessionRuntime(db, agentSessionId, target);
      if (watcherModeFromEnv() === 'daemon') {
        const ready = cliType === 'hermes' ? ['hermes', '>>', '❯'] : ['❯'];
        const fallback = cliType === 'hermes'
          ? ['tools', 'model', 'ready']
          : ['high effort', 'bypass perm', 'accept edits'];
        enqueueDaemonWatch(db, {
          pane_id: target,
          session_id: agentSessionId,
          ready_strategy: 'wait',
          ready_markers: ready,
          fallback_markers: fallback,
          exit_command: exitCmd,
          kill_grace_sec: 5,
          timeout_sec: agentTimeout,
          prompt_path: promptFile,
          buffer_name: bufferName,
          finalizer_kind: 'reconcile',
        });
      } else {
        const readyPatterns = cliType === 'hermes'
          ? `echo "$CONTENT" | grep -q "hermes\\|>>\\|❯" 2>/dev/null`
          : `echo "$CONTENT" | LC_ALL=C grep -qF $'\\xe2\\x9d\\xaf' 2>/dev/null`;
        const fallbackReady = cliType === 'hermes'
          ? `echo "$CONTENT" | grep -q "tools\\|model\\|ready" 2>/dev/null`
          : `echo "$CONTENT" | grep -q "high effort\\|bypass perm\\|accept edits" 2>/dev/null`;

        const watcherFile = join(tmpDir, 'watch.sh');
        const watcherStateFile = join(tmpDir, 'watch.state');
        const watcherContent = `#!/bin/bash
TARGET="${target}"
PROMPT="${promptFile}"
BUFFER="${bufferName}"
ABSOLUTE_TIMEOUT=${agentTimeout}
START_TIME=$(date +%s)
STATE_FILE="${watcherStateFile}"

check_timeout() {
  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ $ABSOLUTE_TIMEOUT -gt 0 ] && [ $ELAPSED -ge $ABSOLUTE_TIMEOUT ]; then
    printf '%s\n' "timeout" > "$STATE_FILE"
    tmux send-keys -t "$TARGET" "${exitCmd}" Enter 2>/dev/null
    sleep 5
    tmux kill-pane -t "$TARGET" 2>/dev/null
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
printf '%s\n' "pane_closed" > "$STATE_FILE"
`;
        writeFileSync(watcherFile, watcherContent, { mode: 0o755 });

        const watcher = spawn('bash', [watcherFile], { detached: true, stdio: 'ignore' });
        attachTmuxWatcherFinalizer(watcher, agentSessionId, watcherStateFile);
      }

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
            requestedLayout,
            model: model || 'default',
            workspace: workspacePath,
            isolation: isolation || 'shared',
            tmuxSession: detachedTmux?.sessionName,
            attachCommand: detachedTmux?.attachCommand,
            message: detachedTmux
              ? `Spawned "${agentName}" in detached tmux session "${detachedTmux.sessionName}". Attach with: ${detachedTmux.attachCommand}`
              : `Spawned "${agentName}" — ${layoutDesc[spawnLayout]}. Pre-registered with heartbeat. Lead watchdog active.`,
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
//  Smart Task Router
// ═══════════════════════════════════════

server.tool(
  'route',
  `Get a model recommendation for a task based on historical performance data.
Returns the recommended model, confidence score, complexity classification, and reasoning.
Use this before brain_wake to auto-select the best model for the job.`,
  {
    task: z.string().describe('Task description to route'),
    available_models: cArr(z.string()).optional().describe('Models available to choose from (e.g. ["haiku", "sonnet", "opus"])'),
    prefer_speed: cBool().optional().describe('Prefer faster models over higher quality (default: false)'),
    prefer_quality: cBool().optional().describe('Prefer higher quality models over speed (default: false)'),
  },
  async ({ task, available_models, prefer_speed, prefer_quality }) => {
    ensureSession();
    const router = new TaskRouter(db, room);
    const recommendation = router.routeTask(task, { available_models, prefer_speed, prefer_quality });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(recommendation, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════
//  Git Workflow Tools
// ═══════════════════════════════════════

server.tool(
  'commit',
  `Analyze unstaged changes, determine a conventional commit type, generate a commit message,
and stage + commit the changes. Uses git diff to understand what changed, then generates
a conventional commit message (feat, fix, docs, refactor, test, chore, etc.).

Works in any language. Run from the repository root.`,
  {
    message: z.string().optional().describe('Commit message override. If not provided, a conventional commit message is auto-generated from the diff.'),
    files: cArr(z.string()).optional().describe('Specific files to stage and commit. If not provided, commits all unstaged changes.'),
    no_verify: cBool().optional().describe('Pass --no-verify to bypass git hooks (default: false)'),
    amend: cBool().optional().describe('Amend the previous commit instead of creating a new one (default: false)'),
  },
  async ({ message, files, no_verify, amend }) => {
    ensureSession();

    // Get the diff
    const fileArg = files ? files.join(' ') : '.';
    let diffCmd = `git diff --cached ${fileArg}`;
    if (!files) {
      // Stage everything first so we get a meaningful diff
      try { execSync('git add -A', { stdio: 'pipe', cwd: room }); } catch { /* may fail if nothing to add */ }
      diffCmd = 'git diff --cached';
    } else {
      // Stage only specified files
      for (const f of files) {
        try { execSync(`git add ${f}`, { stdio: 'pipe', cwd: room }); } catch { /* ignore */ }
      }
    }

    let diff = '';
    try {
      diff = execSync(diffCmd, { encoding: 'utf-8', cwd: room, maxBuffer: 10 * 1024 * 1024 });
    } catch (e: any) {
      const errMsg = e.stderr || e.message || '';
      if (errMsg.includes('empty') || errMsg.includes('no changes')) {
        // Nothing staged — try unstaged diff
        const unstagedDiff = execSync('git diff', { encoding: 'utf-8', cwd: room, maxBuffer: 10 * 1024 * 1024 });
        if (!unstagedDiff.trim()) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ committed: false, error: 'No changes to commit. Stage files first with git add.' }) }] };
        }
        // Stage it
        execSync('git add -A', { stdio: 'pipe', cwd: room });
        diff = unstagedDiff;
      } else {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ committed: false, error: `Git error: ${errMsg}` }) }] };
      }
    }

    // Get list of changed files
    let changedFiles: string[] = [];
    try {
      const statusOutput = execSync('git diff --cached --name-only', { encoding: 'utf-8', cwd: room });
      changedFiles = statusOutput.trim().split('\n').filter(f => f);
    } catch { /* ignore */ }

    // Detect what changed (for commit type)
    const hasTests = changedFiles.some(f => f.includes('test') || f.includes('spec') || f.includes('__tests__'));
    const hasDocs = changedFiles.some(f => f.includes('README') || f.includes('docs') || f.includes('.md'));
    const hasConfig = changedFiles.some(f => f.includes('package.json') || f.includes('tsconfig') || f.includes('.yml') || f.includes('.yaml') || f.includes('Cargo.toml') || f.includes('pyproject.toml'));
    const hasSrc = changedFiles.some(f => !f.includes('test') && !f.includes('docs') && !f.includes('README') && (f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.py') || f.endsWith('.rs') || f.endsWith('.go')));

    let commitType = 'chore';
    if (hasSrc) {
      // Heuristic: check diff size and patterns
      const addedLines = (diff.match(/^\+[^+]/gm) || []).length;
      const removedLines = (diff.match(/^-[^-]/gm) || []).length;
      if (diff.includes('fix') || diff.includes('bug') || diff.includes('FIX') || diff.includes('FIXME')) commitType = 'fix';
      else if (diff.includes('feat') || diff.includes('Feature') || addedLines > 50) commitType = 'feat';
      else commitType = 'refactor';
    } else if (hasTests) commitType = 'test';
    else if (hasDocs) commitType = 'docs';
    else if (hasConfig) commitType = 'chore';

    // Generate commit message if not provided
    let commitMsg = message;
    if (!commitMsg) {
      const scope = changedFiles.length === 1
        ? changedFiles[0].split('/')[0].replace(/\.[^.]+$/, '')
        : changedFiles.length > 4 ? 'core' : changedFiles.slice(0, 2).map(f => f.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i).join(',');

      const shortDesc = changedFiles.length === 1
        ? changedFiles[0].replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ')
        : changedFiles.length <= 3
          ? changedFiles.map(f => f.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ')).join(', ')
          : `${changedFiles.slice(0, 2).map(f => f.split('/')[0]).join(', ')} and ${changedFiles.length - 2} more`;

      commitMsg = `${commitType}${scope !== 'core' ? `(${scope})` : ''}: ${shortDesc}`;
    }

    // Build git command
    const verifyFlag = no_verify ? ' --no-verify' : '';
    let commitCmd: string;
    if (amend) {
      commitCmd = `git commit${verifyFlag} --amend -m ${sh(commitMsg)}`;
    } else {
      commitCmd = `git commit${verifyFlag} -m ${sh(commitMsg)}`;
    }

    let commitHash = '';
    let commitError = '';
    try {
      const out = execSync(commitCmd, { encoding: 'utf-8', cwd: room });
      // Extract hash from output
      const hashMatch = out.match(/\[([a-f0-9]+)\s/);
      commitHash = hashMatch ? hashMatch[1] : '';
    } catch (e: any) {
      commitError = e.stderr || e.message;
    }

    if (commitError.includes('nothing to commit')) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ committed: false, error: 'Nothing to commit. Stage changes with git add first.' }) }] };
    }
    if (commitError) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ committed: false, error: `Commit failed: ${commitError}` }) }] };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          committed: true,
          hash: commitHash,
          message: commitMsg,
          type: commitType,
          files: changedFiles,
          amend,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'pr',
  `Create a GitHub pull request from the current branch. Reads recent commit messages
to build the PR body. Supports assigning reviewers, linking issues, and setting labels.
Uses the gh CLI — requires GitHub CLI to be installed and authenticated.`,
  {
    title: z.string().optional().describe('PR title. Auto-generated from commits if not provided.'),
    body: z.string().optional().describe('PR body/description. Auto-generated from commits if not provided.'),
    base: z.string().optional().describe('Base branch to merge into (default: detected from remote tracking branch or "main").'),
    reviewers: cArr(z.string()).optional().describe('GitHub usernames or team slugs to request as reviewers.'),
    labels: cArr(z.string()).optional().describe('Labels to apply to the PR.'),
    issue: z.string().optional().describe('Issue number to link (e.g. "closes #123").'),
    draft: cBool().optional().describe('Create as a draft PR (default: false).'),
    repo: z.string().optional().describe('Repository in "owner/repo" format. Detected from git remote if not provided.'),
  },
  async ({ title, body, base, reviewers, labels, issue, draft, repo }) => {
    ensureSession();

    // Get current branch
    let branch = '';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', cwd: room }).trim();
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ created: false, error: `Not a git repo: ${e.message}` }) }] };
    }
    if (branch === 'HEAD') {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ created: false, error: 'Detached HEAD — cannot create PR from a commit directly.' }) }] };
    }

    // Detect repo
    let repoSlug = repo;
    if (!repoSlug) {
      try {
        const remote = execSync('git remote get-url origin 2>/dev/null || git remote get-url upstream 2>/dev/null', { encoding: 'utf-8', cwd: room }).trim();
        const match = remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
        if (match) repoSlug = match[1];
      } catch { /* ignore */ }
    }
    if (!repoSlug) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ created: false, error: 'Could not detect repo. Provide --repo in "owner/repo" format.' }) }] };
    }

    // Get base branch
    let baseBranch = base;
    if (!baseBranch) {
      try {
        baseBranch = execSync('git rev-parse --abbrev-ref origin/HEAD 2>/dev/null', { encoding: 'utf-8', cwd: room }).trim().replace('origin/', '');
      } catch {
        baseBranch = 'main';
      }
    }

    // Auto-generate title from commits if not provided
    let prTitle = title;
    if (!prTitle) {
      try {
        const commits = execSync(`git log ${branch} ^${baseBranch} --oneline -10`, { encoding: 'utf-8', cwd: room });
        const lines = commits.trim().split('\n').filter(l => l);
        if (lines.length > 0) {
          // Strip the hash prefix to get the message
          const lastCommit = lines[lines.length - 1].replace(/^[a-f0-9]+\s+/, '');
          prTitle = lastCommit;
        }
      } catch { /* use branch name as fallback */ }
      if (!prTitle) prTitle = branch.replace(/[_-]/g, ' ');
    }

    // Auto-generate body from commit messages
    let prBody = body;
    if (!prBody) {
      try {
        const commits = execSync(`git log ${branch} ^${baseBranch} --oneline -20`, { encoding: 'utf-8', cwd: room });
        const lines = commits.trim().split('\n').map(l => l.replace(/^[a-f0-9]+\s+/, '').trim());
        if (lines.length > 0) {
          const changelog = lines.map(l => `- ${l}`).join('\n');
          prBody = `## Summary\n\n${changelog}\n\n## Changes\n\n<!-- Add description of changes here -->\n`;
        }
      } catch { /* empty body */ }
    }

    // Build gh pr create command
    const titleArg = `gh pr create -R ${sh(repoSlug)} --title ${sh(prTitle)} --base ${sh(baseBranch)}`;
    const bodyArg = prBody ? ` --body ${sh(prBody)}` : '';
    const reviewerArg = reviewers && reviewers.length > 0
      ? reviewers.map(r => ` --reviewer ${sh(r)}`).join('')
      : '';
    const labelArg = labels && labels.length > 0
      ? labels.map(l => ` --label ${sh(l)}`).join('')
      : '';
    const draftArg = draft ? ' --draft' : '';
    const issueArg = issue ? ` --assignee @me --link ${sh(issue.startsWith('#') ? issue : `#${issue}`)}` : '';

    const ghCmd = `${titleArg}${bodyArg}${reviewerArg}${labelArg}${draftArg}${issueArg}`;

    let prUrl = '';
    let prNumber = '';
    let prError = '';
    try {
      const out = execSync(ghCmd, { encoding: 'utf-8', cwd: room, maxBuffer: 10 * 1024 * 1024 });
      // gh outputs the PR URL
      const urlMatch = out.match(/https:\/\/github\.com\/[^\s]+/);
      if (urlMatch) prUrl = urlMatch[0];
      const numMatch = out.match(/#(\d+)/);
      if (numMatch) prNumber = numMatch[1];
      // If gh returned nothing useful, try to fetch the PR
      if (!prUrl) {
        const listOut = execSync(`gh pr list -R ${sh(repoSlug)} --head ${sh(branch)} --json number,url --jq '.[0]'`, { encoding: 'utf-8', cwd: room });
        const prInfo = JSON.parse(listOut);
        if (prInfo) { prUrl = prInfo.url; prNumber = String(prInfo.number); }
      }
    } catch (e: any) {
      prError = e.stderr || e.message;
    }

    if (prError && !prUrl) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ created: false, error: `gh PR create failed: ${prError}` }) }] };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          created: true,
          url: prUrl,
          number: prNumber,
          title: prTitle,
          base: baseBranch,
          head: branch,
          repo: repoSlug,
          reviewers: reviewers || [],
          labels: labels || [],
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'clean_branches',
  `Prune local branches whose upstream is gone (merged/dead branches), and clean up
unused git worktrees. Requires no arguments — safely identifies stale branches
and reports what would be deleted before acting.`,
  {
    dry_run: cBool().optional().describe('Show what would be deleted without actually deleting (default: true)'),
    delete_worktrees: cBool().optional().describe('Also clean up stale git worktrees (default: false)'),
    force: cBool().optional().describe('Use -D instead of -d for branch deletion (default: false)'),
  },
  async ({ dry_run: isDryRun, delete_worktrees, force }) => {
    ensureSession();
    const dryRun = isDryRun !== false; // default true
    const prefix = dryRun ? '[DRY RUN] Would delete' : 'Deleted';

    const results: string[] = [];
    const errors: string[] = [];

    // 1. Prune remote references
    try {
      execSync('git fetch --prune', { stdio: 'pipe', cwd: room });
      results.push('Pruned remote references');
    } catch (e: any) {
      errors.push(`git fetch --prune: ${e.message}`);
    }

    // 2. Find gone branches
    let goneBranches: string[] = [];
    try {
      const out = execSync('git branch -vv', { encoding: 'utf-8', cwd: room });
      goneBranches = out
        .split('\n')
        .filter(line => line.includes(': gone]'))
        .map(line => line.trim().replace(/^\*\s+/, '').split(/\s+/)[0])
        .filter(b => b && b !== 'HEAD');
      // Filter out current branch
      const current = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', cwd: room }).trim();
      goneBranches = goneBranches.filter(b => b !== current);
    } catch (e: any) {
      errors.push(`git branch -vv: ${e.message}`);
    }

    const deletedBranches: string[] = [];
    const skippedBranches: string[] = [];

    if (goneBranches.length > 0) {
      for (const branch of goneBranches) {
        try {
          const delFlag = force ? '-D' : '-d';
          execSync(`git branch ${delFlag} ${branch}`, { stdio: 'pipe', cwd: room });
          deletedBranches.push(branch);
        } catch (e: any) {
          skippedBranches.push(`${branch} (${e.message})`);
        }
      }
    }

    // 3. Clean worktrees
    const deletedWorktrees: string[] = [];
    if (delete_worktrees) {
      try {
        const worktreeList = execSync('git worktree list --porcelain', { encoding: 'utf-8', cwd: room });
        const lines = worktreeList.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]?.startsWith('worktree ')) {
            const path = lines[i].replace('worktree ', '').replace(/^./, '').replace(/.$/, '');
            // Check if it's stale (path no longer exists)
            try {
              execSync(`test -d ${sh(path)}`, { stdio: 'pipe', cwd: room });
            } catch {
              // Directory doesn't exist — prune it
              if (!dryRun) {
                try {
                  execSync(`git worktree remove ${sh(path)}`, { stdio: 'pipe', cwd: room });
                  deletedWorktrees.push(path);
                } catch { /* skip */ }
              } else {
                deletedWorktrees.push(path);
              }
            }
          }
        }
      } catch { /* git worktree list may fail if none exist */ }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          mode: dryRun ? 'dry-run' : 'live',
          pruned_remote: results.includes('Pruned remote references'),
          gone_branches_found: goneBranches.length,
          deleted_branches: deletedBranches,
          skipped_branches: skippedBranches,
          deleted_worktrees: deletedWorktrees,
          errors: errors.length > 0 ? errors : undefined,
          summary: [
            results.join(', '),
            deletedBranches.length > 0 ? `${prefix} branches: ${deletedBranches.join(', ')}` : 'No gone branches found',
            deletedWorktrees.length > 0 ? `${prefix} worktrees: ${deletedWorktrees.join(', ')}` : '',
          ].filter(Boolean).join('\n'),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════
//  Security Scan Tool
// ═══════════════════════════════════════

// Security patterns to scan for, organized by severity and category
const SECURITY_PATTERNS = [
  // Critical — credentials and secrets
  { pattern: /(?<!['"`]\w*)[A-Za-z0-9+/]{20,}={0,2}(?!['"`]\w*)/, category: 'generic_secret', severity: 'critical', msg: 'Potential base64-encoded secret detected' },
  { pattern: /(?<![a-zA-Z0-9])(?:ghp_|gho_|github_pat_)[a-zA-Z0-9_]{36,}/, category: 'github_token', severity: 'critical', msg: 'GitHub personal access token hardcoded' },
  { pattern: /(?<![a-zA-Z0-9])(?:sk-[a-zA-Z0-9]{20,})(?![a-zA-Z0-9])/, category: 'openai_key', severity: 'critical', msg: 'OpenAI API key hardcoded' },
  { pattern: /(?<![a-zA-Z0-9])(?:xox[baprs]-[a-zA-Z0-9]{10,})(?![a-zA-Z0-9])/, category: 'slack_token', severity: 'critical', msg: 'Slack token hardcoded' },
  { pattern: /(?<![a-zA-Z0-9])(?:aws_access_key|aws_secret)[_a-zA-Z0-9]*\s*[=:]\s*['"]?[A-Z0-9]{20,}/i, category: 'aws_credential', severity: 'critical', msg: 'AWS credential hardcoded' },
  { pattern: /(?<![a-zA-Z0-9])(?:password|passwd|pwd|secret)\s*[=:]\s*['"][^'"]{8,}['"](?![a-zA-Z0-9]*['"])/i, category: 'hardcoded_password', severity: 'critical', msg: 'Hardcoded password detected' },
  // High — code injection and eval
  { pattern: /\beval\s*\(\s*(?:req|request|body|input|params|query|headers)/i, category: 'eval_injection', severity: 'high', msg: 'eval() with user-controlled input' },
  { pattern: /\bexec\s*\(\s*(?:req|request|body|input|params|query|headers)/i, category: 'exec_injection', severity: 'high', msg: 'exec() with user-controlled input' },
  { pattern: /\b__import__\s*\(\s*(?:req|request|body|input|params|query|headers)/i, category: 'import_injection', severity: 'high', msg: 'Dynamic import with user-controlled input' },
  { pattern: /\bpickle\.(load|loads)\s*\(/i, category: 'pickle_deserialize', severity: 'high', msg: 'pickle deserialization of untrusted data' },
  { pattern: /\.innerHTML\s*=/, category: 'xss_innerHTML', severity: 'high', msg: 'Direct innerHTML assignment — XSS risk' },
  { pattern: /document\.write\s*\(/, category: 'xss_docwrite', severity: 'high', msg: 'document.write() — XSS risk' },
  // Medium — injection and path traversal
  { pattern: /\brenderText\s*\([^)]*(?:req|request|body|input|params|query)/i, category: 'template_injection', severity: 'medium', msg: 'Template rendering with user input' },
  { pattern: /\bsystem\s*\([^)]*(?:req|request|body|input|params|query|cmd)/i, category: 'shell_injection', severity: 'medium', msg: 'shell command with user input' },
  { pattern: /(?<![a-zA-Z0-9])(?:cat|grep|sed|awk|find)\s+.*\$\{.*\}/, category: 'shell_injection', severity: 'medium', msg: 'Shell command with unquoted variable expansion' },
  // GitHub Actions specific
  { pattern: /\${{\s*github\.event\.issue\.title\s*}}/, category: 'gha_injection', severity: 'high', msg: 'GHA: Untrusted issue title in command — injection risk' },
  { pattern: /\${{\s*github\.event\.comment\.body\s*}}/, category: 'gha_injection', severity: 'high', msg: 'GHA: Untrusted comment body in command — injection risk' },
  { pattern: /\${{\s*github\.event\.pull_request\.title\s*}}/, category: 'gha_injection', severity: 'high', msg: 'GHA: Untrusted PR title in command — injection risk' },
  { pattern: /run:\s*\|?\s*\n.*\$\{\{/, category: 'gha_run_injection', severity: 'high', msg: 'GHA: User input in run: block — use env or GITHUB_ENV instead' },
  // SQL injection
  { pattern: /(?:mysql|postgres|sqlite|pg|createQuery|execute)\s*\([^)]*\+[^)]*(?:req|request|body|input|params|query)/i, category: 'sql_injection', severity: 'high', msg: 'SQL query with string concatenation — injection risk' },
  // Path traversal
  { pattern: /(?:readFile|readFileSync|open|readdir)\s*\([^)]*(?:req|request|body|input|params|query).*\+\s*['"]\.\.[\/\\]/i, category: 'path_traversal', severity: 'high', msg: 'File operation with user input that includes path traversal (../)' },
  // Crypto
  { pattern: /crypto\.createCipher\s*\(/, category: 'weak_crypto', severity: 'medium', msg: 'createCipher is deprecated — use createCipheriv instead' },
  { pattern: /md5|sha1\s*(?!_sum)/i, category: 'weak_hash', severity: 'medium', msg: 'MD5/SHA1 used for security — consider SHA-256 or stronger' },
];

server.tool(
  'security_scan',
  `Scan modified files for common security vulnerabilities. Checks for: hardcoded credentials,
API keys, GitHub tokens, eval/exec injection, pickle deserialization, XSS via innerHTML,
GitHub Actions injection vectors (\${'{{{'} github.event.* }} without sanitization), SQL injection,
path traversal, weak crypto, and shell injection.

Results include severity, file path, line number, and a remediation suggestion.
Use the notify parameter to DM agents responsible for files with findings.`,
  {
    files: cArr(z.string()).optional().describe('Specific files to scan. Scans all staged/modified files if not provided.'),
    severity: z.enum(['critical', 'high', 'medium', 'all']).optional().describe('Minimum severity to report (default: high).'),
    notify: cBool().optional().describe('DM agents responsible for files with findings (default: true).'),
    dry_run: cBool().optional().describe('Show what would be scanned without scanning (default: false).'),
  },
  async ({ files, severity: minSeverity, notify: shouldNotify, dry_run: isDryRun }) => {
    ensureSession();
    const sid = ensureSession();

    // Get files to scan
    let targetFiles = files;
    if (!targetFiles) {
      try {
        // Get both staged and unstaged modified files
        const staged = execSync('git diff --cached --name-only', { encoding: 'utf-8', cwd: room }).trim();
        const unstaged = execSync('git diff --name-only', { encoding: 'utf-8', cwd: room }).trim();
        const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf-8', cwd: room }).trim();
        const all = [staged, unstaged, untracked].flatMap(s => s.split('\n')).filter(f => f && !f.includes('node_modules') && !f.includes('.git'));
        targetFiles = [...new Set(all)];
      } catch { /* ignore */ }
    }

    if (!targetFiles || targetFiles.length === 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ scanned: 0, findings: [], message: 'No files to scan.' }) }] };
    }

    const results: Array<{
      file: string;
      line: number;
      severity: string;
      category: string;
      message: string;
      line_content: string;
      agent?: string;
    }> = [];

    const SEVERITY_ORDER = ['critical', 'high', 'medium'];
    const minSev = minSeverity === 'all' ? 'medium' : (minSeverity || 'high');
    const minSevIdx = SEVERITY_ORDER.indexOf(minSev);

    for (const filePath of targetFiles) {
      if (isDryRun) {
        results.push({ file: filePath, line: 0, severity: 'info', category: 'scan', message: 'Would scan this file', line_content: '' });
        continue;
      }

      // Only scan source code and config files
      const SKIP_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.wav', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib', '.lock'];
      if (SKIP_EXTENSIONS.some(ext => filePath.endsWith(ext))) continue;

      let content = '';
      try {
        content = execSync(`cat ${sh(filePath)}`, { encoding: 'utf-8', cwd: room, maxBuffer: 5 * 1024 * 1024 });
      } catch { continue; }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { pattern, category, severity, msg } of SECURITY_PATTERNS) {
          if (pattern.test(line)) {
            const sevIdx = SEVERITY_ORDER.indexOf(severity);
            if (sevIdx >= minSevIdx) {
              // Look up who claimed this file
              const claims = db.getClaims(room);
              const claim = claims.find(c => c.resource === filePath || filePath.startsWith(c.resource));
              results.push({
                file: filePath,
                line: i + 1,
                severity,
                category,
                message: msg,
                line_content: line.trim().substring(0, 200),
                agent: claim?.owner_name,
              });
            }
          }
        }
      }
    }

    // Send DMs to responsible agents
    if (shouldNotify !== false && !isDryRun && results.length > 0) {
      const byAgent = new Map<string, typeof results>();
      for (const r of results) {
        if (r.agent) {
          const list = byAgent.get(r.agent) || [];
          list.push(r);
          byAgent.set(r.agent, list);
        }
      }
      for (const [agent, findings] of byAgent) {
        const summary = findings.map(f => `[${f.severity.toUpperCase()}] ${f.file}:${f.line} — ${f.message}`).join('\n');
        db.sendDM(sid, sessionName, agent, `Security findings in files you modified:\n\n${summary}`);
      }
    }

    const criticalCount = results.filter(r => r.severity === 'critical').length;
    const highCount = results.filter(r => r.severity === 'high').length;
    const mediumCount = results.filter(r => r.severity === 'medium').length;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          scanned: isDryRun ? targetFiles.length : targetFiles.length,
          findings: results.filter(r => r.severity !== 'info'),
          breakdown: { critical: criticalCount, high: highCount, medium: mediumCount },
          agents_notified: shouldNotify !== false ? [...new Set(results.filter(r => r.agent).map(r => r.agent!))] : [],
          summary: results.length === 0
            ? `Clean: 0 security issues in ${targetFiles.length} files.`
            : `Found ${results.length} issues: ${criticalCount} critical, ${highCount} high, ${mediumCount} medium across ${targetFiles.length} files.`,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════
//  Feature Dev — structured multi-phase workflow
// ═══════════════════════════════════════

server.tool(
  'feature_dev',
  `Kick off a structured multi-phase feature development workflow using existing brain primitives.
Sets up a task DAG, spawns agents for parallel work, runs the integration gate between phases,
and repeats until the feature is complete. One call replaces the manual: plan → spawn → monitor → gate loop.

Phases:
  foundation  — types, schemas, interfaces (parallel)
  implementation — core logic (parallel)
  integration  — wiring modules together (sequential, gate runs after)
  testing     — unit + integration tests (parallel)
  quality     — lint, type-check, security scan (sequential gate)

Each phase waits for the previous gate to pass before proceeding. On gate failure,
agents are DM'd their specific errors and given time to fix before retry.`,
  {
    task: z.string().describe('The feature to build — be specific about what the feature does.'),
    agents: cArr(z.string()).optional().describe('Named agent responsibilities, e.g. ["types", "api", "ui", "tests"]. Defaults to ["foundation", "impl", "tests"] if not provided.'),
    layout: z.enum(['horizontal', 'tiled', 'headless']).optional().describe('Layout for spawned agents (default: headless).'),
    model: z.string().optional().describe('Model for spawned agents. Supports per-agent overrides via agent name, e.g. "types:haiku, tests:sonnet".'),
    skip_phases: cArr(z.string()).optional().describe('Phases to skip: "foundation", "implementation", "integration", "testing", "quality".'),
    max_gate_retries: cNum().optional().describe('Max gate attempts per phase before giving up (default: 3).'),
  },
  async ({ task, agents: agentNames, layout, model, skip_phases, max_gate_retries }) => {
    const sid = ensureSession();
    startLeadWatchdog(sid);
    const phaseTimeout = max_gate_retries || 3;
    const spawnLayout = layout || 'headless';
    const isHeadless = spawnLayout === 'headless';

    // Resolve agents
    const agentList = agentNames && agentNames.length > 0
      ? agentNames
      : ['foundation', 'impl', 'tests'];

    // Parse per-agent model overrides (e.g. "foundation:haiku,impl:sonnet")
    const modelOverrides = new Map<string, string | undefined>();
    if (model) {
      if (model.includes(',')) {
        for (const part of model.split(',')) {
          const [name, m] = part.split(':').map(s => s.trim());
          modelOverrides.set(name, m);
        }
      } else {
        // Same model for all
        for (const a of agentList) modelOverrides.set(a, model);
      }
    }

    const skipped = new Set(skip_phases || []);

    // ── Phase 1: Foundation (types, schemas, interfaces) ──
    if (!skipped.has('foundation')) {
      db.postMessage('general', room, sid, sessionName, `[brain_feature_dev] Starting FOUNDATION phase...`);
      db.postMessage('tasks', room, sid, sessionName, `FOUNDATION PHASE: Define all types, schemas, interfaces, and contracts for: ${task}`);

      const foundationAgents: Array<{ name: string; task: string; files: string[] }> = [];
      const typesAgent = `${agentList[0] || 'types'}`;
      foundationAgents.push({
        name: typesAgent,
        task: `Define all TypeScript/Python types, interfaces, and Zod schemas for this feature: ${task}\n\nCreate files in src/types/ or equivalent. Publish contracts with brain_contract_set after each file.`,
        files: ['src/types/', 'src/schemas/', 'src/models/'],
      });

      for (const ag of foundationAgents) {
        const resolvedModel = modelOverrides.get(ag.name);
        db.registerSession(ag.name, room, JSON.stringify({ phase: 'foundation', task }), randomUUID());
        // We don't actually spawn here — just set up the plan and let the lead spawn
        db.setState(`feature_dev:${ag.name}:task`, room, ag.task, sid, sessionName);
        db.setState(`feature_dev:${ag.name}:model`, room, resolvedModel || model || '', sid, sessionName);
      }

      db.setState('feature_dev:phase', room, 'foundation', sid, sessionName);
      db.setState('feature_dev:task', room, task, sid, sessionName);
    }

    // ── Build the full plan in brain ──
    const planTasks: Array<{ name: string; description: string; depends_on?: string[] }> = [];

    if (!skipped.has('foundation')) {
      planTasks.push({ name: 'foundation', description: 'Define types, schemas, and interfaces' });
    }
    if (!skipped.has('implementation')) {
      planTasks.push({
        name: 'implementation',
        description: `Implement the feature: ${task}`,
        depends_on: skipped.has('foundation') ? undefined : ['foundation'],
      });
    }
    if (!skipped.has('integration')) {
      planTasks.push({
        name: 'integration',
        description: 'Wire modules together, verify contracts',
        depends_on: skipped.has('implementation') ? (skipped.has('foundation') ? undefined : ['foundation']) : ['implementation'],
      });
    }
    if (!skipped.has('testing')) {
      planTasks.push({
        name: 'testing',
        description: 'Write unit and integration tests',
        depends_on: skipped.has('integration') ? (skipped.has('implementation') ? (skipped.has('foundation') ? undefined : ['foundation']) : ['implementation']) : ['integration'],
      });
    }
    if (!skipped.has('quality')) {
      planTasks.push({
        name: 'quality',
        description: 'Run lint, type-check, and security scan',
        depends_on: skipped.has('testing') ? (skipped.has('integration') ? (skipped.has('implementation') ? (skipped.has('foundation') ? undefined : ['foundation']) : ['implementation']) : ['integration']) : ['testing'],
      });
    }

    const plan = db.createPlan(room, planTasks);

    // Store plan info
    db.setState('feature_dev:plan_id', room, plan.plan_id, sid, sessionName);
    db.setState('feature_dev:layout', room, spawnLayout, sid, sessionName);
    db.setState('feature_dev:gate_retries', room, String(phaseTimeout), sid, sessionName);

    // Store per-agent config for spawning
    for (const agName of agentList) {
      const resolvedModel = modelOverrides.get(agName);
      if (resolvedModel) {
        db.setState(`feature_dev:model:${agName}`, room, resolvedModel, sid, sessionName);
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          plan_id: plan.plan_id,
          phases: planTasks.map(t => t.name),
          skipped_phases: [...skipped],
          layout: spawnLayout,
          gate_retries: phaseTimeout,
          agents: agentList,
          models: Object.fromEntries(modelOverrides),
          message: `Feature dev plan created: ${planTasks.map(t => t.name).join(' → ')}.
Run brain_plan_next to get the first ready tasks, then brain_wake for each agent.
Use gate between phases, auto_gate for continuous quality checks.
Monitor with agents and plan_status.`,
          instructions: {
            step_1: 'plan_next — get the first ready tasks (foundation)',
            step_2: 'wake for each agent with the task from get feature_dev:<agent>:task',
            step_3: 'gate after each phase to verify integration',
            step_4: 'auto_gate --max_retries 3 for the quality phase',
          },
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════
//  Start Server
// ═══════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start HTTP server if BRAIN_HTTP_PORT is set (runs alongside stdio)
  const httpPort = process.env.BRAIN_HTTP_PORT ? parseInt(process.env.BRAIN_HTTP_PORT, 10) : null;
  if (httpPort) {
    const { startHttpServer } = await import('./http.js');
    const httpHost = process.env.BRAIN_HTTP_HOST || '127.0.0.1';
    await startHttpServer(db, room, httpPort, httpHost);
  }
}

main().catch((err) => {
  console.error('Brain MCP server failed to start:', err);
  process.exit(1);
});
