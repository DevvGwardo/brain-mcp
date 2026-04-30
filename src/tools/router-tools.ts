import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { TaskRouter } from '../router.js';
import type { BrainDB } from '../db.js';
import { enqueueDaemonWatch, watcherModeFromEnv } from '../agent-watcher.js';
import { SPAWN_TMP_PREFIX } from '../constants.js';
import { agentEnvShellPairs } from '../agent-env.js';
import { tmux, tmuxTry } from '../tmux-runtime.js';

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

export interface RouterToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  sessionName: string;
  startLeadWatchdog: (sid: string) => void;
  prepareAgentWorkspace: (baseCwd: string, agentName: string, isolation: 'shared' | 'snapshot') => string;
  minimalAgentPrompt: (name: string, task: string, opts?: any) => string;
  spawnWithRecovery: (...args: any[]) => Promise<any>;
  sh: (value: string) => string;
  spawnedAgentCount: number;
  incrementSpawnedAgentCount: () => number;
  AGENT_COLORS: string[];
}

export function registerRouterTools(
  server: { tool: (name: string, description: string, schema: any, handler: (params: any) => Promise<any>) => void },
  options: RouterToolsOptions,
) {
  const {
    db, room, ensureSession, sessionName, startLeadWatchdog,
    prepareAgentWorkspace, minimalAgentPrompt, spawnWithRecovery,
    sh, incrementSpawnedAgentCount, AGENT_COLORS,
  } = options;

  // ── route ──

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

  // ── wake ──

  server.tool(
    'wake',
    `Spawn a NEW agent session to handle a task. Supports multiple modes:
- tmux (default): visible split pane — requires tmux
- headless: background process — no tmux needed, works everywhere
- Supports multi-LLM routing via the model parameter (e.g. "haiku" for cheap tasks, "opus" for complex ones)
- Configurable timeout (default: none for tmux, 30min for headless)`,
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
      let spawnLayout = layout || 'horizontal';
      if (spawnLayout !== 'headless') {
        try {
          if (tmuxTry(['display-message', '-p', '']) === null) throw new Error('not in tmux');
        } catch {
          spawnLayout = 'headless';
        }
      }
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
      const cliType: 'claude' | 'hermes' | 'other' =
        (cliBase === 'claude' || cliBase.includes('claude')) ? 'claude' :
        (cliBase === 'hermes' || cliBase.includes('hermes')) ? 'hermes' :
        'other';

      db.recordSpawnStarted(
        room, agentName, agentSessionId, task, agentSessionId,
        cliType === 'claude' ? 'claude' : cliType === 'hermes' ? 'hermes' : 'unknown',
        isHeadless ? 'headless' : (watcherModeFromEnv() === 'daemon' ? 'tmux-daemon' : 'tmux-bash'),
      );

      // Build model flag per CLI
      let modelFlag = '';
      if (model) {
        if (cliType === 'claude') modelFlag = ` --model ${sh(model)}`;
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
        // ═══════════════════════════════════════
        //  HEADLESS MODE — no tmux required
        // ═══════════════════════════════════════
        if (isHeadless) {
          const logFile = join(tmpDir, 'agent.log');
          const childEnv = childEnvParts.join(' ');

          // Build the headless command per CLI type
          let headlessCmd: string;
          if (cliType === 'claude') {
            // claude -p (print mode) — non-interactive, uses all MCP tools, exits when done
            headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${sh(cliBase)} -p ${sh(prompt)}${modelFlag} --dangerously-skip-permissions > ${sh(logFile)} 2>&1`;
          } else if (cliType === 'hermes') {
            // hermes chat -q (single query mode) — non-interactive, uses MCP tools, exits when done
            // -Q suppresses TUI, only prints final response
            const hermesModelEnv = model ? `HERMES_MODEL=${sh(model)}` : '';
            headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${hermesModelEnv} ${sh(cliBase)} chat -q ${sh(prompt)} -Q --yolo > ${sh(logFile)} 2>&1`;
          } else {
            // Generic CLI — pass prompt via stdin
            headlessCmd = `cd ${sh(workspacePath)} && env ${childEnv} cat ${sh(promptFile)} | ${sh(cliBase)} > ${sh(logFile)} 2>&1`;
          }

          // Wrapper script with timeout and cleanup
          const watcherFile = join(tmpDir, 'headless.sh');
          const watcherContent = `#!/bin/bash
AGENT_ID="${agentSessionId}"
LOG="${logFile}"
TIMEOUT=${agentTimeout}
START_TIME=$(date +%s)

# Run the agent
${headlessCmd}
EXIT_CODE=$?

# Cleanup (leave LOG; sweep handles the rest)
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
                requestedLayout: layout || 'horizontal',
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

        // ═══════════════════════════════════════
        //  TMUX MODE — visible split panes
        // ═══════════════════════════════════════
        const childEnv = childEnvParts.join(' ');
        let tmuxCmd: string;
        if (cliType === 'claude') {
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${sh(cliBase)}${modelFlag} --dangerously-skip-permissions`;
        } else if (cliType === 'hermes') {
          // Hermes interactive TUI mode — full agent experience in tmux pane
          const hermesModelEnv = model ? `HERMES_MODEL=${sh(model)}` : '';
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${hermesModelEnv} ${sh(cliBase)} --yolo`;
        } else {
          tmuxCmd = `cd ${sh(workspacePath)} && env ${childEnv} ${sh(cliBase)}`;
        }
        const bufferName = `brain-${ts}`;

        let target: string;

        if (spawnLayout === 'window') {
          tmux(['new-window', '-n', tmuxName, tmuxCmd]);
          target = tmuxName;
        } else {
          const paneId = tmux(['split-window', '-h', '-P', '-F', '#{pane_id}', tmuxCmd]);

          const agentColor = AGENT_COLORS[incrementSpawnedAgentCount() % AGENT_COLORS.length];

          try {
            let paneCount = 2;
            try {
              paneCount = tmux(['list-panes']).split('\n').filter(Boolean).length || 2;
            } catch { /* default */ }

            if (spawnLayout === 'tiled' || paneCount > 4) {
              tmux(['select-layout', 'tiled']);
            } else if (paneCount <= 2) {
              tmux(['select-layout', 'even-horizontal']);
            } else {
              tmux(['select-layout', 'main-vertical']);
              tmuxTry(['resize-pane', '-t', '{top-left}', '-x', '40%']);
            }
            tmuxTry(['select-layout', '-E']);
            tmuxTry(['set-option', '-p', '-t', paneId, 'pane-border-style', `fg=${agentColor}`]);
            tmux(['set-option', '-w', 'pane-active-border-style', 'fg=#9333EA,bold']);
            tmux(['select-pane', '-t', '{top-left}', '-P', 'bg=#0d0a1a']);
            tmux(['select-pane', '-t', '{top-left}']);
          } catch { /* layout may vary by tmux version */ }

          target = paneId;
        }

        // Watcher: wait for ready, paste prompt, wait for exit or timeout
        // CLI-specific exit command and ready detection
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
rm -rf "$TMPDIR_PATH"
`;
        writeFileSync(watcherFile, watcherContent, { mode: 0o755 });

        const watcher = spawn('bash', [watcherFile], { detached: true, stdio: 'ignore' });
        watcher.on('error', (err) => {
          try { db.markDone(agentSessionId, -1, true, `watcher failed: ${err.message}`); } catch { /* best effort */ }
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
              requestedLayout: layout || 'horizontal',
              model: model || 'default',
              workspace: workspacePath,
              isolation: isolation || 'shared',
              message: `Spawned "${agentName}" — ${layoutDesc[spawnLayout]}. Pre-registered with heartbeat. Lead watchdog active.`,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        try {
          db.pulse(agentSessionId, 'failed', `spawn error: ${err.message || String(err)}`);
          try { unlinkSync(promptFile); } catch { /* best effort */ }
        } catch { /* cleanup */ }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err.message || String(err) }) }],
          isError: true,
        };
      }
    }
  );
}
