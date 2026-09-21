/**
 * SiftrCode V3 - Task-Level Statistical Bootstrap Evaluator (Phase V3.1F)
 *
 * Implements rigorous statistical analysis over paired task episodes:
 * - Resamples independent TASK EPISODES (not individual ContextUnits!)
 * - Computes 95% confidence intervals, empirical p-values, and win/tie/loss counts
 * - Stratified breakdown by repository and task type
 */

import { TaskRankingEvaluation } from './ranking_metrics';

export interface TaskPairedDelta {
  taskId: string;
  repo: string;
  taskType: string;
  baseline: TaskRankingEvaluation;
  candidate: TaskRankingEvaluation;
  ndcg10Delta: number;
  recall10Delta: number;
  mrrDelta: number;
  tokensDelta: number;
  latencyDelta: number;
}

export interface MetricBootstrapResult {
  meanDelta: number;
  medianDelta: number;
  ciLower95: number;
  ciUpper95: number;
  pValue: number;
  wins: number;
  ties: number;
  losses: number;
  isStatisticallySignificant: boolean;
}

export interface BootstrapEvaluationReport {
  totalTasks: number;
  iterations: number;
  randomSeed: number;
  ndcg10: MetricBootstrapResult;
  recall10: MetricBootstrapResult;
  mrr: MetricBootstrapResult;
  perRepoDeltas: Record<string, { ndcg10Delta: number; recall10Delta: number; mrrDelta: number; taskCount: number }>;
  perTypeDeltas: Record<string, { ndcg10Delta: number; recall10Delta: number; mrrDelta: number; taskCount: number }>;
}

export class TaskLevelBootstrap {
  /**
   * Resamples task episodes to calculate non-parametric bootstrap confidence intervals.
   */
  public static evaluate(
    deltas: TaskPairedDelta[],
    options: { iterations?: number; seed?: number } = {}
  ): BootstrapEvaluationReport {
    const iterations = options.iterations ?? 2000;
    const seed = options.seed ?? 42;
    const n = deltas.length;

    if (n === 0) {
      throw new Error('BOOTSTRAP_ERROR: Cannot perform bootstrap on zero task episodes.');
    }

    const ndcg10Deltas = deltas.map((d) => d.ndcg10Delta);
    const recall10Deltas = deltas.map((d) => d.recall10Delta);
    const mrrDeltas = deltas.map((d) => d.mrrDelta);

    const ndcg10Result = TaskLevelBootstrap.resampleMetric(ndcg10Deltas, iterations, seed);
    const recall10Result = TaskLevelBootstrap.resampleMetric(recall10Deltas, iterations, seed + 1);
    const mrrResult = TaskLevelBootstrap.resampleMetric(mrrDeltas, iterations, seed + 2);

    // Per-repository breakdown
    const perRepo: Record<string, { ndcgSum: number; recSum: number; mrrSum: number; count: number }> = {};
    for (const d of deltas) {
      if (!perRepo[d.repo]) {
        perRepo[d.repo] = { ndcgSum: 0, recSum: 0, mrrSum: 0, count: 0 };
      }
      perRepo[d.repo].ndcgSum += d.ndcg10Delta;
      perRepo[d.repo].recSum += d.recall10Delta;
      perRepo[d.repo].mrrSum += d.mrrDelta;
      perRepo[d.repo].count++;
    }

    const perRepoDeltas: Record<string, { ndcg10Delta: number; recall10Delta: number; mrrDelta: number; taskCount: number }> = {};
    for (const [r, stat] of Object.entries(perRepo)) {
      perRepoDeltas[r] = {
        ndcg10Delta: Number((stat.ndcgSum / stat.count).toFixed(4)),
        recall10Delta: Number((stat.recSum / stat.count).toFixed(4)),
        mrrDelta: Number((stat.mrrSum / stat.count).toFixed(4)),
        taskCount: stat.count,
      };
    }

    // Per-type breakdown
    const perType: Record<string, { ndcgSum: number; recSum: number; mrrSum: number; count: number }> = {};
    for (const d of deltas) {
      if (!perType[d.taskType]) {
        perType[d.taskType] = { ndcgSum: 0, recSum: 0, mrrSum: 0, count: 0 };
      }
      perType[d.taskType].ndcgSum += d.ndcg10Delta;
      perType[d.taskType].recSum += d.recall10Delta;
      perType[d.taskType].mrrSum += d.mrrDelta;
      perType[d.taskType].count++;
    }

    const perTypeDeltas: Record<string, { ndcg10Delta: number; recall10Delta: number; mrrDelta: number; taskCount: number }> = {};
    for (const [t, stat] of Object.entries(perType)) {
      perTypeDeltas[t] = {
        ndcg10Delta: Number((stat.ndcgSum / stat.count).toFixed(4)),
        recall10Delta: Number((stat.recSum / stat.count).toFixed(4)),
        mrrDelta: Number((stat.mrrSum / stat.count).toFixed(4)),
        taskCount: stat.count,
      };
    }

    return {
      totalTasks: n,
      iterations,
      randomSeed: seed,
      ndcg10: ndcg10Result,
      recall10: recall10Result,
      mrr: mrrResult,
      perRepoDeltas,
      perTypeDeltas,
    };
  }

  private static resampleMetric(
    sample: number[],
    iterations: number,
    initialSeed: number
  ): MetricBootstrapResult {
    const n = sample.length;
    const means: number[] = new Array(iterations);

    let s = initialSeed;
    const nextRandom = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };

    for (let iter = 0; iter < iterations; iter++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const idx = Math.floor(nextRandom() * n);
        sum += sample[idx];
      }
      means[iter] = sum / n;
    }

    means.sort((a, b) => a - b);

    const meanDelta = sample.reduce((acc, v) => acc + v, 0) / n;
    const sortedSample = [...sample].sort((a, b) => a - b);
    const medianDelta = n % 2 === 0
      ? (sortedSample[n / 2 - 1] + sortedSample[n / 2]) / 2
      : sortedSample[Math.floor(n / 2)];

    const lowerIdx = Math.floor(iterations * 0.025);
    const upperIdx = Math.floor(iterations * 0.975);
    const ciLower95 = means[lowerIdx];
    const ciUpper95 = means[upperIdx];

    // Two-tailed bootstrap p-value: proportion of resampled means crossing 0 in opposite direction
    let extremeCount = 0;
    if (meanDelta >= 0) {
      extremeCount = means.filter((m) => m <= 0).length;
    } else {
      extremeCount = means.filter((m) => m >= 0).length;
    }
    const pValue = Number(Math.min(1.0, (2.0 * extremeCount) / iterations).toFixed(4));

    let wins = 0;
    let ties = 0;
    let losses = 0;
    for (const v of sample) {
      if (v > 0.0001) wins++;
      else if (v < -0.0001) losses++;
      else ties++;
    }

    const isStatisticallySignificant = pValue < 0.05 && (ciLower95 > 0 || ciUpper95 < 0);

    return {
      meanDelta: Number(meanDelta.toFixed(4)),
      medianDelta: Number(medianDelta.toFixed(4)),
      ciLower95: Number(ciLower95.toFixed(4)),
      ciUpper95: Number(ciUpper95.toFixed(4)),
      pValue,
      wins,
      ties,
      losses,
      isStatisticallySignificant,
    };
  }
}
