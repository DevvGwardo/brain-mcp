import { execSync } from 'node:child_process';
import type { BrainDB, Session } from './db.js';

type ExecRunner = (command: string, options?: { encoding?: 'utf8'; stdio?: any }) => string | Buffer;

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runTmuxQuery(command: string, execRunner: ExecRunner = execSync): string | null {
  try {
    const output = execRunner(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return String(output).trim();
  } catch {
    return null;
  }
}

export function readTmuxTargetFromSession(session?: Pick<Session, 'metadata'> | null): string | null {
  if (!session?.metadata) return null;
  try {
    const parsed = JSON.parse(session.metadata);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const target = (parsed as Record<string, unknown>).tmux_target;
    return typeof target === 'string' && target.trim() ? target.trim() : null;
  } catch {
    return null;
  }
}

export function getTmuxPanePid(target: string, execRunner: ExecRunner = execSync): number | null {
  const raw = runTmuxQuery(
    `tmux display-message -p -t ${sh(target)} '#{pane_pid}'`,
    execRunner,
  );
  if (!raw) return null;
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function isTmuxTargetAlive(target: string, execRunner: ExecRunner = execSync): boolean {
  return runTmuxQuery(`tmux display-message -t ${sh(target)} -p ""`, execRunner) !== null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    // kill(pid, 0) treats zombies as alive; we rely on heartbeat staleness in watchdog.ts to catch that case.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerTmuxSessionRuntime(
  db: BrainDB,
  sessionId: string,
  target: string,
): number | null {
  const panePid = getTmuxPanePid(target);
  db.mergeSessionMetadata(sessionId, {
    spawn_transport: 'tmux',
    tmux_target: target,
    tmux_pane_pid: panePid,
  });
  db.setSessionPid(sessionId, panePid);
  return panePid;
}
