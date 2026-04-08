import { z } from 'zod';
import { join, resolve } from 'node:path';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { TaskRouter } from '../router.js';
import { compileWorkflow } from '../workflow.js';
import type { BrainDB } from '../db.js';

const THINGKING_LEVEL_SCHEMA = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional().describe('Reasoning/thinking level for pi-core agents. Default: medium.');

// ── Conductor health monitor ──
// Tracks active conductor PIDs and polls for liveness.
const conductorMonitors = new Map<string, ReturnType<typeof setInterval>>();

function startConductorHealthMonitor(
  db: BrainDB,
  room: string,
  planId: string,
  pid: number,
  sid: string,
  sessionName: string,
) {
  // Clear any existing monitor for this plan
  stopConductorHealthMonitor(planId);

  const interval = setInterval(() => {
    try {
      // Check if PID is still alive (signal 0 = no-op check)
      process.kill(pid, 0);
    } catch {
      // Process is dead — update run state
      clearInterval(interval);
      conductorMonitors.delete(planId);

      const runStateKey = `workflow:${planId}:run`;
      const existing = db.getState(runStateKey, room);
      if (existing) {
        try {
          const state = JSON.parse(existing.value);
          state.crashed_at = new Date().toISOString();
          state.status = 'crashed';
          db.setState(runStateKey, room, JSON.stringify(state), sid, sessionName);
        } catch { /* best effort */ }
      }

      db.postMessage('alerts', room, sid, sessionName,
        `Workflow conductor (plan ${planId}) crashed — PID ${pid} no longer exists. Check log at stored path.`);
    }
  }, 10_000); // Poll every 10s

  conductorMonitors.set(planId, interval);
}

function stopConductorHealthMonitor(planId: string) {
  const existing = conductorMonitors.get(planId);
  if (existing) {
    clearInterval(existing);
    conductorMonitors.delete(planId);
  }
}

/** Kill a running conductor by plan ID. Returns true if found and killed. */
function killConductorByPlan(db: BrainDB, room: string, planId: string, sid: string, sessionName: string): { ok: boolean; error?: string } {
  const runStateKey = `workflow:${planId}:run`;
  const existing = db.getState(runStateKey, room);
  if (!existing) {
    return { ok: false, error: `No running workflow found for plan ${planId}` };
  }

  let state: any;
  try {
    state = JSON.parse(existing.value);
  } catch {
    return { ok: false, error: `Corrupt run state for plan ${planId}` };
  }

  if (state.status === 'stopped' || state.status === 'crashed' || state.status === 'completed') {
    return { ok: false, error: `Workflow ${planId} already ${state.status}` };
  }

  // Kill the conductor PID
  if (state.pid) {
    try {
      process.kill(state.pid, 'SIGTERM');
      // Give it a moment, then force kill if needed
      setTimeout(() => {
        try { process.kill(state.pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 3000);
    } catch (err: any) {
      if (err.code !== 'ESRCH') {
        return { ok: false, error: `Failed to kill PID ${state.pid}: ${err.message}` };
      }
      // ESRCH = process already dead
    }
  }

  // Stop the health monitor
  stopConductorHealthMonitor(planId);

  // Update run state
  state.stopped_at = new Date().toISOString();
  state.status = 'stopped';
  db.setState(runStateKey, room, JSON.stringify(state), sid, sessionName);

  // Mark all active agent sessions as failed
  const agents = db.getAgentHealth(room);
  for (const agent of agents) {
    if (agent.status === 'working' || agent.status === 'queued') {
      try {
        db.pulse(agent.id, 'failed', `Workflow ${planId} stopped by user`);
        db.set_exit_code(agent.id, 143); // SIGTERM exit code
      } catch { /* best effort */ }
    }
  }

  return { ok: true };
}

import { cNum, cBool, cArr } from './schema-helpers.js';

export interface WorkflowToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  sessionName: string;
  startLeadWatchdog: (sid: string) => void;
  prepareAgentWorkspace: (baseCwd: string, agentName: string, isolation: 'shared' | 'snapshot') => string;
  sh: (value: string) => string;
}

export function registerWorkflowTools(
  server: { tool: (name: string, description: string, schema: any, handler: (params: any) => Promise<any>) => void },
  options: WorkflowToolsOptions,
) {
  const { db, room, ensureSession, sessionName, startLeadWatchdog, prepareAgentWorkspace, sh } = options;

function compileWorkflowForRoom(
    goal: string,
    opts: {
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
      mode: opts.mode,
      max_agents: opts.max_agents,
      focus_files: opts.focus_files,
      recommendModel: opts.auto_route_models === false
        ? undefined
        : (task: string, role: string) => {
          const rec = router.routeTask(task, { available_models: opts.available_models });
          return {
            model: rec.model,
            confidence: rec.confidence,
            reasoning: `[${role}] ${rec.reasoning}`,
          };
        },
      thinkingLevel: opts.thinking_level,
    });
  }

  function persistCompiledWorkflow(
    sid: string,
    compiled: ReturnType<typeof compileWorkflowForRoom>,
    configPath?: string,
  ) {
    const plan = db.createPlan(
      room,
      compiled.tasks.map((task: any) => ({
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

  // ── workflow_compile ──

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
      thinking_level: THINGKING_LEVEL_SCHEMA,
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

  // ── workflow_apply ──

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
      thinking_level: THINGKING_LEVEL_SCHEMA,
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
            phases: compiled.phases.map((phase: any) => ({
              name: phase.name,
              parallel: phase.parallel,
              agents: phase.agents.map((agent: any) => ({
                name: agent.name,
                role: agent.role,
                model: agent.model,
              })),
            })),
            ready_tasks: persisted.ready_tasks.map((task: any) => ({
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

  // ── workflow_run ──

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
      thinking_level: THINGKING_LEVEL_SCHEMA,
      available_models: cArr(z.string()).optional().describe('Optional list of models available for auto-routing.'),
      focus_files: cArr(z.string()).optional().describe('Optional file or directory hints to bias scope assignment.'),
      auto_route_models: cBool().optional().describe('Suggest per-agent models using historical metrics when available (default: true).'),
      isolation: z.enum(['shared', 'snapshot']).optional().describe('Use the shared workspace or generate isolated snapshot workspaces per agent (default: shared).'),
      config_path: z.string().optional().describe('Optional JSON file path to write the generated conductor config. Relative paths are resolved from the current room.'),
      log_path: z.string().optional().describe('Optional log file path for the launched conductor. Relative paths are resolved from the current room.'),
      workflow_timeout: cNum().optional().describe('Global workflow timeout in seconds. If the conductor runs longer than this, it is killed. Default: no limit (relies on per-agent timeouts).'),
    },
    async ({ goal, max_agents, mode, thinking_level, available_models, focus_files, auto_route_models, isolation, config_path, log_path, workflow_timeout }) => {
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
        compiled.conductor_config.phases = compiled.conductor_config.phases.map((phase: any) => ({
          ...phase,
          agents: phase.agents.map((agent: any) => ({
            ...agent,
            workspace: prepareAgentWorkspace(room, agent.name, 'snapshot'),
          })),
        }));
      }

      // Apply global workflow timeout to conductor config if provided
      if (workflow_timeout && workflow_timeout > 0) {
        compiled.conductor_config.timeout = workflow_timeout;
      }

      const defaultConfigPath = join(tmpdir(), `brain-workflow-${Date.now()}.json`);
      const persisted = persistCompiledWorkflow(sid, compiled, config_path || defaultConfigPath);
      const configFile = persisted.config_path || resolve(room, config_path || defaultConfigPath);
      const conductorPath = new URL('../conductor.js', import.meta.url).pathname;
      const logFile = resolve(room, log_path || join(tmpdir(), `brain-workflow-${persisted.plan_id}.log`));
      const logFd = openSync(logFile, 'a');

      // Build env with optional global timeout
      const conductorEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        BRAIN_DB_PATH: process.env.BRAIN_DB_PATH || '',
        BRAIN_ROOM: room,
      };
      if (workflow_timeout && workflow_timeout > 0) {
        conductorEnv.BRAIN_WORKFLOW_TIMEOUT = String(workflow_timeout);
      }

      const child = spawn('node', [conductorPath, '--config', configFile], {
        cwd: room,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: conductorEnv,
      });
      closeSync(logFd);
      child.unref();

      // Start conductor health monitoring
      if (child.pid) {
        startConductorHealthMonitor(db, room, persisted.plan_id, child.pid, sid, sessionName);
      }

      const runState = {
        plan_id: persisted.plan_id,
        pid: child.pid,
        config_path: configFile,
        log_path: logFile,
        started_at: new Date().toISOString(),
        mode: compiled.conductor_config.mode,
        isolation: isolationMode,
        workflow_timeout: workflow_timeout || null,
        status: 'running',
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
            workflow_timeout: workflow_timeout || null,
            health_monitor: child.pid ? 'active (polling every 10s)' : 'unavailable (no PID)',
            ready_tasks: persisted.ready_tasks.map((task: any) => ({
              id: task.id,
              name: task.name,
              agent_name: task.agent_name,
            })),
            next_steps: [
              'Use brain_agents to monitor live agent status',
              `Use brain_plan_status with plan_id=${persisted.plan_id} to inspect task progress`,
              `Use brain_workflow_stop with plan_id=${persisted.plan_id} to cancel`,
              `Inspect the conductor log at ${logFile} if execution stalls`,
            ],
          }, null, 2),
        }],
      };
    }
  );

  // ── workflow_stop ──

  server.tool(
    'workflow_stop',
    `Stop a running workflow conductor and mark all its active agents as failed.
Use this to cancel a workflow that is stuck, taking too long, or no longer needed.
The conductor process is sent SIGTERM (then SIGKILL after 3s), the health monitor is stopped,
and all working/queued agents are marked failed.`,
    {
      plan_id: z.string().describe('Plan ID of the workflow to stop (from workflow_run response)'),
    },
    async ({ plan_id }) => {
      const sid = ensureSession();
      const result = killConductorByPlan(db, room, plan_id, sid, sessionName);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: result.ok,
            plan_id,
            error: result.error,
            message: result.ok
              ? `Workflow ${plan_id} stopped. Conductor killed, health monitor stopped, active agents marked failed.`
              : `Failed to stop workflow ${plan_id}: ${result.error}`,
          }, null, 2),
        }],
        isError: !result.ok,
      };
    }
  );
}
