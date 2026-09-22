/**
 * SiftrCode V2 - Task Economics & Honest CPVST Model (Phase 20G)
 *
 * Tracks granular tokens, latency, and costs across context generation and agent runs.
 * Invariant: Only compute CPVST when verifiedSuccess is known and pricing is VALID.
 * Never manufacture CPVST from partial pricing or unknown outcomes.
 */

import { TaskOutcomeV1 } from '../outcome/task_outcome';

export interface TaskEconomicsV1 {
  contextInputTokens: number;
  agentInputTokens?: number | null;
  agentOutputTokens?: number | null;
  cachedInputTokens?: number | null;
  contextGenerationCostUSD?: number | null;
  agentCostUSD?: number | null;
  totalCostUSD?: number | null;
  contextLatencyMs: number;
  taskLatencyMs?: number | null;
  pricingStatus: 'VALID' | 'PRICING_UNAVAILABLE';
}

export interface CpvstResult {
  cpvstUSD: number | null;
  status: 'COMPUTED' | 'PRICING_UNAVAILABLE' | 'TASK_NOT_VERIFIED_SUCCESS';
  rationale: string;
}

/**
 * Computes Cost Per Verified Successful Task (CPVST) strictly obeying safety invariants.
 */
export function computeCPVST(
  economics: TaskEconomicsV1 | undefined,
  outcome: TaskOutcomeV1
): CpvstResult {
  if (!economics) {
    return {
      cpvstUSD: null,
      status: 'PRICING_UNAVAILABLE',
      rationale: 'No economics data recorded for episode.',
    };
  }

  if (outcome.verifiedSuccess !== true) {
    return {
      cpvstUSD: null,
      status: 'TASK_NOT_VERIFIED_SUCCESS',
      rationale: `Cannot compute CPVST on non-verified or failed task (verifiedSuccess=${outcome.verifiedSuccess}).`,
    };
  }

  if (economics.pricingStatus !== 'VALID' || economics.totalCostUSD == null || economics.totalCostUSD <= 0) {
    return {
      cpvstUSD: null,
      status: 'PRICING_UNAVAILABLE',
      rationale: 'Valid full pricing model is unavailable for this episode.',
    };
  }

  return {
    cpvstUSD: economics.totalCostUSD,
    status: 'COMPUTED',
    rationale: `Successfully computed CPVST: $${economics.totalCostUSD.toFixed(6)}`,
  };
}
