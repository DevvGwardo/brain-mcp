/**
 * Task DAG Planning Tools
 * - plan: Create a task execution plan with dependencies
 * - plan_next: Get next tasks ready to work on
 * - plan_update: Update a task status in the plan
 * - plan_status: View full plan status
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainDB } from '../db.js';

interface PlanToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  getSessionId: () => string | null;
  getSessionName: () => string;
}

export function registerPlanTools(
  server: McpServer,
  options: PlanToolsOptions,
) {
  const { db, room, ensureSession } = options;

  // Schema coercion helpers
  const cArr = <T extends z.ZodTypeAny>(item: T) => z.preprocess(
    (v: unknown) => {
      if (typeof v !== 'string') return v;
      try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : v;
      } catch {
        return v;
      }
    },
    z.array(item),
  );

  // ── plan ──────────────────────────────────────────────────────────────────
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

  // ── plan_next ─────────────────────────────────────────────────────────────
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

  // ── plan_update ───────────────────────────────────────────────────────────
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

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, task_id, status, result: result || null }),
        }],
      };
    }
  );

  // ── plan_status ───────────────────────────────────────────────────────────
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
}
