/**
 * SiftrCode V2 - Candidate Observation & Exposure-Aware Labeling
 * Invariant: Unexposed candidates MUST NEVER be labeled negative.
 * Compliance: Telemetry strictly respects customer DataRights.
 */

import { ContextResolution } from '../context/context_resolution';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { DataRights, createDefaultDataRights } from '../rights/data_rights';
import { ObservabilityLevel } from '../agents/agent_adapter';
import { ExposureDecisionV2, isExposedV2 } from './exposure_decision';

export type ObservationLabel = 'POSITIVE' | 'NEGATIVE' | 'UNEXPOSED_UNKNOWN';

export interface CandidateObservation {
  taskId: string;
  contextUnitId: string;
  wasExposed: boolean;
  exposureResolution: ContextResolution;
  exposureRank?: number;
  wasInspectedByAgent: boolean;
  wasEditedByAgent: boolean;
  wasInFailureTrace: boolean;
  features?: ContextFeaturesV1;
  label: ObservationLabel;
  dataRights: DataRights;
  timestamp: number;
}

/**
 * Computes the outcome label strictly respecting the exposure boundary.
 *
 * Rule 1: If unit was edited, inspected, or present in failure trace -> POSITIVE.
 * Rule 2: If unit was EXPOSED to agent but never used/touched -> NEGATIVE.
 * Rule 3: If unit was NEVER exposed -> UNEXPOSED_UNKNOWN (NEVER NEGATIVE).
 */
export function computeObservationLabel(
  wasExposed: boolean,
  wasInspectedByAgent: boolean,
  wasEditedByAgent: boolean,
  wasInFailureTrace: boolean
): ObservationLabel {
  if (wasEditedByAgent || wasInspectedByAgent || wasInFailureTrace) {
    return 'POSITIVE';
  }

  if (wasExposed) {
    return 'NEGATIVE';
  }

  // Critical Invariant: Unexposed units cannot be treated as negative examples!
  return 'UNEXPOSED_UNKNOWN';
}

export function createCandidateObservation(params: {
  taskId: string;
  contextUnitId: string;
  wasExposed: boolean;
  exposureResolution: ContextResolution;
  exposureRank?: number;
  wasInspectedByAgent: boolean;
  wasEditedByAgent: boolean;
  wasInFailureTrace: boolean;
  features?: ContextFeaturesV1;
  dataRights?: DataRights;
  timestamp?: number;
}): CandidateObservation {
  const label = computeObservationLabel(
    params.wasExposed,
    params.wasInspectedByAgent,
    params.wasEditedByAgent,
    params.wasInFailureTrace
  );

  return {
    taskId: params.taskId,
    contextUnitId: params.contextUnitId,
    wasExposed: params.wasExposed,
    exposureResolution: params.exposureResolution,
    exposureRank: params.exposureRank,
    wasInspectedByAgent: params.wasInspectedByAgent,
    wasEditedByAgent: params.wasEditedByAgent,
    wasInFailureTrace: params.wasInFailureTrace,
    features: params.features,
    label,
    dataRights: params.dataRights ?? createDefaultDataRights(),
    timestamp: params.timestamp ?? Date.now(),
  };
}

export interface TrainingExample {
  contextUnitId: string;
  features: ContextFeaturesV1;
  label: 0 | 1;
}

/**
 * Status check for training export quarantine (Section 17).
 */
export function isTrainingExportQuarantined(): boolean {
  return true;
}

/**
 * @deprecated QUARANTINED (Section 17): Binary production training export is quarantined.
 * Must NOT be treated as causal or unbiased training data. Use V2 telemetry pipeline and DatasetBuilder.
 */
export function exportTrainingExamples(observations: CandidateObservation[]): TrainingExample[] {
  console.warn(
    '[QUARANTINED] exportTrainingExamples: Binary production training export is quarantined pending V2 telemetry & durable stores (Section 17).'
  );
  const examples: TrainingExample[] = [];

  for (const obs of observations) {
    // 1. Data Rights Check: Privacy-by-default
    if (!obs.dataRights.trainingAllowed) {
      continue;
    }

    // 2. Exposure Check: Never train on unexposed unknown candidates
    if (obs.label === 'UNEXPOSED_UNKNOWN') {
      continue;
    }

    if (!obs.features) {
      continue;
    }

    const labelNumeric = obs.label === 'POSITIVE' ? 1 : 0;

    examples.push({
      contextUnitId: obs.contextUnitId,
      features: obs.features,
      label: labelNumeric,
    });
  }

  return examples;
}

// =============================================================================
// V2 TELEMETRY & OBSERVATION SCHEMA (Sections 18-24)
// =============================================================================

export type LabelEvidenceType =
  | 'READ'
  | 'REQUESTED'
  | 'EDITED'
  | 'TEST_RELATED'
  | 'FAILURE_TRACE'
  | 'PATCH_MEMBER'
  | 'OUTCOME_ASSOCIATION'
  | 'COUNTERFACTUAL_UTILITY';

export type LabelEvidenceStrength =
  | 'WEAK'
  | 'MEDIUM'
  | 'STRONG'
  | 'EXPERIMENTAL';

export interface LabelEvidence {
  labelType: LabelEvidenceType;
  value: number;
  confidence: number;
  strength: LabelEvidenceStrength;
  source: string;
}

export type ResolvedOutcomeLabel =
  | 'POSITIVE'
  | 'WEAK_NEGATIVE'
  | 'UNKNOWN'
  | 'UNEXPOSED_UNKNOWN';

export interface ObservedBehavior {
  read?: boolean;
  explicitlyRequested?: boolean;
  expanded?: boolean;
  edited?: boolean;
  testRelated?: boolean;
  appearedInFailureTrace?: boolean;
}

/**
 * Computes evidence-based outcome labeling respecting agent observability level (Section 22 & 23).
 *
 * Invariant: Unexposed candidates are ALWAYS UNEXPOSED_UNKNOWN (never negative).
 * Invariant: Exposed but unused with SIFTR_CALLS_ONLY or PARTIAL_AGENT_TRACE is UNKNOWN, NEVER negative.
 * Invariant: Weak negative requires FULL_TOOL_TRACE + exposure + no interaction + task success.
 */
export function computeLabelEvidence(params: {
  exposure: ExposureDecisionV2;
  observabilityLevel: ObservabilityLevel;
  observedBehavior: ObservedBehavior;
  taskSucceeded?: boolean;
}): { evidence: LabelEvidence[]; outcomeLabel: ResolvedOutcomeLabel } {
  const evidence: LabelEvidence[] = [];
  const exposed = isExposedV2(params.exposure);

  // 1. Check positive evidence signals
  if (params.observedBehavior.edited) {
    evidence.push({
      labelType: 'EDITED',
      value: 1.0,
      confidence: 0.95,
      strength: 'STRONG',
      source: 'agent_edit',
    });
  }
  if (params.observedBehavior.read) {
    evidence.push({
      labelType: 'READ',
      value: 1.0,
      confidence: 0.85,
      strength: 'MEDIUM',
      source: 'agent_read',
    });
  }
  if (params.observedBehavior.explicitlyRequested) {
    evidence.push({
      labelType: 'REQUESTED',
      value: 1.0,
      confidence: 0.9,
      strength: 'STRONG',
      source: 'agent_explicit_request',
    });
  }
  if (params.observedBehavior.appearedInFailureTrace) {
    evidence.push({
      labelType: 'FAILURE_TRACE',
      value: 1.0,
      confidence: 0.8,
      strength: 'MEDIUM',
      source: 'failure_stack_trace',
    });
  }
  if (params.observedBehavior.testRelated) {
    evidence.push({
      labelType: 'TEST_RELATED',
      value: 1.0,
      confidence: 0.75,
      strength: 'MEDIUM',
      source: 'test_execution',
    });
  }

  // If any positive evidence was detected:
  if (evidence.length > 0) {
    return { evidence, outcomeLabel: 'POSITIVE' };
  }

  // 2. Unexposed candidate invariant: NEVER NEGATIVE
  if (!exposed) {
    return { evidence, outcomeLabel: 'UNEXPOSED_UNKNOWN' };
  }

  // 3. Exposed candidate with no positive interactions (Section 23)
  // If observability level is limited (SIFTR_CALLS_ONLY or PARTIAL_AGENT_TRACE),
  // we have no visibility into agent internal decisions -> UNKNOWN, NEVER negative.
  if (
    params.observabilityLevel === 'SIFTR_CALLS_ONLY' ||
    params.observabilityLevel === 'PARTIAL_AGENT_TRACE'
  ) {
    return { evidence, outcomeLabel: 'UNKNOWN' };
  }

  // If observability is FULL_TOOL_TRACE or HARNESS_NATIVE:
  // A negative label is ONLY supported if the task actually SUCCEEDED without the candidate.
  if (params.taskSucceeded === true) {
    evidence.push({
      labelType: 'OUTCOME_ASSOCIATION',
      value: 0.0,
      confidence: 0.5,
      strength: 'WEAK',
      source: 'unreferenced_in_successful_trajectory',
    });
    return { evidence, outcomeLabel: 'WEAK_NEGATIVE' };
  }

  // Task failed or outcome unknown: do not assume candidate was negative
  return { evidence, outcomeLabel: 'UNKNOWN' };
}

/**
 * SiftrCode V2 - Authoritative Candidate Observation Schema (Section 18)
 */
export interface CandidateObservationV2 {
  schemaVersion: '2';
  observationId: string;
  taskId: string;
  siftrSessionId: string;
  workspaceSnapshotId: string;
  contextUnitId: string;
  agentEnvironmentId: string;
  observabilityLevel: ObservabilityLevel;
  featureSchemaVersion: string;
  features: ContextFeaturesV1;
  candidate: {
    generated: boolean;
    candidateRank?: number;
    retrievalSources: string[];
  };
  exposure: ExposureDecisionV2;
  observedBehavior: ObservedBehavior;
  evidence: LabelEvidence[];
  outcomeLabel: ResolvedOutcomeLabel;
  outcomeId?: string;
  rightsReference: string;
  recordedAt: string;
}

export function createCandidateObservationV2(params: {
  observationId?: string;
  taskId: string;
  siftrSessionId: string;
  workspaceSnapshotId: string;
  contextUnitId: string;
  agentEnvironmentId: string;
  observabilityLevel: ObservabilityLevel;
  featureSchemaVersion?: string;
  features: ContextFeaturesV1;
  candidate: {
    generated: boolean;
    candidateRank?: number;
    retrievalSources: string[];
  };
  exposure: ExposureDecisionV2;
  observedBehavior?: ObservedBehavior;
  outcomeId?: string;
  rightsReference: string;
  taskSucceeded?: boolean;
  recordedAt?: string;
}): CandidateObservationV2 {
  const behavior: ObservedBehavior = params.observedBehavior ?? {};
  const { evidence, outcomeLabel } = computeLabelEvidence({
    exposure: params.exposure,
    observabilityLevel: params.observabilityLevel,
    observedBehavior: behavior,
    taskSucceeded: params.taskSucceeded,
  });

  const observationId =
    params.observationId ??
    `cobs_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;

  return {
    schemaVersion: '2',
    observationId,
    taskId: params.taskId,
    siftrSessionId: params.siftrSessionId,
    workspaceSnapshotId: params.workspaceSnapshotId,
    contextUnitId: params.contextUnitId,
    agentEnvironmentId: params.agentEnvironmentId,
    observabilityLevel: params.observabilityLevel,
    featureSchemaVersion: params.featureSchemaVersion ?? '1.0.0',
    features: params.features,
    candidate: params.candidate,
    exposure: params.exposure,
    observedBehavior: behavior,
    evidence,
    outcomeLabel,
    outcomeId: params.outcomeId,
    rightsReference: params.rightsReference,
    recordedAt: params.recordedAt ?? new Date().toISOString(),
  };
}

