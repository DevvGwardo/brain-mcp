/**
 * spawn-recovery.ts — Error recovery system for brain-mcp agent spawning.
 *
 * Provides:
 * 1. ErrorDetection  — catches shell/CLI failures that slip through detached spawn
 * 2. RetryWithBackoff — exponential backoff for transient spawn failures
 * 3. CrashRecovery   — pre-spawn checkpoint + recovery context building
 * 4. EscalationProtocol — consecutive failure tracking + alert escalation
 *
 * Integrates into: brain_wake (headless + tmux modes), swarm spawn path
 */

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentFailureRecord as PersistedAgentFailure, BrainDB } from './db.js';
import { createServerLogger } from './server-log.js';
import { isProcessAlive } from './tmux-runtime.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 16000;
const ESCALATION_THRESHOLD = 3; // alerts after 3 consecutive failures
const MAX_RESPAWN_ATTEMPTS = 5;  // stop retrying after 5
const STARTUP_GRACE_MS = 1500;

export type DeathType = 'spawn_failure' | 'crash' | 'unknown';

export interface SpawnAttempt {
  attempt: number;
  timestamp: number;
  error?: string;
  exitCode?: number;
  pid?: number;
}

export interface SpawnFailureRecord {
  agentId: string;
  agentName: string;
  room: string;
  attempts: SpawnAttempt[];
  lastError?: string;
  backoffUntil: number;
  escalationLevel: number; // 0 = normal, 1 = warned, 2 = escalated
  deathType: DeathType;
}

// ── Error Detection ───────────────────────────────────────────────────────────

export interface SpawnError {
  code: 'ENOENT' | 'EACCES' | 'EINVALID' | 'ETIMEDOUT' | 'ECLI_ERROR' | 'EAUTH' | 'UNKNOWN';
  message: string;
  recoverable: boolean; // true = worth retrying, false = permanent failure
}

/**
 * Classify a spawn error to determine if it's recoverable.
 */
export function classifyError(err: NodeJS.ErrnoException): SpawnError {
  const code = err.code;
  const msg = err.message;

  if (code === 'ENOENT') {
    return {
      code: 'ENOENT',
      message: `Command not found: ${msg}`,
      recoverable: false, // CLI not installed — retrying won't help
    };
  }
  if (code === 'EACCES') {
    return {
      code: 'EACCES',
      message: `Permission denied: ${msg}`,
      recoverable: false, // needs system fix, not retry
    };
  }
  if (code === 'ETIMEDOUT' || code === 'ETIMEDOUT' || msg.includes('timeout')) {
    return {
      code: 'ETIMEDOUT',
      message: `Spawn timed out: ${msg}`,
      recoverable: true, // might succeed on retry with different args
    };
  }
  // ENOENT on the script itself — missing tmp file or broken path
  if (msg.includes('No such file') || msg.includes('not found')) {
    return {
      code: 'ENOENT',
      message: `Path not found: ${msg}`,
      recoverable: true, // race condition on tmp file creation
    };
  }
  return {
    code: 'UNKNOWN',
    message: msg,
    recoverable: true,
  };
}

/**
 * Classify early process failures captured from the spawned CLI's output.
 * This catches permanent auth/config problems that should not be retried.
 */
export function classifyProcessFailure(error?: string, exitCode?: number): SpawnError {
  const msg = (error || '').trim();

  if (/codex token refresh failed with status\s+401/i.test(msg)) {
    return {
      code: 'EAUTH',
      message: `Codex authentication failed (401). Run \`codex login\` and retry. Last output: ${msg}`,
      recoverable: false,
    };
  }

  if (/(authentication failed|not logged in|login required|invalid refresh token|unauthorized)/i.test(msg)) {
    return {
      code: 'EAUTH',
      message: `CLI authentication failed. Refresh credentials and retry. Last output: ${msg}`,
      recoverable: false,
    };
  }

  if (/\bcommand not found\b|not found:|no such file/i.test(msg)) {
    return {
      code: 'ENOENT',
      message: msg || `process exited with code ${exitCode ?? -1}`,
      recoverable: false,
    };
  }

  if (/permission denied/i.test(msg)) {
    return {
      code: 'EACCES',
      message: msg,
      recoverable: false,
    };
  }

  return {
    code: 'ECLI_ERROR',
    message: msg || `process exited with code ${exitCode ?? -1}`,
    recoverable: true,
  };
}

// ── Retry with Backoff ─────────────────────────────────────────────────────────

function computeBackoff(attempt: number): number {
  const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
  return Math.min(backoff, BACKOFF_MAX_MS);
}

/**
 * Sleep helper with backoff promise.
 */
async function backoffSleep(attempt: number): Promise<void> {
  const ms = computeBackoff(attempt);
  await new Promise((r) => setTimeout(r, ms));
}

// ── Failure Tracking ───────────────────────────────────────────────────────────

/**
 * Get or create a failure record for an agent.
 */
export function getOrCreateFailureRecord(
  db: BrainDB,
  agentId: string,
  agentName: string,
  room: string,
): SpawnFailureRecord {
  const row = db.failure_get(agentId);
  if (!row) {
    db.failure_record(agentId, {
      agent_name: agentName,
      death_type: 'unknown',
    });
    return {
      agentId,
      agentName,
      room,
      attempts: [],
      backoffUntil: 0,
      escalationLevel: 0,
      deathType: 'unknown',
    };
  }
  return failureRecordFromRow(row, room);
}

/**
 * Record a failed spawn attempt.
 */
export function recordSpawnFailure(
  db: BrainDB,
  record: SpawnFailureRecord,
  attempt: number,
  error?: string,
  exitCode?: number,
): void {
  record.attempts.push({
    attempt,
    timestamp: Date.now(),
    error,
    exitCode,
  });
  record.lastError = error;

  // Update death type based on pattern
  if (record.attempts.length === 1) {
    record.deathType = 'spawn_failure';
  }

  // Compute backoff
  const backoffMs = computeBackoff(record.attempts.length);
  record.backoffUntil = Date.now() + backoffMs;

  // Update escalation level
  if (record.attempts.length >= ESCALATION_THRESHOLD) {
    record.escalationLevel = 2; // escalated
  } else if (record.attempts.length >= 2) {
    record.escalationLevel = 1; // warned
  }

  db.failure_record(record.agentId, {
    agent_name: record.agentName,
    failure_count: record.attempts.length,
    last_failure_at: record.attempts[record.attempts.length - 1].timestamp,
    backoff_until: record.backoffUntil,
    escalation_level: record.escalationLevel,
    death_type: record.deathType,
  });
}

/**
 * Clear failure record on successful spawn.
 */
export function clearFailureRecord(db: BrainDB, agentId: string): void {
  db.failure_clear(agentId);
}

export function shouldStopRetrying(record: SpawnFailureRecord): boolean {
  return record.attempts.length >= MAX_RESPAWN_ATTEMPTS;
}

export function shouldEscalate(record: SpawnFailureRecord): boolean {
  return record.escalationLevel >= 2;
}

function failureRecordFromRow(row: PersistedAgentFailure, room: string): SpawnFailureRecord {
  const attempts: SpawnAttempt[] = [];
  for (let i = 0; i < row.failure_count; i++) {
    attempts.push({
      attempt: i + 1,
      timestamp: row.last_failure_at,
    });
  }
  return {
    agentId: row.agent_id,
    agentName: row.agent_name,
    room,
    attempts,
    backoffUntil: row.backoff_until,
    escalationLevel: row.escalation_level,
    deathType: row.death_type,
  };
}

// ── Crash Recovery ─────────────────────────────────────────────────────────────

export interface RecoveryContext {
  agentId: string;
  agentName: string;
  room: string;
  claims: string[];
  recentActivity: Array<{ type: string; summary: string; created_at: string }>;
  lastProgress?: string;
  taskState: { running_tasks: string[]; last_progress: string | null };
  metrics: { total: number; failures: number } | null;
}

/**
 * Build recovery context for a dead agent — preserves state for respawn.
 * Called before spawn to pre-save checkpoint, and by watchdog after crash.
 */
export function buildRecoveryContext(
  db: BrainDB,
  agentId: string,
  agentName: string,
  room: string,
): RecoveryContext {
  // Get claims owned by this agent
  const claims = db.getClaims(room).filter((c) => c.owner_id === agentId).map((c) => c.resource);

  // Get recent context entries for this agent
  const recentActivity = db
    .getContext(room, { session_id: agentId, limit: 10, order: 'desc' })
    .map((e) => ({
      type: e.entry_type,
      summary: e.summary,
      created_at: e.created_at,
    }));

  // Get session progress
  const session = db.getSession(agentId);
  const lastProgress = session?.progress || undefined;

  // Get recent task actions
  const runningTasks = db
    .getContext(room, { session_id: agentId, entry_type: 'action', limit: 5 })
    .map((e) => e.summary);

  // Get metrics
  const metricsRows = db.getMetrics(room, agentName, 100);
  const total = metricsRows.length;
  const failures = metricsRows.filter((m) => m.outcome === 'failed').length;

  return {
    agentId,
    agentName,
    room,
    claims,
    recentActivity,
    lastProgress,
    taskState: {
      running_tasks: runningTasks,
      last_progress: lastProgress || null,
    },
    metrics: total > 0 ? { total, failures } : null,
  };
}

/**
 * Save a pre-spawn checkpoint so recovery can reconstruct what we were trying to do.
 */
export function savePreSpawnCheckpoint(
  db: BrainDB,
  room: string,
  agentId: string,
  agentName: string,
  task: string,
): void {
  try {
    db.saveCheckpoint(room, agentId, agentName, {
      current_task: task,
      files_touched: [],
      decisions: ['Pre-spawn checkpoint — agent not yet started'],
      progress_summary: 'pending',
      blockers: [],
      next_steps: ['Agent spawning, wait for first heartbeat'],
    });
  } catch (e) {
    // Non-fatal — checkpoint is for recovery, not critical path
    createServerLogger({ component: 'spawn-recovery', room }).log(`failed to save pre-spawn checkpoint: ${e}`);
  }
}

/**
 * Format recovery context as a human-readable string for alerts.
 */
export function formatRecoveryReport(ctx: RecoveryContext): string {
  const lines: string[] = [
    `RECOVERY CONTEXT for ${ctx.agentName} (${ctx.agentId})`,
    `Room: ${ctx.room}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    '--- Claims ---',
    ctx.claims.length > 0 ? ctx.claims.join(', ') : '(none)',
    '',
    '--- Recent Activity ---',
  ];

  for (const entry of ctx.recentActivity.slice(0, 5)) {
    lines.push(`  [${entry.type}] ${entry.summary} (${entry.created_at})`);
  }

  lines.push('', '--- Task State ---');
  lines.push(
    `  Running tasks: ${ctx.taskState.running_tasks.length > 0 ? ctx.taskState.running_tasks.join(', ') : '(none)'}`,
  );
  lines.push(`  Last progress: ${ctx.taskState.last_progress || '(none)'}`);

  if (ctx.metrics) {
    lines.push('', '--- Metrics ---');
    lines.push(`  Total tasks: ${ctx.metrics.total}, Failures: ${ctx.metrics.failures}`);
  }

  return lines.join('\n');
}

// ── Spawn with Full Error Recovery ─────────────────────────────────────────────

export interface SpawnResult {
  success: boolean;
  pid?: number;
  error?: string;
  attempt: number;
  exitCode?: number;
  recoveryContext?: RecoveryContext;
}

interface StartupCheckResult {
  started: boolean;
  exitCode?: number;
  error?: string;
}

export interface SessionExitResolution {
  finalized: boolean;
  status?: 'done' | 'failed';
  progress?: string;
}

function readFailureDetails(logFile: string, exitCodeFile: string): { exitCode?: number; error?: string } {
  let exitCode: number | undefined;
  let error: string | undefined;

  if (existsSync(exitCodeFile)) {
    try {
      const raw = readFileSync(exitCodeFile, 'utf8').trim();
      if (raw !== '') exitCode = Number(raw);
    } catch { /* best effort */ }
  }

  if (existsSync(logFile)) {
    try {
      const logText = readFileSync(logFile, 'utf8').trim();
      if (logText) {
        const lines = logText.split('\n').slice(-5).join('\n').trim();
        if (lines) error = lines.slice(0, 300);
      }
    } catch { /* best effort */ }
  }

  return { exitCode, error };
}

export function reconcileSessionExit(
  db: BrainDB,
  sessionId: string,
  exitCode: number,
  detail?: string,
): SessionExitResolution {
  const session = db.getSession(sessionId);
  if (!session) return { finalized: false };

  const normalizedExitCode = Number.isFinite(exitCode) ? exitCode : -1;
  db.set_exit_code(sessionId, normalizedExitCode);

  if (session.status === 'done' || session.status === 'failed') {
    return {
      finalized: false,
      status: session.status,
      progress: session.progress || undefined,
    };
  }

  const work = db.getSessionWorkSummary(sessionId);
  const hasConfirmedWork = session.status === 'working' || work.didWork;

  if (normalizedExitCode === 0) {
    if (!hasConfirmedWork) {
      const progress = 'process exited before first heartbeat';
      db.markDone(sessionId, normalizedExitCode, true, progress);
      return { finalized: true, status: 'failed', progress };
    }

    const progress = work.didWork
      ? `process completed (exit 0, ${work.summary})`
      : 'process completed (exit 0)';
    db.markDone(sessionId, normalizedExitCode, false, progress);
    return { finalized: true, status: 'done', progress };
  }

  const progress = detail
    ? `process exited with code ${normalizedExitCode}: ${detail}`
    : `process exited with code ${normalizedExitCode}`;
  db.markDone(sessionId, normalizedExitCode, true, progress.slice(0, 1000));
  return { finalized: true, status: 'failed', progress };
}

export function waitForStartup(
  db: BrainDB,
  sessionId: string,
  proc: ReturnType<typeof spawn>,
  pid: number,
  logFile: string,
  exitCodeFile: string,
): Promise<StartupCheckResult> {
  return new Promise((resolve) => {
    let settled = false;
    let earlyExitCode: number | undefined;

    const finish = (result: StartupCheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener('error', onError);
      proc.removeListener('exit', onExit);
      resolve(result);
    };

    const onError = (err: NodeJS.ErrnoException) => {
      const classified = classifyError(err);
      finish({ started: false, error: classified.message });
    };

    const onExit = (code: number | null) => {
      earlyExitCode = code ?? -1;
      if (earlyExitCode === 0) {
        const session = db.getSession(sessionId);
        const work = db.getSessionWorkSummary(sessionId);
        const hasConfirmedWork = !!session && (
          session.status === 'working' ||
          session.status === 'done' ||
          session.status === 'failed' ||
          work.didWork
        );
        finish({
          started: hasConfirmedWork,
          exitCode: 0,
          error: hasConfirmedWork ? undefined : 'process exited before first heartbeat',
        });
        return;
      }
      const failure = readFailureDetails(logFile, exitCodeFile);
      finish({
        started: false,
        exitCode: failure.exitCode ?? earlyExitCode,
        error: failure.error ?? `exited with code ${failure.exitCode ?? earlyExitCode}`,
      });
    };

    const timer = setTimeout(() => {
      if (isProcessAlive(pid)) {
        finish({ started: true });
        return;
      }

      const failure = readFailureDetails(logFile, exitCodeFile);
      finish({
        started: false,
        exitCode: failure.exitCode ?? earlyExitCode ?? -1,
        error: failure.error ?? `exited with code ${failure.exitCode ?? earlyExitCode ?? -1}`,
      });
    }, STARTUP_GRACE_MS);

    proc.once('error', onError);
    proc.once('exit', onExit);
  });
}

/**
 * Spawn an agent process with full error recovery:
 * - Error detection (early stderr capture + error classification)
 * - Retry with exponential backoff
 * - Pre-spawn checkpoint + recovery context
 * - Escalation alerts on repeated failures
 *
 * Returns SpawnResult — caller decides what to do with it.
 */
export async function spawnWithRecovery(
  db: BrainDB,
  room: string,
  agentId: string,
  agentName: string,
  task: string,
  spawnCmd: string,
  logFile: string,
  onBeforeSpawn?: () => void,
): Promise<SpawnResult> {
  const record = getOrCreateFailureRecord(db, agentId, agentName, room);
  const ts = Date.now();
  const pidFile = join(tmpdir(), `brain-pid-${ts}-${agentName}.txt`);
  const exitCodeFile = join(tmpdir(), `brain-exit-${ts}-${agentName}.txt`);

  // Pre-spawn checkpoint — save what we're trying to do
  savePreSpawnCheckpoint(db, room, agentId, agentName, task);

  // Build the wrapper script that captures exit code + PID
  const watcherFile = join(tmpdir(), `brain-recovery-${ts}-${agentName}.sh`);
  const wrapperScript = [
    `#!/bin/bash`,
    `set -o pipefail`,
    `echo $$ > "${pidFile}"`,
    `${spawnCmd}`,
    `exit_code=$?`,
    `echo $exit_code > "${exitCodeFile}"`,
    `exit $exit_code`,
  ].join('\n');

  writeFileSync(watcherFile, wrapperScript, { mode: 0o755 });

  // Build recovery context while we're trying to spawn
  const recoveryCtx = buildRecoveryContext(db, agentId, agentName, room);

  // Retry loop with backoff
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Check backoff
    const now = Date.now();
    if (now < record.backoffUntil && attempt > 1) {
      const waitMs = record.backoffUntil - now;
      await new Promise((r) => setTimeout(r, waitMs));
    }

    onBeforeSpawn?.();

    let spawnedPid: number | null = null;

    try {
      const proc = spawn('bash', [watcherFile], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      spawnedPid = proc.pid ?? null;
      if (!spawnedPid) {
        throw new Error(`spawned process has no pid for ${agentName}`);
      }
      proc.unref();

      let startupConfirmed = false;
      const onFinalExit = (code: number | null) => {
        if (!startupConfirmed) return;
        const failure = readFailureDetails(logFile, exitCodeFile);
        reconcileSessionExit(
          db,
          agentId,
          failure.exitCode ?? code ?? -1,
          failure.error,
        );
      };
      proc.on('exit', onFinalExit);

      const startup = await waitForStartup(db, agentId, proc, spawnedPid, logFile, exitCodeFile);
      if (startup.started) {
        startupConfirmed = true;
        if (proc.exitCode !== null) {
          const failure = readFailureDetails(logFile, exitCodeFile);
          reconcileSessionExit(
            db,
            agentId,
            failure.exitCode ?? proc.exitCode ?? 0,
            failure.error,
          );
          proc.removeListener('exit', onFinalExit);
        }
        // Success — clear failure record
        clearFailureRecord(db, agentId);
        return { success: true, pid: spawnedPid!, attempt };
      }

      proc.removeListener('exit', onFinalExit);

      const errMsg = startup.error ?? `exited with code ${startup.exitCode ?? -1}`;
      const classified = classifyProcessFailure(errMsg, startup.exitCode);
      recordSpawnFailure(db, record, attempt, classified.message, startup.exitCode);

      if (!classified.recoverable) {
        try { unlinkSync(watcherFile); } catch { /* best effort */ }
        try { unlinkSync(pidFile); } catch { /* best effort */ }
        try { unlinkSync(exitCodeFile); } catch { /* best effort */ }
        return {
          success: false,
          error: classified.message,
          attempt,
          exitCode: startup.exitCode,
          recoveryContext: recoveryCtx,
        };
      }

      // Post alert if escalating
      if (shouldEscalate(record)) {
        postEscalationAlert(db, room, agentName, agentId, record, recoveryCtx);
      }
    } catch (err: any) {
      const classified = classifyError(err);
      recordSpawnFailure(db, record, attempt, classified.message);

      if (!classified.recoverable) {
        // Permanent failure — don't retry
        try { unlinkSync(watcherFile); } catch { /* best effort */ }
        try { unlinkSync(pidFile); } catch { /* best effort */ }
        try { unlinkSync(exitCodeFile); } catch { /* best effort */ }

        return {
          success: false,
          error: classified.message,
          attempt,
        };
      }
    }

    // Retry with backoff
    if (attempt < MAX_RETRIES) {
      await backoffSleep(attempt);
    }
  }

  // All retries exhausted
  try { unlinkSync(watcherFile); } catch { /* best effort */ }

  return {
    success: false,
    error: `Spawn failed after ${MAX_RETRIES} attempts: ${record.lastError}`,
    attempt: MAX_RETRIES,
    recoveryContext: recoveryCtx,
  };
}

// ── Escalation Protocol ────────────────────────────────────────────────────────

/**
 * Post an escalation alert to the brain alerts channel.
 */
function postEscalationAlert(
  db: BrainDB,
  room: string,
  agentName: string,
  agentId: string,
  record: SpawnFailureRecord,
  ctx: RecoveryContext,
): void {
  if (record.escalationLevel < 2) return; // only escalate at level 2

  const report = formatRecoveryReport(ctx);
  const backoffSec = Math.round((record.backoffUntil - Date.now()) / 1000);

  db.postMessage(
    'alerts',
    room,
    'spawn-recovery',
    'spawn-recovery',
    `ESCALATION [spawn-recovery] agent=${agentName} previous_id=${agentId} ` +
      `failures=${record.attempts.length} last_error="${record.lastError}" ` +
      `backoff_sec=${backoffSec > 0 ? backoffSec : 'none'}` +
      `\n\nRecovery context:\n${report}`,
  );
}

// ── Ghost session detection ────────────────────────────────────────────────────

/**
 * Mark a session as 'ghost' if it was queued but never produced a heartbeat.
 * Called by the sweepGhostSessions db method; exposed here for external callers.
 */
export function markGhostSession(db: BrainDB, agentId: string, agentName: string): void {
  // Use markDone instead of private pulse — sets exit_code and status to 'failed'
  db.markDone(agentId, -1, true, 'ghost: spawn succeeded but no heartbeat received');
}

// ── Cleanup helper ─────────────────────────────────────────────────────────────

export function cleanupSpawnTempFiles(patterns: string[] = [
  'brain-recovery-',
  'brain-pid-',
  'brain-exit-',
  'brain-prompt-',
  'brain-agent-',
]): number {
  let removed = 0;
  try {
    const { readdirSync, unlinkSync, statSync } = require('node:fs');
    const { join: j } = require('node:path');
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour

    for (const file of readdirSync(tmpdir())) {
      if (!patterns.some((p) => file.startsWith(p))) continue;
      const path = j(tmpdir(), file);
      try {
        const stat = statSync(path);
        if (now - stat.mtimeMs > maxAge) {
          unlinkSync(path);
          removed++;
        }
      } catch { /* skip */ }
    }
  } catch { /* tmpdir not accessible */ }
  return removed;
}
