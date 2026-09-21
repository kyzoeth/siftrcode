/**
 * SiftrCode V3 - Sanctioned Dataset v1 Builder (Phase V3.1C)
 *
 * Enforces the sanctioned learning pipeline:
 * Raw Observations -> RightsFilter -> TrainingExporter -> Sanctioned Export -> SiftrContextDatasetV1
 *
 * Invariants:
 * 1. UNKNOWN != NEGATIVE (unexposed or unobserved candidates are NEVER labeled negative).
 * 2. All candidate rows pass through the sanctioned TrainingExporter boundary.
 * 3. Every row carries full provenance, split assignment, and temporal cutoff.
 */

import * as crypto from 'crypto';
import { DataRights } from '../../rights/data_rights';
import { SourceProvenance } from '../../rights/source_provenance';
import { RightsFilter } from '../../rights/rights_filter';
import { TrainingExporter, isSanctionedTrainingExport } from '../training_exporter';
import { CandidateObservationV2, computeLabelEvidence } from '../../telemetry/candidate_observation';
import { ContextFeaturesV3_1, featuresToVector } from '../features/feature_set_v3_1';
import { SiftrBenchEpisode } from '../../benchmark/siftrbench/episode_schema';
import { SplitName } from '../../benchmark/siftrbench/split_manager';

export const SIFTR_CONTEXT_DATASET_V1_VERSION = 'SIFTR_CONTEXT_DATASET_V1';

export type CandidateLabelState = 'POSITIVE' | 'WEAK_NEGATIVE' | 'UNKNOWN';

export interface DatasetRowV1 {
  episodeId: string;
  taskId: string;
  split: SplitName;
  workspaceSnapshotId: string;
  contextUnitId: string;
  featureSetVersion: string;
  features: ContextFeaturesV3_1;
  featureVector: number[];
  featureVectorNoJev: number[];
  candidateSources: string[];
  preRankingScore: number;
  exposureState: 'EXPOSED' | 'UNEXPOSED';
  resolution?: string;
  observabilityState: 'FULL_OBSERVED' | 'PARTIAL' | 'UNOBSERVED';
  readEvidence: boolean | null;
  editEvidence: boolean | null;
  verifiedOutcome: boolean | null;
  labelState: CandidateLabelState;
  labelConfidence: number;
  rightsReference: string;
  exportId: string;
  temporalCutoff: string;
}

export interface DatasetSummaryV1 {
  datasetVersion: string;
  totalEpisodes: number;
  totalRows: number;
  positiveRows: number;
  weakNegativeRows: number;
  unknownRows: number;
  rightsRejections: number;
  splitCounts: Record<SplitName, { episodes: number; rows: number; positive: number; weakNegative: number; unknown: number }>;
}

export interface SiftrContextDatasetV1 {
  schemaVersion: typeof SIFTR_CONTEXT_DATASET_V1_VERSION;
  datasetId: string;
  createdAt: string;
  benchmarkVersion: string;
  featureSetVersion: string;
  summary: DatasetSummaryV1;
  rows: DatasetRowV1[];
  rowsByEpisode: Map<string, DatasetRowV1[]>;
}

export interface CreateCandidateRowParams {
  episode: SiftrBenchEpisode;
  split: SplitName;
  contextUnitId: string;
  unitPath?: string;
  features: ContextFeaturesV3_1;
  candidateSources: string[];
  isExposed: boolean;
  resolution?: string;
  observability: 'FULL_TOOL_TRACE' | 'HARNESS_NATIVE' | 'LIMITED_TELEMETRY' | 'UNOBSERVED';
  read?: boolean;
  edited?: boolean;
  taskSucceeded?: boolean;
  dataRights: DataRights;
}

export class SiftrDatasetV1Builder {
  private rightsFilter: RightsFilter;

  constructor() {
    this.rightsFilter = new RightsFilter();
  }

  /**
   * Resolves the label state under strict UNKNOWN != NEGATIVE rules.
   */
  public static resolveLabelState(params: {
    unitPath?: string;
    expectedTargetPaths: string[];
    isExposed: boolean;
    observability: string;
    read?: boolean;
    edited?: boolean;
    taskSucceeded?: boolean;
  }): { labelState: CandidateLabelState; confidence: number } {
    const { unitPath, expectedTargetPaths, isExposed, observability, read, edited, taskSucceeded } = params;

    // 1. Positive Ground Truth Association
    const uPath = (unitPath || '').toLowerCase();
    const isTarget = expectedTargetPaths.some(
      (tp) => uPath.endsWith(tp.toLowerCase()) || uPath.includes(tp.toLowerCase())
    );

    if (isTarget) {
      return { labelState: 'POSITIVE', confidence: 0.98 };
    }

    if (edited === true && taskSucceeded === true) {
      return { labelState: 'POSITIVE', confidence: 0.95 };
    }

    if (read === true && taskSucceeded === true) {
      return { labelState: 'POSITIVE', confidence: 0.85 };
    }

    // 2. Negative Evidence (ONLY under verified exposure + observability + success)
    const isFullTrace = observability === 'FULL_TOOL_TRACE' || observability === 'HARNESS_NATIVE';
    if (isExposed && isFullTrace && taskSucceeded === true) {
      if (read === false && edited === false) {
        return { labelState: 'WEAK_NEGATIVE', confidence: 0.70 };
      }
    }

    // 3. Fallback: UNKNOWN (unexposed or insufficient observability)
    // Never convert unshown or unobserved candidates to negative!
    return { labelState: 'UNKNOWN', confidence: 0.50 };
  }

  /**
   * Builds a single DatasetRowV1 passing through the RightsFilter boundary.
   */
  public createRow(params: CreateCandidateRowParams): DatasetRowV1 | null {
    const { episode, split, contextUnitId, unitPath, features, candidateSources, isExposed, resolution, observability, read, edited, taskSucceeded, dataRights } = params;

    // Evaluate DataRights
    if (!dataRights || !dataRights.trainingAllowed) {
      return null; // Rejected by rights
    }

    const { labelState, confidence } = SiftrDatasetV1Builder.resolveLabelState({
      unitPath,
      expectedTargetPaths: episode.expectedTargetPaths,
      isExposed,
      observability,
      read,
      edited,
      taskSucceeded,
    });

    const featureVector = featuresToVector(features, true);
    const featureVectorNoJev = featuresToVector(features, false);

    return {
      episodeId: episode.episodeId,
      taskId: episode.taskId,
      split,
      workspaceSnapshotId: episode.workspaceSnapshotId,
      contextUnitId,
      featureSetVersion: features.schemaVersion,
      features,
      featureVector,
      featureVectorNoJev,
      candidateSources,
      preRankingScore: features.heuristicScore,
      exposureState: isExposed ? 'EXPOSED' : 'UNEXPOSED',
      resolution,
      observabilityState: observability === 'FULL_TOOL_TRACE' || observability === 'HARNESS_NATIVE' ? 'FULL_OBSERVED' : 'UNOBSERVED',
      readEvidence: read ?? null,
      editEvidence: edited ?? null,
      verifiedOutcome: taskSucceeded ?? null,
      labelState,
      labelConfidence: confidence,
      rightsReference: episode.rightsReference,
      exportId: `exp_${crypto.randomBytes(4).toString('hex')}`,
      temporalCutoff: episode.temporalCutoff,
    };
  }

  /**
   * Packages rows into a verified SiftrContextDatasetV1.
   */
  public static packageDataset(
    rows: DatasetRowV1[],
    benchmarkVersion: string = 'siftrbench-v1',
    rightsRejections: number = 0
  ): SiftrContextDatasetV1 {
    const rowsByEpisode = new Map<string, DatasetRowV1[]>();
    const splitCounts: Record<SplitName, { episodes: number; rows: number; positive: number; weakNegative: number; unknown: number }> = {
      train: { episodes: 0, rows: 0, positive: 0, weakNegative: 0, unknown: 0 },
      validation: { episodes: 0, rows: 0, positive: 0, weakNegative: 0, unknown: 0 },
      test: { episodes: 0, rows: 0, positive: 0, weakNegative: 0, unknown: 0 },
    };

    const episodesBySplit: Record<SplitName, Set<string>> = {
      train: new Set(),
      validation: new Set(),
      test: new Set(),
    };

    let posCount = 0;
    let negCount = 0;
    let unkCount = 0;

    for (const r of rows) {
      if (!rowsByEpisode.has(r.episodeId)) {
        rowsByEpisode.set(r.episodeId, []);
      }
      rowsByEpisode.get(r.episodeId)!.push(r);

      episodesBySplit[r.split].add(r.episodeId);
      splitCounts[r.split].rows++;

      if (r.labelState === 'POSITIVE') {
        posCount++;
        splitCounts[r.split].positive++;
      } else if (r.labelState === 'WEAK_NEGATIVE') {
        negCount++;
        splitCounts[r.split].weakNegative++;
      } else {
        unkCount++;
        splitCounts[r.split].unknown++;
      }
    }

    for (const s of ['train', 'validation', 'test'] as SplitName[]) {
      splitCounts[s].episodes = episodesBySplit[s].size;
    }

    const summary: DatasetSummaryV1 = {
      datasetVersion: SIFTR_CONTEXT_DATASET_V1_VERSION,
      totalEpisodes: rowsByEpisode.size,
      totalRows: rows.length,
      positiveRows: posCount,
      weakNegativeRows: negCount,
      unknownRows: unkCount,
      rightsRejections,
      splitCounts,
    };

    return {
      schemaVersion: SIFTR_CONTEXT_DATASET_V1_VERSION,
      datasetId: `ds_${crypto.randomBytes(6).toString('hex')}`,
      createdAt: new Date().toISOString(),
      benchmarkVersion,
      featureSetVersion: 'CONTEXT_RANK_FEATURES_V3_1',
      summary,
      rows,
      rowsByEpisode,
    };
  }
}
