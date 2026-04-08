export type WorkflowKind = 'feature' | 'bugfix' | 'refactor' | 'integration' | 'research';
export type WorkflowMode = 'claude' | 'py' | 'pi' | 'pi-core';

export interface ModelSuggestion {
  model: string;
  confidence?: number;
  reasoning?: string;
}

export interface WorkflowAgentSpec {
  name: string;
  role: string;
  phase: string;
  task: string;
  files: string[];
  depends_on?: string[];
  model?: string;
  model_confidence?: number;
  model_reasoning?: string;
  acceptance: string[];
}

export interface WorkflowTaskSpec {
  name: string;
  phase: string;
  description: string;
  depends_on?: string[];
  agent_name: string;
  files: string[];
  acceptance: string[];
}

export interface WorkflowPhaseSpec {
  name: string;
  parallel: boolean;
  objective: string;
  agents: WorkflowAgentSpec[];
}

export interface ConductorAgentConfig {
  name: string;
  task: string;
  files?: string[];
  model?: string;
  role?: string;
  acceptance?: string[];
  depends_on?: string[];
  workspace?: string;
  thinking_level?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  thinking_budgets?: { minimal?: number; low?: number; medium?: number; high?: number };
}

export interface ConductorPhaseConfig {
  name: string;
  parallel: boolean;
  agents: ConductorAgentConfig[];
}

export interface WorkflowConductorConfig {
  task: string;
  cwd: string;
  gate: boolean;
  timeout: number;
  max_gate_retries: number;
  mode: WorkflowMode;
  model?: string;
  thinking_level?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  thinking_budgets?: { minimal?: number; low?: number; medium?: number; high?: number };
  phases: ConductorPhaseConfig[];
}

export interface CompiledWorkflow {
  kind: WorkflowKind;
  goal: string;
  summary: string;
  rationale: string[];
  domains: string[];
  phases: WorkflowPhaseSpec[];
  tasks: WorkflowTaskSpec[];
  conductor_config: WorkflowConductorConfig;
  suggested_layout: 'headless' | 'horizontal' | 'tiled';
  suggested_next_steps: string[];
}

export interface WorkflowCompileOptions {
  cwd?: string;
  mode?: WorkflowMode;
  max_agents?: number;
  available_models?: string[];
  focus_files?: string[];
  recommendModel?: (task: string, role: string) => ModelSuggestion | undefined;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

interface DomainBlueprint {
  key: string;
  role: string;
  keywords: string[];
  files: string[];
  implementationTask: (goal: string, kind: WorkflowKind) => string;
  acceptance: string[];
}

const DOMAIN_BLUEPRINTS: DomainBlueprint[] = [
  {
    key: 'orchestration',
    role: 'workflow-compiler',
    keywords: ['workflow', 'swarm', 'agent', 'orchestrat', 'autopilot', 'planner', 'compiler', 'brain_wake', 'brain_swarm'],
    files: ['src/index.ts', 'src/conductor.ts', 'src/autopilot.ts', 'src/router.ts', 'hermes/orchestrator.py'],
    implementationTask: (goal, kind) =>
      kind === 'bugfix'
        ? `Fix the orchestration/runtime path for: ${goal}. Keep spawned-agent behavior stable and avoid regressions in plan or swarm flows.`
        : `Implement the core orchestration and workflow-runtime changes for: ${goal}. Reuse existing brain plan/swarm primitives instead of inventing a second control plane.`,
    acceptance: [
      'Workflow/task decomposition is encoded in brain primitives, not only prose.',
      'Spawn-time instructions are specific enough for each agent to execute independently.',
    ],
  },
  {
    key: 'transport',
    role: 'transport-runtime',
    keywords: ['render', 'renderer', 'output', 'transport', 'response', 'http', 'stream'],
    files: ['src/renderer.ts', 'src/http.ts'],
    implementationTask: (goal, kind) =>
      kind === 'bugfix'
        ? `Fix the transport/rendering path affected by: ${goal}. Preserve payload compatibility while improving observable output quality.`
        : `Wire the renderer or transport surfaces needed for: ${goal}. Keep tool-response formatting and external interfaces coherent.`,
    acceptance: [
      'User-facing output shape is explicit and testable.',
      'Transport behavior remains compatible with existing clients.',
    ],
  },
  {
    key: 'memory',
    role: 'memory-runtime',
    keywords: ['memory', 'sqlite', 'db', 'database', 'embedding', 'context', 'checkpoint', 'ledger'],
    files: ['src/db.ts', 'src/embeddings.ts', 'hermes-context/', 'hermes/db.py'],
    implementationTask: (goal, kind) =>
      kind === 'bugfix'
        ? `Fix the persistence/memory path involved in: ${goal}. Preserve existing DB semantics and migration safety.`
        : `Implement the persistence, context, or memory changes needed for: ${goal}. Fit them into the current SQLite-backed brain model.`,
    acceptance: [
      'State written by the workflow is queryable through existing brain tools.',
      'No new persistence path bypasses the current SQLite coordination layer.',
    ],
  },
  {
    key: 'api',
    role: 'tooling-surface',
    keywords: ['api', 'route', 'router', 'server', 'endpoint', 'mcp tool', 'tool schema', 'http'],
    files: ['src/index.ts', 'src/http.ts', 'src/router.ts'],
    implementationTask: (goal, kind) =>
      kind === 'bugfix'
        ? `Fix the MCP/API surface involved in: ${goal}. Keep tool schemas stable unless the change explicitly requires new parameters.`
        : `Expose the tooling/API surface required for: ${goal}. Match the existing MCP style, naming, and response shapes.`,
    acceptance: [
      'The MCP entrypoint exposes the new capability with clear parameters.',
      'The returned schema is structured enough for downstream automation.',
    ],
  },
  {
    key: 'python',
    role: 'python-conductor',
    keywords: ['python', 'hermes', 'cli', 'conductor', 'pipeline'],
    files: ['hermes/cli.py', 'hermes/orchestrator.py', 'hermes/prompt.py'],
    implementationTask: (goal, kind) =>
      kind === 'bugfix'
        ? `Fix the Python conductor flow touched by: ${goal}. Keep Hermes orchestration behavior consistent with the Node entrypoints.`
        : `Update the Python conductor integration for: ${goal}. Keep pipeline JSON and brain-driven orchestration aligned with the Node path.`,
    acceptance: [
      'Node and Python orchestration paths do not drift in capability or config shape.',
      'Generated workflow config can be consumed by the conductor without hand-editing.',
    ],
  },
  {
    key: 'docs',
    role: 'docs-sync',
    keywords: ['readme', 'docs', 'documentation', 'guide', 'example'],
    files: ['README.md'],
    implementationTask: (goal) =>
      `Document the user-facing workflow for: ${goal}. Include the shortest path for someone to use the new capability correctly.`,
    acceptance: [
      'At least one concrete usage example exists.',
      'Documentation matches the final tool names and parameter shapes.',
    ],
  },
];

const KIND_KEYWORDS: Record<WorkflowKind, string[]> = {
  feature: ['add', 'build', 'create', 'implement', 'support', 'introduce', 'upgrade'],
  bugfix: ['bug', 'fix', 'broken', 'issue', 'regression', 'error', 'fail', 'ugly'],
  refactor: ['refactor', 'restructure', 'cleanup', 'simplify', 'rename', 'split', 'extract', 'rework'],
  integration: ['integrate', 'wire', 'connect', 'bridge', 'sync', 'align', 'unify', 'compose'],
  research: ['research', 'explore', 'evaluate', 'compare', 'investigate', 'plan', 'analyze', 'spike'],
};

function countMatches(haystack: string, keywords: string[]): number {
  return keywords.reduce((count, keyword) => count + (haystack.includes(keyword) ? 1 : 0), 0);
}

function classifyWorkflowKind(goal: string): WorkflowKind {
  const lower = goal.toLowerCase();
  const scores = (Object.keys(KIND_KEYWORDS) as WorkflowKind[]).map((kind) => ({
    kind,
    score: countMatches(lower, KIND_KEYWORDS[kind]),
  }));
  scores.sort((a, b) => b.score - a.score);
  const [best] = scores;
  if (!best || best.score === 0) return 'feature';
  if (best.kind === 'integration' && lower.includes('fix')) return 'bugfix';
  return best.kind;
}

function detectDomains(goal: string, focusFiles?: string[]): string[] {
  const lower = `${goal} ${(focusFiles || []).join(' ')}`.toLowerCase();
  const scored = DOMAIN_BLUEPRINTS
    .map((domain) => ({ key: domain.key, score: countMatches(lower, domain.keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const domains = scored.map((entry) => entry.key);
  if (domains.length === 0) return ['orchestration'];
  if (!domains.includes('orchestration') && /(workflow|swarm|agent|plan|conductor|brain)/.test(lower)) {
    domains.unshift('orchestration');
  }
  return [...new Set(domains)];
}

function normalizeAgentName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'agent';
}

function uniqueFiles(files: string[], extra?: string[]): string[] {
  return [...new Set([...(files || []), ...(extra || [])])];
}

function buildPlannerAcceptance(kind: WorkflowKind): string[] {
  const base = [
    'The workflow explicitly maps goal -> phases -> agent tasks.',
    'Dependencies are encoded so the lead can sequence work without rereading the entire goal.',
  ];
  if (kind === 'bugfix') {
    base.push('The plan isolates diagnosis, code changes, and regression checks.');
  }
  if (kind === 'research') {
    base.push('The plan separates evidence gathering from implementation work.');
  }
  return base;
}

function timeoutFor(kind: WorkflowKind): number {
  switch (kind) {
    case 'bugfix':
      return 900;
    case 'research':
      return 1200;
    case 'refactor':
    case 'integration':
      return 1500;
    case 'feature':
    default:
      return 1800;
  }
}

function gateRetriesFor(kind: WorkflowKind): number {
  return kind === 'research' ? 1 : 3;
}

function defaultParallelAgents(maxAgents: number | undefined): number {
  const raw = maxAgents ?? 4;
  return Math.max(1, Math.min(raw, 6));
}

function buildAgent(
  name: string,
  role: string,
  phase: string,
  task: string,
  files: string[],
  acceptance: string[],
  recommendModel?: (task: string, role: string) => ModelSuggestion | undefined,
  depends_on?: string[],
): WorkflowAgentSpec {
  const suggestion = recommendModel?.(task, role);
  return {
    name: normalizeAgentName(name),
    role,
    phase,
    task,
    files,
    depends_on,
    model: suggestion?.model,
    model_confidence: suggestion?.confidence,
    model_reasoning: suggestion?.reasoning,
    acceptance,
  };
}

function makeTaskName(phase: string, agentName: string): string {
  return `${normalizeAgentName(phase)}:${normalizeAgentName(agentName)}`;
}

export function compileWorkflow(goal: string, options: WorkflowCompileOptions = {}): CompiledWorkflow {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) {
    throw new Error('Goal is required');
  }

  const kind = classifyWorkflowKind(trimmedGoal);
  const domains = detectDomains(trimmedGoal, options.focus_files);
  const maxAgents = defaultParallelAgents(options.max_agents);
  const recommendModel = options.recommendModel;
  const phases: WorkflowPhaseSpec[] = [];
  const lowerGoal = trimmedGoal.toLowerCase();

  const rationale: string[] = [
    `Classified goal as ${kind} based on its language and expected delivery shape.`,
    `Detected focus areas: ${domains.join(', ')}.`,
  ];

  const buildDomainLimit = Math.max(1, maxAgents - 2);
  const implementationDomains = domains.slice(0, buildDomainLimit);
  const needsPlanner =
    kind === 'research' ||
    kind === 'refactor' ||
    domains.length > 1 ||
    trimmedGoal.length > 120 ||
    (domains.includes('orchestration') && /(workflow|swarm|plan|planner|compiler|autopilot)/.test(lowerGoal));

  if (needsPlanner) {
    rationale.push('Added a design phase to force explicit decomposition before parallel execution.');
    phases.push({
      name: 'design',
      parallel: false,
      objective: 'Turn the goal into executable work slices and capture shared assumptions.',
      agents: [
        buildAgent(
          'planner',
          'workflow-planner',
          'design',
          `Analyze the goal and translate it into a concrete workflow for: ${trimmedGoal}. Define boundaries, shared assumptions, and the minimum contracts downstream agents need.`,
          uniqueFiles(['src/index.ts', 'src/conductor.ts', 'README.md'], options.focus_files),
          buildPlannerAcceptance(kind),
          recommendModel,
        ),
      ],
    });
  }

  const buildAgents = implementationDomains.map((domainKey) => {
    const blueprint = DOMAIN_BLUEPRINTS.find((entry) => entry.key === domainKey)!;
    return buildAgent(
      blueprint.role,
      blueprint.role,
      'build',
      blueprint.implementationTask(trimmedGoal, kind),
      uniqueFiles(blueprint.files, options.focus_files),
      blueprint.acceptance,
      recommendModel,
      needsPlanner ? ['planner'] : undefined,
    );
  });

  phases.push({
    name: 'build',
    parallel: buildAgents.length > 1,
    objective: 'Implement the core code changes in the narrowest parallel slices possible.',
    agents: buildAgents,
  });

  const needsIntegration = buildAgents.length > 1 || kind === 'integration';
  if (needsIntegration) {
    rationale.push('Added an integration phase because more than one build slice must be reconciled.');
    const integrationFiles = uniqueFiles(
      ['src/index.ts', 'src/conductor.ts', 'src/router.ts', 'hermes/orchestrator.py'],
      options.focus_files,
    );
    phases.push({
      name: 'integration',
      parallel: false,
      objective: 'Reconcile contracts between the parallel slices and make the final orchestration path coherent.',
      agents: [
        buildAgent(
          'integrator',
          'integration-owner',
          'integration',
          `Integrate the workflow pieces for: ${trimmedGoal}. Resolve contract mismatches, align runtime behavior, and ensure the lead can execute the workflow without manual glue code.`,
          integrationFiles,
          [
            'Parallel outputs compose into one end-to-end flow.',
            'Lead/invoker instructions are clear enough to run without reverse-engineering the code.',
          ],
          recommendModel,
          buildAgents.map((agent) => agent.name),
        ),
      ],
    });
  }

  const qualityDependsOn = needsIntegration
    ? ['integrator']
    : buildAgents.map((agent) => agent.name);
  phases.push({
    name: 'quality',
    parallel: false,
    objective: 'Prove the workflow works and capture the shortest usage path.',
    agents: [
      buildAgent(
        'quality',
        'verification-owner',
        'quality',
        `Add or update verification coverage for: ${trimmedGoal}. Prefer focused tests around the new workflow behavior and verify the exposed tool responses stay readable.`,
        uniqueFiles(['src/renderer.test.ts', 'src/test-harness.ts', 'test-e2e.mjs'], options.focus_files),
        [
          'There is at least one automated or scriptable verification path.',
          'The final workflow can be exercised without hidden manual steps.',
        ],
        recommendModel,
        qualityDependsOn,
      ),
    ],
  });

  const tasks: WorkflowTaskSpec[] = [];
  for (const phase of phases) {
    for (const agent of phase.agents) {
      tasks.push({
        name: makeTaskName(phase.name, agent.name),
        phase: phase.name,
        description: agent.task,
        depends_on: agent.depends_on?.map((dep) =>
          dep === 'planner'
            ? makeTaskName('design', dep)
            : dep === 'integrator'
              ? makeTaskName('integration', dep)
              : makeTaskName('build', dep),
        ),
        agent_name: agent.name,
        files: agent.files,
        acceptance: agent.acceptance,
      });
    }
  }

  const conductorPhases: ConductorPhaseConfig[] = phases.map((phase) => ({
    name: phase.name,
    parallel: phase.parallel,
    agents: phase.agents.map((agent) => ({
      name: agent.name,
      task: agent.task,
      files: agent.files,
      model: agent.model,
      role: agent.role,
      acceptance: agent.acceptance,
      depends_on: agent.depends_on,
    })),
  }));

  const summary = `${kind} workflow with ${phases.length} phase${phases.length === 1 ? '' : 's'} and ${tasks.length} agent task${tasks.length === 1 ? '' : 's'}.`;

  return {
    kind,
    goal: trimmedGoal,
    summary,
    rationale,
    domains,
    phases,
    tasks,
    conductor_config: {
      task: trimmedGoal,
      cwd: options.cwd || process.cwd(),
      gate: true,
      timeout: timeoutFor(kind),
      max_gate_retries: gateRetriesFor(kind),
      mode: options.mode || 'pi-core',
      model: undefined,
      thinking_level: options.thinkingLevel ?? 'medium',
      phases: conductorPhases,
    },
    suggested_layout: 'headless',
    suggested_next_steps: [
      'Review the compiled phases and trim any agent whose scope still overlaps.',
      'Persist the workflow with workflow_apply to create a brain plan and optional conductor config.',
      'Use plan_next or the generated conductor config to start execution.',
    ],
  };
}
