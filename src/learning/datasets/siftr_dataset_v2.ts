/**
 * SiftrCode V2 - SiftrContextDatasetV2 (Phase 20J)
 *
 * Dataset export contract for SIFTR_CONTEXT_DATASET_V2.
 * Invariant:
 * 1. UNKNOWN != NEGATIVE (unselected/unexposed candidates are NEVER labeled negative).
 * 2. Supervision signals are explicitly decoupled (wasRead, wasEdited, wasInSuccessfulTask, etc.).
 * 3. Never collapse multi-dimensional behavior prematurely into binary labels.
 * 4. Point-in-time safety: no future git commits, diffs, or post-task evidence in pre-task features.
 * 5. NO model training from V2 dataset in Phase 20.
 */

import { ContextExposureState } from '../episodes/context_exposure';
import { VerificationConfidence } from '../outcome/task_outcome';
import { TaskEconomicsV1 } from '../economics/task_economics';

export const SIFTR_CONTEXT_DATASET_V2_VERSION = 'SIFTR_CONTEXT_DATASET_V2';

export interface SiftrContextDatasetV2Row {
  rowId: string;
  exportId: string;
  episodeId: string;
  taskIdentityHash: string;
  repositoryFamily: string;
  taskType: string;
  contextUnitId: string;
  unitPath?: string;
  candidateRetrievalProvenance: string[];
  candidateFeatureVector: Record<string, number | boolean | null>;
  preRankPosition?: number;
  finalRank: number;
  finalScore: number;
  exposureState: ContextExposureState;
  wasSelected: boolean;
  wasShown: boolean;
  wasRead: boolean;
  wasEdited: boolean;
  wasInSuccessfulTask: boolean;
  wasInFailedTask: boolean;
  verifiedSuccess: boolean | null;
  outcomeConfidence: VerificationConfidence;
  verifiedTargetEvidence: boolean;
  humanRelevanceLabel?: 'RELEVANT' | 'IRRELEVANT' | 'UNKNOWN';
  contextTokens: number;
  taskEconomics?: TaskEconomicsV1;
  rightsReference: string;
  exportedAt: string;
}

export interface SiftrContextDatasetV2Summary {
  datasetVersion: typeof SIFTR_CONTEXT_DATASET_V2_VERSION;
  exportId: string;
  exportedAt: string;
  totalEpisodes: number;
  totalCandidateRows: number;
  selectedUnitsCount: number;
  shownUnitsCount: number;
  readUnitsCount: number;
  editedUnitsCount: number;
  verifiedSuccessTasksCount: number;
  verifiedFailedTasksCount: number;
  unknownOutcomeTasksCount: number;
  repositoryDistribution: Record<string, number>;
  taskTypeDistribution: Record<string, number>;
}

export interface DatasetV2ExportResult {
  exportId: string;
  datasetVersion: typeof SIFTR_CONTEXT_DATASET_V2_VERSION;
  rows: SiftrContextDatasetV2Row[];
  summary: SiftrContextDatasetV2Summary;
  totalEpisodesEvaluated: number;
  totalEpisodesAccepted: number;
  totalEpisodesRejected: number;
  rejections: Array<{ episodeId: string; reasons: string[] }>;
  exportedAt: string;
}

export type SanctionedDatasetV2Export = DatasetV2ExportResult & {
  readonly [key: symbol]: true | undefined;
};
