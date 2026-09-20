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
