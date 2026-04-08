import { z } from 'zod';
import { randomUUID } from 'node:crypto';
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
const cArr = <T extends z.ZodTypeAny>(item: T) => z.preprocess(
  (v) => {
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

export interface FeatureDevToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  sessionName: string;
  startLeadWatchdog: (sid: string) => void;
}

export function registerFeatureDevTools(
  server: { tool: (name: string, description: string, schema: any, handler: (params: any) => Promise<any>) => void },
  options: FeatureDevToolsOptions,
) {
  const { db, room, ensureSession, sessionName, startLeadWatchdog } = options;

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
            const [name, m] = part.split(':').map((s: string) => s.trim());
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
            message: `Feature dev plan created: ${planTasks.map(t => t.name).join(' → ')}.\nRun brain_plan_next to get the first ready tasks, then brain_wake for each agent.\nUse gate between phases, auto_gate for continuous quality checks.\nMonitor with agents and plan_status.`,
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
}
