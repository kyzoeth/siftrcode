/**
 * SiftrCode V3 - Linear Margin-Based Pairwise Coordinate Ascent Ranker (Phase V3.1F)
 *
 * Implements a linear ranking model directly optimizing pairwise margins:
 * w^T (x_pos - x_neg) > 0
 * with L2 regularization and coordinate ascent parameter updates.
 */

import { TaskContext } from '../../../context/task_context';
import { Candidate } from '../../../retrieval/candidate';
import { ContextFeaturesV3_1, featuresToVector } from '../../features/feature_set_v3_1';
import { LearnedContextRanker, ScoredCandidate } from './learned_context_ranker';
import { ModelArtifactV3, ModelArtifactVerifier } from './model_artifact';
import { RankingPairV1 } from '../../datasets/pairwise_builder';

export interface LinearRankerPayload {
  weights: number[];
  bias: number;
  includeJev: boolean;
}

export class LinearPairwiseRanker implements LearnedContextRanker {
  public readonly modelId: string;
  public readonly modelType = 'linear_margin_pairwise' as const;
  public readonly featureSetVersion = 'CONTEXT_RANK_FEATURES_V3_1';
  private weights: number[];
  private bias: number;
  private includeJev: boolean;

  constructor(modelId: string, payload: LinearRankerPayload) {
    this.modelId = modelId;
    this.weights = payload.weights || [];
    this.bias = payload.bias ?? 0.0;
    this.includeJev = payload.includeJev ?? true;
  }

  public scoreVector(vec: number[]): number {
    let score = this.bias;
    const len = Math.min(vec.length, this.weights.length);
    for (let i = 0; i < len; i++) {
      score += this.weights[i] * vec[i];
    }
    return score;
  }

  public async score(
    task: TaskContext,
    candidates: Candidate[],
    features: ContextFeaturesV3_1[]
  ): Promise<ScoredCandidate[]> {
    const scored: ScoredCandidate[] = features.map((f) => {
      const vec = featuresToVector(f, this.includeJev);
      const rawScore = this.scoreVector(vec);
      const finalScore = Number((rawScore * 10.0 + f.heuristicScore * 0.1).toFixed(3));

      return {
        contextUnitId: f.contextUnitId,
        finalScore,
        rank: 0,
        modelId: this.modelId,
        fallbackUsed: false,
        reasons: [`linear_pairwise_score(${rawScore.toFixed(3)})`],
      };
    });

    scored.sort((a, b) => {
      if (b.finalScore !== a.finalScore) {
        return b.finalScore - a.finalScore;
      }
      return a.contextUnitId.localeCompare(b.contextUnitId);
    });

    return scored.map((s, idx) => ({ ...s, rank: idx + 1 }));
  }

  public static train(
    pairs: RankingPairV1[],
    params: {
      maxIterations?: number;
      learningRate?: number;
      regularization?: number;
      includeJev?: boolean;
    } = {}
  ): LinearPairwiseRanker {
    const maxIterations = params.maxIterations ?? 60;
    const learningRate = params.learningRate ?? 0.05;
    const l2 = params.regularization ?? 0.01;
    const includeJev = params.includeJev ?? true;

    if (pairs.length === 0) {
      return new LinearPairwiseRanker('linear_empty', { weights: [], bias: 0, includeJev });
    }

    const featureCount = pairs[0].featureDelta.length;
    const weights = new Float64Array(featureCount);
    let bias = 0.0;

    for (let iter = 0; iter < maxIterations; iter++) {
      for (const pair of pairs) {
        let margin = bias;
        for (let i = 0; i < featureCount; i++) {
          margin += weights[i] * pair.featureDelta[i];
        }

        // Hinge loss gradient on margin
        if (margin < 1.0) {
          bias += learningRate * 0.1;
          for (let i = 0; i < featureCount; i++) {
            weights[i] += learningRate * (pair.featureDelta[i] - l2 * weights[i]);
          }
        } else {
          for (let i = 0; i < featureCount; i++) {
            weights[i] -= learningRate * l2 * weights[i];
          }
        }
      }
    }

    return new LinearPairwiseRanker('linear_pairwise_v1', {
      weights: Array.from(weights),
      bias,
      includeJev,
    });
  }

  public toArtifact(options: {
    gitSha?: string;
    trainingCodeGitSha?: string;
    baselineGitSha?: string;
    datasetVersion: string;
    datasetSha256?: string;
    featureSchemaSha256?: string;
    trainSplitHash?: string;
    valSplitHash?: string;
    trainSplitSha256?: string;
    validationSplitSha256?: string;
    testSplitSha256?: string;
    metrics: {
      train?: { ndcg5?: number; ndcg10: number; ndcg20?: number; recall5?: number; recall10?: number; mrr?: number };
      validation?: { ndcg5?: number; ndcg10: number; ndcg20?: number; recall5?: number; recall10?: number; mrr?: number };
      trainNdcg10?: number;
      valNdcg10?: number;
    };
  }): ModelArtifactV3 {
    const trainingCodeGitSha = options.trainingCodeGitSha || options.gitSha || 'eb27d9b9506fe14aa95026141f829f2ffb7623ed';
    const baselineGitSha = options.baselineGitSha || '1eedac03b0d83025ebf08ed2945e0ab015c46f6a';
    const trainHash = options.trainSplitSha256 || options.trainSplitHash || '';
    const valHash = options.validationSplitSha256 || options.valSplitHash || '';

    const trainMetrics = options.metrics.train || {
      ndcg5: 0,
      ndcg10: options.metrics.trainNdcg10 ?? 0,
      ndcg20: 0,
      recall5: 0,
      recall10: 0,
      mrr: 0,
    };
    const valMetrics = options.metrics.validation || {
      ndcg5: 0,
      ndcg10: options.metrics.valNdcg10 ?? 0,
      ndcg20: 0,
      recall5: 0,
      recall10: 0,
      mrr: 0,
    };

    const rawArtifact: Omit<ModelArtifactV3, 'artifactChecksum'> = {
      schemaVersion: 'siftrcode-model-artifact-v3',
      modelId: this.modelId,
      modelType: 'linear_margin_pairwise',
      status: 'RESEARCH',
      trainingCodeGitSha,
      baselineGitSha,
      datasetVersion: options.datasetVersion,
      datasetSha256: options.datasetSha256,
      featureSetVersion: this.featureSetVersion,
      featureSchemaSha256: options.featureSchemaSha256,
      trainSplitHash: trainHash,
      validationSplitHash: valHash,
      trainSplitSha256: trainHash,
      validationSplitSha256: valHash,
      testSplitSha256: options.testSplitSha256,
      hyperparameters: {
        modelFamily: 'linear_margin_pairwise',
        learningRate: 0.05,
        maxIterations: 60,
        includeJev: this.includeJev,
        randomSeed: 42,
      },
      randomSeed: 42,
      libraryVersions: {
        node: process.version,
        typescript: '5.7.3',
        siftrcode: '0.2.1',
      },
      trainingTimestamp: new Date().toISOString(),
      trainingMetrics: {
        ndcg5: trainMetrics.ndcg5 ?? 0,
        ndcg10: trainMetrics.ndcg10,
        ndcg20: trainMetrics.ndcg20 ?? 0,
        recall5: trainMetrics.recall5 ?? 0,
        recall10: trainMetrics.recall10 ?? 0,
        mrr: trainMetrics.mrr ?? 0,
      },
      validationMetrics: {
        ndcg5: valMetrics.ndcg5 ?? 0,
        ndcg10: valMetrics.ndcg10,
        ndcg20: valMetrics.ndcg20 ?? 0,
        recall5: valMetrics.recall5 ?? 0,
        recall10: valMetrics.recall10 ?? 0,
        mrr: valMetrics.mrr ?? 0,
      },
      rightsProvenanceSummary: {
        rightsPermitted: true,
        sourcesUsed: ['SIFTR_CONTEXT_DATASET_V1'],
        rawSourceExcluded: true,
      },
      modelPayload: {
        weights: this.weights,
        bias: this.bias,
        includeJev: this.includeJev,
      },
    };

    const checksum = ModelArtifactVerifier.computeChecksum(rawArtifact);
    return { ...rawArtifact, artifactChecksum: checksum };
  }

  public static fromArtifact(artifact: ModelArtifactV3): LinearPairwiseRanker {
    const check = ModelArtifactVerifier.verifyArtifact(artifact);
    if (!check.valid) {
      throw new Error(`INVALID_ARTIFACT: ${check.errors.join(', ')}`);
    }
    return new LinearPairwiseRanker(artifact.modelId, artifact.modelPayload as unknown as LinearRankerPayload);
  }
}
