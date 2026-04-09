import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface ServerLoggerOptions {
  component: string;
  room?: string;
  roomLabel?: string;
}

function envEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function createServerLogger(options: ServerLoggerOptions) {
  const room = options.room ?? process.cwd();
  const roomLabel = (options.roomLabel ?? basename(room)) || 'default';
  const configuredPath = process.env.BRAIN_LOG_PATH?.trim();
  const logPath = configuredPath
    ? (isAbsolute(configuredPath) ? configuredPath : resolve(room, configuredPath))
    : join(tmpdir(), 'brain-mcp', `${roomLabel}.log`);
  const mirrorToStderr = envEnabled(process.env.BRAIN_STDERR_LOGS);
  const prefix = `${options.component} room=${roomLabel} pid=${process.pid}`;

  return {
    path: logPath,
    log(message: string) {
      const line = `${new Date().toISOString()} [${prefix}] ${message}\n`;
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(logPath, line, 'utf8');
      } catch {
        // Keep MCP stdio quiet even if filesystem logging is unavailable.
      }

      if (mirrorToStderr) {
        try {
          process.stderr.write(line);
        } catch {
          // Best effort only.
        }
      }
    },
  };
}
