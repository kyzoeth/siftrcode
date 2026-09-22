/**
 * SiftrCode V3.1 - Final Fresh Holdout Offline Evaluator (Phase 11)
 *
 * Evaluates the ranked plans returned by FrozenV2ContextProvider and LearnedV3ContextProvider
 * on the genuinely fresh, authentic 40-task natural holdout:
 * - Real shared candidateBudget: 50 through ContextEngine and both providers
 * - Real context token budget: 8,000 tokens
 * - Evaluates ranked plans and candidate units returned by both authentic providers
 * - Point-in-time git workspaces at each task's baseCommit
 * - Persists provider implementation, baseCommit, and bundleChecksum provenance
 * - Non-parametric task-level bootstrap 95% confidence intervals
 * - Emits experiments/v3-1-final-natural/offline_evaluation.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { SiftrBenchManifest } from '../../benchmark/siftrbench/episode_schema';
import { TreeRanker } from '../models/context_rank/tree_ranker';
import { RankingMetricsCalculator, TaskRankingEvaluation } from './ranking_metrics';
import { TaskLevelBootstrap, TaskPairedDelta } from './bootstrap';
import {
  FrozenV2ContextProvider,
  LearnedV3ContextProvider,
  AUTHORITATIVE_V2_SHA,
  ProviderBundleProvenance,
} from './context_providers';

export interface FinalOfflineEvaluationOptions {
  maxTasks?: number;
  taskFilter?: string;
  candidateBudget?: number;
  tokenBudget?: number;
  manifestPath?: string;
  outputPath?: string;
  persistReport?: boolean;
  v2Provider?: any;
  v3Provider?: any;
}

export interface FinalOfflineEvaluationReport {
  schemaVersion: 'siftrcode-final-offline-eval-v1';
  evaluatedAt: string;
  totalHoldoutTasks: number;
  candidateBudget: number;
  tokenBudget: number;
  gatePassed: boolean;
  gateDecision: 'OFFLINE_GATE_PASSED' | 'OFFLINE_GATE_FAILED';
  rationale: string;
  provenance: {
    evaluatedAt: string;
    candidateBudget: number;
    tokenBudget: number;
    v2Provider: {
      name: string;
      implementation: string;
      baselineSha: string;
    };
    v3Provider: {
      name: string;
      implementation: string;
      modelArtifactSha256: string;
    };
  };
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
    baseCommit: string;
    expectedTargetPaths: string[];
    v2: TaskRankingEvaluation;
    v3: TaskRankingEvaluation;
    ndcg10Delta: number;
    recall10Delta: number;
    mrrDelta: number;
    winner: 'V3' | 'V2' | 'TIE';
    v2Provenance: ProviderBundleProvenance;
    v3Provenance: ProviderBundleProvenance;
  }>;
}

export async function runFinalOfflineEvaluation(
  options: FinalOfflineEvaluationOptions = {}
): Promise<FinalOfflineEvaluationReport> {
  const rootDir = path.resolve(__dirname, '../../..');
  const finalExpDir = path.join(rootDir, 'experiments/v3-1-final-natural');
  const manifestPath = options.manifestPath || path.join(finalExpDir, 'natural_holdout_manifest.json');
  const gbdtArtifactPath = path.join(rootDir, 'data/models/gbdt_pairwise_v1.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Final natural holdout manifest missing at: ${manifestPath}`);
  }
  if (!fs.existsSync(gbdtArtifactPath)) {
    throw new Error(`Trained GBDT model artifact missing at: ${gbdtArtifactPath}`);
  }

  const manifest: SiftrBenchManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const gbdtArtifactRaw = fs.readFileSync(gbdtArtifactPath, 'utf8');
  const gbdtArtifact = JSON.parse(gbdtArtifactRaw);
  const gbdtSha256 = crypto.createHash('sha256').update(gbdtArtifactRaw).digest('hex');
  const v3TreeRanker = TreeRanker.fromArtifact(gbdtArtifact);

  // Initialize or use injected providers
  const v2Provider = options.v2Provider || new FrozenV2ContextProvider();
  const v3Provider = options.v3Provider || new LearnedV3ContextProvider(v3TreeRanker);

  console.log('🏛️  [Final Offline Evaluation] Initializing evaluation on frozen fresh natural holdout...');
  console.log(`   Episodes: ${manifest.episodes.length} tasks across ${Object.keys(manifest.repositoryDistribution).length} repositories`);
  const candidateBudget = options.candidateBudget ?? 50;
  const tokenBudget = options.tokenBudget ?? 8000;
  console.log(`   Candidate Budget: ${candidateBudget} | Token Budget: ${tokenBudget} tokens`);
  console.log(`   V2 Provider: ${v2Provider.getImplementation()}`);
  console.log(`   V3 Provider: ${v3Provider.getImplementation()}`);

  const repoPaths: Record<string, string> = {
    express: path.join(rootDir, 'benchmarks/express-repo'),
    fastapi: path.join(rootDir, 'benchmarks/fastapi-repo'),
    commander: path.join(rootDir, 'benchmarks/commander-repo'),
    siftrcode: rootDir,
  };

  const initialShas: Record<string, string> = {};
  for (const [rId, rPath] of Object.entries(repoPaths)) {
    if (rId !== 'siftrcode' && fs.existsSync(rPath)) {
      try {
        initialShas[rId] = execSync(`git -C "${rPath}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
      } catch {}
    }
  }

  const tmpDirsToClean: string[] = [];

  function getPointInTimeWorkspace(repoId: string, baseCommit: string): string {
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

    return repoDir;
  }

  let episodes = manifest.episodes;
  if (options.taskFilter) {
    episodes = episodes.filter(
      (e) =>
        e.episodeId.includes(options.taskFilter!) ||
        e.repositoryId.includes(options.taskFilter!) ||
        e.taskId.includes(options.taskFilter!)
    );
  }

  if (options.maxTasks && options.maxTasks > 0) {
    episodes = episodes.slice(0, options.maxTasks);
  }

  console.log(`\n🔬 Scoring ${episodes.length} fresh tasks using FrozenV2ContextProvider vs LearnedV3ContextProvider...`);
  const pairedDeltas: TaskPairedDelta[] = [];
  const taskResults: FinalOfflineEvaluationReport['taskResults'] = [];
  const v2TaskEvals: TaskRankingEvaluation[] = [];
  const v3TaskEvals: TaskRankingEvaluation[] = [];

  try {
    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const repoDir = getPointInTimeWorkspace(ep.repositoryId, ep.baseCommit);

      // Invoke FrozenV2ContextProvider
      const v2Bundle = await v2Provider.getContext({
        workspaceDir: repoDir,
        prompt: ep.taskPrompt,
        tokenBudget,
        candidateBudget,
        baseCommit: ep.baseCommit,
        repoId: ep.repositoryId,
      });

      // Invoke LearnedV3ContextProvider
      const v3Bundle = await v3Provider.getContext({
        workspaceDir: repoDir,
        prompt: ep.taskPrompt,
        tokenBudget,
        candidateBudget,
        baseCommit: ep.baseCommit,
        repoId: ep.repositoryId,
      });

      // Evaluate the ranked plans returned by both authentic providers
      const v2TaskEval = RankingMetricsCalculator.evaluateTaskRanking({
        taskId: ep.taskId,
        rankedUnits: v2Bundle.rankedUnits,
        expectedTargetPaths: ep.expectedTargetPaths,
        tokenLimit: tokenBudget,
      });
      v2TaskEvals.push(v2TaskEval);

      const v3TaskEval = RankingMetricsCalculator.evaluateTaskRanking({
        taskId: ep.taskId,
        rankedUnits: v3Bundle.rankedUnits,
        expectedTargetPaths: ep.expectedTargetPaths,
        tokenLimit: tokenBudget,
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
        baseCommit: ep.baseCommit,
        expectedTargetPaths: ep.expectedTargetPaths,
        v2: v2TaskEval,
        v3: v3TaskEval,
        ndcg10Delta,
        recall10Delta,
        mrrDelta,
        winner,
        v2Provenance: v2Bundle.provenance,
        v3Provenance: v3Bundle.provenance,
      });

      const outcomeIcon = winner === 'V3' ? '🟢 V3 WIN' : winner === 'V2' ? '🔴 V2 WIN' : '⚪ TIE';
      console.log(
        `   [${i + 1}/${episodes.length}] ${ep.taskId.padEnd(46)} ${outcomeIcon} (NDCG@10: V2=${v2TaskEval.ndcg10.toFixed(3)}, V3=${v3TaskEval.ndcg10.toFixed(3)}, Δ=${ndcg10Delta >= 0 ? '+' : ''}${ndcg10Delta.toFixed(3)})`
      );
    }

    // Bootstrap analysis
    console.log('\n🧮 Running non-parametric bootstrap resampling (2,000 iterations)...');
    const bootstrapReport = TaskLevelBootstrap.evaluate(pairedDeltas, { iterations: 2000, seed: 42 });

    // Summary calculations
    const v2Summary = {
      meanNdcg5: Number((v2TaskEvals.reduce((s, t) => s + t.ndcg5, 0) / v2TaskEvals.length).toFixed(4)),
      meanNdcg10: Number((v2TaskEvals.reduce((s, t) => s + t.ndcg10, 0) / v2TaskEvals.length).toFixed(4)),
      meanNdcg20: Number((v2TaskEvals.reduce((s, t) => s + t.ndcg20, 0) / v2TaskEvals.length).toFixed(4)),
      meanRecall5: Number((v2TaskEvals.reduce((s, t) => s + t.recall5, 0) / v2TaskEvals.length).toFixed(4)),
      meanRecall10: Number((v2TaskEvals.reduce((s, t) => s + t.recall10, 0) / v2TaskEvals.length).toFixed(4)),
      meanRecall20: Number((v2TaskEvals.reduce((s, t) => s + t.recall20, 0) / v2TaskEvals.length).toFixed(4)),
      meanMrr: Number((v2TaskEvals.reduce((s, t) => s + t.mrr, 0) / v2TaskEvals.length).toFixed(4)),
      targetCoverage: Number((v2TaskEvals.filter((t) => t.targetHit).length / v2TaskEvals.length).toFixed(4)),
      meanTokensConsumed: Math.round(v2TaskEvals.reduce((s, t) => s + t.tokensConsumed, 0) / v2TaskEvals.length),
    };

    const v3Summary = {
      meanNdcg5: Number((v3TaskEvals.reduce((s, t) => s + t.ndcg5, 0) / v3TaskEvals.length).toFixed(4)),
      meanNdcg10: Number((v3TaskEvals.reduce((s, t) => s + t.ndcg10, 0) / v3TaskEvals.length).toFixed(4)),
      meanNdcg20: Number((v3TaskEvals.reduce((s, t) => s + t.ndcg20, 0) / v3TaskEvals.length).toFixed(4)),
      meanRecall5: Number((v3TaskEvals.reduce((s, t) => s + t.recall5, 0) / v3TaskEvals.length).toFixed(4)),
      meanRecall10: Number((v3TaskEvals.reduce((s, t) => s + t.recall10, 0) / v3TaskEvals.length).toFixed(4)),
      meanRecall20: Number((v3TaskEvals.reduce((s, t) => s + t.recall20, 0) / v3TaskEvals.length).toFixed(4)),
      meanMrr: Number((v3TaskEvals.reduce((s, t) => s + t.mrr, 0) / v3TaskEvals.length).toFixed(4)),
      targetCoverage: Number((v3TaskEvals.filter((t) => t.targetHit).length / v3TaskEvals.length).toFixed(4)),
      meanTokensConsumed: Math.round(v3TaskEvals.reduce((s, t) => s + t.tokensConsumed, 0) / v3TaskEvals.length),
    };

    const v3Wins = taskResults.filter((r) => r.winner === 'V3').length;
    const v2Wins = taskResults.filter((r) => r.winner === 'V2').length;
    const ties = taskResults.filter((r) => r.winner === 'TIE').length;

    const pairedSummaryDeltas = {
      ndcg10Delta: Number((v3Summary.meanNdcg10 - v2Summary.meanNdcg10).toFixed(4)),
      recall10Delta: Number((v3Summary.meanRecall10 - v2Summary.meanRecall10).toFixed(4)),
      mrrDelta: Number((v3Summary.meanMrr - v2Summary.meanMrr).toFixed(4)),
      v3Wins,
      v2Wins,
      ties,
    };

    // Per-repo metrics
    const perRepoMetrics: Record<string, any> = {};
    const repos = Array.from(new Set(episodes.map((e) => e.repositoryId)));
    for (const r of repos) {
      const repoTasks = taskResults.filter((t) => t.repo === r);
      const rV2Ndcg10 = repoTasks.reduce((s, t) => s + t.v2.ndcg10, 0) / repoTasks.length;
      const rV3Ndcg10 = repoTasks.reduce((s, t) => s + t.v3.ndcg10, 0) / repoTasks.length;
      perRepoMetrics[r] = {
        tasks: repoTasks.length,
        v2Ndcg10: Number(rV2Ndcg10.toFixed(4)),
        v3Ndcg10: Number(rV3Ndcg10.toFixed(4)),
        ndcg10Delta: Number((rV3Ndcg10 - rV2Ndcg10).toFixed(4)),
        v3Wins: repoTasks.filter((t) => t.winner === 'V3').length,
        v2Wins: repoTasks.filter((t) => t.winner === 'V2').length,
        ties: repoTasks.filter((t) => t.winner === 'TIE').length,
      };
    }

    // Per-type metrics
    const perTypeMetrics: Record<string, any> = {};
    const types = Array.from(new Set(episodes.map((e) => e.taskType)));
    for (const ty of types) {
      const typeTasks = taskResults.filter((t) => t.taskType === ty);
      const tyV2Ndcg10 = typeTasks.reduce((s, t) => s + t.v2.ndcg10, 0) / typeTasks.length;
      const tyV3Ndcg10 = typeTasks.reduce((s, t) => s + t.v3.ndcg10, 0) / typeTasks.length;
      perTypeMetrics[ty] = {
        tasks: typeTasks.length,
        v2Ndcg10: Number(tyV2Ndcg10.toFixed(4)),
        v3Ndcg10: Number(tyV3Ndcg10.toFixed(4)),
        ndcg10Delta: Number((tyV3Ndcg10 - tyV2Ndcg10).toFixed(4)),
        v3Wins: typeTasks.filter((t) => t.winner === 'V3').length,
        v2Wins: typeTasks.filter((t) => t.winner === 'V2').length,
        ties: typeTasks.filter((t) => t.winner === 'TIE').length,
      };
    }

    // Discriminativeness audit
    const discriminativeness = {
      pathExplicitPromptRate: 0.0,
      perfectAt1RateV2: Number((v2TaskEvals.filter((t) => t.firstHitRank === 1).length / v2TaskEvals.length).toFixed(4)),
      perfectAt1RateV3: Number((v3TaskEvals.filter((t) => t.firstHitRank === 1).length / v3TaskEvals.length).toFixed(4)),
      tieRate: Number((ties / episodes.length).toFixed(4)),
      isDiscriminative: ties / episodes.length < 0.95,
    };

    // Promotion gate decision
    let gatePassed = true;
    let gateDecision: 'OFFLINE_GATE_PASSED' | 'OFFLINE_GATE_FAILED' = 'OFFLINE_GATE_PASSED';
    let rationale = '';

    if (pairedSummaryDeltas.ndcg10Delta < 0) {
      gatePassed = false;
      gateDecision = 'OFFLINE_GATE_FAILED';
      rationale = `Learned ContextRank V3 failed the final offline gate: NDCG@10 delta (${pairedSummaryDeltas.ndcg10Delta}) or win/loss ratio (${v3Wins} wins vs ${v2Wins} losses).`;
    } else if (v3Wins < v2Wins) {
      gatePassed = false;
      gateDecision = 'OFFLINE_GATE_FAILED';
      rationale = `Learned ContextRank V3 had more task losses (${v2Wins}) than wins (${v3Wins}).`;
    } else if (pairedSummaryDeltas.recall10Delta < -0.05) {
      gatePassed = false;
      gateDecision = 'OFFLINE_GATE_FAILED';
      rationale = `Recall@10 regressed significantly: delta = ${pairedSummaryDeltas.recall10Delta}.`;
    } else {
      rationale = `Learned ContextRank V3 surpassed frozen V2 baseline with delta NDCG@10 = +${pairedSummaryDeltas.ndcg10Delta} and ${v3Wins} wins vs ${v2Wins} losses.`;
    }

    const report: FinalOfflineEvaluationReport = {
      schemaVersion: 'siftrcode-final-offline-eval-v1',
      evaluatedAt: new Date().toISOString(),
      totalHoldoutTasks: episodes.length,
      candidateBudget,
      tokenBudget,
      gatePassed,
      gateDecision,
      rationale,
      provenance: {
        evaluatedAt: new Date().toISOString(),
        candidateBudget,
        tokenBudget,
        v2Provider: {
          name: 'FrozenV2ContextProvider',
          implementation: v2Provider.getImplementation(),
          baselineSha: AUTHORITATIVE_V2_SHA,
        },
        v3Provider: {
          name: 'LearnedV3ContextProvider',
          implementation: v3Provider.getImplementation(),
          modelArtifactSha256: gbdtSha256,
        },
      },
      v2Summary,
      v3Summary,
      pairedDeltas: pairedSummaryDeltas,
      discriminativeness,
      bootstrapReport,
      perRepoMetrics,
      perTypeMetrics,
      taskResults,
    };

    const reportPath = options.outputPath || path.join(finalExpDir, 'offline_evaluation.json');
    if (options.persistReport !== false) {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    }

    console.log('\n📊 ================= FINAL OFFLINE HOLDOUT REPORT =================');
    console.log(`   Gate Decision:     [ ${gateDecision} ]`);
    console.log(`   Rationale:         ${rationale}`);
    console.log('   -------------------------------------------------------------');
    console.log(`   Metric             Frozen V2       Learned V3       Delta`);
    console.log(
      `   NDCG@5:            ${v2Summary.meanNdcg5.toFixed(4)}          ${v3Summary.meanNdcg5.toFixed(4)}          ${v3Summary.meanNdcg5 - v2Summary.meanNdcg5 >= 0 ? '+' : ''}${(v3Summary.meanNdcg5 - v2Summary.meanNdcg5).toFixed(4)}`
    );
    console.log(
      `   NDCG@10:           ${v2Summary.meanNdcg10.toFixed(4)}          ${v3Summary.meanNdcg10.toFixed(4)}          ${pairedSummaryDeltas.ndcg10Delta >= 0 ? '+' : ''}${pairedSummaryDeltas.ndcg10Delta.toFixed(4)}`
    );
    console.log(
      `   Recall@10:         ${v2Summary.meanRecall10.toFixed(4)}          ${v3Summary.meanRecall10.toFixed(4)}          ${pairedSummaryDeltas.recall10Delta >= 0 ? '+' : ''}${pairedSummaryDeltas.recall10Delta.toFixed(4)}`
    );
    console.log(
      `   MRR:               ${v2Summary.meanMrr.toFixed(4)}          ${v3Summary.meanMrr.toFixed(4)}          ${pairedSummaryDeltas.mrrDelta >= 0 ? '+' : ''}${pairedSummaryDeltas.mrrDelta.toFixed(4)}`
    );
    console.log(
      `   Target Coverage:   ${(v2Summary.targetCoverage * 100).toFixed(1)}%          ${(v3Summary.targetCoverage * 100).toFixed(1)}%          ${(v3Summary.targetCoverage - v2Summary.targetCoverage) * 100 >= 0 ? '+' : ''}${((v3Summary.targetCoverage - v2Summary.targetCoverage) * 100).toFixed(1)}%`
    );
    console.log('   -------------------------------------------------------------');
    console.log(`   Task Outcomes:     ${v3Wins} V3 wins, ${ties} ties, ${v2Wins} V2 wins`);
    console.log(
      `   95% CI (NDCG@10):  [${bootstrapReport.ndcg10.ciLower95.toFixed(4)}, ${bootstrapReport.ndcg10.ciUpper95.toFixed(4)}]`
    );
    console.log('   =============================================================');
    if (options.persistReport !== false) {
      console.log(`✔ Report persisted to: ${reportPath}`);
    }

    return report;
  } finally {
    for (const tmp of tmpDirsToClean) {
      try {
        execSync(`git worktree remove --force "${tmp}" --quiet`, { stdio: 'pipe' });
      } catch {}
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
    for (const [rId, rPath] of Object.entries(repoPaths)) {
      if (rId !== 'siftrcode' && fs.existsSync(rPath)) {
        try {
          const target = initialShas[rId] || 'origin/master';
          execSync(
            `git -C "${rPath}" checkout --quiet "${target}" 2>/dev/null || git -C "${rPath}" checkout --quiet master 2>/dev/null || true`
          );
        } catch {}
      }
    }
  }
}
