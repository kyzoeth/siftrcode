/**
 * SiftrCode V3 - Pairwise Ranking Example Builder (Phase V3.1C)
 *
 * Generates within-task pairwise ranking examples:
 * Positive ContextUnit > Observed Weak-Negative ContextUnit
 *
 * Invariants:
 * 1. Ranking pairs are strictly generated WITHIN the same task episode.
 * 2. Never generate cross-task pairs (candidates from different tasks are non-comparable).
 * 3. UNKNOWN candidates are excluded from pairwise comparisons (UNKNOWN != NEGATIVE).
 */

import { DatasetRowV1, SiftrContextDatasetV1 } from './siftr_dataset_v1';
import { SplitName } from '../../benchmark/siftrbench/split_manager';

export interface RankingPairV1 {
  episodeId: string;
  taskId: string;
  split: SplitName;
  positiveUnitId: string;
  negativeUnitId: string;
  pairType?: 'TARGET_VS_WEAK_NEGATIVE' | 'TARGET_VS_NON_TARGET';
  positiveFeatures: number[];
  negativeFeatures: number[];
  featureDelta: number[]; // x_pos - x_neg
  weight: number;
}

export interface PairwiseGenerationReport {
  policyVersion: 'within_task_pos_gt_weakneg_v1';
  totalTasksWithPairs: number;
  totalPairsGenerated: number;
  pairsPerSplit: Record<SplitName, number>;
  positiveRowsUsed: number;
  weakNegativeRowsUsed: number;
  benchmarkPositivesUsed: number;
  benchmarkNonTargetsUsed: number;
  behavioralWeakNegativesUsed: number;
  unknownRowsExcluded: number;
  meanPairsPerTask: number;
}

export interface PairwiseDatasetV1 {
  schemaVersion: 'pairwise-ranking-dataset-v1';
  createdAt: string;
  report: PairwiseGenerationReport;
  pairs: RankingPairV1[];
  pairsBySplit: Record<SplitName, RankingPairV1[]>;
}

export class PairwiseBuilder {
  /**
   * Generates strictly within-task pairwise ranking instances.
   */
  public static buildPairs(
    dataset: SiftrContextDatasetV1,
    options: { includeJev?: boolean; maxPairsPerTask?: number } = {}
  ): PairwiseDatasetV1 {
    const includeJev = options.includeJev ?? true;
    const maxPairsPerTask = options.maxPairsPerTask ?? 200;

    const pairs: RankingPairV1[] = [];
    const pairsBySplit: Record<SplitName, RankingPairV1[]> = {
      train: [],
      validation: [],
      test: [],
    };

    let positiveRowsUsed = 0;
    let weakNegativeRowsUsed = 0;
    let benchmarkPositivesUsed = 0;
    let benchmarkNonTargetsUsed = 0;
    let behavioralWeakNegativesUsed = 0;
    let unknownRowsExcluded = 0;
    let tasksWithPairsCount = 0;

    for (const [episodeId, rows] of dataset.rowsByEpisode.entries()) {
      const positives: DatasetRowV1[] = [];
      const negatives: DatasetRowV1[] = [];

      for (const r of rows) {
        const isPos = r.labelState === 'POSITIVE' || r.benchmarkRelevanceLabel === 'TARGET';
        const isWeakNeg = r.labelState === 'WEAK_NEGATIVE';
        const isExposedNonTarget = r.benchmarkRelevanceLabel === 'NON_TARGET' && r.exposureState === 'EXPOSED';

        if (isPos) {
          positives.push(r);
          benchmarkPositivesUsed++;
        } else if (isWeakNeg || isExposedNonTarget) {
          negatives.push(r);
          if (isWeakNeg) behavioralWeakNegativesUsed++;
          if (isExposedNonTarget) benchmarkNonTargetsUsed++;
        } else {
          unknownRowsExcluded++;
        }
      }

      if (positives.length === 0 || negatives.length === 0) {
        continue;
      }

      tasksWithPairsCount++;
      positiveRowsUsed += positives.length;
      weakNegativeRowsUsed += negatives.length;

      let taskPairCount = 0;
      for (const pos of positives) {
        const pVec = includeJev ? pos.featureVector : pos.featureVectorNoJev;

        for (const neg of negatives) {
          if (taskPairCount >= maxPairsPerTask) break;

          const nVec = includeJev ? neg.featureVector : neg.featureVectorNoJev;
          const delta: number[] = new Array(pVec.length);
          for (let i = 0; i < pVec.length; i++) {
            delta[i] = pVec[i] - nVec[i];
          }

          const pairType = neg.labelState === 'WEAK_NEGATIVE'
            ? 'TARGET_VS_WEAK_NEGATIVE'
            : 'TARGET_VS_NON_TARGET';

          const pair: RankingPairV1 = {
            episodeId,
            taskId: pos.taskId,
            split: pos.split,
            positiveUnitId: pos.contextUnitId,
            negativeUnitId: neg.contextUnitId,
            pairType,
            positiveFeatures: pVec,
            negativeFeatures: nVec,
            featureDelta: delta,
            weight: 1.0,
          };

          pairs.push(pair);
          pairsBySplit[pos.split].push(pair);
          taskPairCount++;
        }
        if (taskPairCount >= maxPairsPerTask) break;
      }
    }

    const report: PairwiseGenerationReport = {
      policyVersion: 'within_task_pos_gt_weakneg_v1',
      totalTasksWithPairs: tasksWithPairsCount,
      totalPairsGenerated: pairs.length,
      pairsPerSplit: {
        train: pairsBySplit.train.length,
        validation: pairsBySplit.validation.length,
        test: pairsBySplit.test.length,
      },
      positiveRowsUsed,
      weakNegativeRowsUsed,
      benchmarkPositivesUsed,
      benchmarkNonTargetsUsed,
      behavioralWeakNegativesUsed,
      unknownRowsExcluded,
      meanPairsPerTask: tasksWithPairsCount > 0 ? Math.round(pairs.length / tasksWithPairsCount) : 0,
    };

    return {
      schemaVersion: 'pairwise-ranking-dataset-v1',
      createdAt: new Date().toISOString(),
      report,
      pairs,
      pairsBySplit,
    };
  }
}
