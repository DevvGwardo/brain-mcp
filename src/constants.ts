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
