import * as fs from 'fs';
import * as path from 'path';

export interface ResearchStatusResponse {
  available: boolean;

  production: {
    engine: 'deterministic_context_rank';
    baselineSha: string;
    status: 'ACTIVE';
  };

  learnedCandidate: {
    modelId: string;
    modelStatus: string;
    modelArtifactSha256: string;
    featureSchemaSha256: string;
    trainingCodeGitSha: string;
  };

  promotionGate: {
    status:
      | 'V3.1_PROMOTION_GATE_PASSED'
      | 'V3.1_FAILED_TO_BEAT_BASELINE'
      | 'V3.1_INSUFFICIENT_EVIDENCE';

    evaluationHeadSha: string;
    evaluatedAt: string;
    holdoutManifestSha256: string;

    tasks: number;

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
    };
  };

  repoBreakdown: Array<{
    repo: string;
    taskCount: number;
    v2Ndcg10: number;
    v3Ndcg10: number;
    delta: number;
  }>;
}

export function loadResearchStatus(customRootDir?: string): ResearchStatusResponse {
  const rootDir = customRootDir || path.resolve(__dirname, '../..');
  const finalStatusPath = path.join(rootDir, 'experiments/v3-1-final-natural/final_status.json');
  const offlineEvalPath = path.join(rootDir, 'experiments/v3-1-final-natural/offline_evaluation.json');
  const gbdtModelPath = path.join(rootDir, 'data/models/gbdt_pairwise_v1.json');

  const defaultUnavailable: ResearchStatusResponse = {
    available: false,
    production: {
      engine: 'deterministic_context_rank',
      baselineSha: '1eedac03b0d83025ebf08ed2945e0ab015c46f6a',
      status: 'ACTIVE',
    },
    learnedCandidate: {
      modelId: 'gbdt_pairwise_v1',
      modelStatus: 'RESEARCH',
      modelArtifactSha256: '',
      featureSchemaSha256: '',
      trainingCodeGitSha: '',
    },
    promotionGate: {
      status: 'V3.1_INSUFFICIENT_EVIDENCE',
      evaluationHeadSha: '',
      evaluatedAt: '',
      holdoutManifestSha256: '',
      tasks: 0,
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
      },
    },
    repoBreakdown: [],
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

    if (offlineEval.perRepoMetrics && typeof offlineEval.perRepoMetrics === 'object') {
      for (const [repoName, metrics] of Object.entries<any>(offlineEval.perRepoMetrics)) {
        repoBreakdown.push({
          repo: repoName,
          taskCount: Number(metrics.tasks || 0),
          v2Ndcg10: Number(metrics.v2Ndcg10 || 0),
          v3Ndcg10: Number(metrics.v3Ndcg10 || 0),
          delta: Number(metrics.ndcg10Delta || 0),
        });
      }
    }

    return {
      available: true,
      production: {
        engine: 'deterministic_context_rank',
        baselineSha: finalStatus.v2ImplementationSha || '1eedac03b0d83025ebf08ed2945e0ab015c46f6a',
        status: 'ACTIVE',
      },
      learnedCandidate: {
        modelId: gbdtModel.modelId || 'gbdt_pairwise_v1',
        modelStatus: gbdtModel.status || 'RESEARCH',
        modelArtifactSha256: finalStatus.modelArtifactSha256 || '',
        featureSchemaSha256: gbdtModel.featureSchemaSha256 || '',
        trainingCodeGitSha: gbdtModel.trainingCodeGitSha || '',
      },
      promotionGate: {
        status: finalStatus.status,
        evaluationHeadSha: finalStatus.evaluationHeadSha || '',
        evaluatedAt: finalStatus.evaluatedAt || '',
        holdoutManifestSha256: finalStatus.holdoutManifestSha256 || '',
        tasks: offlineEval.totalHoldoutTasks || 40,
        metrics: {
          v2Ndcg10: Number(finalStatus.gateMetrics.v2Ndcg10 || 0),
          v3Ndcg10: Number(finalStatus.gateMetrics.v3Ndcg10 || 0),
          ndcg10Delta: Number(finalStatus.gateMetrics.ndcg10Delta || 0),
          v2Recall10: Number(finalStatus.gateMetrics.v2Recall10 || 0),
          v3Recall10: Number(finalStatus.gateMetrics.v3Recall10 || 0),
          recall10Delta: Number(finalStatus.gateMetrics.recall10Delta || 0),
          v2Mrr: Number(finalStatus.gateMetrics.v2Mrr || 0),
          v3Mrr: Number(finalStatus.gateMetrics.v3Mrr || 0),
          mrrDelta: Number(finalStatus.gateMetrics.mrrDelta || 0),
          v3Wins: Number(finalStatus.gateMetrics.v3Wins || 0),
          v2Wins: Number(finalStatus.gateMetrics.v2Wins || 0),
          ties: Number(finalStatus.gateMetrics.ties || 0),
        },
      },
      repoBreakdown,
    };
  } catch {
    return defaultUnavailable;
  }
}
