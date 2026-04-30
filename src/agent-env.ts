/**
 * agent-env — explicit allowlist for env vars that propagate to spawned agents.
 *
 * Closes the leak in spawn-recovery.ts where `env: process.env` was leaking
 * deployment secrets (RAILWAY_TOKEN, GITHUB_TOKEN, CF_API_TOKEN, etc.) into
 * every agent process. Tmux-pane spawns also funnel through this helper so
 * the explicit list is the single source of truth — note that the tmux
 * server's own env is a separate leak surface and is out of scope here.
 */

export const AGENT_ENV_ALLOW: ReadonlyArray<string | RegExp> = [
  // POSIX baseline
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR',
  'LANG', 'TERM', 'TERMINFO',
  /^LC_/,

  // brain-mcp coordination
  /^BRAIN_/,

  // Hermes runtime + provider
  /^HERMES_/,
  'NOUS_API_KEY',

  // Claude / pi / codex / OpenRouter providers
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',

  // Node CLI binary lookup (pi, hermes, codex, claude code may probe this)
  'NPM_CONFIG_PREFIX',
];

function isAllowed(key: string): boolean {
  for (const rule of AGENT_ENV_ALLOW) {
    if (typeof rule === 'string' ? rule === key : rule.test(key)) return true;
  }
  return false;
}

/**
 * Filter `source` to AGENT_ENV_ALLOW, then merge `extras` (extras win on
 * conflict and bypass the allowlist — they are the caller's explicit choice).
 */
export function buildAgentEnv(
  extras: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v == null) continue;
    if (isAllowed(k)) out[k] = v;
  }
  for (const [k, v] of Object.entries(extras)) {
    if (v != null) out[k] = v;
  }
  return out;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Same as buildAgentEnv but returns shell-quoted `KEY='value'` strings, ready
 * to embed into `env ${parts.join(' ')} cmd ...` template literals.
 */
export function agentEnvShellPairs(
  extras: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
): string[] {
  const env = buildAgentEnv(extras, source);
  return Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)}`);
}
