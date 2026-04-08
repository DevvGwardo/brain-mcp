/**
 * Gate Tools
 * - gate: Run the integration gate (tsc + contract validation)
 * - auto_gate: Run the integration gate in a loop
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainDB } from '../db.js';
import { runGate, runGateAndNotify } from '../gate.js';

interface GateToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  getSessionId: () => string | null;
  getSessionName: () => string;
}

export function registerGateTools(
  server: McpServer,
  options: GateToolsOptions,
) {
  const { db, room, ensureSession, getSessionName } = options;

  // Schema coercion helpers
  const cBool = () => z.preprocess(
    (v: unknown) => {
      if (typeof v !== 'string') return v;
      const s = (v as string).toLowerCase().trim();
      if (s === 'true' || s === '1' || s === 'yes') return true;
      if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
      return v;
    },
    z.boolean(),
  );
  const cNum = () => z.preprocess(
    (v: unknown) => typeof v === 'string' && (v as string).trim() !== '' ? Number(v) : v,
    z.number(),
  );

  // ── gate ───────────────────────────────────────────────────────────────────
  server.tool(
    'gate',
    `Run the integration gate: tsc --noEmit + contract validation.
Catches type errors, missing imports, param mismatches between agents.
If errors are found, DMs each responsible agent with their specific errors and resets their status to "working".
Use this after all agents report "done" to verify integration before shipping.`,
    {
      notify: cBool().optional().describe('DM agents with their errors and reset status to working (default: true)'),
      dry_run: cBool().optional().describe('Just check, don\'t DM agents (default: false)'),
    },
    async ({ notify, dry_run }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      const result = (dry_run || notify === false)
        ? runGate(db, room, room)
        : runGateAndNotify(db, room, room, sid, sessionName);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...result,
            // Truncate large error lists for readability
            tsc: { ...result.tsc, errors: result.tsc.errors.slice(0, 20) },
          }, null, 2),
        }],
      };
    }
  );

  // ── auto_gate ──────────────────────────────────────────────────────────────
  server.tool(
    'auto_gate',
    `Run the integration gate in a loop until all errors are fixed or max retries are hit.
After each failed gate, agents are DM'd their specific errors and given time to fix them.
Returns the final gate result. Use this after all agents report "done" to ship with confidence.`,
    {
      max_retries: cNum().optional().describe('Max gate attempts before giving up (default: 5)'),
      wait_seconds: cNum().optional().describe('Seconds to wait between gate attempts for agents to fix errors (default: 30)'),
    },
    async ({ max_retries, wait_seconds }) => {
      const sid = ensureSession();
      const sessionName = getSessionName();
      const maxAttempts = max_retries || 5;
      const waitMs = (wait_seconds || 30) * 1000;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = runGateAndNotify(db, room, room, sid, sessionName);

        if (result.passed) {
          // Record success metrics for all agents
          const agents = db.getAgentHealth(room);
          for (const agent of agents) {
            if (agent.name !== sessionName && agent.status === 'done') {
              db.recordMetric(room, agent.name, agent.id, {
                outcome: 'success',
                gate_passes: attempt,
                tsc_errors: 0,
                contract_mismatches: 0,
              });
            }
          }

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ...result,
                passed: true,
                attempts: attempt,
                message: `Gate PASSED on attempt ${attempt}/${maxAttempts}. All clear to ship.`,
              }, null, 2),
            }],
          };
        }

        if (attempt < maxAttempts) {
          // Wait for agents to fix errors
          db.postMessage('general', room, sid, sessionName,
            `Gate attempt ${attempt}/${maxAttempts} failed (${result.tsc.error_count} tsc, ${result.contracts.mismatch_count} contract). Agents notified. Waiting ${wait_seconds || 30}s...`);

          await new Promise(resolve => setTimeout(resolve, waitMs));

          // Check if agents have fixed and re-reported done
          const agents = db.getAgentHealth(room);
          const stillWorking = agents.filter(a => a.status === 'working' && a.name !== sessionName);
          if (stillWorking.length > 0) {
            // Wait a bit more for working agents
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
        }
      }

      // Final failure
      const finalResult = runGate(db, room, room);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...finalResult,
            passed: false,
            attempts: maxAttempts,
            message: `Gate FAILED after ${maxAttempts} attempts. Remaining errors need manual attention.`,
          }, null, 2),
        }],
      };
    }
  );
}
