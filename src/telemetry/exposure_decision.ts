/**
 * SiftrCode V2 - Exposure Decisions
 * Captures what context was shown to the agent and at what resolution.
 */

import { ContextResolution } from '../context/context_resolution';

export interface ExposureDecision {
  contextUnitId: string;
  exposureResolution: ContextResolution;
  exposureRank: number;
  exposureCostTokens: number;
  timestamp: number;
}

export function isExposed(decision: ExposureDecision): boolean {
  return decision.exposureResolution !== ContextResolution.OMIT;
}

export function createExposureDecision(params: {
  contextUnitId: string;
  exposureResolution: ContextResolution;
  exposureRank: number;
  exposureCostTokens?: number;
  timestamp?: number;
}): ExposureDecision {
  return {
    contextUnitId: params.contextUnitId,
    exposureResolution: params.exposureResolution,
    exposureRank: params.exposureRank,
    exposureCostTokens: params.exposureCostTokens ?? 0,
    timestamp: params.timestamp ?? Date.now(),
  };
}

/**
 * SiftrCode V2 - Authoritative Exposure Decision (Section 19 & 20)
 * Records exact policy identity, eligibility, propensity, and rank.
 */
export interface ExposureDecisionV2 {
  contextUnitId: string;
  eligibleForSelection: boolean;
  selected: boolean;
  candidateRank?: number;
  finalBundleRank?: number;
  resolution: ContextResolution;
  actualTokenCost?: number;
  contextPlanId: string;
  policyId: string;
  policyVersion: string;
  selectionProbability?: number;
  explorationPolicy?: string;
  timestamp: string;
}

export function isExposedV2(decision: ExposureDecisionV2): boolean {
  return decision.selected && decision.resolution !== ContextResolution.OMIT;
}

export function createExposureDecisionV2(params: {
  contextUnitId: string;
  eligibleForSelection: boolean;
  selected: boolean;
  candidateRank?: number;
  finalBundleRank?: number;
  resolution: ContextResolution;
  actualTokenCost?: number;
  contextPlanId: string;
  policyId?: string;
  policyVersion?: string;
  selectionProbability?: number;
  explorationPolicy?: string;
  timestamp?: string;
}): ExposureDecisionV2 {
  const isSelected = params.selected && params.resolution !== ContextResolution.OMIT;
  return {
    contextUnitId: params.contextUnitId,
    eligibleForSelection: params.eligibleForSelection,
    selected: isSelected,
    candidateRank: params.candidateRank,
    finalBundleRank: params.finalBundleRank,
    resolution: params.resolution,
    actualTokenCost: params.actualTokenCost,
    contextPlanId: params.contextPlanId,
    policyId: params.policyId ?? 'siftr-deterministic',
    policyVersion: params.policyVersion ?? '2.1.0',
    selectionProbability: params.selectionProbability !== undefined
      ? params.selectionProbability
      : (isSelected ? 1.0 : undefined),
    explorationPolicy: params.explorationPolicy,
    timestamp: params.timestamp ?? new Date().toISOString(),
  };
}

