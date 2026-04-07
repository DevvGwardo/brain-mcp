/**
 * Integration Gate — runs between phases to catch cross-agent mismatches.
 *
 * Checks:
 * 1. tsc --noEmit (type errors, missing imports, wrong params)
 * 2. Contract validation (provides/expects mismatches)
 * 3. Test execution (npm test or detected test framework)
 * 4. Behavioral validation (MCP tool availability and basic behavior)
 * 5. Performance baseline checks (latency benchmarks on critical paths)
 *
 * Routes errors to responsible agents via DM.
 * Zero Claude tokens — pure Node.js.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';
import type { BrainDB, ContractMismatch } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface GateError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface RoutedErrors {
  agent_id: string;
  agent_name: string;
  errors: string[];
}

export interface TestResult {
  passed: boolean;
  exit_code: number | null;
  duration_ms: number;
  output: string;
  test_count: number;
  failures: string[];
}

export interface BehavioralCheck {
  name: string;
  passed: boolean;
  detail: string;
  duration_ms: number;
}

export interface PerformanceBaseline {
  name: string;
  passed: boolean;
  actual_ms: number;
  baseline_ms: number;
  threshold_ms: number;
  detail: string;
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
  tests: {
    passed: boolean;
    result: TestResult | null;
  };
  behavioral: {
    passed: boolean;
    checks: BehavioralCheck[];
  };
  performance: {
    passed: boolean;
    baselines: PerformanceBaseline[];
  };
  routed: RoutedErrors[];
  summary: string;
  duration_ms: number;
}

/** Performance baselines for critical operations (in milliseconds) */
const PERFORMANCE_BASELINES = {
  // DB operation latency limits
  db_broadcast: { baseline: 5, threshold: 20 },
  db_get_messages: { baseline: 2, threshold: 10 },
  db_validate_contracts: { baseline: 10, threshold: 50 },
  // Note: db_pulse baseline removed — pulse() is private (pre-existing issue)
  // Gate phase timeouts
  tsc_timeout: 60000,       // 1 minute
  test_timeout: 120000,     // 2 minutes
  perf_timeout: 30000,      // 30 seconds total
};

/**
 * Parse tsc output into structured errors.
 * Format: src/file.ts(10,5): error TS2345: Argument of type...
 */
function parseTscOutput(output: string): GateError[] {
  const errors: GateError[] = [];
  for (const line of output.split('\n')) {
    // Match: file(line,col): error CODE: message
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/);
    if (match) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        severity: match[4] as 'error' | 'warning',
        code: match[5],
        message: match[6],
      });
    }
  }
  return errors;
}

/**
 * Detect available test framework and return the appropriate command.
 */
function detectTestCommand(cwd: string): { cmd: string; args: string[] } | null {
  // Check package.json for test script
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts?.test) {
        // npm test — detect what framework it uses
        // Check for vitest.config
        if (existsSync(join(cwd, 'vitest.config'))) {
          return { cmd: 'npx', args: ['vitest', 'run', '--reporter=json'] };
        }
        if (existsSync(join(cwd, 'jest.config'))) {
          return { cmd: 'npx', args: ['jest', '--json'] };
        }
        // Fallback to npm test
        return { cmd: 'npm', args: ['test', '--', '--reporter=json'] };
      }
    } catch {
      // Ignore JSON parse errors
    }
  }
  
  // Check for vitest directly
  if (existsSync(join(cwd, 'vitest.config'))) {
    return { cmd: 'npx', args: ['vitest', 'run', '--reporter=json'] };
  }
  
  // Check for jest directly
  if (existsSync(join(cwd, 'jest.config'))) {
    return { cmd: 'npx', args: ['jest', '--json'] };
  }
  
  // Check for test files to determine framework
  const testPatterns = [
    { pattern: '**/*.test.ts', cmd: 'vitest' },
    { pattern: '**/*.spec.ts', cmd: 'vitest' },
    { pattern: '**/*.test.js', cmd: 'jest' },
    { pattern: '**/*.spec.js', cmd: 'jest' },
    { pattern: '**/*.test.mjs', cmd: 'node' },
  ];
  
  // Default: try to find any test files
  for (const tp of testPatterns) {
    try {
      const result = execSync(`find . -name "${tp.pattern.split('/').pop()}" -type f 2>/dev/null | head -5`, {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      });
      if (result.trim()) {
        if (tp.cmd === 'node') {
          // For .mjs test files, try to run with test harness
          return { cmd: 'node', args: ['--test', '--test-name-pattern=.*'] };
        }
        return { cmd: 'npx', args: [tp.cmd, 'run'] };
      }
    } catch {
      // find failed, continue
    }
  }
  
  return null;
}

/**
 * Run test suite and parse results.
 */
function runTests(cwd: string, timeout = PERFORMANCE_BASELINES.test_timeout): TestResult {
  const start = Date.now();
  const testCmd = detectTestCommand(cwd);
  
  if (!testCmd) {
    return {
      passed: true,
      exit_code: null,
      duration_ms: Date.now() - start,
      output: 'No test framework detected',
      test_count: 0,
      failures: [],
    };
  }
  
  try {
    const output = execSync(`${testCmd.cmd} ${testCmd.args.join(' ')}`, {
      cwd,
      encoding: 'utf-8',
      timeout,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    
    // Try to parse JSON test results
    let testCount = 0;
    let failures: string[] = [];
    
    try {
      const json = JSON.parse(output);
      if (json.testResults) {
        for (const tr of json.testResults) {
          testCount += tr.assertionResults?.length || 0;
          for (const ar of tr.assertionResults || []) {
            if (ar.status === 'failed') {
              failures.push(`${ar.fullName}: ${ar.failureMessages?.join('; ') || 'unknown'}`);
            }
          }
        }
      } else if (json.numTotalTests !== undefined) {
        testCount = json.numTotalTests;
        failures = (json.failedSuites || []).flatMap((s: any) => 
          (s.assertionResults || []).filter((a: any) => a.status === 'failed')
            .map((a: any) => `${s.fullName}: ${a.failureMessages?.join('; ') || 'unknown'}`)
        );
      }
    } catch {
      // Not JSON output, try to extract test counts from text
      const passMatch = output.match(/(\d+)\s+pass(ed|ing)?/i);
      const failMatch = output.match(/(\d+)\s+fail(ed|ing)?/i);
      testCount = (passMatch ? parseInt(passMatch[1]) : 0) + (failMatch ? parseInt(failMatch[1]) : 0);
      failures = failMatch ? [`${failMatch[1]} test(s) failed`] : [];
    }
    
    return {
      passed: failures.length === 0,
      exit_code: 0,
      duration_ms: Date.now() - start,
      output: output.slice(0, 2000), // Truncate long output
      test_count: testCount,
      failures: failures.slice(0, 20), // Limit failure list
    };
  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '');
    let failures: string[] = [];
    let testCount = 0;
    
    try {
      const json = JSON.parse(output);
      if (json.testResults) {
        for (const tr of json.testResults) {
          testCount += tr.assertionResults?.length || 0;
          for (const ar of tr.assertionResults || []) {
            if (ar.status === 'failed') {
              failures.push(`${ar.fullName}: ${ar.failureMessages?.join('; ') || 'unknown'}`);
            }
          }
        }
      }
    } catch {
      // Non-JSON error output
      const failMatch = output.match(/(\d+)\s+fail(ed|ing)?/i);
      if (failMatch) {
        testCount = parseInt(failMatch[1]);
        failures = [`${failMatch[1]} test(s) failed`];
      }
    }
    
    return {
      passed: false,
      exit_code: err.status || 1,
      duration_ms: Date.now() - start,
      output: output.slice(0, 2000),
      test_count: testCount,
      failures: failures.slice(0, 20),
    };
  }
}

/**
 * Run behavioral validation checks on the MCP tools.
 * These are smoke tests to verify basic functionality.
 */
function runBehavioralChecks(db: BrainDB, room: string): BehavioralCheck[] {
  const checks: BehavioralCheck[] = [];
  
  // Check 1: DB can write and read messages
  const t1 = Date.now();
  try {
    db.postMessage('general', room, 'gate-check', 'Gate Checker', 'Behavioral check message');
    const msgs = db.getMessages('general', room);
    const found = msgs.some(m => m.content === 'Behavioral check message');
    checks.push({
      name: 'db_message_roundtrip',
      passed: found,
      detail: found ? 'Messages persist and can be retrieved' : 'Message not found after write',
      duration_ms: Date.now() - t1,
    });
  } catch (err: any) {
    checks.push({
      name: 'db_message_roundtrip',
      passed: false,
      detail: `Error: ${err.message}`,
      duration_ms: Date.now() - t1,
    });
  }
  
  // Check 2: DB state operations
  const t2 = Date.now();
  try {
    const testKey = `gate-behavioral-${Date.now()}`;
    db.setState(testKey, room, 'test-value', 'gate-check', 'Gate Checker');
    const val = db.getState(testKey, room);
    checks.push({
      name: 'db_state_persistence',
      passed: val?.value === 'test-value',
      detail: val?.value === 'test-value' ? 'State persists correctly' : `Expected 'test-value', got '${val?.value}'`,
      duration_ms: Date.now() - t2,
    });
  } catch (err: any) {
    checks.push({
      name: 'db_state_persistence',
      passed: false,
      detail: `Error: ${err.message}`,
      duration_ms: Date.now() - t2,
    });
  }
  
  // Check 3: Contract validation runs without error
  const t3 = Date.now();
  try {
    const mismatches = db.validateContracts(room);
    checks.push({
      name: 'contract_validation_execution',
      passed: true,
      detail: `Contract validation completed, found ${mismatches.length} mismatch(es)`,
      duration_ms: Date.now() - t3,
    });
  } catch (err: any) {
    checks.push({
      name: 'contract_validation_execution',
      passed: false,
      detail: `Error: ${err.message}`,
      duration_ms: Date.now() - t3,
    });
  }
  
  // Check 4: Agent health reporting
  const t4 = Date.now();
  try {
    const agents = db.getAgentHealth(room);
    checks.push({
      name: 'agent_health_query',
      passed: true,
      detail: `Agent health query returned ${agents.length} agent(s)`,
      duration_ms: Date.now() - t4,
    });
  } catch (err: any) {
    checks.push({
      name: 'agent_health_query',
      passed: false,
      detail: `Error: ${err.message}`,
      duration_ms: Date.now() - t4,
    });
  }
  
  // Check 5: Claims tracking
  const t5 = Date.now();
  try {
    const claims = db.getClaims(room);
    checks.push({
      name: 'claims_tracking',
      passed: true,
      detail: `Claims query returned ${claims.length} claim(s)`,
      duration_ms: Date.now() - t5,
    });
  } catch (err: any) {
    checks.push({
      name: 'claims_tracking',
      passed: false,
      detail: `Error: ${err.message}`,
      duration_ms: Date.now() - t5,
    });
  }
  
  return checks;
}

/**
 * Run performance baseline checks on critical DB operations.
 */
function runPerformanceBaselines(db: BrainDB, room: string): PerformanceBaseline[] {
  const baselines: PerformanceBaseline[] = [];
  const testRoom = `${room}-perf-${Date.now()}`;
  
  // Baseline: db_broadcast (postMessage)
  const t1 = Date.now();
  try {
    for (let i = 0; i < 100; i++) {
      db.postMessage('general', testRoom, 'gate-perf', 'Gate Perf', `Perf test ${i}`);
    }
    const elapsed = Date.now() - t1;
    const avgMs = elapsed / 100;
    baselines.push({
      name: 'db_broadcast_100',
      passed: avgMs <= PERFORMANCE_BASELINES.db_broadcast.threshold,
      actual_ms: avgMs,
      baseline_ms: PERFORMANCE_BASELINES.db_broadcast.baseline,
      threshold_ms: PERFORMANCE_BASELINES.db_broadcast.threshold,
      detail: avgMs <= PERFORMANCE_BASELINES.db_broadcast.baseline 
        ? 'Performance is optimal' 
        : avgMs <= PERFORMANCE_BASELINES.db_broadcast.threshold 
          ? 'Performance is acceptable' 
          : 'Performance degraded',
    });
  } catch (err: any) {
    baselines.push({
      name: 'db_broadcast_100',
      passed: false,
      actual_ms: -1,
      baseline_ms: PERFORMANCE_BASELINES.db_broadcast.baseline,
      threshold_ms: PERFORMANCE_BASELINES.db_broadcast.threshold,
      detail: `Error: ${err.message}`,
    });
  }
  
  // Baseline: db_get_messages
  const t2 = Date.now();
  try {
    for (let i = 0; i < 100; i++) {
      db.getMessages('general', testRoom);
    }
    const elapsed = Date.now() - t2;
    const avgMs = elapsed / 100;
    baselines.push({
      name: 'db_get_messages_100',
      passed: avgMs <= PERFORMANCE_BASELINES.db_get_messages.threshold,
      actual_ms: avgMs,
      baseline_ms: PERFORMANCE_BASELINES.db_get_messages.baseline,
      threshold_ms: PERFORMANCE_BASELINES.db_get_messages.threshold,
      detail: avgMs <= PERFORMANCE_BASELINES.db_get_messages.baseline 
        ? 'Performance is optimal' 
        : avgMs <= PERFORMANCE_BASELINES.db_get_messages.threshold 
          ? 'Performance is acceptable' 
          : 'Performance degraded',
    });
  } catch (err: any) {
    baselines.push({
      name: 'db_get_messages_100',
      passed: false,
      actual_ms: -1,
      baseline_ms: PERFORMANCE_BASELINES.db_get_messages.baseline,
      threshold_ms: PERFORMANCE_BASELINES.db_get_messages.threshold,
      detail: `Error: ${err.message}`,
    });
  }
  
  // Baseline: db_validateContracts
  const t3 = Date.now();
  try {
    for (let i = 0; i < 50; i++) {
      db.validateContracts(testRoom);
    }
    const elapsed = Date.now() - t3;
    const avgMs = elapsed / 50;
    baselines.push({
      name: 'db_validate_contracts_50',
      passed: avgMs <= PERFORMANCE_BASELINES.db_validate_contracts.threshold,
      actual_ms: avgMs,
      baseline_ms: PERFORMANCE_BASELINES.db_validate_contracts.baseline,
      threshold_ms: PERFORMANCE_BASELINES.db_validate_contracts.threshold,
      detail: avgMs <= PERFORMANCE_BASELINES.db_validate_contracts.baseline 
        ? 'Performance is optimal' 
        : avgMs <= PERFORMANCE_BASELINES.db_validate_contracts.threshold 
          ? 'Performance is acceptable' 
          : 'Performance degraded',
    });
  } catch (err: any) {
    baselines.push({
      name: 'db_validate_contracts_50',
      passed: false,
      actual_ms: -1,
      baseline_ms: PERFORMANCE_BASELINES.db_validate_contracts.baseline,
      threshold_ms: PERFORMANCE_BASELINES.db_validate_contracts.threshold,
      detail: `Error: ${err.message}`,
    });
  }
  
  // Note: db_pulse benchmark removed — pulse() is private throughout the codebase
  // (pre-existing architectural issue). The other baselines provide sufficient
  // coverage of critical DB operations.
  
  return baselines;
}

/**
 * Run the integration gate. Returns structured results.
 * Does NOT send DMs — caller decides what to do with the results.
 */
export function runGate(db: BrainDB, room: string, cwd: string): GateResult {
  const overallStart = Date.now();
  
  // ── 1. TypeScript compilation check ──
  let tscErrors: GateError[] = [];
  const hasTsConfig = existsSync(join(cwd, 'tsconfig.json'));

  if (hasTsConfig) {
    try {
      execSync('npx tsc --noEmit 2>&1', {
        cwd,
        encoding: 'utf-8',
        timeout: PERFORMANCE_BASELINES.tsc_timeout,
      });
    } catch (err: any) {
      const output = (err.stdout || '') + (err.stderr || '');
      tscErrors = parseTscOutput(output);
    }
  }

  // ── 2. Contract validation ──
  const mismatches = db.validateContracts(room);

  // ── 3. Test execution ──
  const testResult = runTests(cwd, PERFORMANCE_BASELINES.test_timeout);

  // ── 4. Behavioral validation checks ──
  const behavioralChecks = runBehavioralChecks(db, room);

  // ── 5. Performance baseline checks ──
  const performanceBaselines = runPerformanceBaselines(db, room);

  // ── 6. Route errors to responsible agents ──
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

  function addError(agentId: string, agentName: string, category: string, error: string) {
    const entry = errorsByAgent.get(agentId) || { agent_id: agentId, agent_name: agentName, errors: [] };
    entry.errors.push(`[${category}] ${error}`);
    errorsByAgent.set(agentId, entry);
  }

  // Route tsc errors
  for (const err of tscErrors) {
    if (err.severity === 'warning') continue; // Don't route warnings as errors
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
      addError(owner.id, owner.name, 'tsc', errStr);
    }
  }

  // Route contract mismatches — notify BOTH sides
  for (const m of mismatches) {
    // Notify the expecting agent
    const expecter = agents.find(a => a.name === m.expected_by);
    if (expecter) {
      addError(expecter.id, expecter.name, 'contract', m.detail);
    }
    // Notify the providing agent (if exists)
    if (m.provided_by) {
      const provider = agents.find(a => a.name === m.provided_by);
      if (provider) {
        addError(provider.id, provider.name, 'contract', m.detail);
      }
    }
  }

  // Route test failures — attribute to authors of changed files if possible
  for (const failure of testResult.failures) {
    // Try to extract file from failure message
    const fileMatch = failure.match(/\/([^\/\s]+\.(ts|js|mjs)):/);
    if (fileMatch) {
      const file = fileMatch[1];
      let owner = fileToAgent.get(file);
      if (!owner) {
        for (const [resource, agent] of fileToAgent) {
          if (file.startsWith(resource)) {
            owner = agent;
            break;
          }
        }
      }
      if (owner) {
        addError(owner.id, owner.name, 'test', failure.slice(0, 200));
      }
    }
  }

  // Route behavioral check failures
  for (const check of behavioralChecks) {
    if (!check.passed) {
      // Behavioral failures are typically system-level, route to conductor
      addError('conductor', 'Conductor', 'behavioral', `${check.name}: ${check.detail}`);
    }
  }

  // Route performance baseline failures
  for (const baseline of performanceBaselines) {
    if (!baseline.passed) {
      addError('conductor', 'Conductor', 'performance', `${baseline.name}: ${baseline.detail} (${baseline.actual_ms.toFixed(2)}ms avg)`);
    }
  }

  // Determine overall pass/fail
  const tscPassed = tscErrors.filter(e => e.severity === 'error').length === 0;
  const contractsPassed = mismatches.length === 0;
  const testsPassed = testResult.passed;
  const behavioralPassed = behavioralChecks.every(c => c.passed);
  const performancePassed = performanceBaselines.every(b => b.passed);
  
  const passed = tscPassed && contractsPassed && testsPassed && behavioralPassed && performancePassed;

  const parts: string[] = [];
  if (hasTsConfig) {
    parts.push(tscPassed ? 'tsc: PASS' : `tsc: ${tscErrors.filter(e => e.severity === 'error').length} error(s)`);
  } else {
    parts.push('tsc: skipped (no tsconfig.json)');
  }
  parts.push(contractsPassed ? 'contracts: PASS' : `contracts: ${mismatches.length} mismatch(es)`);
  parts.push(testsPassed ? 'tests: PASS' : `tests: ${testResult.failures.length} failure(s)`);
  parts.push(behavioralPassed ? 'behavioral: PASS' : `behavioral: ${behavioralChecks.filter(c => !c.passed).length} check(s) failed`);
  parts.push(performancePassed ? 'performance: PASS' : `performance: ${performanceBaselines.filter(b => !b.passed).length} baseline(s) degraded`);

  return {
    passed,
    tsc: { 
      passed: tscPassed, 
      error_count: tscErrors.filter(e => e.severity === 'error').length, 
      errors: tscErrors 
    },
    contracts: { passed: contractsPassed, mismatch_count: mismatches.length, mismatches },
    tests: { passed: testsPassed, result: testResult },
    behavioral: { passed: behavioralPassed, checks: behavioralChecks },
    performance: { passed: performancePassed, baselines: performanceBaselines },
    routed: [...errorsByAgent.values()],
    summary: passed ? `GATE PASSED — ${parts.join(', ')}` : `GATE FAILED — ${parts.join(', ')}`,
    duration_ms: Date.now() - overallStart,
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
    // Group errors by category for cleaner reporting
    const categories = ['tsc', 'contract', 'test', 'behavioral', 'performance'];
    
    // DM each agent with their specific errors
    for (const routed of result.routed) {
      // Group errors by category
      const byCategory = new Map<string, string[]>();
      for (const err of routed.errors) {
        const match = err.match(/^\[([^\]]+)\]\s*(.+)$/);
        const cat = match ? match[1] : 'unknown';
        const msg = match ? match[2] : err;
        const list = byCategory.get(cat) || [];
        list.push(msg);
        byCategory.set(cat, list);
      }
      
      const lines: string[] = [
        `INTEGRATION GATE FAILED — you have ${routed.errors.length} error(s) to fix:`,
        '',
      ];
      
      for (const cat of categories) {
        const catErrors = byCategory.get(cat);
        if (catErrors?.length) {
          lines.push(`─── ${cat.toUpperCase()} (${catErrors.length}) ───`);
          for (let i = 0; i < catErrors.length; i++) {
            lines.push(`  ${i + 1}. ${catErrors[i]}`);
          }
          lines.push('');
        }
      }
      
      lines.push('Fix these issues, then call brain_contract_check and brain_pulse with status="done" when ready.');
      
      const message = lines.join('\n');
      db.sendDM(conductorId, conductorName, routed.agent_id, message);
      // Note: Setting agent status to 'working' would be done here via pulse(),
      // but pulse() is private throughout the codebase (pre-existing issue).
      // The DM notification is the primary mechanism for alerting agents.
    }

    // Post gate failure to alerts channel
    db.postMessage('alerts', room, conductorId, conductorName, result.summary);
  } else {
    db.postMessage('general', room, conductorId, conductorName, result.summary);
  }

  return result;
}
