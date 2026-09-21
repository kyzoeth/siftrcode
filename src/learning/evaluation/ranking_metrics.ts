/**
 * SiftrCode V3 - Ranking Metrics Calculator (Phase V3.1E & F)
 *
 * Implements canonical, deduplicated, bounded ranking evaluation metrics:
 * NDCG@k, Recall@k, MRR, Target Coverage, and Context Token Accounting.
 *
 * Invariants (P0-5, P0-6):
 * 1. Materialized Token Budgeting: Canonical promotion metrics evaluate the actual
 *    budget-constrained context bundle (<= 8,000 tokens) exposed to the agent.
 * 2. Deduplicated Targets: Multiple units matching the same target path do not inflate DCG or Recall.
 * 3. Strict [0, 1] Clamping: Asserts 0.0 <= metric <= 1.0 for all values.
 * 4. Zero-Candidate Episodes: Retained in the evaluation denominator with 0 metrics.
 */

export interface TaskRankingEvaluation {
  taskId: string;
  candidateCount: number;
  tokensConsumed: number;
  latencyMs: number;
  firstHitRank: number;
  // Post-budget canonical metrics (evaluated on the actual budget-constrained bundle exposed to agent)
  ndcg5: number;
  ndcg10: number;
  ndcg20: number;
  recall5: number;
  recall10: number;
  recall20: number;
  recall50: number;
  mrr: number;
  targetHit: boolean;
  // Pre-budget diagnostic metrics (evaluated on full unconstrained candidate list)
  preBudgetNdcg5?: number;
  preBudgetNdcg10?: number;
  preBudgetNdcg20?: number;
  preBudgetRecall10?: number;
  preBudgetMrr?: number;
}

export interface AggregateRankingMetrics {
  totalTasks: number;
  ndcg5: number;
  ndcg10: number;
  ndcg20: number;
  recall5: number;
  recall10: number;
  recall20: number;
  recall50: number;
  mrr: number;
  meanLatencyMs: number;
  meanTokens: number;
  targetCoverage: number;
  preBudgetNdcg10?: number;
  preBudgetRecall10?: number;
}

export class RankingMetricsCalculator {
  /**
   * Materializes the actual budget-constrained context bundle up to tokenLimit.
   */
  public static materializeBudgetedBundle(
    rankedUnits: Array<{ contextUnitId: string; path?: string; tokenEstimate?: number }>,
    tokenLimit: number = 8000
  ): Array<{ contextUnitId: string; path?: string; tokenEstimate?: number }> {
    const bundle: Array<{ contextUnitId: string; path?: string; tokenEstimate?: number }> = [];
    let accumulatedTokens = 0;
    for (const unit of rankedUnits) {
      const tok = unit.tokenEstimate || 100;
      if (accumulatedTokens + tok <= tokenLimit) {
        bundle.push(unit);
        accumulatedTokens += tok;
      }
    }
    return bundle;
  }

  /**
   * Computes comprehensive ranking metrics for a single task episode.
   */
  public static evaluateTaskRanking(params: {
    taskId: string;
    rankedUnits: Array<{ contextUnitId: string; path?: string; tokenEstimate?: number }>;
    expectedTargetPaths: string[];
    tokenLimit?: number;
    latencyMs?: number;
  }): TaskRankingEvaluation {
    const { taskId, rankedUnits, expectedTargetPaths, tokenLimit = 8000, latencyMs = 0 } = params;
    const targets = expectedTargetPaths.map((p) => p.toLowerCase());
    const totalTargets = Math.max(1, targets.length);

    // Handle zero-candidate episode cleanly (must remain in denominator)
    if (rankedUnits.length === 0) {
      return {
        taskId,
        candidateCount: 0,
        tokensConsumed: 0,
        latencyMs,
        firstHitRank: 0,
        ndcg5: 0,
        ndcg10: 0,
        ndcg20: 0,
        recall5: 0,
        recall10: 0,
        recall20: 0,
        recall50: 0,
        mrr: 0,
        targetHit: false,
        preBudgetNdcg5: 0,
        preBudgetNdcg10: 0,
        preBudgetNdcg20: 0,
        preBudgetRecall10: 0,
        preBudgetMrr: 0,
      };
    }

    // 1. Diagnostic: Pre-budget metrics on unconstrained ranked list
    const preBudget = this.computeMetricsForList(rankedUnits, targets, totalTargets);

    // 2. Canonical: Post-budget metrics on materialized bundle exposed to agent
    const budgetedBundle = this.materializeBudgetedBundle(rankedUnits, tokenLimit);
    const postBudget = this.computeMetricsForList(budgetedBundle, targets, totalTargets);

    let tokensConsumed = 0;
    for (const u of budgetedBundle) {
      tokensConsumed += u.tokenEstimate || 100;
    }

    // Invariant assertion: all metrics must be strictly in [0, 1]
    this.assertBounds(postBudget.ndcg5, 'ndcg5');
    this.assertBounds(postBudget.ndcg10, 'ndcg10');
    this.assertBounds(postBudget.ndcg20, 'ndcg20');
    this.assertBounds(postBudget.recall5, 'recall5');
    this.assertBounds(postBudget.recall10, 'recall10');
    this.assertBounds(postBudget.recall20, 'recall20');
    this.assertBounds(postBudget.recall50, 'recall50');
    this.assertBounds(postBudget.mrr, 'mrr');

    return {
      taskId,
      candidateCount: rankedUnits.length,
      tokensConsumed,
      latencyMs,
      firstHitRank: postBudget.firstHitRank,
      ndcg5: postBudget.ndcg5,
      ndcg10: postBudget.ndcg10,
      ndcg20: postBudget.ndcg20,
      recall5: postBudget.recall5,
      recall10: postBudget.recall10,
      recall20: postBudget.recall20,
      recall50: postBudget.recall50,
      mrr: postBudget.mrr,
      targetHit: postBudget.firstHitRank > 0,
      preBudgetNdcg5: preBudget.ndcg5,
      preBudgetNdcg10: preBudget.ndcg10,
      preBudgetNdcg20: preBudget.ndcg20,
      preBudgetRecall10: preBudget.recall10,
      preBudgetMrr: preBudget.mrr,
    };
  }

  private static computeMetricsForList(
    units: Array<{ contextUnitId: string; path?: string; tokenEstimate?: number }>,
    targets: string[],
    totalTargets: number
  ) {
    const discoveredTargets = new Set<string>();
    let firstHitRank = 0;
    let dcg5 = 0;
    let dcg10 = 0;
    let dcg20 = 0;

    for (let r = 0; r < units.length; r++) {
      const rankNum = r + 1;
      const unit = units[r];
      const uPath = (unit.path || '').toLowerCase();

      let isNewTargetHit = false;
      for (const tp of targets) {
        if (uPath.endsWith(tp) || uPath.includes(tp)) {
          if (firstHitRank === 0) {
            firstHitRank = rankNum;
          }
          if (!discoveredTargets.has(tp)) {
            discoveredTargets.add(tp);
            isNewTargetHit = true;
          }
        }
      }

      const rel = isNewTargetHit ? 1 : 0;
      if (rankNum <= 5 && rel > 0) dcg5 += rel / Math.log2(rankNum + 1);
      if (rankNum <= 10 && rel > 0) dcg10 += rel / Math.log2(rankNum + 1);
      if (rankNum <= 20 && rel > 0) dcg20 += rel / Math.log2(rankNum + 1);
    }

    const countUniqueHitsAtK = (k: number) => {
      const seen = new Set<string>();
      for (let r = 0; r < Math.min(k, units.length); r++) {
        const uPath = (units[r].path || '').toLowerCase();
        for (const tp of targets) {
          if (uPath.endsWith(tp) || uPath.includes(tp)) {
            seen.add(tp);
          }
        }
      }
      return seen.size;
    };

    const hits5 = countUniqueHitsAtK(5);
    const hits10 = countUniqueHitsAtK(10);
    const hits20 = countUniqueHitsAtK(20);
    const hits50 = countUniqueHitsAtK(50);

    let idcg5 = 0;
    let idcg10 = 0;
    let idcg20 = 0;
    for (let t = 1; t <= Math.min(totalTargets, 5); t++) idcg5 += 1 / Math.log2(t + 1);
    for (let t = 1; t <= Math.min(totalTargets, 10); t++) idcg10 += 1 / Math.log2(t + 1);
    for (let t = 1; t <= Math.min(totalTargets, 20); t++) idcg20 += 1 / Math.log2(t + 1);

    const ndcg5 = idcg5 > 0 ? Math.min(1.0, Math.max(0.0, dcg5 / idcg5)) : 0;
    const ndcg10 = idcg10 > 0 ? Math.min(1.0, Math.max(0.0, dcg10 / idcg10)) : 0;
    const ndcg20 = idcg20 > 0 ? Math.min(1.0, Math.max(0.0, dcg20 / idcg20)) : 0;

    const recall5 = Math.min(1.0, Math.max(0.0, hits5 / totalTargets));
    const recall10 = Math.min(1.0, Math.max(0.0, hits10 / totalTargets));
    const recall20 = Math.min(1.0, Math.max(0.0, hits20 / totalTargets));
    const recall50 = Math.min(1.0, Math.max(0.0, hits50 / totalTargets));
    const mrr = firstHitRank > 0 ? Math.min(1.0, Math.max(0.0, 1 / firstHitRank)) : 0;

    return {
      firstHitRank,
      ndcg5: Number(ndcg5.toFixed(4)),
      ndcg10: Number(ndcg10.toFixed(4)),
      ndcg20: Number(ndcg20.toFixed(4)),
      recall5: Number(recall5.toFixed(4)),
      recall10: Number(recall10.toFixed(4)),
      recall20: Number(recall20.toFixed(4)),
      recall50: Number(recall50.toFixed(4)),
      mrr: Number(mrr.toFixed(4)),
    };
  }

  private static assertBounds(val: number, name: string): void {
    if (isNaN(val) || val < 0.0 || val > 1.0) {
      throw new Error(`[RankingMetricsCalculator] Metric bound violation for ${name}: ${val}. Must be in [0, 1].`);
    }
  }

  /**
   * Computes aggregate metrics across multiple task evaluations.
   */
  public static computeAggregate(tasks: TaskRankingEvaluation[]): AggregateRankingMetrics {
    const n = Math.max(1, tasks.length);
    const mean = (fn: (t: TaskRankingEvaluation) => number) =>
      Number((tasks.reduce((acc, t) => acc + fn(t), 0) / n).toFixed(4));

    const hits = tasks.filter((t) => t.targetHit).length;

    return {
      totalTasks: tasks.length,
      ndcg5: mean((t) => t.ndcg5),
      ndcg10: mean((t) => t.ndcg10),
      ndcg20: mean((t) => t.ndcg20),
      recall5: mean((t) => t.recall5),
      recall10: mean((t) => t.recall10),
      recall20: mean((t) => t.recall20),
      recall50: mean((t) => t.recall50),
      mrr: mean((t) => t.mrr),
      meanLatencyMs: Number((tasks.reduce((acc, t) => acc + t.latencyMs, 0) / n).toFixed(1)),
      meanTokens: Math.round(tasks.reduce((acc, t) => acc + t.tokensConsumed, 0) / n),
      targetCoverage: Number((hits / n).toFixed(4)),
      preBudgetNdcg10: mean((t) => t.preBudgetNdcg10 || 0),
      preBudgetRecall10: mean((t) => t.preBudgetRecall10 || 0),
    };
  }
}
