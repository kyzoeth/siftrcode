/**
 * SiftrCode V3 - Feature Ablation Runner (Phase V3.1F)
 *
 * Measures the marginal contribution of proprietary SiftrCode feature channels:
 * 1. Frozen V2 deterministic baseline
 * 2. Learned model without JEV
 * 3. Learned model + JEV
 * 4. Learned model without Graph topology
 * 5. Learned model without Git intelligence
 * 6. Learned model without Runtime/test evidence
 * 7. Full structured model
 */

import { ContextFeaturesV3_1, featuresToVector } from '../features/feature_set_v3_1';
import { TreeRanker } from '../models/context_rank/tree_ranker';
import { RankingMetricsCalculator, TaskRankingEvaluation, AggregateRankingMetrics } from './ranking_metrics';
import { SiftrBenchEpisode } from '../../benchmark/siftrbench/episode_schema';

export type AblationVariant =
  | 'v2_baseline'
  | 'learned_without_jev'
  | 'learned_with_jev'
  | 'learned_without_graph'
  | 'learned_without_git'
  | 'learned_without_runtime'
  | 'learned_full_model';

export interface AblationResult {
  variant: AblationVariant;
  description: string;
  aggregate: AggregateRankingMetrics;
  ndcg10DeltaOverV2: number;
  recall10DeltaOverV2: number;
  mrrDeltaOverV2: number;
}

export interface AblationStudyReport {
  schemaVersion: 'siftrcode-ablation-study-v1';
  evaluatedAt: string;
  totalHeldOutEpisodes: number;
  results: AblationResult[];
}

export class AblationRunner {
  /**
   * Masks out specific feature subsets in a feature vector to simulate ablations.
   */
  public static maskFeatures(
    features: ContextFeaturesV3_1,
    variant: AblationVariant
  ): ContextFeaturesV3_1 {
    const f: ContextFeaturesV3_1 = { ...features };

    if (variant === 'learned_without_jev') {
      f.hasJevSignals = false;
      f.semanticRelevanceProbability = null;
      f.implementationNeededProbability = null;
      f.likelyEditTargetProbability = null;
      f.likelyRootCauseProbability = null;
    } else if (variant === 'learned_without_graph') {
      f.graphDegree = 0;
      f.minDistanceToSeed = null;
      f.minDistanceToErrorFrame = null;
      f.isDirectDependency = false;
      f.isDirectDependent = false;
    } else if (variant === 'learned_without_git') {
      f.changeFrequency = 0;
      f.recentChangeFrequency = 0;
      f.maxCoChangeWithSeeds = 0;
    } else if (variant === 'learned_without_runtime') {
      f.inStackTrace = false;
      f.isFailingTestTarget = false;
      f.inCompilerError = false;
      f.inDirtyDiff = false;
    }

    return f;
  }
}
