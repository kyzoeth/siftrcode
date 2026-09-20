/**
 * SiftrCode V2 - Candidate Observation & Exposure-Aware Labeling
 * Invariant: Unexposed candidates MUST NEVER be labeled negative.
 * Compliance: Telemetry strictly respects customer DataRights.
 */

import { ContextResolution } from '../context/context_resolution';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { DataRights, createDefaultDataRights } from '../rights/data_rights';

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
 * Exports training examples while strictly enforcing customer DataRights and exposure bounds.
 */
export function exportTrainingExamples(observations: CandidateObservation[]): TrainingExample[] {
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
