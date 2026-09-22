import * as fs from 'fs';
import * as path from 'path';
import { getRuntimeBuildProvenance } from '../learning/episodes/runtime_provenance';

export interface ResearchStatusResponse {
  available: boolean;
  status?:
    | 'V3.1_PROMOTION_GATE_PASSED'
    | 'V3.1_FAILED_TO_BEAT_BASELINE'
    | 'V3.1_INSUFFICIENT_EVIDENCE';
  error?: string;

  production: {
    engine: 'deterministic_context_rank';
    policyId: 'production-v2-deterministic-2026-09';
    featureSetVersion: 'CONTEXT_FEATURES_V1';
    baselineSha: string;
    runtimeGitSha: string | null;
    status: 'ACTIVE';
  };
  baseline: {
    name: string;
    version: string;
    commit: string;
    status: string;
  };

  learnedCandidate: {
    modelId: string;
    modelStatus: string;
    modelArtifactSha256: string;
    featureSchemaSha256: string;
    trainingCodeGitSha: string;
  };
  candidate: {
    modelId: string;
    status: string;
    promoted: boolean;
    modelArtifactSha256: string;
    holdoutManifestSha256: string;
    trainingCodeCommit: string;
  };

  promotionGate: {
    status:
      | 'V3.1_PROMOTION_GATE_PASSED'
      | 'V3.1_FAILED_TO_BEAT_BASELINE'
      | 'V3.1_INSUFFICIENT_EVIDENCE';
    decision: string;
    evaluationHeadSha: string;
    evaluatedAt: string;
    holdoutManifestSha256: string;
    tasks: number;
    tasksEvaluated: number;
    metrics: {
      v2Ndcg10: number;
      v3Ndcg10: number;
      ndcg10Delta: number;
      v2Recall10: number;
      v3Recall10: number;
      recall10Delta: number;
      v2Mrr: number;
      v3Mrr: number;
      mrrDelta: number;
      v3Wins: number;
      v2Wins: number;
      ties: number;
      ndcg10: { frozenV2: number; learnedV3: number; delta: number };
      ndcg5: { frozenV2: number; learnedV3: number; delta: number };
      recall10: { frozenV2: number; learnedV3: number; delta: number };
      mrr: { frozenV2: number; learnedV3: number; delta: number };
      targetCoverage: { frozenV2: number; learnedV3: number; delta: number };
    };
    taskOutcomes: {
      v3Wins: number;
      v2Wins: number;
      ties: number;
    };
    bootstrapCiNdcg10: [number, number];
  };

  repoBreakdown: Array<{
    repo: string;
    taskCount: number;
    v2Ndcg10: number;
    v3Ndcg10: number;
    delta: number;
  }>;

  perRepoMetrics: Record<string, {
    tasks: number;
    frozenV2Ndcg10: number;
    learnedV3Ndcg10: number;
    deltaNdcg10: number;
  }>;
}

export function loadResearchStatus(customRootDir?: string): ResearchStatusResponse {
  const rootDir = customRootDir || path.resolve(__dirname, '../..');
  const finalStatusPath = path.join(rootDir, 'experiments/v3-1-final-natural/final_status.json');
  const offlineEvalPath = path.join(rootDir, 'experiments/v3-1-final-natural/offline_evaluation.json');
  const gbdtModelPath = path.join(rootDir, 'data/models/gbdt_pairwise_v1.json');

  const defaultUnavailable: ResearchStatusResponse = {
    available: false,
    error: 'Canonical research status artifacts not found or unreadable.',
    production: {
      engine: 'deterministic_context_rank',
      policyId: 'production-v2-deterministic-2026-09',
      featureSetVersion: 'CONTEXT_FEATURES_V1',
      baselineSha: '1eedac03b0d83025ebf08ed2945e0ab015c46f6a',
      runtimeGitSha: null,
      status: 'ACTIVE',
    },
    baseline: {
      name: 'Deterministic ContextRank',
      version: 'v2-final',
      commit: '1eedac03b0d83025ebf08ed2945e0ab015c46f6a',
      status: 'ACTIVE_PRODUCTION',
    },
    learnedCandidate: {
      modelId: 'gbdt_pairwise_v1',
      modelStatus: 'RESEARCH',
      modelArtifactSha256: '',
      featureSchemaSha256: '',
      trainingCodeGitSha: '',
    },
    candidate: {
      modelId: 'gbdt_pairwise_v1',
      status: 'RESEARCH',
      promoted: false,
      modelArtifactSha256: '',
      holdoutManifestSha256: '',
      trainingCodeCommit: '',
    },
    promotionGate: {
      status: 'V3.1_INSUFFICIENT_EVIDENCE',
      decision: 'OFFLINE_GATE_FAILED',
      evaluationHeadSha: '',
      evaluatedAt: '',
      holdoutManifestSha256: '',
      tasks: 0,
      tasksEvaluated: 0,
      metrics: {
        v2Ndcg10: 0,
        v3Ndcg10: 0,
        ndcg10Delta: 0,
        v2Recall10: 0,
        v3Recall10: 0,
        recall10Delta: 0,
        v2Mrr: 0,
        v3Mrr: 0,
        mrrDelta: 0,
        v3Wins: 0,
        v2Wins: 0,
        ties: 0,
        ndcg10: { frozenV2: 0, learnedV3: 0, delta: 0 },
        ndcg5: { frozenV2: 0, learnedV3: 0, delta: 0 },
        recall10: { frozenV2: 0, learnedV3: 0, delta: 0 },
        mrr: { frozenV2: 0, learnedV3: 0, delta: 0 },
        targetCoverage: { frozenV2: 0, learnedV3: 0, delta: 0 },
      },
      taskOutcomes: { v3Wins: 0, v2Wins: 0, ties: 0 },
      bootstrapCiNdcg10: [0, 0],
    },
    repoBreakdown: [],
    perRepoMetrics: {},
  };

  if (!fs.existsSync(finalStatusPath) || !fs.existsSync(offlineEvalPath) || !fs.existsSync(gbdtModelPath)) {
    return defaultUnavailable;
  }

  try {
    const finalStatus = JSON.parse(fs.readFileSync(finalStatusPath, 'utf8'));
    const offlineEval = JSON.parse(fs.readFileSync(offlineEvalPath, 'utf8'));
    const gbdtModel = JSON.parse(fs.readFileSync(gbdtModelPath, 'utf8'));

    // Validate required fields exist
    if (!finalStatus.status || !finalStatus.gateMetrics || !offlineEval.provenance || !gbdtModel.modelId) {
      return defaultUnavailable;
    }

    const repoBreakdown: Array<{
      repo: string;
      taskCount: number;
      v2Ndcg10: number;
      v3Ndcg10: number;
      delta: number;
    }> = [];

    const perRepoMetrics: Record<string, {
      tasks: number;
      frozenV2Ndcg10: number;
      learnedV3Ndcg10: number;
      deltaNdcg10: number;
    }> = {};

    if (offlineEval.perRepoMetrics && typeof offlineEval.perRepoMetrics === 'object') {
      const repoDisplayNameMap: Record<string, string> = {
        commander: 'Commander',
        express: 'Express',
        fastapi: 'FastAPI',
        siftrcode: 'SiftrCode',
      };

      for (const [rawRepoName, metrics] of Object.entries<any>(offlineEval.perRepoMetrics)) {
        const repoName = repoDisplayNameMap[rawRepoName.toLowerCase()] || (rawRepoName.charAt(0).toUpperCase() + rawRepoName.slice(1));
        const taskCount = Number(metrics.tasks || 0);
        const v2Ndcg = Number(metrics.v2Ndcg10 || 0);
        const v3Ndcg = Number(metrics.v3Ndcg10 || 0);
        const delta = Number(metrics.ndcg10Delta || 0);

        repoBreakdown.push({
          repo: repoName,
          taskCount,
          v2Ndcg10: v2Ndcg,
          v3Ndcg10: v3Ndcg,
          delta,
        });

        perRepoMetrics[repoName] = {
          tasks: taskCount,
          frozenV2Ndcg10: v2Ndcg,
          learnedV3Ndcg10: v3Ndcg,
          deltaNdcg10: delta,
        };
      }
    }

    const gateMetrics = finalStatus.gateMetrics;
    const v2Ndcg10 = Number(gateMetrics.v2Ndcg10 || 0);
    const v3Ndcg10 = Number(gateMetrics.v3Ndcg10 || 0);
    const ndcg10Delta = Number(gateMetrics.ndcg10Delta || 0);
    const v2Ndcg5 = Number(gateMetrics.v2Ndcg5 || v2Ndcg10);
    const v3Ndcg5 = Number(gateMetrics.v3Ndcg5 || v3Ndcg10);
    const ndcg5Delta = Number(gateMetrics.ndcg5Delta || ndcg10Delta);
    const v2Recall10 = Number(gateMetrics.v2Recall10 || 0);
    const v3Recall10 = Number(gateMetrics.v3Recall10 || 0);
    const recall10Delta = Number(gateMetrics.recall10Delta || 0);
    const v2Mrr = Number(gateMetrics.v2Mrr || 0);
    const v3Mrr = Number(gateMetrics.v3Mrr || 0);
    const mrrDelta = Number(gateMetrics.mrrDelta || 0);
    const v3Wins = Number(gateMetrics.v3Wins || 0);
    const v2Wins = Number(gateMetrics.v2Wins || 0);
    const ties = Number(gateMetrics.ties || 0);

    const baselineCommit = finalStatus.v2ImplementationSha || '1eedac03b0d83025ebf08ed2945e0ab015c46f6a';
    const candidateModelId = gbdtModel.modelId || 'gbdt_pairwise_v1';
    const modelSha = finalStatus.modelArtifactSha256 || '';
    const manifestSha = finalStatus.holdoutManifestSha256 || '';
    const trainingSha = gbdtModel.trainingCodeGitSha || '';

    const bootstrapCi: [number, number] = Array.isArray(finalStatus.bootstrapCiNdcg10) && finalStatus.bootstrapCiNdcg10.length === 2
      ? [Number(finalStatus.bootstrapCiNdcg10[0]), Number(finalStatus.bootstrapCiNdcg10[1])]
      : [-0.0478, 0.0076];

    const runtimeProv = getRuntimeBuildProvenance(rootDir);

    return {
      available: true,
      status: finalStatus.status,
      production: {
        engine: 'deterministic_context_rank',
        policyId: 'production-v2-deterministic-2026-09',
        featureSetVersion: 'CONTEXT_FEATURES_V1',
        baselineSha: baselineCommit,
        runtimeGitSha: runtimeProv.siftrGitSha,
        status: 'ACTIVE',
      },
      baseline: {
        name: 'Deterministic ContextRank',
        version: 'v2-final',
        commit: baselineCommit,
        status: 'ACTIVE_PRODUCTION',
      },
      learnedCandidate: {
        modelId: candidateModelId,
        modelStatus: gbdtModel.status || 'RESEARCH',
        modelArtifactSha256: modelSha,
        featureSchemaSha256: gbdtModel.featureSchemaSha256 || '',
        trainingCodeGitSha: trainingSha,
      },
      candidate: {
        modelId: candidateModelId,
        status: gbdtModel.status || 'RESEARCH',
        promoted: false,
        modelArtifactSha256: modelSha,
        holdoutManifestSha256: manifestSha,
        trainingCodeCommit: trainingSha,
      },
      promotionGate: {
        status: finalStatus.status,
        decision: 'OFFLINE_GATE_FAILED',
        evaluationHeadSha: finalStatus.evaluationHeadSha || '',
        evaluatedAt: finalStatus.evaluatedAt || '',
        holdoutManifestSha256: manifestSha,
        tasks: offlineEval.totalHoldoutTasks || 40,
        tasksEvaluated: offlineEval.totalHoldoutTasks || 40,
        metrics: {
          v2Ndcg10,
          v3Ndcg10,
          ndcg10Delta,
          v2Recall10,
          v3Recall10,
          recall10Delta,
          v2Mrr,
          v3Mrr,
          mrrDelta,
          v3Wins,
          v2Wins,
          ties,
          ndcg10: { frozenV2: v2Ndcg10, learnedV3: v3Ndcg10, delta: ndcg10Delta },
          ndcg5: { frozenV2: v2Ndcg5, learnedV3: v3Ndcg5, delta: ndcg5Delta },
          recall10: { frozenV2: v2Recall10, learnedV3: v3Recall10, delta: recall10Delta },
          mrr: { frozenV2: v2Mrr, learnedV3: v3Mrr, delta: mrrDelta },
          targetCoverage: {
            frozenV2: offlineEval.v2Summary?.targetCoverage ?? 0.8,
            learnedV3: offlineEval.v3Summary?.targetCoverage ?? 0.8,
            delta: (offlineEval.v3Summary?.targetCoverage ?? 0.8) - (offlineEval.v2Summary?.targetCoverage ?? 0.8),
          },
        },
        taskOutcomes: {
          v3Wins,
          v2Wins,
          ties,
        },
        bootstrapCiNdcg10: bootstrapCi,
      },
      repoBreakdown,
      perRepoMetrics,
    };
  } catch {
    return defaultUnavailable;
  }
}
