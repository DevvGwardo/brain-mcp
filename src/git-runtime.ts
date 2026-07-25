import { execFileSync } from 'node:child_process';

export function git(
  args: string[],
  cwd: string,
  opts: { encoding?: 'utf-8'; stdio?: any; maxBuffer?: number } = {},
): string {
  const out = execFileSync('git', args, {
    cwd,
    encoding: opts.encoding ?? 'utf-8',
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
  });
  return String(out);
}

export function gitTry(args: string[], cwd: string): string | null {
  try { return git(args, cwd); } catch { return null; }
}
