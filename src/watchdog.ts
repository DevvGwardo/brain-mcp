#!/usr/bin/env node
/**
 * Brain Persistent Watchdog — survives lead session crashes.
 * Runs as a detached child process, checks for stale agents every 15s.
 *
 * Enhanced with:
 * 1. Auto-respawn: <30s = spawn failure, <120s = crash
 * 2. Process table verification via PID lookup
 * 3. Recovery context building from dead agent's state
 * 4. Escalation for repeated failures with backoff
 */

import { BrainDB } from './db.js';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildRecoveryContext,
  formatRecoveryReport,
  markGhostSession,
  type RecoveryContext,
} from './spawn-recovery.js';

const dbPath = process.env.BRAIN_DB_PATH || `${process.env.HOME}/.claude/brain/brain.db`;
const room = process.env.BRAIN_ROOM || process.cwd();
const pollInterval = 15000; // 15 seconds

// Thresholds
const SPAWN_FAILURE_THRESHOLD_SEC = 30;  // Agent died within 30s of creation → spawn failure
const CRASH_THRESHOLD_SEC = 120;          // Agent died within 120s → crash (not spawn failure)
const VERY_STALE_THRESHOLD_SEC = 300;     // 5 minutes — prune territory
const MAX_RESPAWN_ATTEMPTS = 5;
const ESCALATION_THRESHOLD = 3;            // Escalate after 3 failures
const BACKOFF_BASE_SEC = 15;              // Exponential backoff base
const BACKOFF_MAX_SEC = 300;              // 5 minute max backoff
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const TEMP_FILE_PATTERNS = [
  'brain-prompt-',
  'brain-swarm-',
  'brain-watch-',
  'brain-exit-',
  'brain-pid-',
  'brain-agent-',
];

// In-memory tracking (survives across watchdog cycles)
interface AgentFailureRecord {
  agentId: string;
  agentName: string;
  failureCount: number;
  lastFailureAt: number;        // Unix ms
  lastSpawnedAt: number | null; // Unix ms — when we (or conductor) spawned it
  backoffUntil: number;         // Unix ms — don't respawn before this
  deathType: 'spawn_failure' | 'crash' | 'unknown';
}

const failureTracker = new Map<string, AgentFailureRecord>();

function log(msg: string) {
  console.error(`[watchdog ${new Date().toISOString()}] ${msg}`);
}

// ── Temp file cleanup ─────────────────────────────────────────────────────────

/**
 * Remove stale brain-mcp temp files older than TEMP_FILE_MAX_AGE_MS.
 * Called periodically by the watchdog to sweep up after crashed/killed processes.
 */
function cleanupStaleTempFiles(): number {
  let removed = 0;
  const now = Date.now();
  try {
    const files = readdirSync(tmpdir());
    for (const file of files) {
      if (!TEMP_FILE_PATTERNS.some(p => file.startsWith(p))) continue;
      const filePath = join(tmpdir(), file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
          unlinkSync(filePath);
          removed++;
        }
      } catch { /* skip inaccessible files */ }
    }
  } catch { /* tmpdir may not exist in some envs */ }
  return removed;
}

// ── Process table checking ───────────────────────────────────────────────────

/**
 * Check if a process with the given PID is actually running.
 * Returns true if the process exists and is not a zombie.
 */
function isProcessAlive(pid: number): boolean {
  try {
    // Use ps to check process state — 'Z' = zombie
    const output = execSync(`ps -o state= -p ${pid} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    const state = output.trim();
    // State is single letter: S=sleeping, R=running, I=idle, Z=zombie, etc.
    return state !== 'Z' && state !== '';
  } catch {
    // Process doesn't exist or ps failed
    return false;
  }
}

/**
 * Get detailed process info for an agent.
 */
function getProcessInfo(pid: number): { alive: boolean; state: string; cmd: string } | null {
  try {
    const stateOut = execSync(`ps -o state= -p ${pid} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
    const cmdOut = execSync(`ps -o comm= -p ${pid} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
    return {
      alive: stateOut !== 'Z' && stateOut !== '',
      state: stateOut,
      cmd: cmdOut,
    };
  } catch {
    return null;
  }
}

// Recovery context building delegated to spawn-recovery.ts

// ── Failure tracking ──────────────────────────────────────────────────────────

function getOrCreateFailureRecord(agentId: string, agentName: string): AgentFailureRecord {
  if (!failureTracker.has(agentId)) {
    failureTracker.set(agentId, {
      agentId,
      agentName,
      failureCount: 0,
      lastFailureAt: 0,
      lastSpawnedAt: null,
      backoffUntil: 0,
      deathType: 'unknown',
    });
  }
  return failureTracker.get(agentId)!;
}

function recordFailure(record: AgentFailureRecord, deathType: 'spawn_failure' | 'crash'): void {
  record.failureCount++;
  record.lastFailureAt = Date.now();
  record.deathType = deathType;

  // Exponential backoff: 15s, 30s, 60s, 120s, 240s...
  const backoffMs = Math.min(
    BACKOFF_BASE_SEC * Math.pow(2, record.failureCount - 1) * 1000,
    BACKOFF_MAX_SEC * 1000,
  );
  record.backoffUntil = Date.now() + backoffMs;
}

function shouldEscalate(record: AgentFailureRecord): boolean {
  return record.failureCount >= ESCALATION_THRESHOLD;
}

function shouldStopRetrying(record: AgentFailureRecord): boolean {
  return record.failureCount >= MAX_RESPAWN_ATTEMPTS;
}

// ── Agent respawn ─────────────────────────────────────────────────────────────

interface RespawnResult {
  spawned: boolean;
  reason: string;
  newSessionId?: string;
}

/**
 * Attempt to respawn a dead agent.
 * For the watchdog, we can't fully replay the original agent config,
 * so we post a respawn request to the alerts channel for a conductor/orchestrator to handle.
 * We also record a checkpoint with recovery context for the next agent.
 */
async function attemptRespawn(
  agentId: string,
  agentName: string,
  record: AgentFailureRecord,
): Promise<RespawnResult> {
  const now = Date.now();

  // Check backoff
  if (now < record.backoffUntil) {
    return {
      spawned: false,
      reason: `backoff until ${new Date(record.backoffUntil).toISOString()} (attempt ${record.failureCount}/${MAX_RESPAWN_ATTEMPTS})`,
    };
  }

  if (shouldStopRetrying(record)) {
    return {
      spawned: false,
      reason: `max retries (${MAX_RESPAWN_ATTEMPTS}) exceeded — not retrying`,
    };
  }

  // Build and save recovery context
  const recoveryCtx = buildRecoveryContext(db, agentId, agentName, room);
  try {
    db.saveCheckpoint(room, agentId, agentName, {
      current_task: `Recovery checkpoint after ${record.deathType} (attempt ${record.failureCount})`,
      files_touched: [],
      decisions: [`Previous agent crashed with death_type=${record.deathType}`],
      progress_summary: recoveryCtx.taskState.last_progress || 'unknown',
      blockers: [`Previous agent died: ${record.deathType}`],
      next_steps: ['Assess recovery context and decide whether to respawn'],
    });
  } catch (e) {
    log(`Failed to save recovery checkpoint: ${e}`);
  }

  // Post respawn request — conductor or manual intervention handles actual spawning
  const isEscalation = shouldEscalate(record);
  const priority = isEscalation ? 'ESCALATED' : 'normal';
  const escalationNote = isEscalation
    ? ` [ESCALATED after ${record.failureCount} failures — manual review recommended]`
    : '';

  db.postMessage(
    'alerts',
    room,
    'watchdog',
    'watchdog',
    `RESPAWN_REQUEST [${priority}] agent=${agentName} previous_id=${agentId} death_type=${record.deathType} ` +
    `attempt=${record.failureCount}/${MAX_RESPAWN_ATTEMPTS} backoff_sec=${BACKOFF_BASE_SEC * Math.pow(2, record.failureCount - 1)}` +
    `${escalationNote}` +
    `\n\nRecovery context:\n${formatRecoveryReport(recoveryCtx)}`,
  );

  record.lastSpawnedAt = now;

  return {
    spawned: true,
    reason: `respawn request posted (${record.deathType}, attempt ${record.failureCount})`,
    newSessionId: undefined, // Conductor will assign new ID
  };
}

// ── Main watchdog loop ────────────────────────────────────────────────────────

const db = new BrainDB(dbPath);
let lastStaleAlerts: string[] = [];
let cleanupCycleCounter = 0;

async function main() {
  log(`Starting enhanced watchdog for room: ${room}, db: ${dbPath}`);
  log(`Thresholds: spawn_failure<${SPAWN_FAILURE_THRESHOLD_SEC}s, crash<${CRASH_THRESHOLD_SEC}s`);

  while (true) {
    try {
      await new Promise(r => setTimeout(r, pollInterval));

      const agents = db.getAgentHealth(room);
      const conductorAgent = agents.find(a => a.name.includes('conductor') || a.name === 'conductor');
      const otherAgents = agents.filter(a => a.id !== conductorAgent?.id);

      // ── Step 1: Check for newly stale agents ─────────────────────────────
      const newlyStale = otherAgents.filter(a => a.is_stale && !lastStaleAlerts.includes(a.id));
      if (newlyStale.length > 0) {
        log(`Detected stale agents: ${newlyStale.map(a => `${a.name}(${a.heartbeat_age_seconds}s)`).join(', ')}`);

        for (const agent of newlyStale) {
          db.postMessage(
            'alerts',
            room,
            'watchdog',
            'watchdog',
            `STALE: ${agent.name} (${agent.heartbeat_age_seconds}s since heartbeat, status=${agent.status})`,
          );
        }

        lastStaleAlerts = [...lastStaleAlerts, ...newlyStale.map(a => a.id)];
      }

      // ── Step 2: Check for dead/stale agents needing respawn ──────────────
      for (const agent of otherAgents) {
        if (agent.status === 'working' && agent.heartbeat_age_seconds > 60) {
          // Get the session to check PID
          const session = db.getSession(agent.id);
          let processAlive = false;
          let processInfo: ReturnType<typeof getProcessInfo> | null = null;

          if (session?.pid) {
            processInfo = getProcessInfo(session.pid);
            processAlive = processInfo !== null && processInfo.alive;
          }

          if (!processAlive) {
            // Process is confirmed dead — determine death type
            const record = getOrCreateFailureRecord(agent.id, agent.name);
            const age = agent.heartbeat_age_seconds;

            // Determine death type based on how long the agent lived
            // If we know when it was created (lastSpawnedAt), use that.
            // Otherwise infer from heartbeat age vs spawn time in session.
            let deathType: 'spawn_failure' | 'crash';

            if (record.lastSpawnedAt) {
              // We tracked when we last attempted respawn
              const lifespanSec = (Date.now() - record.lastSpawnedAt) / 1000;
              deathType = lifespanSec < SPAWN_FAILURE_THRESHOLD_SEC ? 'spawn_failure' : 'crash';
            } else {
              // First death — infer from heartbeat age
              // If agent was stale very quickly after creation, it's a spawn failure
              const sessionCreated = session?.created_at ? new Date(session.created_at).getTime() : 0;
              const lifespanMs = Date.now() - sessionCreated;
              const lifespanSec = lifespanMs / 1000;

              if (lifespanSec < SPAWN_FAILURE_THRESHOLD_SEC) {
                deathType = 'spawn_failure';
              } else {
                deathType = 'crash';
              }
            }

            // Skip if we're in backoff
            if (Date.now() < record.backoffUntil) {
              log(`Agent ${agent.name} in backoff until ${new Date(record.backoffUntil).toISOString()}`);
              continue;
            }

            if (shouldStopRetrying(record)) {
              log(`Agent ${agent.name} exceeded max retries (${MAX_RESPAWN_ATTEMPTS}) — skipping`);
              db.postMessage(
                'alerts',
                room,
                'watchdog',
                'watchdog',
                `AGENT_STOPPED: ${agent.name} — max retries exceeded after ${record.failureCount} failures. Manual intervention required.`,
              );
              continue;
            }

            recordFailure(record, deathType);

            const severity = shouldEscalate(record) ? 'ESCALATED' : 'WARN';
            log(`[${severity}] Agent ${agent.name} confirmed dead (${deathType}, pid=${session?.pid}, processAlive=${processAlive}, attempt ${record.failureCount})`);

            // ── CRITICAL FIX: Mark the session as 'failed' with exit code.
            // Previously this was missing — sessions stuck at 'working' forever (ghost sessions).
            db.markDone(
              agent.id,
              -1, // Unknown exit code — process is already gone; we infer failure.
              true, // failed=true
              `watchdog confirmed dead: ${deathType}, pid=${session?.pid ?? 'unknown'}`,
            );

            // Build recovery context and attempt respawn
            const recoveryCtx = buildRecoveryContext(db, agent.id, agent.name, room);
            const respawnResult = await attemptRespawn(agent.id, agent.name, record);

            log(`Respawn ${respawnResult.spawned ? 'succeeded' : 'skipped'}: ${respawnResult.reason}`);
          }
        }
      }

      // ── Step 3: Clean up tracking for agents that recovered ──────────────
      lastStaleAlerts = lastStaleAlerts.filter(id => {
        const agent = agents.find(a => a.id === id);
        return agent && agent.is_stale;
      });

      // ── Step 4: Periodic health summary ──────────────────────────────────
      const now = Date.now();
      const workingAgents = otherAgents.filter(a => a.status === 'working');
      const staleWorking = workingAgents.filter(a => a.is_stale);

      if (staleWorking.length > 0) {
        log(`Health: ${workingAgents.length} working, ${staleWorking.length} stale+working (potential zombies)`);
      }

      // ── Step 5: Temp file cleanup (every ~60s) ─────────────────────────────
      cleanupCycleCounter++;
      if (cleanupCycleCounter >= 4) {
        cleanupCycleCounter = 0;
        const removed = cleanupStaleTempFiles();
        if (removed > 0) {
          log(`Cleaned up ${removed} stale temp file(s)`);
        }
      }

    } catch (err) {
      log(`Error in watchdog loop: ${err}`);
    }
  }
}

main().catch(err => {
  console.error(`Watchdog fatal error: ${err}`);
  process.exit(1);
});
