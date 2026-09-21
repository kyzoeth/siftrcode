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
        provenanceId: resolved.provenance?.provenanceId,
        rightsReference: obs.rightsReference,
        exportedAt,
      });

      rows.push(trainingRow);
    }

    return {
      exportId,
      datasetVersion: options.datasetVersion,
      rows,
      totalEvaluated: observations.length,
      totalAccepted: rows.length,
      totalRejected: rejections.length,
      rejectionSummary,
      rejections,
      exportedAt,
    };
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
        datasetVersion: options.datasetVersion,
        repository: repo,
        tenantId: resolved.tenantId || ev.tenantId,
        exportedAt,
      });
    }

    return {
      exportId,
      datasetVersion: options.datasetVersion,
      records,
      totalEvaluated: evidenceRecords.length,
      totalAccepted: records.length,
      totalRejected: rejections.length,
      rejectionSummary,
      rejections,
      exportedAt,
    };
  }
}
