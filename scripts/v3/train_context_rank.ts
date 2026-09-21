#!/usr/bin/env node
/**
 * SiftrCode V3 - Train ContextRank Models (Phase V3.1F)
 *
 * Trains structured learning-to-rank models on pairwise training instances:
 * 1. Pairwise GBDT (TreeRanker)
 * 2. Margin-Based Linear Pairwise (LinearPairwiseRanker)
 *
 * Emits learning curves and signed ModelArtifactV3 artifacts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { TreeRanker } from '../../src/learning/models/context_rank/tree_ranker';
import { LinearPairwiseRanker } from '../../src/learning/models/context_rank/linear_pairwise_ranker';
import { PairwiseDatasetV1, RankingPairV1 } from '../../src/learning/datasets/pairwise_builder';
import { SiftrContextDatasetV1, DatasetRowV1 } from '../../src/learning/datasets/siftr_dataset_v1';
import { RankingMetricsCalculator, TaskRankingEvaluation } from '../../src/learning/evaluation/ranking_metrics';

export interface LearningCurvePoint {
  taskCount: number;
  pairCount: number;
  trainLoss?: number;
  valNdcg10: number;
  valRecall10: number;
  valMrr: number;
}

export function runTrainContextRank() {
  const rootDir = path.resolve(__dirname, '../..');
  const dataDir = path.join(rootDir, 'data');
  const modelsDir = path.join(dataDir, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });

  console.log('🧠 [ContextRank v1 Training] Loading datasets...');
  const pairwisePath = path.join(dataDir, 'pairwise_dataset_v1.json');
  const datasetPath = path.join(dataDir, 'siftr_dataset_v1.json');

  if (!fs.existsSync(pairwisePath) || !fs.existsSync(datasetPath)) {
    throw new Error('Datasets missing. Run build_dataset first.');
  }

  const pairwiseData: PairwiseDatasetV1 = JSON.parse(fs.readFileSync(pairwisePath, 'utf8'));
  const dataset: SiftrContextDatasetV1 = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

  const trainPairs = pairwiseData.pairsBySplit.train;
  const valPairs = pairwiseData.pairsBySplit.validation;
  const testPairs = pairwiseData.pairsBySplit.test || [];
  console.log(`   Train pairs: ${trainPairs.length}, Validation pairs: ${valPairs.length}`);

  // Provenance metadata
  let trainingCodeGitSha = 'eb27d9b9506fe14aa95026141f829f2ffb7623ed';
  try {
    trainingCodeGitSha = execSync('git rev-parse HEAD', { cwd: rootDir }).toString().trim();
  } catch (e) {}
  const baselineGitSha = '1eedac03b0d83025ebf08ed2945e0ab015c46f6a';

  const trainSplitSha256 = crypto.createHash('sha256').update(JSON.stringify(trainPairs)).digest('hex');
  const validationSplitSha256 = crypto.createHash('sha256').update(JSON.stringify(valPairs)).digest('hex');
  const valSplitSha256 = validationSplitSha256;
  const testSplitSha256 = crypto.createHash('sha256').update(JSON.stringify(testPairs)).digest('hex');
  const datasetSha256 = crypto.createHash('sha256').update(fs.readFileSync(datasetPath)).digest('hex');

  console.log(`   Training Git SHA: ${trainingCodeGitSha}`);
  console.log(`   Baseline Git SHA: ${baselineGitSha}`);
  console.log(`   Train Split SHA-256: ${trainSplitSha256}`);
  console.log(`   Val Split SHA-256:   ${valSplitSha256}`);

  // Reconstruct rows by episode for train and validation evaluation
  const trainRowsByEpisode = new Map<string, DatasetRowV1[]>();
  const valRowsByEpisode = new Map<string, DatasetRowV1[]>();
  for (const r of dataset.rows) {
    if (r.split === 'train') {
      if (!trainRowsByEpisode.has(r.episodeId)) trainRowsByEpisode.set(r.episodeId, []);
      trainRowsByEpisode.get(r.episodeId)!.push(r);
    } else if (r.split === 'validation') {
      if (!valRowsByEpisode.has(r.episodeId)) valRowsByEpisode.set(r.episodeId, []);
      valRowsByEpisode.get(r.episodeId)!.push(r);
    }
  }

  // 1. Train Pairwise GBDT (Model Family 1)
  console.log('\n🌲 Training Model Family 1: Pairwise GBDT (LambdaMART Style)...');
  const t0 = Date.now();
  const gbdt = TreeRanker.train(trainPairs, {
    maxIterations: 50,
    learningRate: 0.08,
    includeJev: true,
  });
  const trainDurationGbdt = Date.now() - t0;
  console.log(`✔ Trained GBDT in ${trainDurationGbdt}ms.`);

  // Evaluate GBDT on Train and Validation splits separately
  const gbdtTrainEval = evaluateModelOnRows(gbdt, trainRowsByEpisode);
  const gbdtValEval = evaluateModelOnRows(gbdt, valRowsByEpisode);
  console.log(`   GBDT Train      NDCG@10: ${gbdtTrainEval.ndcg10}, Recall@10: ${gbdtTrainEval.recall10}, MRR: ${gbdtTrainEval.mrr}`);
  console.log(`   GBDT Validation NDCG@10: ${gbdtValEval.ndcg10}, Recall@10: ${gbdtValEval.recall10}, MRR: ${gbdtValEval.mrr}`);

  // Export GBDT Artifact with complete provenance
  const gbdtArtifact = gbdt.toArtifact({
    trainingCodeGitSha,
    baselineGitSha,
    datasetVersion: 'SIFTR_CONTEXT_DATASET_V1',
    datasetSha256,
    trainSplitSha256,
    validationSplitSha256,
    testSplitSha256,
    metrics: {
      train: {
        ndcg5: gbdtTrainEval.ndcg5,
        ndcg10: gbdtTrainEval.ndcg10,
        ndcg20: gbdtTrainEval.ndcg20,
        recall5: gbdtTrainEval.recall5,
        recall10: gbdtTrainEval.recall10,
        mrr: gbdtTrainEval.mrr,
      },
      validation: {
        ndcg5: gbdtValEval.ndcg5,
        ndcg10: gbdtValEval.ndcg10,
        ndcg20: gbdtValEval.ndcg20,
        recall5: gbdtValEval.recall5,
        recall10: gbdtValEval.recall10,
        mrr: gbdtValEval.mrr,
      },
    },
  });
  const gbdtPath = path.join(modelsDir, 'gbdt_pairwise_v1.json');
  fs.writeFileSync(gbdtPath, JSON.stringify(gbdtArtifact, null, 2), 'utf8');
  console.log(`✔ Persisted GBDT artifact: ${gbdtPath}`);

  // 2. Train Margin-based Linear Pairwise Ranker (Model Family 2)
  console.log('\n📐 Training Model Family 2: Linear Margin Pairwise Coordinate Ranker...');
  const t1 = Date.now();
  const linear = LinearPairwiseRanker.train(trainPairs, {
    maxIterations: 80,
    learningRate: 0.05,
    includeJev: true,
  });
  const trainDurationLinear = Date.now() - t1;
  console.log(`✔ Trained Linear Pairwise Ranker in ${trainDurationLinear}ms.`);

  const linearTrainEval = evaluateModelOnRows(linear, trainRowsByEpisode);
  const linearValEval = evaluateModelOnRows(linear, valRowsByEpisode);
  console.log(`   Linear Train      NDCG@10: ${linearTrainEval.ndcg10}, Recall@10: ${linearTrainEval.recall10}, MRR: ${linearTrainEval.mrr}`);
  console.log(`   Linear Validation NDCG@10: ${linearValEval.ndcg10}, Recall@10: ${linearValEval.recall10}, MRR: ${linearValEval.mrr}`);

  const linearArtifact = linear.toArtifact({
    trainingCodeGitSha,
    baselineGitSha,
    datasetVersion: 'SIFTR_CONTEXT_DATASET_V1',
    datasetSha256,
    trainSplitSha256,
    validationSplitSha256,
    testSplitSha256,
    metrics: {
      train: {
        ndcg5: linearTrainEval.ndcg5,
        ndcg10: linearTrainEval.ndcg10,
        ndcg20: linearTrainEval.ndcg20,
        recall5: linearTrainEval.recall5,
        recall10: linearTrainEval.recall10,
        mrr: linearTrainEval.mrr,
      },
      validation: {
        ndcg5: linearValEval.ndcg5,
        ndcg10: linearValEval.ndcg10,
        ndcg20: linearValEval.ndcg20,
        recall5: linearValEval.recall5,
        recall10: linearValEval.recall10,
        mrr: linearValEval.mrr,
      },
    },
  });
  const linearPath = path.join(modelsDir, 'linear_pairwise_v1.json');
  fs.writeFileSync(linearPath, JSON.stringify(linearArtifact, null, 2), 'utf8');
  console.log(`✔ Persisted Linear artifact: ${linearPath}`);

  // 3. Learning Curves
  console.log('\n📈 Generating Learning Curves (scaling training task counts)...');
  const taskIds = Array.from(new Set(trainPairs.map((p) => p.episodeId)));
  const increments = [10, 25, 50, taskIds.length].filter((cnt, idx, arr) => cnt <= taskIds.length && (idx === 0 || cnt > arr[idx - 1]));

  const learningCurve: LearningCurvePoint[] = [];
  for (const count of increments) {
    const subsetTasks = new Set(taskIds.slice(0, count));
    const subsetPairs = trainPairs.filter((p) => subsetTasks.has(p.episodeId));
    const subGbdt = TreeRanker.train(subsetPairs, { maxIterations: 40, learningRate: 0.08 });
    const evalResult = evaluateModelOnRows(subGbdt, valRowsByEpisode);

    learningCurve.push({
      taskCount: count,
      pairCount: subsetPairs.length,
      valNdcg10: evalResult.ndcg10,
      valRecall10: evalResult.recall10,
      valMrr: evalResult.mrr,
    });
    console.log(`   Tasks: ${count.toString().padStart(3)} | Pairs: ${subsetPairs.length.toString().padStart(4)} | Val NDCG@10: ${evalResult.ndcg10.toFixed(4)} | Recall@10: ${evalResult.recall10.toFixed(4)}`);
  }

  const learningCurvePath = path.join(dataDir, 'learning_curve.json');
  fs.writeFileSync(learningCurvePath, JSON.stringify(learningCurve, null, 2), 'utf8');
  console.log(`✔ Learning curves saved to: ${learningCurvePath}`);

  return { gbdtArtifact, linearArtifact, learningCurve };
}

function evaluateModelOnRows(model: any, rowsByEpisode: Map<string, DatasetRowV1[]>) {
  const taskEvals: TaskRankingEvaluation[] = [];

  for (const [epId, rows] of rowsByEpisode.entries()) {
    const scored = rows.map((r) => {
      const vec = r.featureVector;
      const score = model.scoreVector ? model.scoreVector(vec) : 0;
      return {
        contextUnitId: r.contextUnitId,
        score: score * 10 + r.preRankingScore * 0.1,
        isPositive: r.benchmarkRelevanceLabel === 'TARGET' || r.labelState === 'POSITIVE',
        tokenEstimate: r.features.tokenEstimate || 100,
      };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.contextUnitId.localeCompare(b.contextUnitId);
    });

    const rankedUnits = scored.map((s) => ({
      contextUnitId: s.contextUnitId,
      path: s.isPositive ? 'target' : 'unrelated',
      tokenEstimate: s.tokenEstimate,
    }));

    taskEvals.push(
      RankingMetricsCalculator.evaluateTaskRanking({
        taskId: epId,
        rankedUnits,
        expectedTargetPaths: ['target'],
        tokenLimit: 8000,
      })
    );
  }

  return RankingMetricsCalculator.computeAggregate(taskEvals);
}

if (require.main === module) {
  runTrainContextRank();
}
