import { z } from 'zod';
import type { BrainDB } from '../db.js';

// ── Schema helpers ──
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

export interface MetricsToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  compactMode: boolean;
  setCompactMode: (value: boolean) => void;
  reply: (data: any, compactData?: any, rendererName?: string) => { content: [{ type: 'text'; text: string }] };
}

export function registerMetricsTools(
  server: { tool: (name: string, description: string, schema: any, handler: (params: any) => Promise<any>) => void },
  options: MetricsToolsOptions,
) {
  const { db, room, ensureSession, reply } = options;
  let { compactMode } = options;
  const setCompactMode = (v: boolean) => {
    compactMode = v;
    options.setCompactMode(v);
  };

  // ── compact ──

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
      const newMode = enabled !== undefined ? enabled : !compactMode;
      setCompactMode(newMode);
      return reply({ compact: newMode }, { c: newMode ? 1 : 0 });
    }
  );

  // ── brain_metrics ──

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

  // ── brain_metric_record ──

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

  // ── metrics ──

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

  // ── metric_record ──

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
}
