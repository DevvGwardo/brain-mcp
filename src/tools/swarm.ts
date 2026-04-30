/**
 * Swarm & Agent Orchestration Tools
 * - swarm: Spawn multiple agents at once
 * - wake: Spawn a new agent session
 * - respawn: Respawn a failed or stale agent with recovery context
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, openSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { BrainDB } from '../db.js';
import { minimalAgentPrompt } from '../autopilot.js';
import { spawnWithRecovery, savePreSpawnCheckpoint, buildRecoveryContext, classifyError } from '../spawn-recovery.js';
import { enqueueDaemonWatch, watcherModeFromEnv } from '../agent-watcher.js';
import { SPAWN_TMP_PREFIX } from '../constants.js';
import { cNum, cBool, cArr } from './schema-helpers.js';

interface SwarmToolsOptions {
  db: BrainDB;
  room: string;
  roomLabel: string;
  ensureSession: () => string;
  getSessionId: () => string | null;
  getSessionName: () => string;
  startLeadWatchdog: (leadSessionId: string) => void;
  prepareAgentWorkspace: (baseCwd: string, agentName: string, isolation: 'shared' | 'snapshot') => string;
  spawnedAgentCount: number;
  incrementSpawnedAgentCount: () => number;
  AGENT_COLORS: string[];
}

export function registerSwarmTools(
  server: McpServer,
  options: SwarmToolsOptions,
) {
  const {
    db, room, roomLabel, ensureSession, getSessionId, getSessionName,
    startLeadWatchdog, prepareAgentWorkspace, incrementSpawnedAgentCount,
  } = options;



  function sh(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  // ── swarm ────────────────────────────────────────────────────────────────────
  server.tool(
    'swarm',
    `Spawn multiple agents at once to work on a task in parallel. This is the high-level
orchestration tool — one call replaces multiple brain_wake calls.
Automatically: registers as lead, creates a task plan, spawns all agents, starts watchdog.
Use brain_agents to monitor, brain_auto_gate when done.`,
    {
      task: z.string().describe('The overall task to accomplish'),
      agents: cArr(z.object({
        name: z.string().describe('Agent name (e.g. "api-worker", "test-writer")'),
        task: z.string().describe('Specific task for this agent'),
        files: cArr(z.string()).optional().describe('Files this agent is responsible for'),
        model: z.string().optional().describe('Model override for this agent'),
        role: z.string().optional().describe('Role template for this agent'),
        acceptance: cArr(z.string()).optional().describe('Success criteria'),
        depends_on: cArr(z.string()).optional().describe('Other agent names whose outputs this agent should respect'),
        isolation: z.enum(['shared', 'snapshot']).optional().describe('Run in shared workspace or isolated snapshot'),
      })).describe('Array of agents to spawn'),
      layout: z.enum(['horizontal', 'tiled', 'headless']).optional().describe('Layout for all agents (default: headless)'),
      model: z.string().optional().describe('Default model for all agents'),
      isolation: z.enum(['shared', 'snapshot']).optional().describe('Default workspace isolation (default: shared)'),
    },
    async ({ task, agents: agentConfigs, layout, model: defaultModel, isolation }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      startLeadWatchdog(sid);

      const spawnLayout = layout || 'headless';
      const cliBase = process.env.BRAIN_DEFAULT_CLI || 'claude';

      // Store shared context
      db.setState('swarm-task', room, task, sid, sessionName);

      const spawned: Array<{ name: string; sessionId: string; taskId: number; workspace: string }> = [];
      const errors: string[] = [];

      for (const agentCfg of agentConfigs) {
        try {
          const agentSessionId = randomUUID();
          const agentName = agentCfg.name;
          const workspacePath = prepareAgentWorkspace(room, agentName, agentCfg.isolation || isolation || 'shared');

          const taskId = db.postMessage('tasks', room, sid, sessionName, agentCfg.task);

          // Keep new sessions queued until the child sends its first confirmed heartbeat.
          // This prevents ghost agents from appearing healthy when spawn dies immediately.
          db.registerSession(
            agentName, room,
            JSON.stringify({ parent_session_id: sid, task_id: taskId, swarm: true, workspace: workspacePath }),
            agentSessionId,
          );
          db.pulse(agentSessionId, 'queued', `swarm queued; depends_on=${JSON.stringify(agentCfg.depends_on)}`);

          const childEnvParts = [
            process.env.BRAIN_DB_PATH ? `BRAIN_DB_PATH=${sh(process.env.BRAIN_DB_PATH)}` : null,
            `BRAIN_ROOM=${sh(room)}`,
            `BRAIN_SESSION_ID=${sh(agentSessionId)}`,
            `BRAIN_SESSION_NAME=${sh(agentName)}`,
          ].filter(Boolean);

          const agentModel = agentCfg.model || defaultModel;
          const cliType: 'claude' | 'hermes' | 'other' =
            (cliBase === 'claude' || cliBase.includes('claude')) ? 'claude' :
            (cliBase === 'hermes' || cliBase.includes('hermes')) ? 'hermes' :
            'other';

          const prompt = minimalAgentPrompt(agentName, agentCfg.task, {
            files: agentCfg.files,
            role: agentCfg.role,
            acceptance: agentCfg.acceptance,
            dependsOn: agentCfg.depends_on,
            workspacePath,
          });

          const childEnv = childEnvParts.join(' ');
          const tmpDir = mkdtempSync(join(tmpdir(), SPAWN_TMP_PREFIX));
          const logFile = join(tmpDir, 'agent.log');
          const promptFile = join(tmpDir, 'prompt.txt');
          writeFileSync(promptFile, prompt);

          let headlessCmd: string;
          if (cliType === 'claude') {
            const modelFlag = agentModel ? ` --model ${sh(agentModel)}` : '';
            headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} claude -p ${sh(prompt)}${modelFlag} --dangerously-skip-permissions > ${sh(logFile)} 2>&1`;
          } else if (cliType === 'hermes') {
            const hermesModelEnv = agentModel ? `HERMES_MODEL=${sh(agentModel)}` : '';
            headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${hermesModelEnv} hermes chat -q ${sh(prompt)} -Q --yolo > ${sh(logFile)} 2>&1`;
          } else {
            headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} cat ${sh(promptFile)} | ${sh(cliBase)} > ${sh(logFile)} 2>&1`;
          }

          // Spawn with recovery: error detection, retry w/ backoff, startup verification
          const result = await spawnWithRecovery(
            db, room, agentSessionId, agentName, agentCfg.task,
            headlessCmd, logFile,
          );

          if (result.success) {
            db.setSessionPid(agentSessionId, result.pid!);
            spawned.push({ name: agentName, sessionId: agentSessionId, taskId, workspace: workspacePath });
          } else {
            db.pulse(agentSessionId, 'failed', `spawn recovery exhausted: ${result.error}`);
            errors.push(`${agentName}: ${result.error}`);
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
          }
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
            message: `Swarm launched: ${spawned.length} agents spawned${errors.length ? `, ${errors.length} failed` : ''}. Monitor with brain_agents. Run brain_auto_gate when all agents report done.`,
          }, null, 2),
        }],
      };
    }
  );

  // ── wake ─────────────────────────────────────────────────────────────────────
  server.tool(
    'wake',
    `Spawn a NEW agent session to handle a task. Supports multiple modes:
- tmux (default): visible split pane — requires tmux
- headless: background process — no tmux needed, works everywhere
- Supports multi-LLM routing via the model parameter
- Configurable timeout (default: none for tmux, 30min for headless)`,
    {
      task: z.string().describe('The full task description for the new session to execute'),
      name: z.string().optional().describe('Name for the new agent session (default: "agent-<timestamp>")'),
      layout: z.enum(['vertical', 'horizontal', 'tiled', 'window', 'headless']).optional().describe('"horizontal" = side by side (default). "vertical" = stacked. "tiled" = auto-grid. "window" = new tmux tab. "headless" = background process (no tmux needed).'),
      files: cArr(z.string()).optional().describe('Optional file scope for the agent'),
      role: z.string().optional().describe('Optional role template to include in the prompt'),
      acceptance: cArr(z.string()).optional().describe('Success criteria the agent should satisfy before marking done'),
      isolation: z.enum(['shared', 'snapshot']).optional().describe('Run in the shared workspace or an isolated snapshot (default: shared)'),
      model: z.string().optional().describe('Model to use for this agent'),
      auto_route: cBool().optional().describe('Auto-select the best model based on task complexity and historical metrics'),
      timeout: cNum().optional().describe('Timeout in seconds. Default: 3600 (1 hour). Set 0 for no timeout.'),
      cli: z.string().optional().describe('Custom CLI command to spawn instead of "claude"'),
    },
    async ({ task, name, layout, files, role, acceptance, isolation, model: modelParam, auto_route, timeout: timeoutSec, cli }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      startLeadWatchdog(sid);
      const agentName = name || `agent-${Date.now()}`;
      const agentSessionId = randomUUID();
      const tmuxName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const spawnLayout = layout || 'horizontal';
      const isHeadless = spawnLayout === 'headless';
      const agentTimeout = timeoutSec ?? (isHeadless ? 1800 : 3600);
      const workspacePath = prepareAgentWorkspace(room, agentName, isolation || 'shared');

      // Auto-route
      let model = modelParam;
      if (auto_route && !model) {
        const { TaskRouter } = await import('../router.js');
        const router = new TaskRouter(db, room);
        const rec = router.routeTask(task);
        model = rec.model;
      }

      // Tmux modes require tmux
      if (!isHeadless) {
        try { execSync('tmux display-message -p ""', { stdio: 'ignore' }); } catch {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Not inside a tmux session. Use layout="headless" for non-tmux environments.' }) }],
            isError: true,
          };
        }
      }

      const taskId = db.postMessage('tasks', room, sid, sessionName, task);

      // Keep the child queued until it proves it is alive with a real heartbeat.
      db.registerSession(
        agentName, room,
        JSON.stringify({ parent_session_id: sid, task_id: taskId, model: model || null, headless: isHeadless, workspace: workspacePath }),
        agentSessionId,
      );
      db.pulse(agentSessionId, 'queued', 'spawn queued; waiting for first heartbeat');

      const childEnvParts = [
        process.env.BRAIN_DB_PATH ? `BRAIN_DB_PATH=${sh(process.env.BRAIN_DB_PATH)}` : null,
        `BRAIN_ROOM=${sh(room)}`,
        `BRAIN_SESSION_ID=${sh(agentSessionId)}`,
        `BRAIN_SESSION_NAME=${sh(agentName)}`,
      ].filter(Boolean);

      const cliBase = cli || process.env.BRAIN_DEFAULT_CLI || 'claude';
      const cliType: 'claude' | 'hermes' | 'other' =
        (cliBase === 'claude' || cliBase.includes('claude')) ? 'claude' :
        (cliBase === 'hermes' || cliBase.includes('hermes')) ? 'hermes' :
        'other';

      let modelFlag = '';
      if (model) {
        if (cliType === 'claude') modelFlag = ` --model ${sh(model)}`;
      }

      const prompt = minimalAgentPrompt(agentName, task, { files, role, acceptance, workspacePath });

      const ts = Date.now();
      const tmpDir = mkdtempSync(join(tmpdir(), SPAWN_TMP_PREFIX));
      const promptFile = join(tmpDir, 'prompt.txt');
      writeFileSync(promptFile, prompt);

      try {
        if (isHeadless) {
          const logFile = join(tmpDir, 'agent.log');
          const childEnv = childEnvParts.join(' ');

          let headlessCmd: string;
          if (cliType === 'claude') {
            headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${sh(cliBase)} -p ${sh(prompt)}${modelFlag} --dangerously-skip-permissions > ${sh(logFile)} 2>&1`;
          } else if (cliType === 'hermes') {
            const hermesModelEnv = model ? `HERMES_MODEL=${sh(model)}` : '';
            headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${hermesModelEnv} ${sh(cliBase)} chat -q ${sh(prompt)} -Q --yolo > ${sh(logFile)} 2>&1`;
          } else {
            headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} cat ${sh(promptFile)} | ${sh(cliBase)} > ${sh(logFile)} 2>&1`;
          }

          // Spawn with recovery: error detection, retry w/ backoff, startup verification
          const result = await spawnWithRecovery(
            db, room, agentSessionId, agentName, task,
            headlessCmd, logFile,
          );

          if (!result.success) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
            db.pulse(agentSessionId, 'failed', `spawn recovery exhausted: ${result.error}`);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: result.error }) }],
              isError: true,
            };
          }

          db.setSessionPid(agentSessionId, result.pid!);

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                agent: agentName,
                agentSessionId,
                taskId,
                mode: 'headless',
                model: model || 'default',
                workspace: workspacePath,
                isolation: isolation || 'shared',
                logFile,
                message: `Spawned "${agentName}" in headless mode (no tmux). Monitor with brain_agents. Log: ${logFile}`,
              }, null, 2),
            }],
          };
        }

        // TMUX MODE
        const childEnv = childEnvParts.join(' ');
        let tmuxCmd: string;
        if (cliType === 'claude') {
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${sh(cliBase)}${modelFlag} --dangerously-skip-permissions`;
        } else if (cliType === 'hermes') {
          const hermesModelEnv = model ? `HERMES_MODEL=${sh(model)}` : '';
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${hermesModelEnv} ${sh(cliBase)} --yolo`;
        } else {
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${sh(cliBase)}`;
        }
        const bufferName = `brain-${ts}`;

        let target: string;

        if (spawnLayout === 'window') {
          execSync(`tmux new-window -n "${tmuxName}" "${tmuxCmd}"`);
          target = tmuxName;
        } else {
          const paneId = execSync(`tmux split-window -h -P -F '#{pane_id}' "${tmuxCmd}"`).toString().trim();
          const agentColor = options.AGENT_COLORS[incrementSpawnedAgentCount() % options.AGENT_COLORS.length];

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

        // Watcher script
        const exitCmd = cliType === 'hermes' ? '/quit' : '/exit';
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
        const watcherContent = `#!/bin/bash
TARGET="${target}"
PROMPT="${promptFile}"
BUFFER="${bufferName}"
ABSOLUTE_TIMEOUT=${agentTimeout}
START_TIME=$(date +%s)
TMPDIR_PATH="${tmpDir}"

check_timeout() {
  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ $ABSOLUTE_TIMEOUT -gt 0 ] && [ $ELAPSED -ge $ABSOLUTE_TIMEOUT ]; then
    tmux send-keys -t "$TARGET" "${exitCmd}" Enter 2>/dev/null
    sleep 5
    tmux kill-pane -t "$TARGET" 2>/dev/null
    rm -rf "$TMPDIR_PATH"
    exit 0
  fi
}

READY=0
for i in $(seq 1 60); do
  sleep 2
  check_timeout
  tmux display-message -t "$TARGET" -p "" 2>/dev/null || exit 0
  CONTENT=$(tmux capture-pane -t "$TARGET" -p 2>/dev/null)
  if \${readyPatterns}; then
    READY=1; break
  fi
  if \${fallbackReady}; then
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
rm -rf "$TMPDIR_PATH"
`;
        writeFileSync(watcherFile, watcherContent, { mode: 0o755 });
        const watcher = spawn('bash', [watcherFile], { detached: true, stdio: 'ignore' });
        watcher.on('error', (err) => {
          try { db.pulse(agentSessionId, 'failed', `watcher failed: ${err.message}`); } catch { /* best effort */ }
        });
        watcher.unref();
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
              model: model || 'default',
              workspace: workspacePath,
              isolation: isolation || 'shared',
                message: `Spawned "${agentName}" — ${layoutDesc[spawnLayout]}. Session is queued until the first heartbeat. Lead watchdog active.`,
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

  // ── respawn ─────────────────────────────────────────────────────────────────
  server.tool(
    'respawn',
    `Respawn a failed or stale agent with context about what it accomplished before failing.
Reads the original task, the agent's posts, claims, and progress to brief the replacement.
The replacement agent picks up where the failed one left off.`,
    {
      agent_name: z.string().describe('Name of the failed/stale agent to respawn'),
      extra_context: z.string().optional().describe('Additional instructions for the replacement'),
      layout: z.enum(['vertical', 'horizontal', 'tiled', 'window', 'headless']).optional().describe('Layout for the new agent (default: headless)'),
      model: z.string().optional().describe('Model override for the replacement agent'),
    },
    async ({ agent_name, extra_context, layout, model }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      startLeadWatchdog(sid);

      const agents = db.getAgentHealth(room);
      const failed = agents.find(a => a.name === agent_name);
      if (!failed) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `Agent "${agent_name}" not found` }) }],
          isError: true,
        };
      }

      const session = db.getSession(failed.id);
      const metadata = session?.metadata ? JSON.parse(session.metadata) : {};
      const originalTaskId = metadata.task_id;

      let originalTask = '';
      if (originalTaskId) {
        const taskMessages = db.getMessages('tasks', room, originalTaskId - 1, 1);
        if (taskMessages.length > 0) originalTask = taskMessages[0].content;
      }

      const agentPosts = db.getMessages('general', room).filter(m => m.sender_id === failed.id);
      const lastProgress = failed.progress || 'unknown';

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

      if (failed.id) {
        db.releaseAllClaims(failed.id);
      }

      db.recordMetric(room, agent_name, failed.id, {
        task_description: originalTask.slice(0, 200),
        outcome: 'failed',
        started_at: session?.created_at,
      });

      const replacementName = `${agent_name}-r${Date.now() % 10000}`;

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
}
