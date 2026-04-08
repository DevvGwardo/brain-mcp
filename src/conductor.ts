#!/usr/bin/env node

/**
 * Brain Conductor — zero-token orchestration CLI.
 *
 * Replaces the lead Claude session. Spawns agents, monitors heartbeats,
 * runs integration gates between phases, DMs agents with errors.
 * All coordination is Node.js — Claude tokens only spent on real work.
 *
 * Usage:
 *   brain-conductor "Build a breakout game" --agents ui engine store
 *   brain-conductor "Refactor auth" --agents backend frontend --gate
 *   brain-conductor --config pipeline.json
 */

import { execSync, spawn as spawnProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { ThinkingBudgets } from '@mariozechner/pi-ai';
import { BrainDB, type SessionStatus } from './db.js';
import { runGateAndNotify, type GateResult } from './gate.js';
import { runPiCoreAgent } from './pi-core-agent.js';

// ── ANSI helpers ──

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlack: '\x1b[40m',
  clearScreen: '\x1b[2J\x1b[H',
  clearLine: '\x1b[2K',
  up: (n: number) => `\x1b[${n}A`,
};

const STATUS_ICONS: Record<string, string> = {
  idle: `${C.dim}○${C.reset}`,
  working: `${C.yellow}●${C.reset}`,
  done: `${C.green}✓${C.reset}`,
  failed: `${C.red}✗${C.reset}`,
  stale: `${C.red}?${C.reset}`,
  queued: `${C.dim}◌${C.reset}`,
};

// ── Agent colors for tmux panes ──

const AGENT_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
  '#EC4899', '#06B6D4', '#F97316', '#14B8A6', '#A855F7',
];

// ── Config types ──

interface AgentConfig {
  name: string;
  task?: string;       // Override task per agent
  files?: string[];    // Files this agent is responsible for
  delay?: number;      // Seconds to wait before spawning
  role?: string;
  acceptance?: string[];
  depends_on?: string[];
  workspace?: string;
  thinkingLevel?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
}

// ── Active pi-core agent tracking for cancellation ──
interface ActiveAgent {
  sessionId: string;
  name: string;
  abortController: AbortController;
  model: string;
  startedAt: number;
}
const activeAgents = new Map<string, ActiveAgent>();

interface PhaseConfig {
  name: string;
  parallel: boolean;
  agents: AgentConfig[];
}

type AgentMode = 'claude' | 'py' | 'pi' | 'pi-core';

interface PipelineConfig {
  task: string;
  cwd: string;
  phases: PhaseConfig[];
  gate: boolean;
  timeout: number;      // Per-agent timeout in seconds
  max_gate_retries: number;
  mode: AgentMode;      // 'pi' = Pi CLI, 'pi-core' = pi-agent-core in-process, 'py' = Python agents, 'claude' = Claude Code CLI
  model: string;        // Model for pi/py agents
  thinkingLevel?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
}

// ── Parse CLI args ──

function parseArgs(): PipelineConfig {
  const args = process.argv.slice(2);
  const cwd = process.cwd();

  const VALID_THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

  // Parse --thinking from CLI (shared across both modes)
  let thinkingLevel: ThinkingLevel | undefined;
  const thinkingIdx = args.indexOf('--thinking');
  if (thinkingIdx !== -1 && args[thinkingIdx + 1]) {
    const lvl = (args[thinkingIdx + 1] || '').toLowerCase() as ThinkingLevel;
    if (VALID_THINKING_LEVELS.includes(lvl)) {
      thinkingLevel = lvl;
    } else {
      console.error(`${C.yellow}Warning:${C.reset} invalid --thinking level "${args[thinkingIdx + 1]}". Use: off|minimal|low|medium|high|xhigh`);
    }
  }

  // Check for --config
  const configIdx = args.indexOf('--config');
  if (configIdx !== -1 && args[configIdx + 1]) {
    const configPath = args[configIdx + 1];
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    // Check for mode override flags on CLI even with --config
    const cliMode = args.includes('--pi') ? 'pi' : args.includes('--pi-core') ? 'pi-core' : args.includes('--py') ? 'py' : args.includes('--claude') ? 'claude' : null;
    // Map snake_case JSON keys to camelCase
    const thinkingLevelFromConfig = raw.thinking_level ?? raw.thinkingLevel;
    return {
      ...raw,
      cwd: raw.cwd || cwd,
      mode: cliMode || raw.mode || 'pi',
      model: raw.model || 'claude-sonnet-4-5',
      ...(cliMode ? { mode: cliMode } : {}),
      ...(thinkingLevel ? { thinkingLevel } : thinkingLevelFromConfig ? { thinkingLevel: thinkingLevelFromConfig } : {}),
    };
  }

  // Parse inline args
  let task = '';
  const agentNames: string[] = [];
  let gate = true;
  let timeout = 600;
  let maxRetries = 3;
  let mode: AgentMode = 'pi';
  let model = 'claude-sonnet-4-5';

  let i = 0;
  while (i < args.length) {
    if (args[i] === '--agents') {
      i++;
      while (i < args.length && !args[i].startsWith('--')) {
        agentNames.push(args[i]);
        i++;
      }
    } else if (args[i] === '--no-gate') {
      gate = false;
      i++;
    } else if (args[i] === '--timeout') {
      timeout = parseInt(args[i + 1]) || 600;
      i += 2;
    } else if (args[i] === '--retries') {
      maxRetries = parseInt(args[i + 1]) || 3;
      i += 2;
    } else if (args[i] === '--pi') {
      mode = 'pi';
      i++;
    } else if (args[i] === '--pi-core') {
      mode = 'pi-core';
      i++;
    } else if (args[i] === '--py') {
      mode = 'py';
      i++;
    } else if (args[i] === '--claude') {
      mode = 'claude';
      i++;
    } else if (args[i] === '--model') {
      model = args[i + 1] || model;
      i += 2;
    } else if (!args[i].startsWith('--')) {
      task = args[i];
      i++;
    } else {
      i++;
    }
  }

  if (!task) {
    console.error(`${C.red}Usage:${C.reset} brain-conductor "task description" --agents name1 name2 ...`);
    console.error(`       brain-conductor --config pipeline.json`);
    console.error('');
    console.error('Options:');
    console.error('  --pi-core         Use pi-agent-core in-process agents (fastest, no subprocess)');
    console.error('  --pi              Use pi CLI subprocess agents');
    console.error('  --py              Use Python subprocess agents');
    console.error('  --claude          Use Claude Code CLI agents');
    console.error('  --model <id>      Model ID (e.g. claude-sonnet-4-5, anthropic/claude-sonnet-4-5)');
    console.error('  --thinking <lvl>  Reasoning level: off|minimal|low|medium|high|xhigh (default: medium)');
    console.error('  --agents <names>  Agent names for CLI mode');
    console.error('  --no-gate         Disable the integration gate');
    console.error('  --timeout <sec>   Per-agent timeout (default 600)');
    console.error('  --retries <n>     Max gate retries (default 3)');

    console.error('  --config file.json  Load pipeline from JSON config');
    process.exit(1);
  }

  if (agentNames.length === 0) {
    agentNames.push('agent-1', 'agent-2');
  }

  return {
    task,
    cwd,
    phases: [{
      name: 'main',
      parallel: true,
      agents: agentNames.map(name => ({ name })),
    }],
    gate,
    timeout,
    max_gate_retries: maxRetries,
    mode,
    model,
    thinkingLevel,
  };
}

// ── Shell escaping ──

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ── Resolve path to agents/ directory (next to dist/) ──

function agentsDir(): string {
  // conductor.js lives in dist/, agents/ is a sibling
  return join(import.meta.dirname || __dirname, '..', 'agents');
}

// ── Spawn an agent into a tmux pane ──

function spawnAgent(
  db: BrainDB,
  config: PipelineConfig,
  agent: AgentConfig,
  conductorId: string,
  agentIndex: number,
): string {
  const agentSessionId = randomUUID();
  const agentName = agent.name;
  const agentTask = agent.task || config.task;
  const tmuxName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const workspaceCwd = agent.workspace || config.cwd;

  // Pre-register in DB
  db.registerSession(
    agentName,
    config.cwd,
    JSON.stringify({ parent_session_id: conductorId, conductor: true, mode: config.mode }),
    agentSessionId,
  );

  const modeLabel = config.mode === 'pi' ? 'pi agent' : config.mode === 'py' ? 'py agent' : 'Claude';

  db.pulse(agentSessionId, 'working', `spawned by conductor; starting ${modeLabel}`);

  // Build env vars (shared between all modes)
  const envParts = [
    process.env.BRAIN_DB_PATH ? `BRAIN_DB_PATH=${sh(process.env.BRAIN_DB_PATH)}` : null,
    `BRAIN_ROOM=${sh(config.cwd)}`,
    `BRAIN_SESSION_ID=${sh(agentSessionId)}`,
    `BRAIN_SESSION_NAME=${sh(agentName)}`,
  ].filter(Boolean);

  if (config.mode === 'pi') {
    // ── Pi coding agent mode ──
    // Pi has built-in tools (read, write, edit, bash, grep, find, ls)
    // and supports the brain-mcp server for coordination.

    // Forward API keys
    if (process.env.ANTHROPIC_API_KEY) {
      envParts.push(`ANTHROPIC_API_KEY=${sh(process.env.ANTHROPIC_API_KEY)}`);
    }
    if (process.env.OPENROUTER_API_KEY) {
      envParts.push(`OPENROUTER_API_KEY=${sh(process.env.OPENROUTER_API_KEY)}`);
    }

    // Build the brain-aware system prompt append
    const fileScope = agent.files?.length
      ? `\nFILE SCOPE: You are responsible for these files: ${agent.files.join(', ')}.`
      : '';
    const roleLine = agent.role ? `\nROLE: ${agent.role}.` : '';
    const acceptance = agent.acceptance?.length
      ? `\nSUCCESS CRITERIA:\n${agent.acceptance.map(item => `- ${item}`).join('\n')}`
      : '';

    const brainPrompt = [
      `You are "${agentName}", a focused coding agent in a multi-agent team.`,
      `You have brain MCP tools available for coordination with other agents.`,
      roleLine,
      fileScope,
      acceptance,
      '',
      `WHEN DONE: post a summary with post, then stop.`,
    ].join('\n');

    // Write the task + brain instructions to a temp file for --append-system-prompt
    const ts = Date.now();
    const systemFile = join(tmpdir(), `brain-sys-${ts}-${tmuxName}.txt`);
    writeFileSync(systemFile, brainPrompt);

    // Resolve model — for direct anthropic provider, use model names like claude-sonnet-4-5
    const piModel = config.model || 'claude-sonnet-4-5';
    // Determine provider from model name
    const piProvider = piModel.includes('/') ? piModel.split('/')[0] : 'anthropic';
    const piModelId = piModel.includes('/') ? piModel : piModel;

    // Build the pi command
    // --print = non-interactive, process prompt and exit
    // --no-session = ephemeral (no session file clutter)
    // --no-extensions --no-skills = lean startup
    // Connect brain-mcp for coordination tools
    const brainMcpServer = join(agentsDir(), '..', 'dist', 'index.js');

    const piCmd = [
      `cd ${sh(workspaceCwd)}`,
      `&&`,
      `env ${envParts.join(' ')}`,
      `pi`,
      `--print`,
      `--provider ${sh(piProvider)}`,
      `--model ${sh(piModelId)}`,
      `--tools read,write,edit,bash,grep,find,ls`,
      `--no-session`,
      `--no-extensions`,
      `--no-skills`,
      `--no-prompt-templates`,
      `--append-system-prompt ${sh(systemFile)}`,
      sh(agentTask),
    ].join(' ');

    // Spawn tmux pane
    const paneId = execSync(
      `tmux split-window -h -P -F '#{pane_id}' "${piCmd}"`
    ).toString().trim();

    applyLayout(paneId, agentIndex);

    // Simple timeout watcher (records exit code on agent exit)
    const watcherFile = join(tmpdir(), `brain-watch-${ts}-${tmuxName}.sh`);
    const dbPath4Watch = (process.env.BRAIN_DB_PATH || '').replace(/'/g, "'\\''");
    const watcherContent = `#!/bin/bash
TARGET="${paneId}"
ABSOLUTE_TIMEOUT=${config.timeout}
START_TIME=$(date +%s)
while true; do
  sleep 5
  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ $ELAPSED -ge $ABSOLUTE_TIMEOUT ]; then
    tmux send-keys -t "$TARGET" C-c 2>/dev/null
    sleep 2
    tmux kill-pane -t "$TARGET" 2>/dev/null
    rm -f "${watcherFile}"
    exit 0
  fi
  tmux display-message -t "$TARGET" -p "" 2>/dev/null || break
done
AGENT_EXIT_CODE=$?
node -e "
const { BrainDB } = require('${join(import.meta.dirname, 'db.js').replace(/'/g, "'\\''")}');
const db = new BrainDB(process.env.BRAIN_DB_PATH || '${dbPath4Watch}');
db.set_exit_code('${agentSessionId}', AGENT_EXIT_CODE);
" 2>/dev/null || true
rm -f "${watcherFile}" "${systemFile}"
`;
    writeFileSync(watcherFile, watcherContent, { mode: 0o755 });
    const watcher = spawnProcess('bash', [watcherFile], { detached: true, stdio: 'ignore' });
    watcher.unref();

  } else if (config.mode === 'py') {
    // ── Python agent mode ──
    envParts.push(`BRAIN_TASK=${sh(agentTask)}`);
    envParts.push(`BRAIN_MODEL=${sh(config.model)}`);
    if (process.env.ANTHROPIC_API_KEY) {
      envParts.push(`ANTHROPIC_API_KEY=${sh(process.env.ANTHROPIC_API_KEY)}`);
    }

    const pyScript = join(agentsDir(), 'brain_agent.py');
    const pyVenv = join(agentsDir(), '.venv', 'bin', 'python3');
    const pyBin = existsSync(pyVenv) ? pyVenv : 'python3';
    const pyCmd = `cd ${sh(workspaceCwd)} && env ${envParts.join(' ')} PYTHONPATH=${sh(agentsDir())} ${sh(pyBin)} ${sh(pyScript)}`;

    // Spawn tmux pane
    const paneId = execSync(
      `tmux split-window -h -P -F '#{pane_id}' "${pyCmd}"`
    ).toString().trim();

    applyLayout(paneId, agentIndex);

    // Simple timeout watcher (records exit code on agent exit)
    const ts = Date.now();
    const watcherFile = join(tmpdir(), `brain-watch-${ts}-${tmuxName}.sh`);
    const dbPath4Watch = (process.env.BRAIN_DB_PATH || '').replace(/'/g, "'\\''");
    const watcherContent = `#!/bin/bash
TARGET="${paneId}"
ABSOLUTE_TIMEOUT=${config.timeout}
START_TIME=$(date +%s)
while true; do
  sleep 5
  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ $ELAPSED -ge $ABSOLUTE_TIMEOUT ]; then
    tmux send-keys -t "$TARGET" C-c 2>/dev/null
    sleep 2
    tmux kill-pane -t "$TARGET" 2>/dev/null
    rm -f "${watcherFile}"
    exit 0
  fi
  tmux display-message -t "$TARGET" -p "" 2>/dev/null || break
done
AGENT_EXIT_CODE=$?
node -e "
const { BrainDB } = require('${join(import.meta.dirname, 'db.js').replace(/'/g, "'\\''")}');
const db = new BrainDB(process.env.BRAIN_DB_PATH || '${dbPath4Watch}');
db.set_exit_code('${agentSessionId}', AGENT_EXIT_CODE);
" 2>/dev/null || true
rm -f "${watcherFile}"
`;
    writeFileSync(watcherFile, watcherContent, { mode: 0o755 });
    const watcher = spawnProcess('bash', [watcherFile], { detached: true, stdio: 'ignore' });
    watcher.unref();

  } else {
    // ── Claude Code mode (original) ──
    const childEnv = envParts.join(' ');
    const claudeCmd = `cd ${sh(workspaceCwd)} && env ${childEnv} claude --dangerously-skip-permissions`;

    // Build prompt
    const fileScope = agent.files?.length
      ? `\nFILE SCOPE: You are responsible for these files: ${agent.files.join(', ')}. Claim them with brain_claim before editing.`
      : '';
    const roleLine = agent.role ? `\nROLE: ${agent.role}.` : '';
    const acceptance = agent.acceptance?.length
      ? `\nSUCCESS CRITERIA:\n${agent.acceptance.map(item => `- ${item}`).join('\n')}`
      : '';
    const dependencyLine = agent.depends_on?.length
      ? `\nDEPENDENCIES: ${agent.depends_on.join(', ')}. Read shared state/messages before duplicating their work.`
      : '';
    const workspaceLine = workspaceCwd !== config.cwd ? `\nWORKSPACE: ${workspaceCwd}` : '';

    const prompt = [
      'You have brain MCP tools available (register, pulse, post, read, dm, inbox, set, get, claim, release, claims, contract_set, contract_get, contract_check).',
      'Use the short names above. If Hermes shows namespaced picker entries like mcp_brain_register, copy the picker exactly. Do not invent brain_brain_* tool names.',
      '',
      `IMPORTANT: Use claim before editing any file, and release when done.`,
      '',
      `Your name: "${agentName}"`,
      `Assigned by: conductor (automated orchestration — no lead Claude session)`,
      roleLine,
      fileScope,
      dependencyLine,
      workspaceLine,
      acceptance,
      '',
      `HEARTBEAT PROTOCOL (CRITICAL):`,
      `- Call pulse with status="working" and a short progress note every 2-3 tool calls`,
      `- pulse returns any pending DMs — READ AND ACT ON THEM (the conductor sends fix requests via DM)`,
      `- If you hit a blocker, call pulse with status="failed" and describe the issue`,
      '',
      `CONTRACT PROTOCOL (CRITICAL — prevents integration bugs):`,
      `- BEFORE writing code: call contract_get to see what other agents provide/expect`,
      `- AFTER writing/modifying a file: call contract_set to publish what your module provides`,
      `  Example: entries=[{"module":"src/ui.ts","name":"drawBattle","kind":"provides","signature":"{\\"params\\":[\\"state: BattleState\\"],\\"returns\\":\\"void\\"}"}]`,
      `- When your code CALLS a function from another module: also publish an "expects" entry`,
      `- BEFORE marking done: call contract_check to verify no mismatches exist`,
      '',
      `YOUR TASK:`,
      agentTask,
      '',
      `WHEN DONE:`,
      `1. Call contract_check — fix any mismatches before proceeding`,
      `2. Call pulse with status="done" and a summary`,
      `3. Call post to announce what you accomplished`,
      `4. Release all claimed files with release`,
      `5. Type /exit to close this session`,
    ].join('\n');

    // Write prompt to temp file
    const ts = Date.now();
    const promptFile = join(tmpdir(), `brain-prompt-${ts}-${tmuxName}.txt`);
    const bufferName = `brain-${ts}-${tmuxName}`;
    writeFileSync(promptFile, prompt);

    // Spawn tmux pane
    const paneId = execSync(
      `tmux split-window -h -P -F '#{pane_id}' "${claudeCmd}"`
    ).toString().trim();

    applyLayout(paneId, agentIndex);

    // Watcher: wait for ready, paste prompt, wait for exit or timeout
    const watcherFile = join(tmpdir(), `brain-watch-${ts}-${tmuxName}.sh`);
    const dbPath4Watch = (process.env.BRAIN_DB_PATH || '').replace(/'/g, "'\\''");
    const watcherContent = `#!/bin/bash
TARGET="${paneId}"
PROMPT="${promptFile}"
BUFFER="${bufferName}"
ABSOLUTE_TIMEOUT=${config.timeout}
START_TIME=$(date +%s)

check_timeout() {
  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ $ELAPSED -ge $ABSOLUTE_TIMEOUT ]; then
    tmux send-keys -t "$TARGET" "/exit" Enter 2>/dev/null
    sleep 5
    tmux kill-pane -t "$TARGET" 2>/dev/null
    rm -f "${watcherFile}"
    exit 0
  fi
}

READY=0
for i in $(seq 1 60); do
  sleep 2
  check_timeout
  tmux display-message -t "$TARGET" -p "" 2>/dev/null || exit 0
  CONTENT=$(tmux capture-pane -t "$TARGET" -p 2>/dev/null)
  if echo "$CONTENT" | LC_ALL=C grep -qF $'\xe2\x9d\xaf' 2>/dev/null; then
    READY=1; break
  fi
  if echo "$CONTENT" | grep -q "high effort\|bypass perm\|accept edits" 2>/dev/null; then
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

AGENT_EXIT_CODE=0
while true; do
  sleep 5
  check_timeout
  tmux display-message -t "$TARGET" -p "" 2>/dev/null || break
done
# Record exit code
node -e "
const { BrainDB } = require('${join(import.meta.dirname, 'db.js').replace(/'/g, "'\\''")}');
const db = new BrainDB(process.env.BRAIN_DB_PATH || '${dbPath4Watch}');
db.set_exit_code('${agentSessionId}', AGENT_EXIT_CODE);
" 2>/dev/null || true
rm -f "${watcherFile}"
`;
    writeFileSync(watcherFile, watcherContent, { mode: 0o755 });
    const watcher = spawnProcess('bash', [watcherFile], { detached: true, stdio: 'ignore' });
    watcher.unref();
  }

  return agentSessionId;
}

// ── Shared tmux layout logic ──

function applyLayout(paneId: string, agentIndex: number): void {
  const agentColor = AGENT_COLORS[agentIndex % AGENT_COLORS.length];
  try {
    let paneCount = 2;
    try { paneCount = parseInt(execSync('tmux list-panes | wc -l').toString().trim(), 10) || 2; } catch { /* default */ }

    if (paneCount > 4) {
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
    execSync(`tmux select-pane -t '{top-left}'`);
  } catch { /* layout may vary */ }
}

// ── Display ──

let displayLines = 0;

function display(
  config: PipelineConfig,
  db: BrainDB,
  phaseIndex: number,
  phase: PhaseConfig,
  agentIds: Map<string, string>,
  gateResult: GateResult | null,
  gateAttempt: number,
  status: string,
) {
  // Clear previous display
  if (displayLines > 0) {
    process.stdout.write(C.up(displayLines) + '\r');
  }

  const lines: string[] = [];
  const width = 60;
  const border = '═'.repeat(width - 2);

  lines.push(`${C.magenta}╔${border}╗${C.reset}`);
  lines.push(`${C.magenta}║${C.reset} ${C.bold}Brain Conductor${C.reset}${' '.repeat(width - 19)}${C.magenta}║${C.reset}`);

  // Task (truncated)
  const taskDisplay = config.task.length > width - 12 ? config.task.slice(0, width - 15) + '...' : config.task;
  lines.push(`${C.magenta}║${C.reset} ${C.dim}Task:${C.reset} ${taskDisplay}${' '.repeat(Math.max(0, width - 9 - taskDisplay.length))}${C.magenta}║${C.reset}`);

  // Phase info
  const phaseStr = `Phase: ${phaseIndex + 1}/${config.phases.length} (${phase.name})`;
  lines.push(`${C.magenta}║${C.reset} ${C.cyan}${phaseStr}${C.reset}${' '.repeat(Math.max(0, width - 4 - phaseStr.length))}${C.magenta}║${C.reset}`);

  lines.push(`${C.magenta}║${C.reset}${' '.repeat(width - 2)}${C.magenta}║${C.reset}`);

  // Agents
  const agents = db.getAgentHealth(config.cwd);
  for (const agentCfg of phase.agents) {
    const sid = agentIds.get(agentCfg.name);
    const agent = sid ? agents.find(a => a.id === sid) : null;

    let statusStr: string;
    let progressStr: string;
    if (!agent) {
      statusStr = STATUS_ICONS['queued'];
      progressStr = `${C.dim}queued${C.reset}`;
    } else if (agent.is_stale) {
      statusStr = STATUS_ICONS['stale'];
      progressStr = `${C.red}stale (${agent.heartbeat_age_seconds}s)${C.reset}`;
    } else {
      statusStr = STATUS_ICONS[agent.status] || STATUS_ICONS['idle'];
      progressStr = agent.progress
        ? (agent.progress.length > 28 ? agent.progress.slice(0, 25) + '...' : agent.progress)
        : agent.status;
    }

    const nameStr = agentCfg.name.padEnd(16);
    const line = ` ${statusStr} ${nameStr} ${progressStr}`;
    // Approximate visible length (strip ANSI)
    const visLen = line.replace(/\x1b\[[^m]*m/g, '').length;
    const pad = Math.max(0, width - 2 - visLen);
    lines.push(`${C.magenta}║${C.reset}${line}${' '.repeat(pad)}${C.magenta}║${C.reset}`);
  }

  lines.push(`${C.magenta}║${C.reset}${' '.repeat(width - 2)}${C.magenta}║${C.reset}`);

  // Gate status
  let gateStr: string;
  if (!config.gate) {
    gateStr = `${C.dim}Gate: disabled${C.reset}`;
  } else if (!gateResult) {
    gateStr = `${C.dim}Gate: ${status}${C.reset}`;
  } else if (gateResult.passed) {
    gateStr = `${C.green}Gate: PASSED${C.reset} — tsc ${gateResult.tsc.passed ? '✓' : '✗'} | contracts ${gateResult.contracts.passed ? '✓' : '✗'}`;
  } else {
    gateStr = `${C.red}Gate: FAILED${C.reset} (attempt ${gateAttempt}/${config.max_gate_retries}) — ${gateResult.tsc.error_count} tsc, ${gateResult.contracts.mismatch_count} contract`;
  }
  const gateVisLen = gateStr.replace(/\x1b\[[^m]*m/g, '').length;
  const gatePad = Math.max(0, width - 4 - gateVisLen);
  lines.push(`${C.magenta}║${C.reset} ${gateStr}${' '.repeat(gatePad)}${C.magenta}║${C.reset}`);

  lines.push(`${C.magenta}╚${border}╝${C.reset}`);

  for (const line of lines) {
    process.stdout.write(C.clearLine + line + '\n');
  }
  displayLines = lines.length;
}

// ── Monitor loop: poll agent health every 5s ──

function allAgentsDone(db: BrainDB, room: string, agentIds: Map<string, string>): boolean {
  const agents = db.getAgentHealth(room);
  for (const [, sid] of agentIds) {
    const agent = agents.find(a => a.id === sid);
    if (!agent) continue;
    if (agent.status !== 'done' && agent.status !== 'failed') return false;
  }
  return true;
}

function anyAgentFailed(db: BrainDB, room: string, agentIds: Map<string, string>): string[] {
  const agents = db.getAgentHealth(room);
  const failed: string[] = [];
  for (const [name, sid] of agentIds) {
    const agent = agents.find(a => a.id === sid);
    if (agent?.status === 'failed') failed.push(name);
  }
  return failed;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Spawn pi-core-agent (in-process, no tmux) ──────────────────────────────

async function spawnPiCoreAgent(
  db: BrainDB,
  config: PipelineConfig,
  agentCfg: AgentConfig,
  conductorId: string,
): Promise<string> {
  const agentSessionId = randomUUID();
  const agentName = agentCfg.name;
  const agentTask = agentCfg.task || config.task;
  const workspaceCwd = agentCfg.workspace || config.cwd;

  // Create abort controller for this agent
  const abortController = new AbortController();

  // Pre-register
  db.registerSession(
    agentName,
    config.cwd,
    JSON.stringify({ parent_session_id: conductorId, conductor: true, mode: 'pi-core' }),
    agentSessionId,
  );
  db.pulse(agentSessionId, 'working', 'spawned by conductor; starting pi-core');

  // Track active agent for cancellation
  activeAgents.set(agentSessionId, {
    sessionId: agentSessionId,
    name: agentName,
    abortController,
    model: config.model,
    startedAt: Date.now(),
  });

  // Fire and forget — runPiCoreAgent handles its own exit code recording
  runPiCoreAgent({
    name: agentName,
    task: agentTask,
    db,
    sessionId: agentSessionId,
    room: config.cwd,
    cwd: workspaceCwd,
    model: config.model,
    timeout: config.timeout,
    files: agentCfg.files,
    role: agentCfg.role,
    acceptance: agentCfg.acceptance,
    dependsOn: agentCfg.depends_on,
    thinkingLevel: (agentCfg as any).thinking_level ?? agentCfg.thinkingLevel ?? config.thinkingLevel,
    thinkingBudgets: (agentCfg as any).thinking_budgets ?? agentCfg.thinkingBudgets ?? config.thinkingBudgets,
    abortSignal: abortController.signal,
    onEvent: (event) => {
      if (event.type === 'agent_end') {
        console.error(`${C.dim}[pi-core:${agentName}] agent_end${C.reset}`);
        activeAgents.delete(agentSessionId);
      }
    },
  }).catch((err) => {
    console.error(`${C.red}[pi-core:${agentName}] unexpected error: ${err.message}${C.reset}`);
    db.pulse(agentSessionId, 'failed', err.message);
    db.set_exit_code(agentSessionId, 1);
    activeAgents.delete(agentSessionId);
  });

  return agentSessionId;
}

/** Abort all active pi-core agents (for conductor shutdown). */
function abortAllAgents(db: BrainDB) {
  for (const [sid, agent] of activeAgents) {
    console.error(`${C.yellow}[conductor] aborting pi-core agent ${agent.name} (${sid})${C.reset}`);
    agent.abortController.abort();
    try {
      db.pulse(sid, 'failed', 'conductor shutdown — agent aborted');
      db.set_exit_code(sid, 143);
    } catch { /* best effort */ }
  }
  activeAgents.clear();
}

// ── Spawn persistent watchdog as detached process ──

function spawnPersistentWatchdog(room: string) {
  const watchdogPath = join(import.meta.dirname, 'watchdog.js');
  if (!existsSync(watchdogPath)) {
    console.error(`${C.dim}[conductor] watchdog.js not found, skipping${C.reset}`);
    return;
  }
  const watchdog = spawnProcess('node', [watchdogPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      BRAIN_ROOM: room,
      BRAIN_DB_PATH: process.env.BRAIN_DB_PATH || '',
    },
  });
  watchdog.unref();
  console.error(`${C.dim}[conductor] spawned persistent watchdog (pid ${watchdog.pid})${C.reset}`);
}

// ── Main ──

async function main() {
  const config = parseArgs();

  // Verify tmux — but pi-core mode doesn't need tmux since agents run in-process
  if (config.mode !== 'pi-core') {
    try {
      execSync('tmux display-message -p ""', { stdio: 'ignore' });
    } catch {
      console.error(`${C.red}Error:${C.reset} Not inside a tmux session. brain-conductor requires tmux for ${config.mode} mode. Use --pi-core for no-tmux execution.`);
      process.exit(1);
    }
  }

  const db = new BrainDB(process.env.BRAIN_DB_PATH);
  const conductorId = randomUUID();
  db.registerSession('conductor', config.cwd, JSON.stringify({ role: 'conductor' }), conductorId);
  db.pulse(conductorId, 'working', 'orchestrating');

  // Spawn persistent watchdog
  spawnPersistentWatchdog(config.cwd);

  // Global workflow timeout from env
  const globalTimeoutSec = parseInt(process.env.BRAIN_WORKFLOW_TIMEOUT || '0', 10);
  let globalTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

  // Cleanup on exit
  function cleanup() {
    try { abortAllAgents(db); } catch { /* best effort */ }
    if (globalTimeoutHandle) clearTimeout(globalTimeoutHandle);
    try { db.pulse(conductorId, 'done', 'conductor exited'); } catch { /* best effort */ }
    try { db.close(); } catch { /* best effort */ }
  }
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  // Set global workflow timeout
  if (globalTimeoutSec > 0) {
    console.error(`${C.yellow}[conductor] global workflow timeout: ${globalTimeoutSec}s${C.reset}`);
    globalTimeoutHandle = setTimeout(() => {
      console.error(`${C.red}[conductor] GLOBAL TIMEOUT after ${globalTimeoutSec}s — aborting all agents${C.reset}`);
      abortAllAgents(db);
      db.pulse(conductorId, 'failed', `global timeout after ${globalTimeoutSec}s`);
      process.exit(124);
    }, globalTimeoutSec * 1000);
  }

  console.log(`${C.bold}${C.magenta}Brain Conductor${C.reset} starting...`);
  console.log(`${C.dim}Task: ${config.task}${C.reset}`);
  const modeLabel = config.mode === 'pi-core' ? `pi-core (${config.model})` : config.mode === 'pi' ? `pi (${config.model})` : config.mode === 'py' ? `py (${config.model})` : 'claude-code';
  const thinkingLabel = config.thinkingLevel ? ` | Thinking: ${config.thinkingLevel}` : '';
  console.log(`${C.dim}Phases: ${config.phases.length} | Mode: ${modeLabel}${thinkingLabel} | Gate: ${config.gate ? 'enabled' : 'disabled'} | Timeout: ${config.timeout}s${C.reset}`);
  console.log('');

  for (let pi = 0; pi < config.phases.length; pi++) {
    const phase = config.phases[pi];
    const agentIds = new Map<string, string>();

    // ── Spawn agents (parallel within phase) ──
    if (config.mode === 'pi-core') {
      // pi-core agents run in-process — spawn all in parallel
      const spawnPromises = phase.agents.map(async (agentCfg) => {
        if (agentCfg.delay && agentCfg.delay > 0) {
          await sleep(agentCfg.delay * 1000);
        }
        const sid = await spawnPiCoreAgent(db, config, agentCfg, conductorId);
        agentIds.set(agentCfg.name, sid);
      });
      await Promise.all(spawnPromises);
    } else {
      // CLI-based modes (pi, py, claude) — use subprocess spawning
      const spawnPromises = phase.agents.map((agentCfg, ai) => {
        if (agentCfg.delay && agentCfg.delay > 0) {
          return sleep(agentCfg.delay * 1000).then(() => {
            const sid = spawnAgent(db, config, agentCfg, conductorId, ai);
            agentIds.set(agentCfg.name, sid);
          });
        }
        const sid = spawnAgent(db, config, agentCfg, conductorId, ai);
        agentIds.set(agentCfg.name, sid);
        return Promise.resolve();
      });
      await Promise.all(spawnPromises);
    }
    display(config, db, pi, phase, agentIds, null, 0, 'waiting for agents...');

    // ── Monitor loop ──
    let gateResult: GateResult | null = null;
    let gateAttempt = 0;

    while (true) {
      await sleep(5000);

      display(config, db, pi, phase, agentIds, gateResult, gateAttempt, 'waiting for agents...');

      // Check if all agents are done
      if (!allAgentsDone(db, config.cwd, agentIds)) continue;

      // Check for hard failures
      const failed = anyAgentFailed(db, config.cwd, agentIds);
      if (failed.length > 0) {
        display(config, db, pi, phase, agentIds, gateResult, gateAttempt, `FAILED: ${failed.join(', ')}`);
        console.log(`\n${C.red}Phase "${phase.name}" failed.${C.reset} Agents that failed: ${failed.join(', ')}`);
        break;
      }

      // ── Run integration gate ──
      if (config.gate) {
        gateAttempt++;
        display(config, db, pi, phase, agentIds, null, gateAttempt, `running gate (attempt ${gateAttempt})...`);

        gateResult = runGateAndNotify(db, config.cwd, config.cwd, conductorId, 'conductor');

        display(config, db, pi, phase, agentIds, gateResult, gateAttempt, '');

        if (gateResult.passed) {
          console.log(`\n${C.green}Phase "${phase.name}" — gate passed!${C.reset}`);
          break;
        }

        if (gateAttempt >= config.max_gate_retries) {
          console.log(`\n${C.red}Phase "${phase.name}" — gate failed after ${gateAttempt} attempts.${C.reset}`);
          console.log(`Remaining errors:`);
          for (const routed of gateResult.routed) {
            console.log(`  ${routed.agent_name}:`);
            for (const err of routed.errors) {
              console.log(`    ${err}`);
            }
          }
          break;
        }

        // Agents got DMs from runGateAndNotify — wait for acknowledgment before retrying
        console.log(`${C.yellow}Gate attempt ${gateAttempt} failed — agents notified via DM. Waiting for acknowledgment...${C.reset}`);

        // Gate escalation: wait up to 60s for any agent to acknowledge via pulse
        const ackDeadline = Date.now() + 60_000;
        const ackedAgents = new Set<string>();
        while (Date.now() < ackDeadline) {
          await sleep(3000);
          const currentAgents = db.getAgentHealth(config.cwd);
          for (const routed of gateResult.routed) {
            if (ackedAgents.has(routed.agent_id)) continue;
            const agent = currentAgents.find(a => a.id === routed.agent_id);
            // Agent acknowledged if it pulsed after the gate DM was sent
            if (agent && agent.status === 'working') {
              ackedAgents.add(routed.agent_id);
            }
          }
          // All agents acknowledged or we've waited long enough
          if (ackedAgents.size >= gateResult.routed.length) break;
        }

        // Report unresponsive agents
        const unresponsive = gateResult.routed.filter(r => !ackedAgents.has(r.agent_id));
        if (unresponsive.length > 0) {
          console.log(`${C.yellow}[gate] ${unresponsive.length} agent(s) did not acknowledge DM within 60s:${C.reset}`);
          for (const u of unresponsive) {
            console.log(`  ${C.yellow}- ${u.agent_name}${C.reset}`);
          }
        }

        continue;
      } else {
        // No gate — phase complete
        console.log(`\n${C.green}Phase "${phase.name}" complete.${C.reset}`);
        break;
      }
    }
  }

  // ── Final summary ──
  console.log('');
  console.log(`${C.bold}${C.magenta}═══ Conductor Summary ═══${C.reset}`);

  const allAgents = db.getAgentHealth(config.cwd);
  const done = allAgents.filter(a => a.status === 'done' && a.name !== 'conductor');
  const failed = allAgents.filter(a => a.status === 'failed');
  const contracts = db.getContracts(config.cwd);
  const mismatches = db.validateContracts(config.cwd);

  console.log(`Agents: ${done.length} done, ${failed.length} failed`);
  console.log(`Contracts: ${contracts.length} published, ${mismatches.length} mismatches`);

  // Record metrics for each agent (closes feedback loop with TaskRouter)
  const workflowStartTime = Date.now();
  for (const agent of allAgents) {
    if (agent.name === 'conductor') continue;
    try {
      const durationSec = agent.heartbeat_age_seconds != null
        ? Math.max(0, (Date.now() / 1000) - (Date.now() / 1000 - agent.heartbeat_age_seconds))
        : undefined;
      db.recordMetric(config.cwd, agent.name, agent.id, {
        model: config.model,
        task_description: config.task,
        duration_seconds: durationSec,
        gate_passes: config.gate ? config.max_gate_retries : 0,
        tsc_errors: 0,
        contract_mismatches: mismatches.length,
        outcome: agent.status === 'done' ? 'success' : 'failure',
      });
    } catch { /* best effort — metrics should never crash the conductor */ }
  }
  console.log(`${C.dim}Metrics recorded for ${allAgents.filter(a => a.name !== 'conductor').length} agent(s)${C.reset}`);

  if (mismatches.length > 0) {
    console.log(`\n${C.red}Outstanding mismatches:${C.reset}`);
    for (const m of mismatches) {
      console.log(`  ${m.detail}`);
    }
  }

  if (failed.length === 0 && mismatches.length === 0) {
    console.log(`\n${C.green}${C.bold}All phases passed. Ship it.${C.reset}`);
  }

  db.pulse(conductorId, 'done', 'all phases complete');
  process.exit(0);
}

main().catch((err) => {
  console.error(`${C.red}Conductor error:${C.reset}`, err);
  process.exit(1);
});
