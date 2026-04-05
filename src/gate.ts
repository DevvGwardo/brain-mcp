/**
 * Integration Gate — runs between phases to catch cross-agent mismatches.
 *
 * Checks:
 * 1. tsc --noEmit (type errors, missing imports, wrong params)
 * 2. Contract validation (provides/expects mismatches)
 *
 * Routes errors to responsible agents via DM.
 * Zero Claude tokens — pure Node.js.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainDB, ContractMismatch } from './db.js';

export interface GateError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

export interface RoutedErrors {
  agent_id: string;
  agent_name: string;
  errors: string[];
}

export interface GateResult {
  passed: boolean;
  tsc: {
    passed: boolean;
    error_count: number;
    errors: GateError[];
  };
  contracts: {
    passed: boolean;
    mismatch_count: number;
    mismatches: ContractMismatch[];
  };
  routed: RoutedErrors[];
  summary: string;
}

/**
 * Parse tsc output into structured errors.
 * Format: src/file.ts(10,5): error TS2345: Argument of type...
 */
function parseTscOutput(output: string): GateError[] {
  const errors: GateError[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/);
    if (match) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        code: match[4],
        message: match[5],
      });
    }
  }
  return errors;
}

/**
 * Run the integration gate. Returns structured results.
 * Does NOT send DMs — caller decides what to do with the results.
 */
export function runGate(db: BrainDB, room: string, cwd: string): GateResult {
  // ── 1. TypeScript compilation check ──
  let tscErrors: GateError[] = [];
  const hasTsConfig = existsSync(join(cwd, 'tsconfig.json'));

  if (hasTsConfig) {
    try {
      execSync('npx tsc --noEmit 2>&1', {
        cwd,
        encoding: 'utf-8',
        timeout: 60000, // 1 minute max
      });
    } catch (err: any) {
      const output = (err.stdout || '') + (err.stderr || '');
      tscErrors = parseTscOutput(output);
    }
  }

  // ── 2. Contract validation ──
  const mismatches = db.validateContracts(room);

  // ── 3. Route errors to responsible agents ──
  const agents = db.getAgentHealth(room);
  const claims = db.getClaims(room);

  // Build file → agent mapping from active claims
  const fileToAgent = new Map<string, { id: string; name: string }>();
  for (const claim of claims) {
    const agent = agents.find(a => a.id === claim.owner_id);
    if (agent) {
      fileToAgent.set(claim.resource, { id: agent.id, name: agent.name });
    }
  }
  // Also map from contracts (agents that published provides for a module)
  const contractProviders = db.getContracts(room, undefined, 'provides');
  for (const c of contractProviders) {
    if (!fileToAgent.has(c.module)) {
      fileToAgent.set(c.module, { id: c.agent_id, name: c.agent_name });
    }
  }

  const errorsByAgent = new Map<string, RoutedErrors>();

  function addError(agentId: string, agentName: string, error: string) {
    const entry = errorsByAgent.get(agentId) || { agent_id: agentId, agent_name: agentName, errors: [] };
    entry.errors.push(error);
    errorsByAgent.set(agentId, entry);
  }

  // Route tsc errors
  for (const err of tscErrors) {
    let owner = fileToAgent.get(err.file);
    if (!owner) {
      // Try prefix match (claim might be "src/ui/" for "src/ui/menu.ts")
      for (const [resource, agent] of fileToAgent) {
        if (err.file.startsWith(resource) || resource.startsWith(err.file.split('/').slice(0, -1).join('/'))) {
          owner = agent;
          break;
        }
      }
    }
    const errStr = `${err.file}(${err.line},${err.column}): ${err.code} ${err.message}`;
    if (owner) {
      addError(owner.id, owner.name, `[tsc] ${errStr}`);
    }
    // If no owner found, it goes into the summary but isn't routed
  }

  // Route contract mismatches — notify BOTH sides
  for (const m of mismatches) {
    // Notify the expecting agent
    const expecter = agents.find(a => a.name === m.expected_by);
    if (expecter) {
      addError(expecter.id, expecter.name, `[contract] ${m.detail}`);
    }
    // Notify the providing agent (if exists)
    if (m.provided_by) {
      const provider = agents.find(a => a.name === m.provided_by);
      if (provider) {
        addError(provider.id, provider.name, `[contract] ${m.detail}`);
      }
    }
  }

  const passed = tscErrors.length === 0 && mismatches.length === 0;
  const parts: string[] = [];
  if (hasTsConfig) {
    parts.push(tscErrors.length === 0 ? 'tsc: PASS' : `tsc: ${tscErrors.length} error(s)`);
  } else {
    parts.push('tsc: skipped (no tsconfig.json)');
  }
  parts.push(mismatches.length === 0 ? 'contracts: PASS' : `contracts: ${mismatches.length} mismatch(es)`);

  return {
    passed,
    tsc: { passed: tscErrors.length === 0, error_count: tscErrors.length, errors: tscErrors },
    contracts: { passed: mismatches.length === 0, mismatch_count: mismatches.length, mismatches },
    routed: [...errorsByAgent.values()],
    summary: passed ? `GATE PASSED — ${parts.join(', ')}` : `GATE FAILED — ${parts.join(', ')}`,
  };
}

/**
 * Run gate AND send DMs to responsible agents with their errors.
 * Also resets their status to 'working' so they know to fix things.
 * Returns the gate result.
 */
export function runGateAndNotify(
  db: BrainDB, room: string, cwd: string,
  conductorId: string, conductorName: string
): GateResult {
  const result = runGate(db, room, cwd);

  if (!result.passed) {
    // DM each agent with their specific errors
    for (const routed of result.routed) {
      const errorList = routed.errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n');
      const message = [
        `INTEGRATION GATE FAILED — you have ${routed.errors.length} error(s) to fix:`,
        errorList,
        '',
        'Fix these issues, then call brain_contract_check and brain_pulse with status="done" when ready.',
      ].join('\n');

      db.sendDM(conductorId, conductorName, routed.agent_id, message);
      // Reset their status so they keep working
      db.pulse(routed.agent_id, 'working', `gate failed: ${routed.errors.length} errors to fix`);
    }

    // Post gate failure to alerts channel
    db.postMessage('alerts', room, conductorId, conductorName, result.summary);
  } else {
    db.postMessage('general', room, conductorId, conductorName, result.summary);
  }

  return result;
}
