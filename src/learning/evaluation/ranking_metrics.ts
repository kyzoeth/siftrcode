/**
 * SiftrCode V3 - Ranking Metrics Calculator (Phase V3.1E & F)
 *
 * Implements canonical ranking evaluation metrics:
 * NDCG@k, Recall@k, MRR, Target Coverage, and Context Token Accounting.
 *
 * Invariant:
 * Evaluated on identical candidate pools, candidate budgets, and token budgets.
 */

export interface TaskRankingEvaluation {
  taskId: string;
  candidateCount: number;
  tokensConsumed: number;
  latencyMs: number;
  firstHitRank: number;
  ndcg5: number;
  ndcg10: number;
  ndcg20: number;
  recall5: number;
  recall10: number;
  recall20: number;
  recall50: number;
  mrr: number;
  targetHit: boolean;
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
}

export class RankingMetricsCalculator {
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

    let dcg5 = 0, idcg5 = 0;
    let dcg10 = 0, idcg10 = 0;
    let dcg20 = 0, idcg20 = 0;
    let hits5 = 0, hits10 = 0, hits20 = 0, hits50 = 0;
    let firstHitRank = 0;
    let tokensAccumulated = 0;

    for (let r = 0; r < rankedUnits.length; r++) {
      const rankNum = r + 1;
      const unit = rankedUnits[r];
      const uPath = (unit.path || '').toLowerCase();
      const isTarget = targets.some((tp) => uPath.endsWith(tp) || uPath.includes(tp));
      const rel = isTarget ? 1 : 0;

      if (isTarget && firstHitRank === 0) {
        firstHitRank = rankNum;
      }

      if (rankNum <= 5) {
        if (rel > 0) hits5++;
        dcg5 += rel / Math.log2(rankNum + 1);
      }
      if (rankNum <= 10) {
        if (rel > 0) hits10++;
        dcg10 += rel / Math.log2(rankNum + 1);
      }
      if (rankNum <= 20) {
        if (rel > 0) hits20++;
        dcg20 += rel / Math.log2(rankNum + 1);
      }
      if (rankNum <= 50 && rel > 0) {
        hits50++;
      }

      const tok = unit.tokenEstimate || 100;
      if (tokensAccumulated + tok <= tokenLimit) {
        tokensAccumulated += tok;
      }
    }

    const totalTargets = Math.max(1, targets.length);
    for (let t = 1; t <= Math.min(totalTargets, 5); t++) idcg5 += 1 / Math.log2(t + 1);
    for (let t = 1; t <= Math.min(totalTargets, 10); t++) idcg10 += 1 / Math.log2(t + 1);
    for (let t = 1; t <= Math.min(totalTargets, 20); t++) idcg20 += 1 / Math.log2(t + 1);

    const ndcg5 = idcg5 > 0 ? dcg5 / idcg5 : 0;
    const ndcg10 = idcg10 > 0 ? dcg10 / idcg10 : 0;
    const ndcg20 = idcg20 > 0 ? dcg20 / idcg20 : 0;
    const recall5 = hits5 / totalTargets;
    const recall10 = hits10 / totalTargets;
    const recall20 = hits20 / totalTargets;
    const recall50 = hits50 / totalTargets;
    const mrr = firstHitRank > 0 ? 1 / firstHitRank : 0;

    return {
      taskId,
      candidateCount: rankedUnits.length,
      tokensConsumed: tokensAccumulated,
      latencyMs,
      firstHitRank,
      ndcg5: Number(ndcg5.toFixed(4)),
      ndcg10: Number(ndcg10.toFixed(4)),
      ndcg20: Number(ndcg20.toFixed(4)),
      recall5: Number(recall5.toFixed(4)),
      recall10: Number(recall10.toFixed(4)),
      recall20: Number(recall20.toFixed(4)),
      recall50: Number(recall50.toFixed(4)),
      mrr: Number(mrr.toFixed(4)),
      targetHit: firstHitRank > 0,
    };
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
    };
  }
}
