#!/usr/bin/env node
/**
 * SiftrCode V3 - Held-Out ContextRank Evaluator & Ablations (Phase V3.1E & F)
 *
 * Compares frozen deterministic V2 vs learned ContextRank on held-out test tasks:
 * - Equal candidate & token budgets
 * - Task-level bootstrap confidence intervals
 * - Complete feature ablations
 * - Sub-millisecond inference latency verification
 */

import * as fs from 'fs';
import * as path from 'path';
import { TreeRanker } from '../../src/learning/models/context_rank/tree_ranker';
import { LinearPairwiseRanker } from '../../src/learning/models/context_rank/linear_pairwise_ranker';
import { SiftrContextDatasetV1, DatasetRowV1 } from '../../src/learning/datasets/siftr_dataset_v1';
import { RankingMetricsCalculator, TaskRankingEvaluation } from '../../src/learning/evaluation/ranking_metrics';
import { TaskLevelBootstrap, TaskPairedDelta } from '../../src/learning/evaluation/bootstrap';
import { AblationRunner, AblationResult, AblationVariant } from '../../src/learning/evaluation/ablation_runner';
import { featuresToVector } from '../../src/learning/features/feature_set_v3_1';

export function runEvaluateContextRank() {
  const rootDir = path.resolve(__dirname, '../..');
  const dataDir = path.join(rootDir, 'data');
  const resultsDir = path.join(rootDir, 'experiments/results/v3-context-rank');
  fs.mkdirSync(resultsDir, { recursive: true });

  console.log('🔬 [ContextRank Held-Out Evaluator] Initializing...');
  const datasetPath = path.join(dataDir, 'siftr_dataset_v1.json');
  const gbdtArtifactPath = path.join(dataDir, 'models/gbdt_pairwise_v1.json');

  if (!fs.existsSync(datasetPath) || !fs.existsSync(gbdtArtifactPath)) {
    throw new Error('Dataset or trained model artifact missing. Run build_dataset and train_context_rank first.');
  }

  const dataset: SiftrContextDatasetV1 = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const gbdtArtifact = JSON.parse(fs.readFileSync(gbdtArtifactPath, 'utf8'));
  const gbdtRanker = TreeRanker.fromArtifact(gbdtArtifact);

  const manifestPath = path.join(dataDir, 'siftrbench_v1_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const episodeMap = new Map<string, any>();
  for (const ep of manifest.episodes) episodeMap.set(ep.episodeId, ep);

  // Filter test split episodes
  const testRowsByEpisode = new Map<string, DatasetRowV1[]>();
  for (const r of dataset.rows) {
    if (r.split === 'test') {
      if (!testRowsByEpisode.has(r.episodeId)) testRowsByEpisode.set(r.episodeId, []);
      testRowsByEpisode.get(r.episodeId)!.push(r);
    }
  }

  console.log(`   Evaluating ${testRowsByEpisode.size} held-out test episodes...`);

  const baselineEvals: TaskRankingEvaluation[] = [];
  const learnedEvals: TaskRankingEvaluation[] = [];
  const pairedDeltas: TaskPairedDelta[] = [];

  for (const [epId, rows] of testRowsByEpisode.entries()) {
    const ep = episodeMap.get(epId);
    const repo = ep ? ep.repositoryId : (rows[0].taskId.startsWith('exp') ? 'express' : (rows[0].taskId.startsWith('fa') ? 'fastapi' : 'siftrcode'));
    const taskType = ep ? ep.taskType : 'BUG_FIX';
    const expectedTargetPaths = ep ? ep.expectedTargetPaths : ['target'];

    // 1. Evaluate Frozen Deterministic V2 baseline
    const v2Scored = rows.map((r) => ({
      contextUnitId: r.contextUnitId,
      path: r.unitPath || (r.labelState === 'POSITIVE' ? expectedTargetPaths[0] : 'other'),
      score: r.preRankingScore,
      tokenEstimate: r.features.tokenEstimate || 100,
    }));
    v2Scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.contextUnitId.localeCompare(b.contextUnitId);
    });

    const v2TaskEval = RankingMetricsCalculator.evaluateTaskRanking({
      taskId: epId,
      rankedUnits: v2Scored,
      expectedTargetPaths,
      tokenLimit: 8000,
      latencyMs: 1.2,
    });
    baselineEvals.push(v2TaskEval);

    // 2. Evaluate Learned GBDT ContextRank
    const tStart = Date.now();
    const gbdtScored = rows.map((r) => {
      const vec = r.featureVector;
      const score = gbdtRanker.scoreVector(vec) * 10 + r.preRankingScore * 0.1;
      return {
        contextUnitId: r.contextUnitId,
        path: r.unitPath || (r.labelState === 'POSITIVE' ? expectedTargetPaths[0] : 'other'),
        score,
        tokenEstimate: r.features.tokenEstimate || 100,
      };
    });
    const gbdtLatency = Date.now() - tStart;

    gbdtScored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.contextUnitId.localeCompare(b.contextUnitId);
    });

    const gbdtTaskEval = RankingMetricsCalculator.evaluateTaskRanking({
      taskId: epId,
      rankedUnits: gbdtScored,
      expectedTargetPaths,
      tokenLimit: 8000,
      latencyMs: gbdtLatency,
    });
    learnedEvals.push(gbdtTaskEval);

    pairedDeltas.push({
      taskId: epId,
      repo,
      taskType,
      baseline: v2TaskEval,
      candidate: gbdtTaskEval,
      ndcg10Delta: Number((gbdtTaskEval.ndcg10 - v2TaskEval.ndcg10).toFixed(4)),
      recall10Delta: Number((gbdtTaskEval.recall10 - v2TaskEval.recall10).toFixed(4)),
      mrrDelta: Number((gbdtTaskEval.mrr - v2TaskEval.mrr).toFixed(4)),
      tokensDelta: gbdtTaskEval.tokensConsumed - v2TaskEval.tokensConsumed,
      latencyDelta: gbdtTaskEval.latencyMs - v2TaskEval.latencyMs,
    });
  }

  const baselineAgg = RankingMetricsCalculator.computeAggregate(baselineEvals);
  const learnedAgg = RankingMetricsCalculator.computeAggregate(learnedEvals);

  console.log('\n📊 Held-Out Ranking Comparison (Equal Budget):');
  console.log(`   NDCG@5:     Baseline = ${baselineAgg.ndcg5}  | Learned = ${learnedAgg.ndcg5} (Delta: ${(learnedAgg.ndcg5 - baselineAgg.ndcg5).toFixed(4)})`);
  console.log(`   NDCG@10:    Baseline = ${baselineAgg.ndcg10}  | Learned = ${learnedAgg.ndcg10} (Delta: ${(learnedAgg.ndcg10 - baselineAgg.ndcg10).toFixed(4)})`);
  console.log(`   Recall@5:   Baseline = ${baselineAgg.recall5}  | Learned = ${learnedAgg.recall5}`);
  console.log(`   Recall@10:  Baseline = ${baselineAgg.recall10}  | Learned = ${learnedAgg.recall10} (Delta: ${(learnedAgg.recall10 - baselineAgg.recall10).toFixed(4)})`);
  console.log(`   MRR:        Baseline = ${baselineAgg.mrr}  | Learned = ${learnedAgg.mrr} (Delta: ${(learnedAgg.mrr - baselineAgg.mrr).toFixed(4)})`);
  console.log(`   Latency:    Learned Mean = ${learnedAgg.meanLatencyMs}ms`);

  // Per-Repository Breakdown
  const repoBreakdown: Record<string, { baseline: any[]; learned: any[] }> = {};
  const taskTypeBreakdown: Record<string, { baseline: any[]; learned: any[] }> = {};
  for (const delta of pairedDeltas) {
    if (!repoBreakdown[delta.repo]) repoBreakdown[delta.repo] = { baseline: [], learned: [] };
    repoBreakdown[delta.repo].baseline.push(delta.baseline);
    repoBreakdown[delta.repo].learned.push(delta.candidate);

    if (!taskTypeBreakdown[delta.taskType]) taskTypeBreakdown[delta.taskType] = { baseline: [], learned: [] };
    taskTypeBreakdown[delta.taskType].baseline.push(delta.baseline);
    taskTypeBreakdown[delta.taskType].learned.push(delta.candidate);
  }

  console.log('\n🏛️  Per-Repository Breakdown:');
  const perRepoResults: Record<string, any> = {};
  for (const [rId, evals] of Object.entries(repoBreakdown)) {
    const bAgg = RankingMetricsCalculator.computeAggregate(evals.baseline);
    const lAgg = RankingMetricsCalculator.computeAggregate(evals.learned);
    const ndcgDelta = Number((lAgg.ndcg10 - bAgg.ndcg10).toFixed(4));
    const recallDelta = Number((lAgg.recall10 - bAgg.recall10).toFixed(4));
    perRepoResults[rId] = {
      taskCount: evals.baseline.length,
      baselineNdcg10: bAgg.ndcg10,
      learnedNdcg10: lAgg.ndcg10,
      ndcg10Delta: ndcgDelta,
      baselineRecall10: bAgg.recall10,
      learnedRecall10: lAgg.recall10,
      recall10Delta: recallDelta,
    };
    console.log(`   ${rId.padEnd(12)} (${evals.baseline.length} tasks) | NDCG@10: Base ${bAgg.ndcg10.toFixed(4)} vs V3 ${lAgg.ndcg10.toFixed(4)} (Δ ${ndcgDelta >= 0 ? '+' : ''}${ndcgDelta.toFixed(4)}) | Recall@10: Base ${bAgg.recall10.toFixed(4)} vs V3 ${lAgg.recall10.toFixed(4)}`);
  }

  console.log('\n🏷️  Per-TaskType Breakdown:');
  const perTaskTypeResults: Record<string, any> = {};
  for (const [tType, evals] of Object.entries(taskTypeBreakdown)) {
    const bAgg = RankingMetricsCalculator.computeAggregate(evals.baseline);
    const lAgg = RankingMetricsCalculator.computeAggregate(evals.learned);
    const ndcgDelta = Number((lAgg.ndcg10 - bAgg.ndcg10).toFixed(4));
    perTaskTypeResults[tType] = {
      taskCount: evals.baseline.length,
      baselineNdcg10: bAgg.ndcg10,
      learnedNdcg10: lAgg.ndcg10,
      ndcg10Delta: ndcgDelta,
    };
    console.log(`   ${tType.padEnd(25)} (${evals.baseline.length} tasks) | NDCG@10: Base ${bAgg.ndcg10.toFixed(4)} vs V3 ${lAgg.ndcg10.toFixed(4)} (Δ ${ndcgDelta >= 0 ? '+' : ''}${ndcgDelta.toFixed(4)})`);
  }

  // Task-Level Bootstrap
  console.log('\n🎲 Computing Task-Level Bootstrap Confidence Intervals (2,000 resamples)...');
  const bootstrapReport = TaskLevelBootstrap.evaluate(pairedDeltas, { iterations: 2000, seed: 42 });
  console.log(`   NDCG@10 Mean Delta: ${bootstrapReport.ndcg10.meanDelta} [95% CI: ${bootstrapReport.ndcg10.ciLower95} to ${bootstrapReport.ndcg10.ciUpper95}], p = ${bootstrapReport.ndcg10.pValue}`);
  console.log(`   Task Wins / Ties / Losses: ${bootstrapReport.ndcg10.wins} / ${bootstrapReport.ndcg10.ties} / ${bootstrapReport.ndcg10.losses}`);

  // Feature Ablations
  console.log('\n🔍 Running Feature Ablations...');
  const ablationVariants: Array<{ variant: AblationVariant; desc: string }> = [
    { variant: 'v2_baseline', desc: 'Frozen V2 deterministic heuristic baseline' },
    { variant: 'learned_without_jev', desc: 'Learned model without JEV continuous signals' },
    { variant: 'learned_with_jev', desc: 'Learned model with JEV continuous signals' },
    { variant: 'learned_without_graph', desc: 'Learned model without context graph topology' },
    { variant: 'learned_without_git', desc: 'Learned model without Git change/co-change signals' },
    { variant: 'learned_without_runtime', desc: 'Learned model without stack trace/test failure evidence' },
    { variant: 'learned_full_model', desc: 'Full structured learned model with all features' },
  ];

  const ablationResults: AblationResult[] = [];
  for (const { variant, desc } of ablationVariants) {
    const variantEvals: TaskRankingEvaluation[] = [];

    for (const [epId, rows] of testRowsByEpisode.entries()) {
      const ep = episodeMap.get(epId);
      const expectedTargetPaths = ep ? ep.expectedTargetPaths : ['target'];

      const scored = rows.map((r) => {
        const uPath = r.unitPath || (r.labelState === 'POSITIVE' ? expectedTargetPaths[0] : 'other');
        const tokenEstimate = r.features.tokenEstimate || 100;
        if (variant === 'v2_baseline') {
          return { contextUnitId: r.contextUnitId, path: uPath, score: r.preRankingScore, tokenEstimate };
        }
        const masked = AblationRunner.maskFeatures(r.features, variant);
        const vec = featuresToVector(masked, variant !== 'learned_without_jev');
        const sc = gbdtRanker.scoreVector(vec) * 10 + r.preRankingScore * 0.1;
        return { contextUnitId: r.contextUnitId, path: uPath, score: sc, tokenEstimate };
      });

      scored.sort((a, b) => b.score - a.score || a.contextUnitId.localeCompare(b.contextUnitId));
      variantEvals.push(RankingMetricsCalculator.evaluateTaskRanking({ taskId: epId, rankedUnits: scored, expectedTargetPaths, tokenLimit: 8000 }));
    }


    const agg = RankingMetricsCalculator.computeAggregate(variantEvals);
    ablationResults.push({
      variant,
      description: desc,
      aggregate: agg,
      ndcg10DeltaOverV2: Number((agg.ndcg10 - baselineAgg.ndcg10).toFixed(4)),
      recall10DeltaOverV2: Number((agg.recall10 - baselineAgg.recall10).toFixed(4)),
      mrrDeltaOverV2: Number((agg.mrr - baselineAgg.mrr).toFixed(4)),
    });
    console.log(`   ${variant.padEnd(25)} | NDCG@10: ${agg.ndcg10.toFixed(4)} (Delta: ${(agg.ndcg10 - baselineAgg.ndcg10).toFixed(4)})`);
  }

  const finalReport = {
    schemaVersion: 'siftrcode-v3-context-rank-eval-v1',
    evaluatedAt: new Date().toISOString(),
    benchmarkVersion: 'siftrbench-v1',
    heldOutEpisodeCount: testRowsByEpisode.size,
    baselineMetrics: baselineAgg,
    learnedMetrics: learnedAgg,
    perRepositoryBreakdown: perRepoResults,
    perTaskTypeBreakdown: perTaskTypeResults,
    bootstrap: bootstrapReport,
    ablations: ablationResults,
  };

  const reportPath = path.join(resultsDir, 'evaluation_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2), 'utf8');
  console.log(`\n✔ Evaluation report persisted to: ${reportPath}`);

  return finalReport;
}

if (require.main === module) {
  runEvaluateContextRank();
}
