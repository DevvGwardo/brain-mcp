/**
 * Smart Task Router — auto-selects models based on task complexity
 * and historical agent metrics.
 *
 * Uses a simple scoring formula combining success rate, speed, and quality.
 * Falls back to static complexity-based mapping when no historical data exists.
 */

import type { BrainDB } from './db.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ModelStats {
  model: string;
  total_tasks: number;
  successes: number;
  failures: number;
  success_rate: number;
  avg_duration: number | null;
  avg_gate_passes: number | null;
  avg_tsc_errors: number | null;
}

export interface RouteRecommendation {
  model: string;
  confidence: number;
  complexity: 'simple' | 'medium' | 'complex';
  reasoning: string;
  alternatives: Array<{ model: string; score: number }>;
  based_on_samples: number;
}

export interface RouteOptions {
  available_models?: string[];
  prefer_speed?: boolean;
  prefer_quality?: boolean;
}

// ── Complexity Keywords ────────────────────────────────────────────────────

const SIMPLE_KEYWORDS = [
  'test', 'lint', 'format', 'rename', 'typo', 'comment', 'log',
  'add console', 'fix typo', 'update version', 'bump', 'cleanup',
  'remove unused', 'delete', 'simple', 'trivial', 'minor',
];

const COMPLEX_KEYWORDS = [
  'architect', 'refactor', 'design', 'migrate', 'security',
  'performance', 'optimize', 'rewrite', 'implement from scratch',
  'distributed', 'concurrent', 'parallel', 'multi-', 'real-time',
  'authentication', 'authorization', 'encryption', 'database schema',
  'api design', 'system design', 'infrastructure', 'deploy',
];

// ── Static Model Tiers (cold start) ────────────────────────────────────────

const DEFAULT_TIERS: Record<string, string[]> = {
  simple: ['haiku', 'flash', 'gpt-4o-mini', 'minimax'],
  medium: ['sonnet', 'gpt-4o', 'gemini-pro'],
  complex: ['opus', 'gpt-4.5', 'o3', 'deepseek-r1'],
};

// ── Router ─────────────────────────────────────────────────────────────────

export class TaskRouter {
  constructor(
    private db: BrainDB,
    private room: string,
  ) {}

  /**
   * Classify task complexity based on description heuristics.
   */
  classifyComplexity(task: string): 'simple' | 'medium' | 'complex' {
    const lower = task.toLowerCase();
    const len = task.length;

    // Check for complex indicators
    const complexScore = COMPLEX_KEYWORDS.filter(k => lower.includes(k)).length;
    if (complexScore >= 2 || len > 500) return 'complex';

    // Check for simple indicators
    const simpleScore = SIMPLE_KEYWORDS.filter(k => lower.includes(k)).length;
    if (simpleScore >= 1 && len < 200) return 'simple';

    // File count heuristic (if files are mentioned)
    const fileMatches = task.match(/\b[\w/-]+\.\w{1,4}\b/g) || [];
    if (fileMatches.length >= 5) return 'complex';

    // Length-based fallback
    if (len < 100) return 'simple';
    if (len > 300) return 'complex';

    return 'medium';
  }

  /**
   * Get historical performance stats grouped by model.
   */
  getModelPerformance(): Map<string, ModelStats> {
    const rows = this.db.getModelMetrics(this.room);
    const stats = new Map<string, ModelStats>();
    for (const row of rows) {
      stats.set(row.model, row);
    }
    return stats;
  }

  /**
   * Route a task to the best available model.
   */
  routeTask(task: string, options?: RouteOptions): RouteRecommendation {
    const complexity = this.classifyComplexity(task);
    const performance = this.getModelPerformance();
    const availableModels = options?.available_models;

    // Filter to available models if specified
    let candidates: ModelStats[] = [...performance.values()];
    if (availableModels?.length) {
      candidates = candidates.filter(c =>
        availableModels.some(m => c.model.includes(m) || m.includes(c.model))
      );
    }

    const totalSamples = candidates.reduce((sum, c) => sum + c.total_tasks, 0);

    // Cold start — no historical data
    if (candidates.length === 0 || totalSamples < 3) {
      return this.coldStartRoute(complexity, availableModels);
    }

    // Score each candidate
    const scored = candidates.map(c => ({
      model: c.model,
      score: this.scoreModel(c, complexity, options),
      stats: c,
    }));

    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    const confidence = Math.min(0.95, totalSamples / 50); // More data = more confidence

    return {
      model: best.model,
      confidence: Math.round(confidence * 100) / 100,
      complexity,
      reasoning: this.explainChoice(best.model, best.score, complexity, best.stats, totalSamples),
      alternatives: scored.slice(1, 4).map(s => ({ model: s.model, score: Math.round(s.score * 100) / 100 })),
      based_on_samples: totalSamples,
    };
  }

  private scoreModel(stats: ModelStats, complexity: string, options?: RouteOptions): number {
    const speedWeight = options?.prefer_speed ? 0.5 : 0.3;
    const qualityWeight = options?.prefer_quality ? 0.5 : 0.2;
    const successWeight = 1 - speedWeight - qualityWeight;

    // Success rate (0–1)
    const successScore = stats.success_rate;

    // Speed factor (normalized inverse duration, 0–1)
    let speedScore = 0.5; // default for missing data
    if (stats.avg_duration !== null && stats.avg_duration > 0) {
      // Faster = better. Cap at 10 min = 0, 10 sec = 1
      speedScore = Math.max(0, Math.min(1, 1 - (stats.avg_duration - 10) / 590));
    }

    // Quality factor (inverse error rate, 0–1)
    let qualityScore = 0.5;
    if (stats.avg_tsc_errors !== null) {
      qualityScore = Math.max(0, Math.min(1, 1 - stats.avg_tsc_errors / 20));
    }

    // Complexity bonus: prefer expensive models for complex tasks
    let complexityBonus = 0;
    if (complexity === 'complex') {
      // Boost models with higher success rates on any task
      complexityBonus = successScore > 0.8 ? 0.1 : 0;
    } else if (complexity === 'simple') {
      // Boost faster models for simple tasks
      complexityBonus = speedScore > 0.7 ? 0.1 : 0;
    }

    return (
      successScore * successWeight +
      speedScore * speedWeight +
      qualityScore * qualityWeight +
      complexityBonus
    );
  }

  private coldStartRoute(complexity: string, availableModels?: string[]): RouteRecommendation {
    const tier = DEFAULT_TIERS[complexity] || DEFAULT_TIERS.medium;

    // Find the first available model from the tier
    let model = tier[0];
    if (availableModels?.length) {
      const match = tier.find(t =>
        availableModels.some(m => m.includes(t) || t.includes(m))
      );
      model = match || availableModels[0];
    }

    return {
      model,
      confidence: 0.3, // Low confidence — cold start
      complexity: complexity as 'simple' | 'medium' | 'complex',
      reasoning: `Cold start (no historical data). Using static mapping: ${complexity} → ${model}. Confidence will improve as metrics accumulate.`,
      alternatives: tier.slice(1, 4).map((m, i) => ({ model: m, score: 0.3 - (i * 0.05) })),
      based_on_samples: 0,
    };
  }

  private explainChoice(
    model: string, score: number, complexity: string,
    stats: ModelStats, samples: number,
  ): string {
    const parts: string[] = [
      `Task classified as ${complexity}.`,
      `${model}: ${Math.round(stats.success_rate * 100)}% success rate across ${stats.total_tasks} tasks.`,
    ];
    if (stats.avg_duration !== null) {
      parts.push(`Avg duration: ${Math.round(stats.avg_duration)}s.`);
    }
    if (stats.avg_gate_passes !== null && stats.avg_gate_passes > 1) {
      parts.push(`Avg ${stats.avg_gate_passes.toFixed(1)} gate iterations.`);
    }
    parts.push(`Score: ${score.toFixed(3)} (based on ${samples} total samples).`);
    return parts.join(' ');
  }
}
