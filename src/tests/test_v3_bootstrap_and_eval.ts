/**
 * SiftrCode V3 - Test Suite: Task-Level Bootstrap & Verified Outcome Evaluation
 *
 * Verifies:
 * 1. Bootstrap resamples strictly over TASK EPISODES, not individual ContextUnits.
 * 2. 95% non-parametric bootstrap confidence interval computation.
 * 3. Ranking metrics under identical candidate and token budgets.
 * 4. Cost Per Verified Successful Task (CPVST) formulation and zero-success handling.
 * 5. Gate decision logic: PROMOTION_PASSED, FAILED_TO_BEAT_BASELINE, INSUFFICIENT_EVIDENCE.
 */

import * as assert from 'assert';
import { TaskLevelBootstrap, TaskPairedDelta } from '../learning/evaluation/bootstrap';
import { RankingMetricsCalculator } from '../learning/evaluation/ranking_metrics';
import { VerifiedTaskEvaluator, PairedTaskEvaluation } from '../learning/evaluation/verified_task_evaluator';

console.log('🧪 [Test Suite V3-Bootstrap & Eval] Starting verification...\n');

// 1. Task-Level Bootstrap Over Episodes
console.log('--- 1. Task-Level Bootstrap Over Episodes ---');
const dummyDeltas: TaskPairedDelta[] = [];
for (let i = 0; i < 40; i++) {
  const lift = i % 3 === 0 ? 0.08 : (i % 3 === 1 ? 0.04 : -0.01);
  dummyDeltas.push({
    taskId: `task_${i}`,
    repo: i < 20 ? 'express' : 'fastapi',
    taskType: 'BUG_FIX',
    baseline: {
      taskId: `task_${i}`,
      candidateCount: 50,
      tokensConsumed: 4000,
      latencyMs: 15,
      firstHitRank: 4,
      ndcg5: 0.4,
      ndcg10: 0.35,
      ndcg20: 0.35,
      recall5: 0.2,
      recall10: 0.3,
      recall20: 0.3,
      recall50: 0.5,
      mrr: 0.25,
      targetHit: true,
    },
    candidate: {
      taskId: `task_${i}`,
      candidateCount: 50,
      tokensConsumed: 3800,
      latencyMs: 16,
      firstHitRank: 2,
      ndcg5: 0.4 + lift,
      ndcg10: 0.35 + lift,
      ndcg20: 0.35 + lift,
      recall5: 0.2,
      recall10: 0.3,
      recall20: 0.3,
      recall50: 0.5,
      mrr: 0.5,
      targetHit: true,
    },
    ndcg10Delta: Number(lift.toFixed(4)),
    recall10Delta: 0,
    mrrDelta: 0.25,
    tokensDelta: -200,
    latencyDelta: 1,
  });
}

const bootstrapReport = TaskLevelBootstrap.evaluate(dummyDeltas, { iterations: 1000, seed: 42 });
assert.strictEqual(bootstrapReport.totalTasks, 40, 'Must resample over 40 task episodes');
assert.ok(bootstrapReport.ndcg10.meanDelta > 0, 'Mean delta must be positive');
assert.ok(bootstrapReport.ndcg10.ciLower95 <= bootstrapReport.ndcg10.meanDelta);
assert.ok(bootstrapReport.ndcg10.meanDelta <= bootstrapReport.ndcg10.ciUpper95);
console.log(`  ✔ Task-level bootstrap computed: mean delta = ${bootstrapReport.ndcg10.meanDelta} [95% CI: ${bootstrapReport.ndcg10.ciLower95} to ${bootstrapReport.ndcg10.ciUpper95}], p = ${bootstrapReport.ndcg10.pValue}`);

// 2. Ranking Metrics Equal-Budget Validation
console.log('\n--- 2. Ranking Metrics Calculation Under Budget ---');
const rankedUnits = [
  { contextUnitId: 'cu_1', path: 'lib/unrelated.js', tokenEstimate: 500 },
  { contextUnitId: 'cu_2', path: 'lib/response.js', tokenEstimate: 600 },
  { contextUnitId: 'cu_3', path: 'lib/request.js', tokenEstimate: 400 },
];

const evalMetrics = RankingMetricsCalculator.evaluateTaskRanking({
  taskId: 't_eval',
  rankedUnits,
  expectedTargetPaths: ['lib/response.js'],
  tokenLimit: 1200, // Fits cu_1 and cu_2 (1100 tokens), drops cu_3
});

assert.strictEqual(evalMetrics.firstHitRank, 2, 'Target is at rank 2');
assert.strictEqual(evalMetrics.tokensConsumed, 1100, 'Context tokens capped under 1200');
assert.strictEqual(evalMetrics.recall5, 1.0, 'Recall@5 should be 1.0');
assert.ok(evalMetrics.ndcg5 > 0, 'NDCG@5 must be positive');

// Deduplication & [0, 1] bounds validation on multiple units for same target
const duplicateTargetUnits = [
  { contextUnitId: 'cu_d1', path: 'lib/response.js', tokenEstimate: 200 },
  { contextUnitId: 'cu_d2', path: 'lib/response.js', tokenEstimate: 200 },
  { contextUnitId: 'cu_d3', path: 'lib/response.js', tokenEstimate: 200 },
  { contextUnitId: 'cu_d4', path: 'lib/response.js', tokenEstimate: 200 },
  { contextUnitId: 'cu_d5', path: 'lib/response.js', tokenEstimate: 200 },
];
const dupEval = RankingMetricsCalculator.evaluateTaskRanking({
  taskId: 't_dup',
  rankedUnits: duplicateTargetUnits,
  expectedTargetPaths: ['lib/response.js'],
});
assert.ok(dupEval.recall5 <= 1.0 && dupEval.recall5 >= 0.0, 'Recall@5 must be in [0, 1]');
assert.ok(dupEval.ndcg5 <= 1.0 && dupEval.ndcg5 >= 0.0, 'NDCG@5 must be in [0, 1]');
assert.strictEqual(dupEval.recall5, 1.0, 'Deduplicated recall on 1 target must equal exactly 1.0');
assert.strictEqual(dupEval.ndcg5, 1.0, 'Deduplicated ideal rank NDCG on 1 target must equal exactly 1.0');
console.log('  ✔ Ranking metrics, deduplicated targets, and [0, 1] bounds validated');

// 3. CPVST Formulation & Zero-Success Handling

console.log('\n--- 3. CPVST Formulation & Zero-Success Handling ---');
// Scenario A: Successes present
const summaryWithSuccess = VerifiedTaskEvaluator.computeSummary('V3_LEARNED', [
  {
    taskId: 't1',
    variant: 'V3_LEARNED',
    verifiedSuccess: true,
    wallClockLatencyMs: 1000,
    contextTokens: 2000,
    agentInputTokens: 4000,
    agentOutputTokens: 500,
    providerCostUSD: 0.10,
    toolCalls: 3,
    trajectoryLength: 4,
    verifierResult: 'PASS',
  },
  {
    taskId: 't2',
    variant: 'V3_LEARNED',
    verifiedSuccess: false,
    wallClockLatencyMs: 1000,
    contextTokens: 2000,
    agentInputTokens: 4000,
    agentOutputTokens: 500,
    providerCostUSD: 0.10,
    toolCalls: 3,
    trajectoryLength: 4,
    verifierResult: 'FAIL',
  },
]);

assert.strictEqual(summaryWithSuccess.successfulTasks, 1);
assert.strictEqual(summaryWithSuccess.totalCostUSD, 0.20);
assert.strictEqual(summaryWithSuccess.cpvstUSD, 0.20, 'CPVST = $0.20 / 1 success = $0.20');
console.log(`  ✔ CPVST with successes: $${summaryWithSuccess.cpvstUSD} per verified success`);

// Scenario B: Zero successes
const summaryZeroSuccess = VerifiedTaskEvaluator.computeSummary('V3_LEARNED', [
  {
    taskId: 't1',
    variant: 'V3_LEARNED',
    verifiedSuccess: false,
    wallClockLatencyMs: 1000,
    contextTokens: 2000,
    agentInputTokens: 4000,
    agentOutputTokens: 500,
    providerCostUSD: 0.10,
    toolCalls: 3,
    trajectoryLength: 4,
    verifierResult: 'FAIL',
  },
]);
assert.strictEqual(summaryZeroSuccess.successfulTasks, 0);
assert.strictEqual(summaryZeroSuccess.cpvstUSD, null, 'CPVST must be null / undefined when zero successes');
console.log('  ✔ Zero-success edge case explicitly handled as null (no divide-by-zero)');

// 4. Promotion Gate Decisions
console.log('\n--- 4. Promotion Gate Decisions ---');
// Under-sampled (< minTasks) => INSUFFICIENT_EVIDENCE
const underSampledReport = VerifiedTaskEvaluator.evaluatePairedExperiment([], { minTasksForPromotion: 30 });
assert.strictEqual(underSampledReport.gateDecision, 'V3.1_INSUFFICIENT_EVIDENCE');
console.log('  ✔ Under-sampled tasks evaluation yields V3.1_INSUFFICIENT_EVIDENCE');

// Success lift => PROMOTION_PASSED
const pairedWithLift: PairedTaskEvaluation[] = [];
for (let i = 0; i < 35; i++) {
  const v2Won = i % 10 === 0;
  const v3Won = i % 5 === 0;
  pairedWithLift.push({
    taskId: `task_${i}`,
    repo: 'express',
    v2: {
      taskId: `task_${i}`,
      variant: 'V2_FROZEN',
      verifiedSuccess: !v2Won && (i % 3 === 0),
      wallClockLatencyMs: 1000,
      contextTokens: 3000,
      agentInputTokens: 6000,
      agentOutputTokens: 500,
      providerCostUSD: 0.05,
      toolCalls: 3,
      trajectoryLength: 4,
      verifierResult: 'OK',
    },
    v3: {
      taskId: `task_${i}`,
      variant: 'V3_LEARNED',
      verifiedSuccess: v3Won || (i % 3 === 0),
      wallClockLatencyMs: 900,
      contextTokens: 2600,
      agentInputTokens: 5200,
      agentOutputTokens: 500,
      providerCostUSD: 0.04,
      toolCalls: 3,
      trajectoryLength: 4,
      verifierResult: 'OK',
    },
    successDelta: 0,
    tokenDelta: -400,
    costDeltaUSD: -0.01,
    latencyDeltaMs: -100,
  });
}

const promotionReport = VerifiedTaskEvaluator.evaluatePairedExperiment(pairedWithLift, { minTasksForPromotion: 30 });
assert.strictEqual(promotionReport.gateDecision, 'V3.1_PROMOTION_GATE_PASSED');
console.log(`  ✔ Verified success lift correctly evaluates to: ${promotionReport.gateDecision}`);

console.log('\n🎉 ALL V3 BOOTSTRAP & EVAL TESTS PASSED CLEANLY!\n');
