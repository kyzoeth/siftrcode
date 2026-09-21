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
  label: 0 | 1 | null;
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
  label: 0 | 1 | null;
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
    confidence: params.confidence ?? (params.label === 1 ? 0.95 : params.label === 0 ? 0.7 : 0.0),
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
  sessionId?: string;
  repository: string;
  tenantId?: string;
  features: ContextFeaturesV1;
  semanticRelevance?: number;
  exposure?: { wasExposed: boolean; resolution?: ContextResolution; policyId?: string };
  observabilityLevel?: string;
  readEvidence: { wasRead: boolean | null; readCount?: number; confidence: number };
  editEvidence: { wasEdited: boolean; editCount?: number; confidence: number };
  testEvidence: { testsPassed?: boolean; regressionTestsPassed?: boolean; confidence: number };
  rootCauseEvidence: { isRootCause?: boolean; confidence: number };
  verifiedOutcomeAssociation: { verifiedSuccess: boolean | null; confidence: number };
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
  exposure?: { wasExposed: boolean; resolution?: ContextResolution; policyId?: string };
  observabilityLevel?: string;
  readEvidence?: { wasRead: boolean | null; readCount?: number; confidence: number };
  editEvidence?: { wasEdited: boolean; editCount?: number; confidence: number };
  testEvidence?: { testsPassed?: boolean; regressionTestsPassed?: boolean; confidence: number };
  rootCauseEvidence?: { isRootCause?: boolean; confidence: number };
  verifiedOutcomeAssociation?: { verifiedSuccess?: boolean | null; confidence: number };
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
  const featureBuilderVersion = params.featureBuilderVersion || 'v1.0.0';

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

  const defaultRead = params.exposure && !params.exposure.wasExposed
    ? null
    : (params.observabilityLevel === 'SIFTR_CALLS_ONLY' || params.observabilityLevel === 'PARTIAL_AGENT_TRACE' ? null : false);

  return {
    evidenceId,
    datasetVersion: params.datasetVersion,
    contextUnitId: params.contextUnitId,
    taskId: params.taskId,
    sessionId: params.sessionId,
    repository: params.repository,
    tenantId: params.tenantId,
    features: params.features,
    semanticRelevance: params.semanticRelevance,
    exposure: params.exposure,
    observabilityLevel: params.observabilityLevel,
    readEvidence: params.readEvidence || { wasRead: defaultRead, confidence: 0.5 },
    editEvidence: params.editEvidence || { wasEdited: false, confidence: 0.5 },
    testEvidence: params.testEvidence || { confidence: 0.5 },
    rootCauseEvidence: params.rootCauseEvidence || { confidence: 0.5 },
    verifiedOutcomeAssociation: {
      verifiedSuccess:
        params.verifiedOutcomeAssociation && params.verifiedOutcomeAssociation.verifiedSuccess !== undefined
          ? params.verifiedOutcomeAssociation.verifiedSuccess
          : null,
      confidence: params.verifiedOutcomeAssociation?.confidence ?? 0.5,
    },
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
    (evidence.verifiedOutcomeAssociation.verifiedSuccess === true && evidence.readEvidence.wasRead === true);

  let outcomeLabel: ResolvedOutcomeLabel = 'UNKNOWN';
  let label: 0 | 1 | null = null;
  if (isPositive) {
    outcomeLabel = 'POSITIVE';
    label = 1;
  } else if (evidence.exposure && !evidence.exposure.wasExposed) {
    outcomeLabel = 'UNEXPOSED_UNKNOWN';
    label = null;
  } else if (
    evidence.observabilityLevel === 'SIFTR_CALLS_ONLY' ||
    evidence.observabilityLevel === 'PARTIAL_AGENT_TRACE' ||
    evidence.readEvidence.wasRead === null
  ) {
    outcomeLabel = 'UNKNOWN';
    label = null;
  } else if (evidence.verifiedOutcomeAssociation.verifiedSuccess === true) {
    outcomeLabel = 'WEAK_NEGATIVE';
    label = 0;
  } else {
    outcomeLabel = 'UNKNOWN';
    label = null;
  }

  const confidence =
    label === null
      ? 0.0
      : Math.max(
          evidence.editEvidence.confidence,
          evidence.verifiedOutcomeAssociation.confidence,
          evidence.readEvidence.confidence
        );

  return {
    rowId: `trow_${evidence.evidenceId}`,
    datasetVersion: evidence.datasetVersion,
    contextUnitId: evidence.contextUnitId,
    taskId: evidence.taskId,
    repository: evidence.repository,
    tenantId: evidence.tenantId,
    features: evidence.features,
    label,
    confidence,
    outcomeLabel,
    lineage: evidence.lineage,
    rightsReference: evidence.rightsReference,
    exportedAt: evidence.exportedAt,
  };
}

/**
 * Derives a graded relevance integer label (0 to 4) for listwise/pairwise rankers (ContextRank).
 * Returns null for unexposed, unobserved, or unverified items (tri-state, preventing false negative grade 0).
 */
export function deriveRankingTrainingExample(evidence: TrainingEvidenceRecord): {
  relevanceGrade: number | null; // null = UNKNOWN / UNEXPOSED / UNOBSERVED; 0 = distractor, 1 = unread, 2 = read, 3 = critical dependency, 4 = causal edit target
  confidence: number;
} {
  // 1. Positive interactions: edits and reads
  if (evidence.editEvidence.wasEdited && evidence.verifiedOutcomeAssociation.verifiedSuccess) {
    return { relevanceGrade: 4, confidence: evidence.editEvidence.confidence };
  }
  if (evidence.editEvidence.wasEdited) {
    return { relevanceGrade: 3, confidence: evidence.editEvidence.confidence };
  }
  if (evidence.readEvidence.wasRead === true && evidence.verifiedOutcomeAssociation.verifiedSuccess) {
    return { relevanceGrade: 2, confidence: evidence.readEvidence.confidence };
  }
  if (evidence.readEvidence.wasRead === true) {
    return { relevanceGrade: 1, confidence: evidence.readEvidence.confidence };
  }

  // 2. Unexposed or unobserved candidates: NEVER automatically turn into relevance grade 0!
  if (evidence.exposure && !evidence.exposure.wasExposed) {
    return { relevanceGrade: null, confidence: 0.0 };
  }
  if (
    evidence.observabilityLevel === 'SIFTR_CALLS_ONLY' ||
    evidence.observabilityLevel === 'PARTIAL_AGENT_TRACE' ||
    evidence.readEvidence.wasRead === null
  ) {
    return { relevanceGrade: null, confidence: 0.0 };
  }

  // 3. Confirmed negative distractor (relevance grade 0):
  // ONLY supported when candidate was exposed under FULL_TOOL_TRACE / HARNESS_NATIVE,
  // confirmed unread and unedited, and the task SUCCEEDED.
  if (evidence.verifiedOutcomeAssociation.verifiedSuccess === true) {
    return { relevanceGrade: 0, confidence: 0.6 };
  }

  // If task failed or outcome is unverified, candidate remains UNKNOWN (null)
  return { relevanceGrade: null, confidence: 0.0 };
}

