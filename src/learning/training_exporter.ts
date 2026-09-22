/**
 * SiftrCode V2 - Training Exporter (Section 50 & 52)
 *
 * Implements the mandatory export boundary pipeline:
 * Raw Observation Store
 *         ↓
 *   Rights Filter
 *         ↓
 *  Training Export
 *
 * Invariants:
 * 1. No training dataset builder can operate directly on raw tables.
 * 2. If trainingAllowed = false, observation CANNOT enter training export.
 * 3. Every training row records full DerivedDataLineage.
 */

import { CandidateObservationV2 } from '../telemetry/candidate_observation';
import { DataRights } from '../rights/data_rights';
import { SourceProvenance } from '../rights/source_provenance';
import { RightsFilter, RightsFilterConfig } from '../rights/rights_filter';
import { TrainingRow, createTrainingRow, TrainingEvidenceRecord } from './lineage';
import { TaskEpisodeV1 } from './episodes/task_episode';
import {
  SIFTR_CONTEXT_DATASET_V2_VERSION,
  SiftrContextDatasetV2Row,
  SiftrContextDatasetV2Summary,
  SanctionedDatasetV2Export,
} from './datasets/siftr_dataset_v2';
import { resolveExposureState, ContextExposureState } from './episodes/context_exposure';
import { FORBIDDEN_PRE_OUTCOME_FIELDS } from './episodes/pre_outcome_snapshot';

export {
  SIFTR_CONTEXT_DATASET_V2_VERSION,
  SiftrContextDatasetV2Row,
  SiftrContextDatasetV2Summary,
  SanctionedDatasetV2Export,
} from './datasets/siftr_dataset_v2';

const SANCTIONED_BRAND = Symbol('SANCTIONED_TRAINING_EXPORT_BRAND');

export type SanctionedTrainingExport = TrainingExportResult & {
  readonly [SANCTIONED_BRAND]?: true;
};

export type SanctionedTrainingEvidenceExport = TrainingEvidenceExportResult & {
  readonly [SANCTIONED_BRAND]?: true;
};

export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const prop = (obj as any)[key];
    if (prop !== null && typeof prop === 'object') {
      deepFreeze(prop);
    }
  }
  return obj;
}

// Module-scoped WeakSet private to training_exporter.ts.
// Outside callers cannot access this set or mark arbitrary objects as sanctioned.
const sanctionedExports = new WeakSet<object>();

export function isSanctionedTrainingExport(obj: unknown): obj is SanctionedTrainingExport {
  return Boolean(
    obj &&
    typeof obj === 'object' &&
    Object.isFrozen(obj) &&
    Array.isArray((obj as any).rows) &&
    Object.isFrozen((obj as any).rows) &&
    sanctionedExports.has(obj)
  );
}

export function isSanctionedTrainingEvidenceExport(obj: unknown): obj is SanctionedTrainingEvidenceExport {
  return Boolean(
    obj &&
    typeof obj === 'object' &&
    Object.isFrozen(obj) &&
    Array.isArray((obj as any).records) &&
    Object.isFrozen((obj as any).records) &&
    sanctionedExports.has(obj)
  );
}

export function isSanctionedDatasetV2Export(obj: unknown): obj is SanctionedDatasetV2Export {
  return Boolean(
    obj &&
    typeof obj === 'object' &&
    Object.isFrozen(obj) &&
    Array.isArray((obj as any).rows) &&
    Object.isFrozen((obj as any).rows) &&
    sanctionedExports.has(obj)
  );
}

export interface TrainingExportOptions {
  datasetVersion: string;
  labelerVersion?: string;
  featureBuilderVersion?: string;
  repository?: string;
  tenantId?: string;
  rightsFilterConfig?: RightsFilterConfig;
  defaultDataRights?: DataRights;
}

export interface TrainingExportResult {
  exportId: string;
  datasetVersion: string;
  rows: TrainingRow[];
  totalEvaluated: number;
  totalAccepted: number;
  totalRejected: number;
  rejectionSummary: Record<string, number>;
  rejections: Array<{ observationId: string; reasons: string[] }>;
  exportedAt: string;
}

export interface TrainingEvidenceExportResult {
  exportId: string;
  datasetVersion: string;
  records: TrainingEvidenceRecord[];
  totalEvaluated: number;
  totalAccepted: number;
  totalRejected: number;
  rejectionSummary: Record<string, number>;
  rejections: Array<{ evidenceId: string; reasons: string[] }>;
  exportedAt: string;
}

export class TrainingExporter {
  private rightsFilter: RightsFilter;

  constructor(config: RightsFilterConfig = {}) {
    this.rightsFilter = new RightsFilter(config);
  }

  /**
   * Primary export boundary: processes raw observations through the Rights Filter,
   * stamping full lineage onto eligible training rows.
   */
  public exportTrainingRows(
    observations: CandidateObservationV2[],
    rightsResolver: (obs: CandidateObservationV2) => {
      dataRights: DataRights;
      provenance?: SourceProvenance;
      repository?: string;
      tenantId?: string;
    },
    options: TrainingExportOptions
  ): TrainingExportResult {
    const exportId = `texport_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
    const exportedAt = new Date().toISOString();

    const rows: TrainingRow[] = [];
    const rejections: Array<{ observationId: string; reasons: string[] }> = [];
    const rejectionSummary: Record<string, number> = {};

    for (const obs of observations) {
      const resolved = rightsResolver(obs);
      if (!resolved || !resolved.dataRights) {
        rejections.push({
          observationId: obs.observationId,
          reasons: ['MISSING_DATA_RIGHTS: Customer DataRights must be provided explicitly.'],
        });
        rejectionSummary['MISSING_DATA_RIGHTS'] = (rejectionSummary['MISSING_DATA_RIGHTS'] || 0) + 1;
        continue;
      }

      const evalResult = this.rightsFilter.evaluate({
        observation: obs,
        dataRights: resolved.dataRights,
        provenance: resolved.provenance,
      });

      if (!evalResult.passed || !evalResult.sanitizedFeatures) {
        rejections.push({
          observationId: obs.observationId,
          reasons: evalResult.reasons,
        });
        for (const r of evalResult.reasons) {
          const key = r.split(':')[0].trim();
          rejectionSummary[key] = (rejectionSummary[key] || 0) + 1;
        }
        continue;
      }

      // Convert outcome label to binary target (Section 23 & 50)
      let label: 0 | 1;
      let confidence = 0.9;
      if (obs.outcomeLabel === 'POSITIVE') {
        label = 1;
        confidence = 0.95;
      } else if (obs.outcomeLabel === 'WEAK_NEGATIVE') {
        label = 0;
        confidence = 0.65;
      } else {
        // Fallback safety: non-binary outcome labels cannot be exported
        rejections.push({
          observationId: obs.observationId,
          reasons: [`NON_BINARY_OUTCOME: Label ${obs.outcomeLabel} cannot be converted to target.`],
        });
        rejectionSummary['NON_BINARY_OUTCOME'] = (rejectionSummary['NON_BINARY_OUTCOME'] || 0) + 1;
        continue;
      }

      const repo = resolved.repository || resolved.provenance?.repository || 'unknown/repository';

      const trainingRow = createTrainingRow({
        datasetVersion: options.datasetVersion,
        contextUnitId: obs.contextUnitId,
        taskId: obs.taskId,
        sessionId: obs.siftrSessionId,
        repository: repo,
        tenantId: resolved.tenantId,
        features: evalResult.sanitizedFeatures,
        label,
        confidence,
        outcomeLabel: obs.outcomeLabel,
        sourceObservationIds: [obs.observationId],
        labelerVersion: options.labelerVersion,
        featureBuilderVersion: options.featureBuilderVersion,
        exportId,
        provenanceId: resolved.provenance?.provenanceId,
        rightsReference: obs.rightsReference,
        exportedAt,
      });

      rows.push(trainingRow);
    }

    const result: SanctionedTrainingExport = {
      exportId,
      datasetVersion: options.datasetVersion,
      rows,
      totalEvaluated: observations.length,
      totalAccepted: rows.length,
      totalRejected: rejections.length,
      rejectionSummary,
      rejections,
      exportedAt,
      [SANCTIONED_BRAND]: true,
    };
    deepFreeze(result);
    sanctionedExports.add(result);
    return result;
  }

  /**
   * Dedicated export boundary for multi-dimensional TrainingEvidenceRecords (Audit Section 13 & 50).
   * Ensures richer TrainingEvidence cannot bypass the TrainingExporter boundary.
   */
  public exportTrainingEvidenceRecords(
    evidenceRecords: TrainingEvidenceRecord[],
    rightsResolver: (ev: TrainingEvidenceRecord) => {
      dataRights: DataRights;
      provenance?: SourceProvenance;
      repository?: string;
      tenantId?: string;
    },
    options: TrainingExportOptions
  ): TrainingEvidenceExportResult {
    const exportId = `texport_ev_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
    const exportedAt = new Date().toISOString();

    const records: TrainingEvidenceRecord[] = [];
    const rejections: Array<{ evidenceId: string; reasons: string[] }> = [];
    const rejectionSummary: Record<string, number> = {};

    for (const ev of evidenceRecords) {
      const resolved = rightsResolver(ev);
      if (!resolved || !resolved.dataRights) {
        rejections.push({
          evidenceId: ev.evidenceId,
          reasons: ['MISSING_DATA_RIGHTS: Customer DataRights must be provided explicitly.'],
        });
        rejectionSummary['MISSING_DATA_RIGHTS'] = (rejectionSummary['MISSING_DATA_RIGHTS'] || 0) + 1;
        continue;
      }

      const evalResult = this.rightsFilter.evaluateTrainingEvidenceRecord({
        evidence: ev,
        dataRights: resolved.dataRights,
        provenance: resolved.provenance,
      });

      if (!evalResult.passed) {
        rejections.push({
          evidenceId: ev.evidenceId,
          reasons: evalResult.reasons,
        });
        for (const r of evalResult.reasons) {
          const key = r.split(':')[0].trim();
          rejectionSummary[key] = (rejectionSummary[key] || 0) + 1;
        }
        continue;
      }

      const repo = resolved.repository || resolved.provenance?.repository || ev.repository;

      records.push({
        ...ev,
        exportId,
        datasetVersion: options.datasetVersion,
        repository: repo,
        tenantId: resolved.tenantId || ev.tenantId,
        exportedAt,
      });
    }

    const result: SanctionedTrainingEvidenceExport = {
      exportId,
      datasetVersion: options.datasetVersion,
      records,
      totalEvaluated: evidenceRecords.length,
      totalAccepted: records.length,
      totalRejected: rejections.length,
      rejectionSummary,
      rejections,
      exportedAt,
      [SANCTIONED_BRAND]: true,
    };
    deepFreeze(result);
    sanctionedExports.add(result);
    return result;
  }

  /**
   * SIFTR_CONTEXT_DATASET_V2 Export Boundary (Phase 20J)
   *
   * Exports canonical TaskEpisodeV1 instances into SiftrContextDatasetV2Row records.
   * Invariants:
   * 1. Rights permitted: trainingAllowed === true strictly enforced (fails closed).
   * 2. Exclude revoked or deleted episodes.
   * 3. Point-in-time boundary: candidate features must be point-in-time without post-outcome leakage.
   * 4. UNKNOWN != NEGATIVE: unselected/unshown candidates are never negative.
   * 5. Multi-dimensional signals (wasRead, wasEdited, wasInSuccessfulTask, etc.) remain decoupled.
   */
  public exportContextDatasetV2(
    episodes: TaskEpisodeV1[],
    options: {
      isRevoked?: (episodeId: string) => boolean;
      datasetVersion?: string;
    } = {}
  ): SanctionedDatasetV2Export {
    const exportId = `texport_v2_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
    const exportedAt = new Date().toISOString();

    const rows: SiftrContextDatasetV2Row[] = [];
    const rejections: Array<{ episodeId: string; reasons: string[] }> = [];

    let totalEpisodesAccepted = 0;
    let selectedUnitsCount = 0;
    let shownUnitsCount = 0;
    let readUnitsCount = 0;
    let editedUnitsCount = 0;
    let verifiedSuccessTasksCount = 0;
    let verifiedFailedTasksCount = 0;
    let unknownOutcomeTasksCount = 0;
    const repositoryDistribution: Record<string, number> = {};
    const taskTypeDistribution: Record<string, number> = {};

    for (const ep of episodes) {
      // 1. Data Rights check (fail-closed)
      if (!ep.rights || ep.rights.trainingAllowed !== true) {
        rejections.push({
          episodeId: ep.episodeId,
          reasons: ['RIGHTS_BLOCKED: trainingAllowed is false or unspecified.'],
        });
        continue;
      }

      // 2. Revocation check
      if (options.isRevoked && options.isRevoked(ep.episodeId)) {
        rejections.push({
          episodeId: ep.episodeId,
          reasons: ['REVOKED_EPISODE: Episode has been revoked/tombstoned by compliance deletion.'],
        });
        continue;
      }

      // 3. Point-in-time feature boundary check
      let hasLeakage = false;
      const leakageReasons: string[] = [];
      for (const cand of ep.contextDecision.candidates) {
        if (cand.featureSnapshot) {
          for (const field of FORBIDDEN_PRE_OUTCOME_FIELDS) {
            if (field in cand.featureSnapshot && (cand.featureSnapshot as Record<string, unknown>)[field] !== undefined) {
              hasLeakage = true;
              leakageReasons.push(`LEAKAGE_IN_FEATURES: Feature snapshot contains forbidden field "${field}".`);
              break;
            }
          }
        }
        if (hasLeakage) break;
      }
      if (hasLeakage) {
        rejections.push({
          episodeId: ep.episodeId,
          reasons: leakageReasons,
        });
        continue;
      }

      totalEpisodesAccepted++;

      // Track distribution
      const repo = ep.repositoryId || 'unknown';
      repositoryDistribution[repo] = (repositoryDistribution[repo] || 0) + 1;
      const ttype = ep.task.taskType || 'OTHER';
      taskTypeDistribution[ttype] = (taskTypeDistribution[ttype] || 0) + 1;

      if (ep.outcome.verifiedSuccess === true) {
        verifiedSuccessTasksCount++;
      } else if (ep.outcome.verifiedSuccess === false) {
        verifiedFailedTasksCount++;
      } else {
        unknownOutcomeTasksCount++;
      }

      const readPathsSet = new Set(ep.trajectory?.readPaths || []);
      const editedPathsSet = new Set(ep.trajectory?.editedPaths || []);
      const selectedUnitIds = new Set(ep.contextDecision.selectedUnits.map((u) => u.contextUnitId));

      for (const candidate of ep.contextDecision.candidates) {
        const wasSelected = candidate.selected || selectedUnitIds.has(candidate.contextUnitId);
        const wasShown = wasSelected;
        const wasRead = candidate.path ? readPathsSet.has(candidate.path) : false;
        const wasEdited = candidate.path ? editedPathsSet.has(candidate.path) : false;

        const exposureState = resolveExposureState({
          wasEdited,
          wasRead,
          wasShown,
          wasSelected,
        });

        if (wasSelected) selectedUnitsCount++;
        if (wasShown) shownUnitsCount++;
        if (wasRead) readUnitsCount++;
        if (wasEdited) editedUnitsCount++;

        const rowId = `row_${exportId}_${ep.episodeId}_${candidate.contextUnitId}`;
        const row: SiftrContextDatasetV2Row = {
          rowId,
          exportId,
          episodeId: ep.episodeId,
          taskIdentityHash: ep.task.promptSha256,
          repositoryFamily: ep.repositoryId,
          taskType: ep.task.taskType || 'OTHER',
          contextUnitId: candidate.contextUnitId,
          unitPath: candidate.path,
          candidateRetrievalProvenance: candidate.retrievalSources || [],
          candidateFeatureVector: candidate.featureSnapshot || {},
          preRankPosition: candidate.preRankPosition,
          finalRank: candidate.finalRank,
          finalScore: candidate.finalScore,
          exposureState,
          wasSelected,
          wasShown,
          wasRead,
          wasEdited,
          wasInSuccessfulTask: ep.outcome.verifiedSuccess === true,
          wasInFailedTask: ep.outcome.verifiedSuccess === false,
          verifiedSuccess: ep.outcome.verifiedSuccess,
          outcomeConfidence: ep.outcome.verificationConfidence,
          verifiedTargetEvidence: wasEdited || wasRead,
          contextTokens: candidate.estimatedTokens,
          taskEconomics: ep.economics,
          rightsReference: ep.rights.permissionSource,
          exportedAt,
        };

        rows.push(row);
      }
    }

    const summary: SiftrContextDatasetV2Summary = {
      datasetVersion: SIFTR_CONTEXT_DATASET_V2_VERSION,
      exportId,
      exportedAt,
      totalEpisodes: totalEpisodesAccepted,
      totalCandidateRows: rows.length,
      selectedUnitsCount,
      shownUnitsCount,
      readUnitsCount,
      editedUnitsCount,
      verifiedSuccessTasksCount,
      verifiedFailedTasksCount,
      unknownOutcomeTasksCount,
      repositoryDistribution,
      taskTypeDistribution,
    };

    const result: SanctionedDatasetV2Export = {
      exportId,
      datasetVersion: SIFTR_CONTEXT_DATASET_V2_VERSION,
      rows,
      summary,
      totalEpisodesEvaluated: episodes.length,
      totalEpisodesAccepted,
      totalEpisodesRejected: rejections.length,
      rejections,
      exportedAt,
      [SANCTIONED_BRAND]: true,
    };

    deepFreeze(result);
    sanctionedExports.add(result);
    return result;
  }
}
