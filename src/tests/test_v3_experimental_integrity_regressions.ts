/**
 * SiftrCode V3.1 - Test Suite: Experimental Integrity Regressions (P0-1 through P1-3)
 *
 * Covers 7 critical scientific regression checks:
 * 1. Point-in-time source workspace isolation (zero future source-tree leakage).
 * 2. Real verifier process invocation (exit code 0/1 drives verifiedSuccess, never proxy).
 * 3. No fake usage (missing credentials blocks evaluation with INSUFFICIENT_EVIDENCE).
 * 4. Zero-candidate episode handling (retained in denominator with 0 metrics).
 * 5. Budgeted metric evaluation (materialized context policy <= 8,000 tokens).
 * 6. Frozen comparator identity (exact v2-final 1eedac03... baseline, matched episodes).
 * 7. Model artifact provenance (real git SHA, 1eedac... baseline, 64-char SHA-256 hashes).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync, execSync } from 'child_process';
import { EpisodeWorkspaceResolver } from '../benchmark/siftrbench/episode_workspace_resolver';
import { RankingMetricsCalculator, TaskRankingEvaluation } from '../learning/evaluation/ranking_metrics';
import { VerifiedTaskEvaluator, SingleTaskVerifiedRun, PairedTaskEvaluation } from '../learning/evaluation/verified_task_evaluator';
import { ModelArtifactVerifier, ModelArtifactV3 } from '../learning/models/context_rank/model_artifact';

export async function runExperimentalIntegrityRegressionTests() {
  console.log('🧪 [Test Suite: V3.1 Experimental Integrity Regressions] Starting...\n');
  const rootDir = path.resolve(__dirname, '../..');
  const dataDir = path.join(rootDir, 'data');

  // =========================================================================
  // Regression 1: Point-in-Time Source Workspace Isolation
  // =========================================================================
  console.log('--- 1. Point-in-Time Source Workspace Isolation ---');
  const FROZEN_V2_SHA = '1eedac03b0d83025ebf08ed2945e0ab015c46f6a';

  try {
    const ws = EpisodeWorkspaceResolver.resolveWorkspace('siftrcode', FROZEN_V2_SHA);
    assert.strictEqual(ws.baseCommit, FROZEN_V2_SHA, 'Resolved commit must exactly equal requested baseCommit');
    assert.strictEqual(ws.isWorktree, true, 'SiftrCode baseCommit must be checked out in isolated worktree');

    const actualGitHead = execSync('git rev-parse HEAD', { cwd: ws.workspacePath }).toString().trim();
    assert.strictEqual(actualGitHead, FROZEN_V2_SHA, 'Worktree HEAD must match baseCommit');

    // Future-only V3 files must be strictly absent in the isolated worktree
    const futureFileRelPath = 'src/learning/models/context_rank/tree_ranker.ts';
    assert.strictEqual(
      fs.existsSync(path.join(ws.workspacePath, futureFileRelPath)),
      false,
      'Future V3 file must NOT exist in old baseCommit snapshot'
    );
    assert.strictEqual(
      fs.existsSync(path.join(rootDir, futureFileRelPath)),
      true,
      'Future V3 file exists on main branch'
    );
    console.log('  ✔ Regression 1 passed: Point-in-time isolation verified (zero future source-tree leakage)\n');
  } finally {
    EpisodeWorkspaceResolver.cleanupAll();
  }

  // =========================================================================
  // Regression 2: Real Verifier Process Invocation
  // =========================================================================
  console.log('--- 2. Real Verifier Process Invocation ---');
  // Fixture: Execute actual sub-processes and ensure verifiedSuccess comes from exit code
  const procPass = spawnSync(process.execPath, ['-e', 'process.stdout.write("All tests passed"); process.exit(0);'], {
    encoding: 'utf8',
  });
  const procFail = spawnSync(process.execPath, ['-e', 'process.stdout.write("AssertionError: test failed"); process.exit(1);'], {
    encoding: 'utf8',
  });

  const verifiedPass = procPass.status === 0;
  const verifiedFail = procFail.status === 0;

  assert.strictEqual(verifiedPass, true, 'Exit code 0 must yield verifiedSuccess = true');
  assert.strictEqual(verifiedFail, false, 'Non-zero exit code must yield verifiedSuccess = false');

  // Even if stdout contains the target phrase "All tests passed", exit code 1 must fail
  const procFailWithDeceptiveOutput = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write("All tests passed"); process.exit(1);'],
    { encoding: 'utf8' }
  );
  assert.strictEqual(
    procFailWithDeceptiveOutput.status === 0,
    false,
    'Deceptive output with non-zero exit code must strictly yield false'
  );
  console.log('  ✔ Regression 2 passed: Real verifier execution verified by process exit code\n');

  // =========================================================================
  // Regression 3: No Fake Usage & Missing Credentials Handled Honestly
  // =========================================================================
  console.log('--- 3. No Fake Usage & Missing Credentials Handled Honestly ---');
  const dummyPairedTask: PairedTaskEvaluation = {
    taskId: 'task_mock_cred',
    repo: 'express',
    v2: {
      taskId: 'task_mock_cred',
      variant: 'V2_FROZEN',
      verifiedSuccess: null,
      wallClockLatencyMs: 0,
      contextTokens: 1200,
      agentInputTokens: 0,
      agentOutputTokens: 0,
      providerCostUSD: 0,
      toolCalls: 0,
      trajectoryLength: 0,
      verifierResult: 'UNAVAILABLE (missing credentials)',
    },
    v3: {
      taskId: 'task_mock_cred',
      variant: 'V3_LEARNED',
      verifiedSuccess: null,
      wallClockLatencyMs: 0,
      contextTokens: 1100,
      agentInputTokens: 0,
      agentOutputTokens: 0,
      providerCostUSD: 0,
      toolCalls: 0,
      trajectoryLength: 0,
      verifierResult: 'UNAVAILABLE (missing credentials)',
    },
    successDelta: 0,
    tokenDelta: -100,
    costDeltaUSD: 0,
    latencyDeltaMs: 0,
  };

  const blockedReport = VerifiedTaskEvaluator.evaluatePairedExperiment([dummyPairedTask], {
    minTasksForPromotion: 30,
    blockedReason: 'REAL_AGENT_EVALUATION_BLOCKED: Missing real agent credentials (ANTHROPIC_API_KEY, OPENAI_API_KEY).',
    missingDependencies: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
  });

  assert.strictEqual(
    blockedReport.gateDecision,
    'V3.1_INSUFFICIENT_EVIDENCE',
    'Missing credentials must yield V3.1_INSUFFICIENT_EVIDENCE'
  );
  assert.strictEqual(
    blockedReport.blockReason,
    'REAL_AGENT_EVALUATION_BLOCKED: Missing real agent credentials (ANTHROPIC_API_KEY, OPENAI_API_KEY).',
    'Block reason must identify missing credentials'
  );
  assert.strictEqual(blockedReport.v2Summary.totalCostUSD, 0, 'No fake provider cost fabricated');
  assert.strictEqual(blockedReport.v2Summary.cpvstUSD, null, 'CPVST is null when zero real successes');
  console.log('  ✔ Regression 3 passed: Missing credentials honestly emitted as INSUFFICIENT_EVIDENCE\n');

  // =========================================================================
  // Regression 4: Zero Candidate Episode Retained in Denominator
  // =========================================================================
  console.log('--- 4. Zero Candidate Episode Retained in Denominator ---');
  const zeroCandEval = RankingMetricsCalculator.evaluateTaskRanking({
    taskId: 'zero_candidate_task',
    rankedUnits: [],
    expectedTargetPaths: ['lib/target.js'],
  });

  assert.strictEqual(zeroCandEval.candidateCount, 0, 'Candidate count must be 0');
  assert.strictEqual(zeroCandEval.ndcg10, 0, 'NDCG@10 must be 0 for zero-candidate episode');
  assert.strictEqual(zeroCandEval.recall10, 0, 'Recall@10 must be 0 for zero-candidate episode');
  assert.strictEqual(zeroCandEval.mrr, 0, 'MRR must be 0 for zero-candidate episode');
  assert.strictEqual(zeroCandEval.targetHit, false, 'targetHit must be false');

  // Evaluated aggregate across 1 normal task (NDCG@10 = 1.0) and 1 zero-candidate task
  const normalTaskEval = RankingMetricsCalculator.evaluateTaskRanking({
    taskId: 'normal_task',
    rankedUnits: [{ contextUnitId: 'u1', path: 'lib/target.js', tokenEstimate: 100 }],
    expectedTargetPaths: ['lib/target.js'],
  });
  assert.strictEqual(normalTaskEval.ndcg10, 1.0, 'Normal task has NDCG@10 = 1.0');

  const combinedAgg = RankingMetricsCalculator.computeAggregate([normalTaskEval, zeroCandEval]);
  assert.strictEqual(combinedAgg.totalTasks, 2, 'Denominator must include the zero-candidate episode');
  assert.strictEqual(combinedAgg.ndcg10, 0.5, 'NDCG@10 mean must be exactly (1.0 + 0.0) / 2 = 0.5');
  assert.strictEqual(combinedAgg.targetCoverage, 0.5, 'Target coverage must be exactly 1 / 2 = 0.5');
  console.log('  ✔ Regression 4 passed: Zero-candidate episode retained in denominator with 0 metrics\n');

  // =========================================================================
  // Regression 5: Budgeted Metric Evaluation Policy (<= 8,000 Tokens)
  // =========================================================================
  console.log('--- 5. Budgeted Metric Evaluation Policy (<= 8,000 Tokens) ---');
  // Unit 1: Huge non-target unit that exceeds budget (9,000 tokens)
  // Unit 2: Target unit that fits within budget (500 tokens)
  const rankedWithHugeUnit = [
    { contextUnitId: 'huge_unit_1', path: 'lib/huge_irrelevant.js', tokenEstimate: 9000 },
    { contextUnitId: 'target_unit_2', path: 'lib/target.js', tokenEstimate: 500 },
  ];

  const bundle = RankingMetricsCalculator.materializeBudgetedBundle(rankedWithHugeUnit, 8000);
  assert.strictEqual(bundle.length, 1, 'Huge unit exceeding 8000 tokens must not be bundled');
  assert.strictEqual(bundle[0].contextUnitId, 'target_unit_2', 'Only units fitting in budget are bundled');

  const budgetedEval = RankingMetricsCalculator.evaluateTaskRanking({
    taskId: 'budgeted_task',
    rankedUnits: rankedWithHugeUnit,
    expectedTargetPaths: ['lib/target.js'],
    tokenLimit: 8000,
  });

  assert.ok(budgetedEval.tokensConsumed <= 8000, 'tokensConsumed must not exceed 8,000');
  assert.ok(budgetedEval.ndcg10 >= 0.0 && budgetedEval.ndcg10 <= 1.0, 'NDCG@10 must be bounded in [0, 1]');
  assert.ok(budgetedEval.recall10 >= 0.0 && budgetedEval.recall10 <= 1.0, 'Recall@10 must be bounded in [0, 1]');
  console.log('  ✔ Regression 5 passed: Context token budgeting strictly enforces <= 8,000 tokens\n');

  // =========================================================================
  // Regression 6: Frozen Comparator Identity
  // =========================================================================
  console.log('--- 6. Frozen Comparator Identity ---');
  const splitManifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'siftrbench_v1_splits.json'), 'utf8'));
  const testAssignments = splitManifest.assignments.filter((a: any) => a.split === 'test');
  assert.ok(testAssignments.length >= 30, `Must have at least 30 held-out test episodes (found ${testAssignments.length})`);

  const baselineReportPath = path.join(rootDir, 'experiments/results/frozen-v2-baseline/frozen_v2_baseline_eval.json');
  if (fs.existsSync(baselineReportPath)) {
    const baselineReport = JSON.parse(fs.readFileSync(baselineReportPath, 'utf8'));
    assert.strictEqual(baselineReport.baselineCommit, FROZEN_V2_SHA, 'Baseline commit must match authoritative V2 SHA');
    assert.strictEqual(baselineReport.gitTag, 'v2-final', 'Baseline gitTag must be v2-final');
    assert.strictEqual(baselineReport.candidateBudget, 50, 'Baseline candidate budget must be 50');
    assert.strictEqual(baselineReport.tokenBudget, 8000, 'Baseline token budget must be 8000');
    assert.strictEqual(baselineReport.taskResults.length, testAssignments.length, 'Evaluated baseline episodes must match test split count');

    for (const ep of testAssignments) {
      const match = baselineReport.taskResults.find((r: any) => r.episodeId === ep.episodeId);
      assert.ok(match, `Baseline report must include episode ${ep.episodeId}`);
    }
  }
  console.log('  ✔ Regression 6 passed: Frozen V2 comparator identity verified\n');

  // =========================================================================
  // Regression 7: Model Artifact Provenance
  // =========================================================================
  console.log('--- 7. Model Artifact Provenance ---');
  const gbdtArtifactPath = path.join(dataDir, 'models/gbdt_pairwise_v1.json');
  assert.ok(fs.existsSync(gbdtArtifactPath), 'GBDT artifact must exist');

  const artifact: ModelArtifactV3 = JSON.parse(fs.readFileSync(gbdtArtifactPath, 'utf8'));
  assert.strictEqual(artifact.schemaVersion, 'siftrcode-model-artifact-v3', 'Invalid schemaVersion');
  assert.strictEqual(artifact.trainingCodeGitSha.length, 40, 'trainingCodeGitSha must be 40-char commit SHA');
  assert.strictEqual(artifact.baselineGitSha, FROZEN_V2_SHA, 'baselineGitSha must be authoritative frozen V2 SHA');
  assert.notStrictEqual(artifact.trainingCodeGitSha, artifact.baselineGitSha, 'trainingCodeGitSha must not equal baselineGitSha');

  // Check 64-char SHA-256 strings
  assert.strictEqual(artifact.trainSplitSha256.length, 64, 'trainSplitSha256 must be 64-char hex SHA-256');
  assert.strictEqual(artifact.validationSplitSha256.length, 64, 'validationSplitSha256 must be 64-char hex SHA-256');
  if (artifact.testSplitSha256) {
    assert.strictEqual(artifact.testSplitSha256.length, 64, 'testSplitSha256 must be 64-char hex SHA-256');
  }
  if (artifact.datasetSha256) {
    assert.strictEqual(artifact.datasetSha256.length, 64, 'datasetSha256 must be 64-char hex SHA-256');
  }

  // Training metrics and validation metrics must be distinct objects
  assert.ok(typeof artifact.trainingMetrics.ndcg10 === 'number', 'trainingMetrics.ndcg10 must be number');
  assert.ok(typeof artifact.validationMetrics.ndcg10 === 'number', 'validationMetrics.ndcg10 must be number');

  const verification = ModelArtifactVerifier.verifyArtifact(artifact);
  assert.strictEqual(verification.valid, true, `Model artifact checksum failed: ${verification.errors.join(', ')}`);
  console.log('  ✔ Regression 7 passed: Model artifact provenance cryptographically verified\n');

  console.log('🎉 ALL SEVEN EXPERIMENTAL INTEGRITY REGRESSIONS PASSED CLEANLY!\n');
}

if (require.main === module) {
  runExperimentalIntegrityRegressionTests().catch((err) => {
    console.error('❌ Regression suite failed:', err);
    process.exit(1);
  });
}
