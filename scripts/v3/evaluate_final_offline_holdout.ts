#!/usr/bin/env node
/**
 * SiftrCode V3.1 - Final Fresh Holdout Offline Evaluation (Phase 11)
 *
 * Evaluates frozen deterministic V2 vs learned ContextRank V3 on the genuinely
 * new, untouched 34-task final holdout:
 * - Equal candidate budget (50 candidates)
 * - Equal context token budget (8,000 tokens)
 * - Identical candidate extraction, feature representation, materialization, and metrics
 * - Non-parametric task-level bootstrap 95% confidence intervals
 * - Emits experiments/v3-1-final/offline_evaluation.json
 *
 * Final Offline Gate:
 * Pass if NDCG@10 delta >= 0, Recall@10 does not materially regress, MRR does not materially regress, wins >= losses.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { SiftrBenchManifest, SiftrBenchEpisode } from '../../src/benchmark/siftrbench/episode_schema';
import { RepositoryIndexer } from '../../src/indexing/repository_index';
import { GraphBuilder } from '../../src/graph/graph_builder';
import { GitGraphIntelligence } from '../../src/graph/git_graph';
import { CandidateGenerator } from '../../src/retrieval/candidate_generator';
import { createTaskContext } from '../../src/context/task_context';
import { createAgentEnvironment } from '../../src/agents/agent_environment';
import { FeatureBuilderV3_1 } from '../../src/learning/features/feature_builder_v3_1';
import { ContextFeaturesV3_1, featuresToVector } from '../../src/learning/features/feature_set_v3_1';
import { ContextFeaturesV1 } from '../../src/ranking/feature_schema';
import { ContextRanker, RankedCandidate } from '../../src/ranking/context_rank';
import { TreeRanker } from '../../src/learning/models/context_rank/tree_ranker';
import { RankingMetricsCalculator, TaskRankingEvaluation } from '../../src/learning/evaluation/ranking_metrics';
import { TaskLevelBootstrap, TaskPairedDelta } from '../../src/learning/evaluation/bootstrap';
import { ContextUnit } from '../../src/context/context_unit';

export interface FinalOfflineEvaluationReport {
  schemaVersion: 'siftrcode-final-offline-eval-v1';
  evaluatedAt: string;
  totalHoldoutTasks: number;
  candidateBudget: number;
  tokenBudget: number;
  gatePassed: boolean;
  gateDecision: 'OFFLINE_GATE_PASSED' | 'OFFLINE_GATE_FAILED';
  rationale: string;
  v2Summary: {
    meanNdcg5: number;
    meanNdcg10: number;
    meanNdcg20: number;
    meanRecall5: number;
    meanRecall10: number;
    meanRecall20: number;
    meanMrr: number;
    targetCoverage: number;
    meanTokensConsumed: number;
  };
  v3Summary: {
    meanNdcg5: number;
    meanNdcg10: number;
    meanNdcg20: number;
    meanRecall5: number;
    meanRecall10: number;
    meanRecall20: number;
    meanMrr: number;
    targetCoverage: number;
    meanTokensConsumed: number;
  };
  pairedDeltas: {
    ndcg10Delta: number;
    recall10Delta: number;
    mrrDelta: number;
    v3Wins: number;
    v2Wins: number;
    ties: number;
  };
  discriminativeness: {
    pathExplicitPromptRate: number;
    perfectAt1RateV2: number;
    perfectAt1RateV3: number;
    tieRate: number;
    isDiscriminative: boolean;
  };
  bootstrapReport: any;
  perRepoMetrics: Record<string, any>;
  perTypeMetrics: Record<string, any>;
  taskResults: Array<{
    taskId: string;
    repo: string;
    taskType: string;
    expectedTargetPaths: string[];
    v2: TaskRankingEvaluation;
    v3: TaskRankingEvaluation;
    ndcg10Delta: number;
    recall10Delta: number;
    mrrDelta: number;
    winner: 'V3' | 'V2' | 'TIE';
  }>;
}

export async function runFinalOfflineEvaluation(): Promise<FinalOfflineEvaluationReport> {
  const rootDir = path.resolve(__dirname, '../..');
  const finalExpDir = path.join(rootDir, 'experiments/v3-1-final-natural');
  const manifestPath = path.join(finalExpDir, 'natural_holdout_manifest.json');
  const gbdtArtifactPath = path.join(rootDir, 'data/models/gbdt_pairwise_v1.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Final natural holdout manifest missing at: ${manifestPath}`);
  }
  if (!fs.existsSync(gbdtArtifactPath)) {
    throw new Error(`Trained GBDT model artifact missing at: ${gbdtArtifactPath}`);
  }

  const manifest: SiftrBenchManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const gbdtArtifact = JSON.parse(fs.readFileSync(gbdtArtifactPath, 'utf8'));
  const v3TreeRanker = TreeRanker.fromArtifact(gbdtArtifact);

  // Fail-closed verification and loading of frozen authoritative V2 ContextRanker from compiled baseline worktree
  const v2RepoDir = path.join(rootDir, '.v2-baseline-worktree');
  if (!fs.existsSync(v2RepoDir)) {
    throw new Error(`FAIL_CLOSED: .v2-baseline-worktree missing at: ${v2RepoDir}`);
  }
  const v2Sha = execSync(`git -C "${v2RepoDir}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
  if (v2Sha !== '1eedac03b0d83025ebf08ed2945e0ab015c46f6a') {
    throw new Error(`FAIL_CLOSED: .v2-baseline-worktree HEAD (${v2Sha}) does not match authoritative V2 commit 1eedac03b0d83025ebf08ed2945e0ab015c46f6a`);
  }
  const v2DistPath = path.join(v2RepoDir, 'dist');
  if (!fs.existsSync(v2DistPath)) {
    throw new Error(`FAIL_CLOSED: .v2-baseline-worktree/dist missing at: ${v2DistPath}`);
  }
  const v2Module = require(v2DistPath);
  if (!v2Module.ContextRanker) {
    throw new Error(`FAIL_CLOSED: ContextRanker missing in .v2-baseline-worktree/dist`);
  }
  const v2DeterministicRanker = new v2Module.ContextRanker();
  console.log(`🏛️  [Final Offline Evaluation] Loaded frozen authoritative V2 ContextRanker (.v2-baseline-worktree/dist @ ${v2Sha})`);

  console.log('🏛️  [Final Offline Evaluation] Initializing evaluation on frozen fresh natural holdout...');
  console.log(`   Episodes: ${manifest.episodes.length} tasks across ${Object.keys(manifest.repositoryDistribution).length} repositories`);
  console.log('   Candidate Budget: 50 | Token Budget: 8000 tokens');

  const repoPaths: Record<string, string> = {
    express: path.join(rootDir, 'benchmarks/express-repo'),
    fastapi: path.join(rootDir, 'benchmarks/fastapi-repo'),
    commander: path.join(rootDir, 'benchmarks/commander-repo'),
    siftrcode: rootDir,
  };

  const repoFilters: Record<string, any> = {
    express: {},
    fastapi: { includePatterns: ['fastapi/**'], excludePatterns: ['**/tests/**', '**/docs/**'] },
    commander: { includePatterns: ['lib/**'], excludePatterns: ['**/tests/**'] },
    siftrcode: { includePatterns: ['src/**'], excludePatterns: ['**/node_modules/**', '**/dist/**', '**/benchmarks/**'] },
  };

  const indexCache = new Map<string, { units: ContextUnit[]; graph: any; gitInt?: GitGraphIntelligence }>();
  const tmpDirsToClean: string[] = [];

  async function getPointInTimeIndex(repoId: string, baseCommit: string): Promise<{ units: ContextUnit[]; graph: any; gitInt?: GitGraphIntelligence }> {
    const cacheKey = `${repoId}:${baseCommit}`;
    if (indexCache.has(cacheKey)) {
      return indexCache.get(cacheKey)!;
    }

    let repoDir: string;
    if (repoId === 'siftrcode') {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `siftr-offline-${baseCommit.slice(0, 8)}-`));
      tmpDirsToClean.push(tmp);
      execSync(`git worktree add --force --detach "${tmp}" ${baseCommit} --quiet`);
      repoDir = tmp;
    } else {
      repoDir = repoPaths[repoId];
      execSync(`git -C "${repoDir}" checkout --quiet ${baseCommit}`);
    }

    const currentSha = execSync(`git -C "${repoDir}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
    if (currentSha !== baseCommit) {
      throw new Error(`POINT_IN_TIME_VIOLATION: ${repoId} workspace at ${currentSha}, expected ${baseCommit}`);
    }

    const indexer = new RepositoryIndexer();
    const idx = await indexer.indexRepository(repoDir, repoFilters[repoId]);
    const gb = new GraphBuilder();
    const graph = gb.buildGraph(idx.units, { repoDir });
    let gitInt: GitGraphIntelligence | undefined;
    try {
      gitInt = new GitGraphIntelligence({ repoDir });
    } catch {}

    const res = { units: idx.units, graph, gitInt };
    indexCache.set(cacheKey, res);
    return res;
  }

  // Scoring with point-in-time workspaces
  console.log(`\n🔬 Scoring ${manifest.episodes.length} fresh tasks with V2 (frozen deterministic) vs V3 (learned GBDT)...`);
  const candGen = new CandidateGenerator();
  const pairedDeltas: TaskPairedDelta[] = [];
  const taskResults: FinalOfflineEvaluationReport['taskResults'] = [];

  const v2TaskEvals: TaskRankingEvaluation[] = [];
  const v3TaskEvals: TaskRankingEvaluation[] = [];

  try {
    for (let i = 0; i < manifest.episodes.length; i++) {
      const ep = manifest.episodes[i];
      const repoKey = ep.repositoryId;
      const repoData = await getPointInTimeIndex(repoKey, ep.baseCommit);

    if (!repoData) {
      throw new Error(`Repository data not loaded for ${repoKey}`);
    }

    const taskCtx = createTaskContext({
      taskId: ep.taskId,
      primaryPrompt: ep.taskPrompt,
      workspaceSnapshotId: ep.workspaceSnapshotId,
      agentEnvironment: createAgentEnvironment({
        agentProvider: 'google',
        model: 'gemini-3.6-flash',
        harnessVersion: 'v3.1.0',
      }),
    });

    const candidates = candGen.generateCandidates(
      taskCtx,
      repoData.units,
      repoData.graph,
      repoData.gitInt,
      { maxCandidates: 50 }
    );

    // Build features for all candidates
    const unitMap = new Map<string, ContextUnit>();
    for (const u of repoData.units) unitMap.set(u.id, u);

    const validCandidatePairs: Array<{ cand: any; unit: ContextUnit; features: ContextFeaturesV3_1 }> = [];
    for (const c of candidates) {
      const u = unitMap.get(c.contextUnitId);
      if (!u) continue;
      const f = FeatureBuilderV3_1.buildFeatures({
        candidate: c,
        unit: u,
        task: taskCtx,
        graph: repoData.graph,
        gitIntelligence: repoData.gitInt,
      });
      validCandidatePairs.push({ cand: c, unit: u, features: f });
    }

    // --- V2 Frozen Deterministic Ranking ---
    const v1Features: ContextFeaturesV1[] = validCandidatePairs.map(({ features: f }) => ({
      schemaVersion: 'v1',
      contextUnitId: f.contextUnitId,
      unitKind: f.unitKind,
      tokenEstimate: f.tokenEstimate,
      isTest: f.isTest,
      isConfig: f.isConfig,
      isDocumentation: f.isDocumentation,
      isSchema: f.isSchema,
      isExported: f.isExported,
      exactSymbolMatch: f.exactSymbolMatch,
      exactPathMatch: f.exactPathMatch,
      bm25Score: f.bm25Score,
      tokenOverlapRatio: f.tokenOverlapRatio,
      graphDegree: f.graphDegree,
      minDistanceToSeed: f.minDistanceToSeed,
      minDistanceToErrorFrame: f.minDistanceToErrorFrame,
      isDirectDependency: f.isDirectDependency,
      isDirectDependent: f.isDirectDependent,
      changeFrequency: f.changeFrequency,
      recentChangeFrequency: f.recentChangeFrequency,
      maxCoChangeWithSeeds: f.maxCoChangeWithSeeds,
      inStackTrace: f.inStackTrace,
      isFailingTestTarget: f.isFailingTestTarget,
      inCompilerError: f.inCompilerError,
      inDirtyDiff: f.inDirtyDiff,
      heuristicScore: f.heuristicScore,
    }));

    const v2Ranked = v2DeterministicRanker.rank(v1Features);
    const v2CandidateList = v2Ranked.map((r: any) => {
      const pair = validCandidatePairs.find((p) => p.cand.contextUnitId === r.contextUnitId);
      return {
        contextUnitId: r.contextUnitId,
        path: pair?.unit.path,
        tokenEstimate: r.features.tokenEstimate || 100,
      };
    });

    const v2TaskEval = RankingMetricsCalculator.evaluateTaskRanking({
      taskId: ep.taskId,
      rankedUnits: v2CandidateList,
      expectedTargetPaths: ep.expectedTargetPaths,
      tokenLimit: 8000,
    });
    v2TaskEvals.push(v2TaskEval);

    // --- V3 Learned GBDT Ranking ---
    const v3Scored = validCandidatePairs.map(({ cand, unit, features: f }) => {
      const vec = featuresToVector(f, true);
      const rawScore = v3TreeRanker.scoreVector(vec);
      const score = rawScore * 10.0 + f.heuristicScore * 0.1;
      return {
        contextUnitId: cand.contextUnitId,
        path: unit.path,
        score,
        tokenEstimate: f.tokenEstimate || 100,
      };
    });

    v3Scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.contextUnitId.localeCompare(b.contextUnitId);
    });

    const v3TaskEval = RankingMetricsCalculator.evaluateTaskRanking({
      taskId: ep.taskId,
      rankedUnits: v3Scored,
      expectedTargetPaths: ep.expectedTargetPaths,
      tokenLimit: 8000,
    });
    v3TaskEvals.push(v3TaskEval);

    // Deltas
    const ndcg10Delta = Number((v3TaskEval.ndcg10 - v2TaskEval.ndcg10).toFixed(4));
    const recall10Delta = Number((v3TaskEval.recall10 - v2TaskEval.recall10).toFixed(4));
    const mrrDelta = Number((v3TaskEval.mrr - v2TaskEval.mrr).toFixed(4));
    const tokensDelta = v3TaskEval.tokensConsumed - v2TaskEval.tokensConsumed;

    let winner: 'V3' | 'V2' | 'TIE' = 'TIE';
    if (v3TaskEval.ndcg10 > v2TaskEval.ndcg10 + 0.0001) winner = 'V3';
    else if (v2TaskEval.ndcg10 > v3TaskEval.ndcg10 + 0.0001) winner = 'V2';

    pairedDeltas.push({
      taskId: ep.taskId,
      repo: ep.repositoryId,
      taskType: ep.taskType,
      baseline: v2TaskEval,
      candidate: v3TaskEval,
      ndcg10Delta,
      recall10Delta,
      mrrDelta,
      tokensDelta,
      latencyDelta: 0,
    });

    taskResults.push({
      taskId: ep.taskId,
      repo: ep.repositoryId,
      taskType: ep.taskType,
      expectedTargetPaths: ep.expectedTargetPaths,
      v2: v2TaskEval,
      v3: v3TaskEval,
      ndcg10Delta,
      recall10Delta,
      mrrDelta,
      winner,
    });

    const mark = winner === 'V3' ? 'V3 WIN 🟢' : winner === 'V2' ? 'V2 WIN 🔴' : 'TIE ⚪';
    console.log(`   [${i + 1}/${manifest.episodes.length}] ${ep.taskId.padEnd(42)} ${mark} (NDCG@10: V2=${v2TaskEval.ndcg10.toFixed(3)}, V3=${v3TaskEval.ndcg10.toFixed(3)}, Δ=${ndcg10Delta >= 0 ? '+' : ''}${ndcg10Delta.toFixed(3)})`);
  }

  // 3. Compute Summary Statistics
  const n = manifest.episodes.length;
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);

  const v2Summary = {
    meanNdcg5: Number(mean(v2TaskEvals.map((e) => e.ndcg5)).toFixed(4)),
    meanNdcg10: Number(mean(v2TaskEvals.map((e) => e.ndcg10)).toFixed(4)),
    meanNdcg20: Number(mean(v2TaskEvals.map((e) => e.ndcg20)).toFixed(4)),
    meanRecall5: Number(mean(v2TaskEvals.map((e) => e.recall5)).toFixed(4)),
    meanRecall10: Number(mean(v2TaskEvals.map((e) => e.recall10)).toFixed(4)),
    meanRecall20: Number(mean(v2TaskEvals.map((e) => e.recall20)).toFixed(4)),
    meanMrr: Number(mean(v2TaskEvals.map((e) => e.mrr)).toFixed(4)),
    targetCoverage: Number((v2TaskEvals.filter((e) => e.targetHit).length / n).toFixed(4)),
    meanTokensConsumed: Math.round(mean(v2TaskEvals.map((e) => e.tokensConsumed))),
  };

  const v3Summary = {
    meanNdcg5: Number(mean(v3TaskEvals.map((e) => e.ndcg5)).toFixed(4)),
    meanNdcg10: Number(mean(v3TaskEvals.map((e) => e.ndcg10)).toFixed(4)),
    meanNdcg20: Number(mean(v3TaskEvals.map((e) => e.ndcg20)).toFixed(4)),
    meanRecall5: Number(mean(v3TaskEvals.map((e) => e.recall5)).toFixed(4)),
    meanRecall10: Number(mean(v3TaskEvals.map((e) => e.recall10)).toFixed(4)),
    meanRecall20: Number(mean(v3TaskEvals.map((e) => e.recall20)).toFixed(4)),
    meanMrr: Number(mean(v3TaskEvals.map((e) => e.mrr)).toFixed(4)),
    targetCoverage: Number((v3TaskEvals.filter((e) => e.targetHit).length / n).toFixed(4)),
    meanTokensConsumed: Math.round(mean(v3TaskEvals.map((e) => e.tokensConsumed))),
  };

  const v3Wins = taskResults.filter((t) => t.winner === 'V3').length;
  const v2Wins = taskResults.filter((t) => t.winner === 'V2').length;
  const ties = taskResults.filter((t) => t.winner === 'TIE').length;

  const pairedSummaryDeltas = {
    ndcg10Delta: Number((v3Summary.meanNdcg10 - v2Summary.meanNdcg10).toFixed(4)),
    recall10Delta: Number((v3Summary.meanRecall10 - v2Summary.meanRecall10).toFixed(4)),
    mrrDelta: Number((v3Summary.meanMrr - v2Summary.meanMrr).toFixed(4)),
    v3Wins,
    v2Wins,
    ties,
  };

  // Discriminativeness metrics
  let leakedPrompts = 0;
  for (const ep of manifest.episodes) {
    for (const tp of ep.expectedTargetPaths) {
      if (ep.taskPrompt.toLowerCase().includes(tp.toLowerCase())) {
        leakedPrompts++;
        break;
      }
    }
  }
  const pathExplicitPromptRate = leakedPrompts / n;
  const perfectAt1RateV2 = v2TaskEvals.filter((e) => e.ndcg10 >= 0.999).length / n;
  const perfectAt1RateV3 = v3TaskEvals.filter((e) => e.ndcg10 >= 0.999).length / n;
  const tieRate = ties / n;
  const isDiscriminative = tieRate < 0.8 && pathExplicitPromptRate === 0;

  const discriminativeness = {
    pathExplicitPromptRate: Number(pathExplicitPromptRate.toFixed(4)),
    perfectAt1RateV2: Number(perfectAt1RateV2.toFixed(4)),
    perfectAt1RateV3: Number(perfectAt1RateV3.toFixed(4)),
    tieRate: Number(tieRate.toFixed(4)),
    isDiscriminative,
  };

  // 4. Statistical Bootstrap
  const bootstrapReport = TaskLevelBootstrap.evaluate(pairedDeltas, { iterations: 2000, seed: 42 });

  // 5. Per-Repository & Per-Type Breakdowns
  const perRepoMetrics: Record<string, any> = {};
  for (const repo of Object.keys(manifest.repositoryDistribution)) {
    const subset = taskResults.filter((t) => t.repo === repo);
    const rN = Math.max(1, subset.length);
    const v2Ndcg10 = mean(subset.map((s) => s.v2.ndcg10));
    const v3Ndcg10 = mean(subset.map((s) => s.v3.ndcg10));
    const rWins = subset.filter((s) => s.winner === 'V3').length;
    const rLosses = subset.filter((s) => s.winner === 'V2').length;
    perRepoMetrics[repo] = {
      taskCount: subset.length,
      v2MeanNdcg10: Number(v2Ndcg10.toFixed(4)),
      v3MeanNdcg10: Number(v3Ndcg10.toFixed(4)),
      ndcg10Delta: Number((v3Ndcg10 - v2Ndcg10).toFixed(4)),
      v3Wins: rWins,
      v2Wins: rLosses,
      ties: subset.length - rWins - rLosses,
    };
  }

  const perTypeMetrics: Record<string, any> = {};
  for (const ttype of Object.keys(manifest.taskTypeDistribution)) {
    const subset = taskResults.filter((t) => t.taskType === ttype);
    const v2Ndcg10 = mean(subset.map((s) => s.v2.ndcg10));
    const v3Ndcg10 = mean(subset.map((s) => s.v3.ndcg10));
    perTypeMetrics[ttype] = {
      taskCount: subset.length,
      v2MeanNdcg10: Number(v2Ndcg10.toFixed(4)),
      v3MeanNdcg10: Number(v3Ndcg10.toFixed(4)),
      ndcg10Delta: Number((v3Ndcg10 - v2Ndcg10).toFixed(4)),
    };
  }

  // 6. Evaluate Final Offline Gate Conditions
  const ndcg10Pass = pairedSummaryDeltas.ndcg10Delta >= 0;
  const recall10Pass = pairedSummaryDeltas.recall10Delta >= -0.05;
  const mrrPass = pairedSummaryDeltas.mrrDelta >= -0.05;
  const winLossPass = v3Wins >= v2Wins;

  const gatePassed = ndcg10Pass && recall10Pass && mrrPass && winLossPass;
  const gateDecision = gatePassed ? 'OFFLINE_GATE_PASSED' : 'OFFLINE_GATE_FAILED';

  const rationale = gatePassed
    ? `Learned ContextRank V3 demonstrated non-negative NDCG@10 delta (${pairedSummaryDeltas.ndcg10Delta >= 0 ? '+' : ''}${pairedSummaryDeltas.ndcg10Delta.toFixed(4)}) with ${v3Wins} wins vs ${v2Wins} losses across ${manifest.episodes.length} natural holdout tasks.`
    : `Learned ContextRank V3 failed the final offline gate: NDCG@10 delta (${pairedSummaryDeltas.ndcg10Delta}) or win/loss ratio (${v3Wins} wins vs ${v2Wins} losses).`;

  const report: FinalOfflineEvaluationReport = {
    schemaVersion: 'siftrcode-final-offline-eval-v1',
    evaluatedAt: new Date().toISOString(),
    totalHoldoutTasks: manifest.episodes.length,
    candidateBudget: 50,
    tokenBudget: 8000,
    gatePassed,
    gateDecision,
    rationale,
    v2Summary,
    v3Summary,
    pairedDeltas: pairedSummaryDeltas,
    discriminativeness,
    bootstrapReport,
    perRepoMetrics,
    perTypeMetrics,
    taskResults,
  };

  const reportPath = path.join(finalExpDir, 'offline_evaluation.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n📊 ================= FINAL OFFLINE HOLDOUT REPORT =================');
  console.log(`   Gate Decision:     [ ${gateDecision} ]`);
  console.log(`   Rationale:         ${rationale}`);
  console.log('   -------------------------------------------------------------');
  console.log(`   Metric             Frozen V2       Learned V3       Delta`);
  console.log(`   NDCG@5:            ${v2Summary.meanNdcg5.toFixed(4)}          ${v3Summary.meanNdcg5.toFixed(4)}          ${(v3Summary.meanNdcg5 - v2Summary.meanNdcg5 >= 0 ? '+' : '')}${(v3Summary.meanNdcg5 - v2Summary.meanNdcg5).toFixed(4)}`);
  console.log(`   NDCG@10:           ${v2Summary.meanNdcg10.toFixed(4)}          ${v3Summary.meanNdcg10.toFixed(4)}          ${pairedSummaryDeltas.ndcg10Delta >= 0 ? '+' : ''}${pairedSummaryDeltas.ndcg10Delta.toFixed(4)}`);
  console.log(`   Recall@10:         ${v2Summary.meanRecall10.toFixed(4)}          ${v3Summary.meanRecall10.toFixed(4)}          ${pairedSummaryDeltas.recall10Delta >= 0 ? '+' : ''}${pairedSummaryDeltas.recall10Delta.toFixed(4)}`);
  console.log(`   MRR:               ${v2Summary.meanMrr.toFixed(4)}          ${v3Summary.meanMrr.toFixed(4)}          ${pairedSummaryDeltas.mrrDelta >= 0 ? '+' : ''}${pairedSummaryDeltas.mrrDelta.toFixed(4)}`);
  console.log(`   Target Coverage:   ${(v2Summary.targetCoverage * 100).toFixed(1)}%          ${(v3Summary.targetCoverage * 100).toFixed(1)}%          ${((v3Summary.targetCoverage - v2Summary.targetCoverage) * 100 >= 0 ? '+' : '')}${((v3Summary.targetCoverage - v2Summary.targetCoverage) * 100).toFixed(1)}%`);
  console.log('   -------------------------------------------------------------');
  console.log(`   Task Outcomes:     ${v3Wins} V3 wins, ${ties} ties, ${v2Wins} V2 wins`);
  console.log(`   95% CI (NDCG@10):  [${bootstrapReport.ndcg10.ciLower95.toFixed(4)}, ${bootstrapReport.ndcg10.ciUpper95.toFixed(4)}]`);
  console.log('   =============================================================');
  console.log(`✔ Report persisted to: ${reportPath}`);

  return report;
  } finally {
    for (const tmp of tmpDirsToClean) {
      try { execSync(`git worktree remove --force "${tmp}" --quiet`, { stdio: 'pipe' }); } catch {}
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
    for (const [rId, rPath] of Object.entries(repoPaths)) {
      if (rId !== 'siftrcode' && fs.existsSync(rPath)) {
        try {
          execSync(`git -C "${rPath}" checkout --quiet origin/master 2>/dev/null || git -C "${rPath}" checkout --quiet master 2>/dev/null || true`);
        } catch {}
      }
    }
  }
}

if (require.main === module) {
  runFinalOfflineEvaluation().catch((err) => {
    console.error('Fatal error during offline evaluation:', err);
    process.exit(1);
  });
}
