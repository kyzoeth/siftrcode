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
import { ContextResolution } from '../context/context_resolution';

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

/**
 * Multi-dimensional training evidence schema (Audit Section 13).
 * Preserves granular semantic, behavioral, and outcome signals without collapsing
 * prematurely into a single binary 0/1 label.
 */
export interface TrainingEvidenceRecord {
  evidenceId: string;
  datasetVersion: string;
  contextUnitId: string;
  taskId: string;
  repository: string;
  tenantId?: string;
  features: ContextFeaturesV1;
  semanticRelevance?: number;
  readEvidence: { wasRead: boolean; readCount?: number; confidence: number };
  editEvidence: { wasEdited: boolean; editCount?: number; confidence: number };
  testEvidence: { testsPassed?: boolean; regressionTestsPassed?: boolean; confidence: number };
  rootCauseEvidence: { isRootCause?: boolean; confidence: number };
  verifiedOutcomeAssociation: { verifiedSuccess?: boolean; confidence: number };
  counterfactualEffect?: { deltaUtility?: number; confidence: number };
  resolutionSufficiency?: { resolution: ContextResolution; sufficient: boolean; confidence: number };
  lineage: DerivedDataLineage;
  rightsReference: string;
  exportedAt: string;
}

export function createTrainingEvidenceRecord(params: {
  evidenceId?: string;
  datasetVersion: string;
  contextUnitId: string;
  taskId: string;
  sessionId: string;
  repository: string;
  tenantId?: string;
  features: ContextFeaturesV1;
  semanticRelevance?: number;
  readEvidence?: { wasRead: boolean; readCount?: number; confidence: number };
  editEvidence?: { wasEdited: boolean; editCount?: number; confidence: number };
  testEvidence?: { testsPassed?: boolean; regressionTestsPassed?: boolean; confidence: number };
  rootCauseEvidence?: { isRootCause?: boolean; confidence: number };
  verifiedOutcomeAssociation?: { verifiedSuccess?: boolean; confidence: number };
  counterfactualEffect?: { deltaUtility?: number; confidence: number };
  resolutionSufficiency?: { resolution: ContextResolution; sufficient: boolean; confidence: number };
  sourceObservationIds: string[];
  labelerVersion?: string;
  featureBuilderVersion?: string;
  provenanceId?: string;
  rightsReference: string;
  exportedAt?: string;
}): TrainingEvidenceRecord {
  const evidenceId =
    params.evidenceId ||
    `evrec_${params.datasetVersion.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;

  const exportedAt = params.exportedAt || new Date().toISOString();
  const labelerVersion = params.labelerVersion || 'v1.0.0';
  const featureBuilderVersion = params.featureBuilderVersion || 'feature_schema_v2';

  const lineage = createDerivedDataLineage({
    trainingRowId: evidenceId,
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
    evidenceId,
    datasetVersion: params.datasetVersion,
    contextUnitId: params.contextUnitId,
    taskId: params.taskId,
    repository: params.repository,
    tenantId: params.tenantId,
    features: params.features,
    semanticRelevance: params.semanticRelevance,
    readEvidence: params.readEvidence || { wasRead: false, confidence: 0.5 },
    editEvidence: params.editEvidence || { wasEdited: false, confidence: 0.5 },
    testEvidence: params.testEvidence || { confidence: 0.5 },
    rootCauseEvidence: params.rootCauseEvidence || { confidence: 0.5 },
    verifiedOutcomeAssociation: params.verifiedOutcomeAssociation || { confidence: 0.5 },
    counterfactualEffect: params.counterfactualEffect,
    resolutionSufficiency: params.resolutionSufficiency,
    lineage,
    rightsReference: params.rightsReference,
    exportedAt,
  };
}

/**
 * Derives a legacy binary TrainingRow from a rich multi-dimensional TrainingEvidenceRecord.
 */
export function deriveBinaryTrainingRow(evidence: TrainingEvidenceRecord): TrainingRow {
  const isPositive =
    evidence.editEvidence.wasEdited ||
    (evidence.verifiedOutcomeAssociation.verifiedSuccess === true && evidence.readEvidence.wasRead);

  const confidence = Math.max(
    evidence.editEvidence.confidence,
    evidence.verifiedOutcomeAssociation.confidence,
    evidence.readEvidence.confidence
  );

  const outcomeLabel: ResolvedOutcomeLabel = isPositive
    ? 'POSITIVE'
    : (evidence.readEvidence.wasRead ? 'UNKNOWN' : 'UNEXPOSED_UNKNOWN');

  return {
    rowId: `trow_${evidence.evidenceId}`,
    datasetVersion: evidence.datasetVersion,
    contextUnitId: evidence.contextUnitId,
    taskId: evidence.taskId,
    repository: evidence.repository,
    tenantId: evidence.tenantId,
    features: evidence.features,
    label: isPositive ? 1 : 0,
    confidence,
    outcomeLabel,
    lineage: evidence.lineage,
    rightsReference: evidence.rightsReference,
    exportedAt: evidence.exportedAt,
  };
}

/**
 * Derives a graded relevance integer label (0 to 4) for listwise/pairwise rankers (ContextRank).
 */
export function deriveRankingTrainingExample(evidence: TrainingEvidenceRecord): {
  relevanceGrade: number; // 0 = distractor, 1 = unread, 2 = read, 3 = critical dependency, 4 = causal edit target
  confidence: number;
} {
  if (evidence.editEvidence.wasEdited && evidence.verifiedOutcomeAssociation.verifiedSuccess) {
    return { relevanceGrade: 4, confidence: evidence.editEvidence.confidence };
  }
  if (evidence.editEvidence.wasEdited) {
    return { relevanceGrade: 3, confidence: evidence.editEvidence.confidence };
  }
  if (evidence.readEvidence.wasRead && evidence.verifiedOutcomeAssociation.verifiedSuccess) {
    return { relevanceGrade: 2, confidence: evidence.readEvidence.confidence };
  }
  if (evidence.readEvidence.wasRead) {
    return { relevanceGrade: 1, confidence: evidence.readEvidence.confidence };
  }
  return { relevanceGrade: 0, confidence: 0.6 };
}

