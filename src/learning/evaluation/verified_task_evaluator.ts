/**
 * SiftrCode V3 - Verified Coding-Task Evaluator (Phase V3.1G)
 *
 * Implements paired A/B evaluation between frozen V2 and learned ContextRank V3
 * on actual coding tasks with independent verification.
 *
 * Primary Metric: Cost Per Verified Successful Task (CPVST)
 * CPVST = total_provider_and_system_cost / number_of_verified_successful_tasks
 *
 * Invariants:
 * 1. Identical agent environment, provider model, tools, and token limits.
 * 2. Tri-state verifiedSuccess (true | false | null).
 * 3. Never substitute "agent says done" for verifier success.
 */

import { SiftrBenchEpisode } from '../../benchmark/siftrbench/episode_schema';

export type GateDecision =
  | 'V3.1_PROMOTION_GATE_PASSED'
  | 'V3.1_FAILED_TO_BEAT_BASELINE'
  | 'V3.1_INSUFFICIENT_EVIDENCE';

export interface SingleTaskVerifiedRun {
  taskId: string;
  variant: 'V2_FROZEN' | 'V3_LEARNED';
  verifiedSuccess: boolean | null;
  wallClockLatencyMs: number;
  contextTokens: number;
  agentInputTokens: number;
  agentOutputTokens: number;
  providerCostUSD: number;
  toolCalls: number;
  trajectoryLength: number;
  verifierResult: string;
}

export interface PairedTaskEvaluation {
  taskId: string;
  repo: string;
  v2: SingleTaskVerifiedRun;
  v3: SingleTaskVerifiedRun;
  successDelta: number; // +1 if V3 won, -1 if V2 won, 0 if tie
  tokenDelta: number; // v3 - v2
  costDeltaUSD: number;
  latencyDeltaMs: number;
}

export interface VerifiedEvaluationSummary {
  variant: 'V2_FROZEN' | 'V3_LEARNED';
  evaluatedTasks: number;
  successfulTasks: number;
  successRate: number;
  totalContextTokens: number;
  meanContextTokensPerTask: number;
  totalCostUSD: number;
  meanCostPerTaskUSD: number;
  meanLatencyMs: number;
  cpvstUSD: number | null; // Cost Per Verified Successful Task (null if 0 successes)
}

export interface VerifiedTaskEvaluationReport {
  schemaVersion: 'siftrcode-verified-task-eval-v1';
  evaluatedAt: string;
  totalPairedTasks: number;
  blockReason?: string;
  missingDependencies?: string[];
  v2Summary: VerifiedEvaluationSummary;
  v3Summary: VerifiedEvaluationSummary;
  pairedDeltas: {
    successRateDelta: number;
    meanTokenDelta: number;
    meanCostDeltaUSD: number;
    meanLatencyDeltaMs: number;
    cpvstDeltaUSD: number | null;
    v3Wins: number;
    v2Wins: number;
    ties: number;
    mcNemar?: {
      statistic: number;
      pValue: number;
      discordantCount: number;
      isSignificantAt05: boolean;
      summary: string;
    };
  };
  proxyOfflineMetrics?: {
    totalTasks: number;
    v2TargetBundleSuccessRate: number;
    v3TargetBundleSuccessRate: number;
    delta: number;
    modeledCostPerTargetCoveredTaskV2USD: number;
    modeledCostPerTargetCoveredTaskV3USD: number;
  };
  gateDecision: GateDecision;
  decisionRationale: string;
  pairedTasks: PairedTaskEvaluation[];
}

export class VerifiedTaskEvaluator {
  /**
   * Computes summary metrics and CPVST for a series of task runs.
   */
  public static computeSummary(
    variant: 'V2_FROZEN' | 'V3_LEARNED',
    runs: SingleTaskVerifiedRun[]
  ): VerifiedEvaluationSummary {
    const n = Math.max(1, runs.length);
    const successes = runs.filter((r) => r.verifiedSuccess === true).length;
    const totalTokens = runs.reduce((acc, r) => acc + r.contextTokens, 0);
    const totalCost = runs.reduce((acc, r) => acc + (r.providerCostUSD || 0), 0);
    const totalLatency = runs.reduce((acc, r) => acc + (r.wallClockLatencyMs || 0), 0);

    const cpvstUSD = successes > 0 ? Number((totalCost / successes).toFixed(4)) : null;

    return {
      variant,
      evaluatedTasks: runs.length,
      successfulTasks: successes,
      successRate: Number((successes / n).toFixed(4)),
      totalContextTokens: totalTokens,
      meanContextTokensPerTask: Math.round(totalTokens / n),
      totalCostUSD: Number(totalCost.toFixed(4)),
      meanCostPerTaskUSD: Number((totalCost / n).toFixed(4)),
      meanLatencyMs: Number((totalLatency / n).toFixed(1)),
      cpvstUSD,
    };
  }

  /**
   * Computes McNemar exact test with continuity correction and exact binomial p-value.
   */
  public static computeMcNemarTest(v3Wins: number, v2Wins: number): {
    statistic: number;
    pValue: number;
    discordantCount: number;
    isSignificantAt05: boolean;
    summary: string;
  } {
    const b = v3Wins;
    const c = v2Wins;
    const totalDiscordant = b + c;

    if (totalDiscordant === 0) {
      return {
        statistic: 0,
        pValue: 1.0,
        discordantCount: 0,
        isSignificantAt05: false,
        summary: 'No discordant pairs (b=0, c=0); p = 1.0000',
      };
    }

    // Chi-squared with Edwards continuity correction: (|b - c| - 1)^2 / (b + c)
    const num = Math.max(0, Math.abs(b - c) - 1);
    const statistic = Number(((num * num) / totalDiscordant).toFixed(4));

    // Exact two-tailed binomial p-value: 2 * sum_{k=0}^{min(b,c)} binom(n, k) * 0.5^n
    const minVal = Math.min(b, c);
    let cumulativeProb = 0;
    for (let k = 0; k <= minVal; k++) {
      cumulativeProb += this.binomialCoeff(totalDiscordant, k) * Math.pow(0.5, totalDiscordant);
    }
    const pValue = Number(Math.min(1.0, 2 * cumulativeProb).toFixed(4));
    const isSignificantAt05 = pValue < 0.05;

    const summary = isSignificantAt05
      ? `Statistically significant paired lift (V3 wins: ${b}, V2 wins: ${c}, p = ${pValue})`
      : `Directionally positive but not statistically significant at alpha = 0.05 (V3 wins: ${b}, V2 wins: ${c}, p = ${pValue})`;

    return {
      statistic,
      pValue,
      discordantCount: totalDiscordant,
      isSignificantAt05,
      summary,
    };
  }

  private static binomialCoeff(n: number, k: number): number {
    if (k < 0 || k > n) return 0;
    if (k === 0 || k === n) return 1;
    let c = 1;
    for (let i = 1; i <= k; i++) {
      c = (c * (n - (k - i))) / i;
    }
    return c;
  }

  /**
   * Evaluates paired A/B results and produces the final V3.1 Gate Decision.
   */
  public static evaluatePairedExperiment(
    pairedTasks: PairedTaskEvaluation[],
    options: {
      minTasksForPromotion?: number;
      minSuccessDelta?: number;
      allowCostReductionAtEqualSuccess?: boolean;
      blockedReason?: string;
      missingDependencies?: string[];
      proxyOfflineMetrics?: {
        totalTasks: number;
        v2TargetBundleSuccessRate: number;
        v3TargetBundleSuccessRate: number;
        delta: number;
        modeledCostPerTargetCoveredTaskV2USD: number;
        modeledCostPerTargetCoveredTaskV3USD: number;
      };
    } = {}
  ): VerifiedTaskEvaluationReport {
    const minTasks = options.minTasksForPromotion ?? 30;
    const minSuccessDelta = options.minSuccessDelta ?? 0.0;
    const v2Runs = pairedTasks.map((p) => p.v2);
    const v3Runs = pairedTasks.map((p) => p.v3);

    const v2Summary = VerifiedTaskEvaluator.computeSummary('V2_FROZEN', v2Runs);
    const v3Summary = VerifiedTaskEvaluator.computeSummary('V3_LEARNED', v3Runs);

    let v3Wins = 0;
    let v2Wins = 0;
    let ties = 0;

    for (const p of pairedTasks) {
      if (p.v3.verifiedSuccess === true && p.v2.verifiedSuccess !== true) {
        v3Wins++;
      } else if (p.v2.verifiedSuccess === true && p.v3.verifiedSuccess !== true) {
        v2Wins++;
      } else {
        ties++;
      }
    }

    const successRateDelta = Number((v3Summary.successRate - v2Summary.successRate).toFixed(4));
    const meanTokenDelta = v3Summary.meanContextTokensPerTask - v2Summary.meanContextTokensPerTask;
    const meanCostDeltaUSD = Number((v3Summary.meanCostPerTaskUSD - v2Summary.meanCostPerTaskUSD).toFixed(4));
    const meanLatencyDeltaMs = Number((v3Summary.meanLatencyMs - v2Summary.meanLatencyMs).toFixed(1));

    let cpvstDeltaUSD: number | null = null;
    if (v3Summary.cpvstUSD !== null && v2Summary.cpvstUSD !== null) {
      cpvstDeltaUSD = Number((v3Summary.cpvstUSD - v2Summary.cpvstUSD).toFixed(4));
    }

    const mcNemar = this.computeMcNemarTest(v3Wins, v2Wins);

    // Determine Gate Decision
    let gateDecision: GateDecision;
    let decisionRationale: string;

    if (options.blockedReason) {
      gateDecision = 'V3.1_INSUFFICIENT_EVIDENCE';
      decisionRationale = options.blockedReason;
    } else if (pairedTasks.length < minTasks) {
      gateDecision = 'V3.1_INSUFFICIENT_EVIDENCE';
      decisionRationale = `Evaluated ${pairedTasks.length} tasks, which is below the threshold of ${minTasks} independent verified episodes required for production promotion.`;
    } else if (v3Summary.successRate < v2Summary.successRate) {
      gateDecision = 'V3.1_FAILED_TO_BEAT_BASELINE';
      decisionRationale = `Learned ContextRank V3 verified success rate (${(v3Summary.successRate * 100).toFixed(1)}%) is lower than frozen V2 baseline (${(v2Summary.successRate * 100).toFixed(1)}%). Baseline remains standard.`;
    } else if (successRateDelta > minSuccessDelta) {
      if (mcNemar.isSignificantAt05 || v3Wins >= 3) {
        gateDecision = 'V3.1_PROMOTION_GATE_PASSED';
        decisionRationale = `Learned ContextRank V3 demonstrated lift in verified task success (${(v3Summary.successRate * 100).toFixed(1)}% vs ${(v2Summary.successRate * 100).toFixed(1)}%, delta +${(successRateDelta * 100).toFixed(1)}%) with CPVST of $${v3Summary.cpvstUSD}. McNemar test: ${mcNemar.summary}.`;
      } else {
        gateDecision = 'V3.1_INSUFFICIENT_EVIDENCE';
        decisionRationale = `Learned ContextRank V3 showed directional lift (+${(successRateDelta * 100).toFixed(1)}%) but insufficient statistical confidence (${mcNemar.summary}). Additional evaluation episodes required.`;
      }
    } else if (successRateDelta === 0 && cpvstDeltaUSD !== null && cpvstDeltaUSD < 0) {
      gateDecision = 'V3.1_PROMOTION_GATE_PASSED';
      decisionRationale = `Learned ContextRank V3 matched baseline verified success (${(v3Summary.successRate * 100).toFixed(1)}%) while reducing CPVST by $${Math.abs(cpvstDeltaUSD)} per successful task.`;
    } else {
      gateDecision = 'V3.1_FAILED_TO_BEAT_BASELINE';
      decisionRationale = `Learned ContextRank V3 did not beat frozen V2 baseline on verified task success (${(v3Summary.successRate * 100).toFixed(1)}% vs ${(v2Summary.successRate * 100).toFixed(1)}%). Baseline remains production standard.`;
    }

    return {
      schemaVersion: 'siftrcode-verified-task-eval-v1',
      evaluatedAt: new Date().toISOString(),
      totalPairedTasks: pairedTasks.length,
      blockReason: options.blockedReason,
      missingDependencies: options.missingDependencies,
      v2Summary,
      v3Summary,
      pairedDeltas: {
        successRateDelta,
        meanTokenDelta,
        meanCostDeltaUSD,
        meanLatencyDeltaMs,
        cpvstDeltaUSD,
        v3Wins,
        v2Wins,
        ties,
        mcNemar,
      },
      proxyOfflineMetrics: options.proxyOfflineMetrics,
      gateDecision,
      decisionRationale,
      pairedTasks,
    };
  }
}
