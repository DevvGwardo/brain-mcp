export const MAX_RESPAWN_ATTEMPTS = 5;
export const ESCALATION_THRESHOLD = 3;

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 16000;

export const BACKOFF_BASE_SEC = 15;
export const BACKOFF_MAX_SEC = 300;

export const STARTUP_GRACE_MS = 1500;
export const STARTUP_GRACE_BY_RUNTIME = {
  claude: 8000,
  hermes: 5000,
  codex: 8000,
  pi: 1500,
  py: 1500,
} as const;

// mkdtempSync prefix for per-spawn private temp dirs (mode 0o700).
// All bash watchers + spawn-recovery wrappers create one of these and
// place their files inside instead of using predictable /tmp paths.
export const SPAWN_TMP_PREFIX = 'brain-spawn-';

// Default ceiling for any spawned agent's lifetime. 0 = no timeout (the
// previous behavior). Defensive default: 30 minutes prevents forgotten
// interactive panes (e.g. pi without --print, claude that didn't /exit)
// from sitting in tmux indefinitely. Override per-spawn via the
// timeout/agentTimeout argument or globally via BRAIN_DEFAULT_AGENT_TIMEOUT.
export const DEFAULT_AGENT_TIMEOUT_SEC = 1800;

export function defaultAgentTimeoutSec(): number {
  const raw = process.env.BRAIN_DEFAULT_AGENT_TIMEOUT;
  if (!raw) return DEFAULT_AGENT_TIMEOUT_SEC;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AGENT_TIMEOUT_SEC;
}
