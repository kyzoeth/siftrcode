/**
 * SiftrCode V2 - Derived-Data Lineage & Training Row Schema (Section 52)
 *
 * Requirements (Section 52):
 * A training row must identify:
 * - source observations
 * - labeler version
 * - feature builder version
 * - dataset version
 *
 * This guarantees full provenance so data can later be audited, removed, or rebuilt.
 */

import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { ResolvedOutcomeLabel } from '../telemetry/candidate_observation';

export interface DerivedDataLineage {
  lineageId: string;
  trainingRowId: string;
  sourceObservationIds: string[];
  sourceTaskId: string;
  sourceSessionId: string;
  repository: string;
  tenantId?: string;
  labelerVersion: string;
  featureBuilderVersion: string;
  datasetVersion: string;
  provenanceId?: string;
  createdAt: string;
}

export interface TrainingRow {
  rowId: string;
  datasetVersion: string;
  contextUnitId: string;
  taskId: string;
  repository: string;
  tenantId?: string;
  features: ContextFeaturesV1;
  label: 0 | 1;
  confidence: number;
  outcomeLabel: ResolvedOutcomeLabel;
  lineage: DerivedDataLineage;
  rightsReference: string;
  exportedAt: string;
}

export function createDerivedDataLineage(params: {
  lineageId?: string;
  trainingRowId: string;
  sourceObservationIds: string[];
  sourceTaskId: string;
  sourceSessionId: string;
  repository: string;
  tenantId?: string;
  labelerVersion: string;
  featureBuilderVersion: string;
  datasetVersion: string;
  provenanceId?: string;
  createdAt?: string;
}): DerivedDataLineage {
  const lineageId =
    params.lineageId ||
    `lin_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;

  return {
    lineageId,
    trainingRowId: params.trainingRowId,
    sourceObservationIds: [...params.sourceObservationIds],
    sourceTaskId: params.sourceTaskId,
    sourceSessionId: params.sourceSessionId,
    repository: params.repository,
    tenantId: params.tenantId,
    labelerVersion: params.labelerVersion,
    featureBuilderVersion: params.featureBuilderVersion,
    datasetVersion: params.datasetVersion,
    provenanceId: params.provenanceId,
    createdAt: params.createdAt || new Date().toISOString(),
  };
}

export function createTrainingRow(params: {
  rowId?: string;
  datasetVersion: string;
  contextUnitId: string;
  taskId: string;
  sessionId: string;
  repository: string;
  tenantId?: string;
  features: ContextFeaturesV1;
  label: 0 | 1;
  confidence?: number;
  outcomeLabel: ResolvedOutcomeLabel;
  sourceObservationIds: string[];
  labelerVersion?: string;
  featureBuilderVersion?: string;
  provenanceId?: string;
  rightsReference: string;
  exportedAt?: string;
}): TrainingRow {
  const rowId =
    params.rowId ||
    `trow_${params.datasetVersion.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;

  const exportedAt = params.exportedAt || new Date().toISOString();
  const labelerVersion = params.labelerVersion || 'v1.0.0';
  const featureBuilderVersion = params.featureBuilderVersion || 'feature_schema_v2';

  const lineage = createDerivedDataLineage({
    trainingRowId: rowId,
    sourceObservationIds: params.sourceObservationIds,
    sourceTaskId: params.taskId,
    sourceSessionId: params.sessionId,
    repository: params.repository,
    tenantId: params.tenantId,
    labelerVersion,
    featureBuilderVersion,
    datasetVersion: params.datasetVersion,
    provenanceId: params.provenanceId,
    createdAt: exportedAt,
  });

  return {
    rowId,
    datasetVersion: params.datasetVersion,
    contextUnitId: params.contextUnitId,
    taskId: params.taskId,
    repository: params.repository,
    tenantId: params.tenantId,
    features: params.features,
    label: params.label,
    confidence: params.confidence ?? (params.label === 1 ? 0.95 : 0.7),
    outcomeLabel: params.outcomeLabel,
    lineage,
    rightsReference: params.rightsReference,
    exportedAt,
  };
}
