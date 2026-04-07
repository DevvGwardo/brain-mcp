/**
 * Brain MCP Output Renderer
 *
 * Transforms raw JSON tool results into formatted, emoji-rich output.
 * Each tool has its own renderer for optimal presentation.
 * Falls back to structured JSON pretty-print for unknown tools.
 *
 * Usage:
 *   import { renderTool, renderers } from './renderer.js';
 *   const output = renderTool('brain_agents', jsonString);
 *   const output = renderTool('brain_wake', jsonString, { compact: true });
 */

// AgentStatus and SessionStatus from ./db.js (not currently imported — status strings are untyped)

// ── ANSI color codes ─────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',

  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  bgBlack: '\x1b[40m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m',
  bgBlue: '\x1b[44m',

  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
};

const dim = (text: string) => `${C.dim}${text}${C.reset}`;
const bold = (text: string) => `${C.bold}${text}${C.reset}`;
const color = (text: string, c: string) => `${c}${text}${C.reset}`;

// Strip all ANSI escape sequences from a string
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

// ── Tool emoji registry ───────────────────────────────────────────────────────

export const TOOL_EMOJI: Record<string, string> = {
  // Session
  brain_register: '🧠👤',
  brain_sessions: '🧠📋',
  brain_status: '🧠📊',
  brain_pulse: '🧠💓',

  // Communication
  brain_post: '🧠📨',
  brain_read: '🧠📖',
  brain_dm: '🧠✉️',
  brain_inbox: '🧠📬',

  // Agents
  brain_agents: '🧠🤖',
  brain_wake: '🧠🐝',
  brain_respawn: '🧠🔄',
  brain_swarm: '🧠🐝',

  // State store
  brain_set: '🧠💾',
  brain_get: '🧠🔍',
  brain_keys: '🧠🔑',
  brain_delete: '🧠🗑️',

  // Resource locking
  brain_claim: '🧠🔒',
  brain_release: '🧠🔓',
  brain_claims: '🧠📋',

  // Contracts
  brain_contract_set: '🧠📜',
  brain_contract_get: '🧠📜',
  brain_contract_check: '🧠✅',

  // Integration
  brain_gate: '🧠⚙️',
  brain_auto_gate: '🧠⚙️',
  brain_clear: '🧠🧹',

  // Context ledger
  brain_context_push: '🧠📝',
  brain_context_get: '🧠📖',
  brain_context_summary: '🧠📝',

  // Checkpoints
  brain_checkpoint: '🧠💾',
  brain_checkpoint_restore: '🧠♻️',

  // Memory
  brain_remember: '🧠🧠',
  brain_recall: '🧠🧠',
  brain_forget: '🧠🧹',

  // Planning
  brain_plan: '🧠📐',
  brain_plan_next: '🧠📐',
  brain_plan_update: '🧠📐',
  brain_plan_status: '🧠📐',

  // Metrics
  brain_metrics: '🧠📈',
  brain_metric_record: '🧠📈',

  // Git
  brain_commit: '🧠📸',
  brain_pr: '🧠🔀',
  brain_clean_branches: '🧠🧹',

  // Security
  brain_security_scan: '🧠🔍',

  // Feature dev
  brain_feature_dev: '🧠🚀',
};

const DEFAULT_EMOJI = '🧠';

function toolEmoji(toolName: string): string {
  return TOOL_EMOJI[toolName] ?? DEFAULT_EMOJI;
}

// ── Status rendering ──────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  idle: C.brightBlack,
  working: C.yellow,
  done: C.green,
  failed: C.red,
  stale: C.red,
  queued: C.brightBlack,
  ready: C.cyan,
  blocked: C.magenta,
};

function statusIcon(s: string): string {
  const icons: Record<string, string> = {
    idle: '○', working: '●', done: '✓', failed: '✗',
    stale: '?', queued: '◌', ready: '▶', blocked: '▣',
  };
  return color(icons[s] ?? '?', STATUS_COLOR[s] ?? C.white);
}

// ── Render options ────────────────────────────────────────────────────────────

export interface RenderOptions {
  /** Compact mode: single line when possible */
  compact?: boolean;
  /** Include raw JSON as fallback */
  includeRaw?: boolean;
  /** Color output (disable for non-TTY) */
  color?: boolean;
  /** Max agents/sessions to show in compact mode */
  maxItems?: number;
}

const DEFAULTS: Required<RenderOptions> = {
  compact: false,
  includeRaw: false,
  color: true,
  maxItems: 20,
};

function opts(o?: Partial<RenderOptions>): Required<RenderOptions> {
  return { ...DEFAULTS, ...o };
}

// ── Core render function ──────────────────────────────────────────────────────

export function renderTool(toolName: string, rawResult: string, options?: Partial<RenderOptions>): string {
  const o = opts(options);
  if (!o.color) {
    // Strip ANSI codes by rendering without color
    return renderToolRaw(toolName, rawResult, o);
  }

  try {
    const data = JSON.parse(rawResult);

    const renderer = TOOL_RENDERERS[toolName];
    if (renderer) {
      return renderer(data, o);
    }
    return renderGeneric(data, toolName, o);
  } catch {
    return renderFallback(rawResult, toolName, o);
  }
}

function renderToolRaw(toolName: string, rawResult: string, o: Required<RenderOptions>): string {
  const emoji = toolEmoji(toolName);
  const prefix = `${emoji} ${toolName}`;
  try {
    const data = JSON.parse(rawResult);
    const renderer = TOOL_RENDERERS[toolName];
    if (renderer) {
      // Render normally then strip ANSI codes for the color=false output
      const rendered = renderer(data, { ...o, color: true });
      return stripAnsi(rendered);
    }
    return `${prefix}\n${formatJSONRaw(data, 0)}`;
  } catch {
    return `${prefix}\n${rawResult}`;
  }
}

// ── Individual tool renderers ─────────────────────────────────────────────────

type ToolRenderer = (data: any, o: Required<RenderOptions>) => string;

const TOOL_RENDERERS: Partial<Record<string, ToolRenderer>> = {

  // ── Session / status ────────────────────────────────────────────────────────

  brain_register(data: any, o): string {
    const id = data.session_id ?? data.id ?? '?';
    const name = data.name ?? '?';
    return [
      `${toolEmoji('brain_register')} Session registered`,
      `  ${bold('ID')}: ${color(id, C.cyan)}`,
      `  ${bold('Name')}: ${color(name, C.green)}`,
      data.room ? `  ${bold('Room')}: ${data.room}` : '',
      data.registered_at ? `  ${bold('At')}: ${data.registered_at}` : '',
    ].filter(Boolean).join('\n');
  },

  brain_sessions(data: any, o): string {
    const sessions = data.sessions ?? [];
    const emoji = toolEmoji('brain_sessions');

    if (sessions.length === 0) {
      return `${emoji} No active sessions`;
    }

    const lines: string[] = [];
    if (!o.compact) {
      lines.push(`${emoji} ${bold(`${sessions.length} session${sessions.length !== 1 ? 's' : ''} in ${data.room ?? 'room'}`)}`);
      lines.push('');
    }

    const shown = sessions.slice(0, o.maxItems);
    for (const s of shown) {
      const sid = s.session_id ?? s.id ?? '?';
      const name = color(s.name ?? '?', C.brightWhite);
      const age = s.heartbeat_age_seconds ?? s.heartbeat_age ?? 0;
      const ageStr = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
      const status = s.status ?? 'idle';
      lines.push(`  ${statusIcon(status)} ${name}  ${dim(`(${sid.slice(0, 8)}..., ${ageStr})`)}`);
    }

    if (sessions.length > shown.length) {
      lines.push(`  ${dim(`... and ${sessions.length - shown.length} more`)}`);
    }

    return lines.join('\n');
  },

  brain_status(data: any, o): string {
    const emoji = toolEmoji('brain_status');
    const lines = [`${emoji} ${bold('Session Status')}`];

    if (data.session_id) lines.push(`  ${bold('ID')}: ${color(data.session_id.slice(0, 12) + '...', C.cyan)}`);
    if (data.name) lines.push(`  ${bold('Name')}: ${color(data.name, C.green)}`);
    if (data.status) lines.push(`  ${bold('Status')}: ${statusIcon(data.status)} ${data.status}`);
    if (data.room) lines.push(`  ${bold('Room')}: ${data.room}`);
    if (data.agent_count !== undefined) lines.push(`  ${bold('Agents')}: ${data.agent_count}`);
    if (data.message_count !== undefined) lines.push(`  ${bold('Messages')}: ${data.message_count}`);

    return lines.join('\n');
  },

  brain_pulse(data: any, o): string {
    if (data.ok) {
      return `${toolEmoji('brain_pulse')} ${color('Pulse recorded', C.green)}`;
    }
    return `${toolEmoji('brain_pulse')} ${color('Pulse failed: ' + (data.error ?? JSON.stringify(data)), C.red)}`;
  },

  // ── Agents ─────────────────────────────────────────────────────────────────

  brain_agents(data: any, o): string {
    const agents = data.agents ?? [];
    const emoji = toolEmoji('brain_agents');

    if (agents.length === 0) {
      return `${emoji} No agents registered`;
    }

    const counts: string[] = [];
    if (data.working > 0) counts.push(`${color(data.working, C.yellow)} working`);
    if (data.done > 0) counts.push(`${color(data.done, C.green)} done`);
    if (data.failed > 0) counts.push(`${color(data.failed, C.red)} failed`);
    if (data.stale > 0) counts.push(`${color(data.stale, C.red)} stale`);

    const header = counts.length > 0
      ? `${emoji} ${bold(`${agents.length} agent${agents.length !== 1 ? 's' : ''}`)} — ${counts.join(', ')}`
      : `${emoji} ${bold(`${agents.length} agent${agents.length !== 1 ? 's' : ''}`)}`;

    if (o.compact) {
      return header;
    }

    const lines = [header, ''];
    const shown = agents.slice(0, o.maxItems);

    for (const a of shown) {
      const name = color(a.name ?? '?', C.brightWhite);
      const status = a.status ?? 'idle';
      const stale = a.is_stale ? ` ${color('STALE', C.red)}` : '';
      const age = a.heartbeat_age_seconds ?? 0;
      const ageStr = age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`;
      const claims = a.held_claims?.length ? ` ${color(`[${a.held_claims.length} claims]`, C.cyan)}` : '';

      lines.push(`  ${statusIcon(status)} ${name}${stale}${claims}  ${dim(ageStr + ' ago')}`);
    }

    if (agents.length > shown.length) {
      lines.push(`  ${dim(`... and ${agents.length - shown.length} more`)}`);
    }

    return lines.join('\n');
  },

  brain_wake(data: any, o): string {
    const emoji = toolEmoji('brain_wake');
    const lines: string[] = [];

    if (data.ok) {
      lines.push(`${emoji} ${bold('Agent spawned')} ${color('✓', C.green)}`);
    } else {
      lines.push(`${emoji} ${bold('Agent spawn')} ${color('✗', C.red)}`);
      if (data.error) lines.push(`  ${color(data.error, C.red)}`);
      return lines.join('\n');
    }

    if (data.agent_id) lines.push(`  ${bold('ID')}: ${color(data.agent_id.slice(0, 12) + '...', C.cyan)}`);
    if (data.name) lines.push(`  ${bold('Name')}: ${color(data.name, C.green)}`);
    if (data.layout) lines.push(`  ${bold('Layout')}: ${data.layout}`);
    if (data.model) lines.push(`  ${bold('Model')}: ${dim(data.model)}`);
    if (data.task) lines.push(`  ${bold('Task')}: ${dim(data.task.slice(0, 80) + (data.task.length > 80 ? '...' : ''))}`);

    return lines.join('\n');
  },

  brain_respawn(data: any, o): string {
    const emoji = toolEmoji('brain_respawn');
    if (data.ok) {
      return `${emoji} ${bold('Agent respawned')} — ${color('New agent:', C.cyan)} ${color(data.new_agent_id?.slice(0, 12) + '...', C.green) ?? '?'}`;
    }
    return `${emoji} ${bold('Respawn failed')} — ${color(data.error ?? 'unknown error', C.red)}`;
  },

  // ── Communication ──────────────────────────────────────────────────────────

  brain_post(data: any, o): string {
    const emoji = toolEmoji('brain_post');
    if (data.ok || data.message_id) {
      return `${emoji} Message posted${data.channel ? ` to ${bold(data.channel)}` : ''} — ${color('ID:', C.cyan)} ${(data.message_id ?? data.id ?? '?').slice(0, 12)}...`;
    }
    return `${emoji} ${color('Post failed: ' + (data.error ?? JSON.stringify(data)), C.red)}`;
  },

  brain_read(data: any, o): string {
    const emoji = toolEmoji('brain_read');
    const msgs = data.messages ?? [];

    if (msgs.length === 0) {
      return `${emoji} No messages in ${bold(data.channel ?? 'general')}`;
    }

    const lines = [`${emoji} ${bold(`${msgs.length} message${msgs.length !== 1 ? 's' : ''}`)} in ${bold(data.channel ?? 'general')}`, ''];
    const shown = msgs.slice(0, o.maxItems);

    for (const m of shown) {
      const sender = color((m.sender ?? m.session_name ?? '?').padEnd(12), C.green);
      const time = m.timestamp ? dim(new Date(m.timestamp).toLocaleTimeString()) : '';
      const content = (m.content ?? '').replace(/\n/g, ' ').slice(0, 80);
      lines.push(`  ${sender} ${time ? time + '  ' : ''}${content}`);
    }

    if (msgs.length > shown.length) {
      lines.push(`  ${dim(`... and ${msgs.length - shown.length} more`)}`);
    }

    return lines.join('\n');
  },

  brain_dm(data: any, o): string {
    const emoji = toolEmoji('brain_dm');
    if (data.ok || data.message_id) {
      return `${emoji} DM sent to ${bold(data.target ?? '?')} — ${color('ID:', C.cyan)} ${(data.message_id ?? data.id ?? '?').slice(0, 8)}...`;
    }
    return `${emoji} ${color('DM failed: ' + (data.error ?? JSON.stringify(data)), C.red)}`;
  },

  brain_inbox(data: any, o): string {
    const emoji = toolEmoji('brain_inbox');
    const msgs = data.direct_messages ?? data.messages ?? [];

    if (msgs.length === 0) {
      return `${emoji} Inbox empty`;
    }

    const lines = [`${emoji} ${bold(`${msgs.length} DM${msgs.length !== 1 ? 's' : ''}`)}`, ''];
    const shown = msgs.slice(0, o.maxItems);

    for (const m of shown) {
      const from = color((m.from ?? m.sender ?? '?').padEnd(12), C.magenta);
      const time = m.timestamp ? dim(new Date(m.timestamp).toLocaleTimeString()) : '';
      const content = (m.content ?? '').replace(/\n/g, ' ').slice(0, 60);
      lines.push(`  ${from} ${time ? time + '  ' : ''}${content}`);
    }

    if (msgs.length > shown.length) {
      lines.push(`  ${dim(`... and ${msgs.length - shown.length} more`)}`);
    }

    return lines.join('\n');
  },

  // ── State store ────────────────────────────────────────────────────────────

  brain_set(data: any, o): string {
    const emoji = toolEmoji('brain_set');
    if (data.ok) {
      return `${emoji} ${bold('State set')} — ${dim(data.key ?? '?')} = ${dim(JSON.stringify(data.value ?? '').slice(0, 40))}`;
    }
    return `${emoji} ${color('Set failed: ' + (data.error ?? JSON.stringify(data)), C.red)}`;
  },

  brain_get(data: any, o): string {
    const emoji = toolEmoji('brain_get');
    if (data.exists || data.value !== undefined) {
      const val = JSON.stringify(data.value ?? '');
      return `${emoji} ${bold('State')} ${dim(data.key ?? '?')} = ${o.compact ? val.slice(0, 60) : val}`;
    }
    return `${emoji} ${dim('Key not found: ' + (data.key ?? '?'))}`;
  },

  brain_keys(data: any, o): string {
    const emoji = toolEmoji('brain_keys');
    const keys = data.keys ?? [];
    if (keys.length === 0) {
      return `${emoji} No keys in state`;
    }
    const shown = keys.slice(0, o.maxItems);
    const lines = [`${emoji} ${bold(`${keys.length} key${keys.length !== 1 ? 's' : ''}`)}`, ''];
    for (const k of shown) {
      lines.push(`  ${color('●', C.cyan)} ${dim(k)}`);
    }
    if (keys.length > shown.length) {
      lines.push(`  ${dim(`... and ${keys.length - shown.length} more`)}`);
    }
    return lines.join('\n');
  },

  brain_delete(data: any, o): string {
    const emoji = toolEmoji('brain_delete');
    if (data.ok) {
      return `${emoji} ${bold('Deleted')} ${dim(data.key ?? '?')}`;
    }
    return `${emoji} ${color('Delete failed: ' + (data.error ?? JSON.stringify(data)), C.red)}`;
  },

  // ── Resource locking ───────────────────────────────────────────────────────

  brain_claim(data: any, o): string {
    const emoji = toolEmoji('brain_claim');
    if (data.ok || data.claimed) {
      return `${emoji} ${bold('Claimed')} ${color(data.resource ?? '?', C.yellow)} — ${dim('TTL: ' + (data.ttl ?? '?') + 's')}`;
    }
    if (data.held_by) {
      return `${emoji} ${color('Already held', C.red)} by ${color(data.held_by, C.magenta)} (${dim(data.held_age ?? '?' + 's ago')})`;
    }
    return `${emoji} ${color('Claim failed: ' + (data.error ?? JSON.stringify(data)), C.red)}`;
  },

  brain_release(data: any, o): string {
    const emoji = toolEmoji('brain_release');
    if (data.ok || data.released) {
      return `${emoji} ${bold('Released')} ${dim(data.resource ?? '?')}`;
    }
    return `${emoji} ${color('Release failed: ' + (data.error ?? JSON.stringify(data)), C.red)}`;
  },

  brain_claims(data: any, o): string {
    const emoji = toolEmoji('brain_claims');
    const claims = data.claims ?? [];

    if (claims.length === 0) {
      return `${emoji} No active claims`;
    }

    const lines = [`${emoji} ${bold(`${claims.length} active claim${claims.length !== 1 ? 's' : ''}`)}`, ''];
    const shown = claims.slice(0, o.maxItems);

    for (const c of shown) {
      const res = color(c.resource ?? '?', C.yellow);
      const holder = color(c.held_by ?? '?', C.green);
      const ttl = c.ttl ?? c.ttl_seconds ?? '?';
      lines.push(`  ${color('🔒', C.yellow)} ${res}  held by ${holder}  ${dim(`TTL: ${ttl}s`)}`);
    }

    if (claims.length > shown.length) {
      lines.push(`  ${dim(`... and ${claims.length - shown.length} more`)}`);
    }

    return lines.join('\n');
  },

  // ── Contracts ─────────────────────────────────────────────────────────────

  brain_contract_check(data: any, o): string {
    const emoji = toolEmoji('brain_contract_check');
    if (data.passed) {
      return `${emoji} ${bold('Contracts')} ${color('PASSED', C.green)} — ${dim(`${data.check_count ?? data.contract_count ?? 0} contracts verified`)}`;
    }
    if (data.mismatches || data.mismatch_count > 0) {
      const lines = [`${emoji} ${bold('Contracts')} ${color('MISMATCH', C.red)}`, ''];
      const mismatches = (data.mismatches ?? []).slice(0, o.maxItems);
      for (const m of mismatches) {
        const contract = color(m.contract ?? '?', C.cyan);
        const field = color(m.field ?? '?', C.yellow);
        const expected = dim('expected: ' + JSON.stringify(m.expected ?? '').slice(0, 40));
        lines.push(`  ${color('✗', C.red)} ${contract}.${field}  ${expected}`);
        if (m.actual !== undefined) lines.push(`    ${color('actual:', C.red)} ${JSON.stringify(m.actual ?? '').slice(0, 60)}`);
      }
      if (data.mismatch_count > mismatches.length) {
        lines.push(`  ${dim(`... and ${data.mismatch_count - mismatches.length} more`)}`);
      }
      return lines.join('\n');
    }
    return `${emoji} ${bold('Contracts')} ${color('CHECKING', C.yellow)}`;
  },

  brain_gate(data: any, o): string {
    const emoji = toolEmoji('brain_gate');
    if (data.passed) {
      return `${emoji} ${bold('Gate')} ${color('PASSED', C.green)} — ${dim(`tsc: ${data.tsc?.error_count ?? 0}, contracts: ${data.contracts?.mismatch_count ?? 0}`)}`;
    }
    const lines = [`${emoji} ${bold('Gate')} ${color('FAILED', C.red)}`, ''];
    if (data.tsc?.error_count > 0) {
      lines.push(`  ${bold('TypeScript')}: ${color(`${data.tsc.error_count} error${data.tsc.error_count !== 1 ? 's' : ''}`, C.red)}`);
      const errors = (data.tsc.errors ?? []).slice(0, 5);
      for (const e of errors) {
        lines.push(`    ${dim(e.file ?? '?')} @ ${e.line ?? '?'}: ${e.message ?? e.error ?? ''}`.slice(0, 120));
      }
    }
    if (data.contracts?.mismatch_count > 0) {
      lines.push(`  ${bold('Contracts')}: ${color(`${data.contracts.mismatch_count} mismatch${data.contracts.mismatch_count !== 1 ? 'es' : ''}`, C.red)}`);
    }
    return lines.join('\n');
  },

  // ── Context ledger ─────────────────────────────────────────────────────────

  brain_context_push(data: any, o): string {
    const emoji = toolEmoji('brain_context_push');
    if (data.ok || data.id) {
      return `${emoji} Context entry added — ${dim(data.entry_type ?? '?')} ${bold(data.summary ?? '').slice(0, 60)}`;
    }
    return `${emoji} ${color('Context push failed: ' + (data.error ?? JSON.stringify(data)), C.red)}`;
  },

  brain_context_summary(data: any, o): string {
    const emoji = toolEmoji('brain_context_summary');
    const lines: string[] = [];

    if (data.total_entries === 0 || data.total === 0) {
      return `${emoji} No context entries`;
    }

    lines.push(`${emoji} ${bold('Context Summary')} — ${bold(data.total_entries ?? data.total + '')} entries`);

    if (data.by_type && !o.compact) {
      for (const [type, count] of Object.entries(data.by_type as Record<string, number>)) {
        if (count > 0) lines.push(`  ${color('●', C.cyan)} ${dim(type)}: ${color(String(count), C.white)}`);
      }
    }

    if (data.recent?.length) {
      lines.push('');
      const shown = data.recent.slice(0, o.maxItems);
      for (const e of shown) {
        lines.push(`  ${dim('»')} ${dim(e.type ?? '?')}: ${(e.summary ?? '').slice(0, 70)}`);
      }
      if (data.recent.length > shown.length) {
        lines.push(`  ${dim(`... and ${data.recent.length - shown.length} more`)}`);
      }
    }

    return lines.join('\n');
  },

  // ── Planning ───────────────────────────────────────────────────────────────

  brain_plan(data: any, o): string {
    const emoji = toolEmoji('brain_plan');
    const lines: string[] = [];

    if (data.message) {
      lines.push(`${emoji} ${bold(data.message)}`);
    } else {
      lines.push(`${emoji} ${bold('Plan created')} — ${data.total_tasks ?? data.tasks?.length ?? 0} tasks`);
    }

    if (!o.compact && data.tasks?.length) {
      lines.push('');
      const statusOrder = ['ready', 'working', 'done', 'blocked', 'pending'];
      const sorted = [...data.tasks].sort((a, b) =>
        statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)
      );
      for (const t of sorted.slice(0, o.maxItems)) {
        const icon = statusIcon(t.status ?? 'queued');
        const name = color(t.name ?? '?', C.brightWhite);
        const deps = (t.depends_on ?? []).length ? ` ${dim(`← ${(t.depends_on as string[]).join(', ')}`)}` : '';
        lines.push(`  ${icon} ${name}${deps}`);
      }
      if (data.tasks.length > sorted.slice(0, o.maxItems).length) {
        lines.push(`  ${dim(`... and ${data.tasks.length} total tasks`)}`);
      }
    }

    return lines.join('\n');
  },

  brain_plan_next(data: any, o): string {
    const emoji = toolEmoji('brain_plan_next');
    const tasks = data.ready_tasks ?? data.tasks ?? [];

    if (tasks.length === 0) {
      return `${emoji} No tasks ready — all blocked or complete`;
    }

    const lines = [`${emoji} ${bold(`${tasks.length} ready task${tasks.length !== 1 ? 's' : ''}`)}`, ''];
    for (const t of tasks.slice(0, o.maxItems)) {
      const name = color(t.name ?? '?', C.green);
      const desc = dim((t.description ?? '').slice(0, 70));
      const agent = t.agent_name ? ` ${dim(`← ${t.agent_name}`)}` : '';
      lines.push(`  ${statusIcon('ready')} ${bold(name)}  ${desc}${agent}`);
    }

    return lines.join('\n');
  },

  brain_plan_status(data: any, o): string {
    const emoji = toolEmoji('brain_plan_status');
    const lines: string[] = [];

    if (data.plan_id) lines.push(`${emoji} ${bold('Plan')} ${dim(data.plan_id.slice(0, 8))}`);

    if (data.summary) {
      const parts: string[] = [];
      if (data.summary.total) parts.push(`${data.summary.total} tasks`);
      if (data.summary.ready) parts.push(`${color(data.summary.ready, C.green)} ready`);
      if (data.summary.working) parts.push(`${color(data.summary.working, C.yellow)} working`);
      if (data.summary.done) parts.push(`${color(data.summary.done, C.green)} done`);
      if (data.summary.blocked) parts.push(`${color(data.summary.blocked, C.red)} blocked`);
      if (parts.length) lines.push(`  ${parts.join(' · ')}`);
    }

    return lines.join('\n') || `${emoji} ${dim('No plan status')}`;
  },

  // ── Memory ─────────────────────────────────────────────────────────────────

  brain_remember(data: any, o): string {
    const emoji = toolEmoji('brain_remember');
    if (data.ok || data.key) {
      return `${emoji} ${bold('Memory saved')} — ${dim(data.key ?? '?')}`;
    }
    return `${emoji} ${color('Remember failed: ' + (data.error ?? JSON.stringify(data)), C.red)}`;
  },

  brain_recall(data: any, o): string {
    const emoji = toolEmoji('brain_recall');
    const results = data.results ?? data.memories ?? [];

    if (results.length === 0) {
      return `${emoji} No memories found for ${dim(data.query ?? '?')}`;
    }

    const lines = [`${emoji} ${bold(`${results.length} memory${results.length !== 1 ? 'ies' : ''}`)} matching ${dim(`"${data.query ?? ''}"`)}`, ''];
    for (const r of results.slice(0, o.maxItems)) {
      const key = color((r.key ?? r.name ?? '?').padEnd(20), C.cyan);
      const content = (r.content ?? r.value ?? '').replace(/\n/g, ' ').slice(0, 60);
      lines.push(`  ${key}  ${content}`);
    }

    return lines.join('\n');
  },

  // ── Git ───────────────────────────────────────────────────────────────────

  brain_commit(data: any, o): string {
    const emoji = toolEmoji('brain_commit');
    if (data.ok || data.sha || data.commit) {
      const sha = (data.sha ?? data.commit ?? '?').slice(0, 7);
      return `${emoji} ${bold('Committed')} ${color(sha, C.green)} — ${dim((data.message ?? data.summary ?? '').slice(0, 60))}`;
    }
    return `${emoji} ${color('Commit failed: ' + (data.error ?? JSON.stringify(data)), C.red)}`;
  },

  brain_pr(data: any, o): string {
    const emoji = toolEmoji('brain_pr');
    if (data.ok || data.url || data.pr_url) {
      return `${emoji} ${bold('PR created')} ${color(data.url ?? data.pr_url ?? '', C.cyan)}`;
    }
    return `${emoji} ${color('PR failed: ' + (data.error ?? JSON.stringify(data)), C.red)}`;
  },

  // ── Metrics ───────────────────────────────────────────────────────────────

  brain_metrics(data: any, o): string {
    const emoji = toolEmoji('brain_metrics');
    const summary = data.summary ?? data;

    if (!summary || (summary.total_runs ?? summary.agents ?? 0) === 0) {
      return `${emoji} No metrics yet`;
    }

    const lines = [`${emoji} ${bold('Metrics')}`, ''];
    if (summary.total_runs !== undefined) lines.push(`  ${bold('Total runs')}: ${summary.total_runs}`);
    if (summary.avg_duration !== undefined) lines.push(`  ${bold('Avg duration')}: ${Math.round(summary.avg_duration / 1000)}s`);
    if (summary.success_rate !== undefined) {
      const rate = Math.round(summary.success_rate * 100);
      const c = rate >= 80 ? C.green : rate >= 50 ? C.yellow : C.red;
      lines.push(`  ${bold('Success rate')}: ${color(`${rate}%`, c)}`);
    }

    return lines.join('\n');
  },
};

// ── Generic fallback renderer ─────────────────────────────────────────────────

function renderGeneric(data: any, toolName: string, o: Required<RenderOptions>): string {
  const emoji = toolEmoji(toolName);

  // Check for common success/fail shapes
  if (typeof data === 'boolean') {
    return `${emoji} ${toolName} — ${data ? color('OK', C.green) : color('FAIL', C.red)}`;
  }
  if (data?.ok === true || data?.success === true) {
    return `${emoji} ${bold(toolName)} ${color('OK', C.green)}${data.message ? ' — ' + dim(data.message) : ''}`;
  }
  if (data?.ok === false || data?.error) {
    return `${emoji} ${bold(toolName)} ${color('ERROR', C.red)}: ${color(data.error ?? JSON.stringify(data), C.red)}`;
  }

  // Fall back to JSON dump
  return `${emoji} ${bold(toolName)}\n${formatJSON(data, 0, o)}`;
}

function renderFallback(raw: string, toolName: string, o: Required<RenderOptions>): string {
  const emoji = toolEmoji(toolName);
  return `${emoji} ${bold(toolName)}\n${raw}`;
}

// ── JSON formatter ────────────────────────────────────────────────────────────

function formatJSON(data: any, indent: number, o: Required<RenderOptions>): string {
  const pad = '  '.repeat(indent);

  if (data === null || data === undefined) {
    return `${pad}${color('null', C.brightBlack)}`;
  }
  if (typeof data === 'boolean') {
    return `${pad}${data ? color('true', C.green) : color('false', C.red)}`;
  }
  if (typeof data === 'number') {
    return `${pad}${color(String(data), C.cyan)}`;
  }
  if (typeof data === 'string') {
    const truncated = data.length > 200 && o.compact ? data.slice(0, 200) + '...' : data;
    return `${pad}${color(`"${truncated}"`, C.brightWhite)}`;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return `${pad}[]`;
    if (o.compact && data.length > 3) {
      return `${pad}[ ${data.map((v: any) => formatJSON(v, 0, o).trim()).join(', ')} ${dim(`(${data.length} items)`)} ]`;
    }
    const items = data.map((v: any) => `${pad}  ${formatJSON(v, indent + 1, o)}`);
    return [`${pad}[`, ...items, `${pad}]`].join('\n');
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    if (keys.length === 0) return `${pad}{}`;
    const entries: string[] = [];
    for (const [k, v] of Object.entries(data)) {
      const keyStr = color(`"${k}"`, C.cyan);
      const valStr = formatJSON(v, indent + 1, o).trimStart();
      entries.push(`${pad}  ${keyStr}: ${valStr}`);
    }
    return [`${pad}{`, ...entries, `${pad}}`].join('\n');
  }
  return `${pad}${String(data)}`;
}

function formatJSONRaw(data: any, indent: number): string {
  const pad = '  '.repeat(indent);
  if (data === null || data === undefined) return `${pad}null`;
  if (typeof data === 'string') return `${pad}"${data.length > 100 ? data.slice(0, 100) + '...' : data}"`;
  if (typeof data === 'number') return `${pad}${data}`;
  if (Array.isArray(data)) {
    if (data.length === 0) return `${pad}[]`;
    return [`${pad}[`, ...data.map((v: any) => formatJSONRaw(v, indent + 1)), `${pad}]`].join('\n');
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data).map(([k, v]) => `${pad}  "${k}": ${formatJSONRaw(v, indent + 1)}`);
    return entries.length === 0 ? `${pad}{}` : [`${pad}{`, ...entries, `${pad}}`].join('\n');
  }
  return `${pad}${String(data)}`;
}
