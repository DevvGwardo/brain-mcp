import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { BrainDB } from './db.js';
import { reconcileSessionExit } from './spawn-recovery.js';

/** Attach exit/error handlers so bash tmux watchers reconcile session state. */
export function attachTmuxWatcherFinalizer(
  db: BrainDB,
  watcher: ChildProcess,
  sessionId: string,
  stateFile: string,
): void {
  watcher.on('error', (err) => {
    try { db.markDone(sessionId, -1, true, `watcher failed: ${err.message}`); } catch { /* best effort */ }
  });
  watcher.on('exit', () => {
    try {
      const raw = existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : '';
      if (raw === 'timeout') {
        reconcileSessionExit(db, sessionId, 124, 'tmux watcher timed out');
      } else if (raw === 'pane_closed' || raw === '') {
        reconcileSessionExit(db, sessionId, 0, 'tmux pane closed');
      }
    } catch { /* best effort */ }
    try { rmSync(dirname(stateFile), { recursive: true, force: true }); } catch { /* best effort */ }
  });
  watcher.unref();
}
