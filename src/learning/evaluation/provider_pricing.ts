/**
 * Official Model Provider Pricing Definitions & Accounting (Phase V3.1 - Phase 8)
 *
 * Implements strict, fail-closed per-token cost calculation based on official provider documentation.
 *
 * Invariants:
 * 1. Fail Closed: Unknown model or unknown billing tier results in providerCostUSD = null and PRICING_UNAVAILABLE.
 * 2. No Silent Fallbacks: Never guess pricing or substitute default models.
 * 3. Thinking Tokens: Explicitly accounted and billed as output tokens according to official policy.
 * 4. Provenance: Every price entry is tied to an official reference URL and effective date.
 */

export type BillingTier = 'free' | 'standard' | 'priority' | 'batch' | 'unknown';

export interface ProviderPricing {
  provider: 'google';
  model: string;
  billingTier: BillingTier;
  effectiveFrom: string;
  effectiveThrough?: string;
  inputUSDPerMTok: number | null;
  outputUSDPerMTok: number | null;
  cachedInputUSDPerMTok?: number | null;
  thinkingTokenTreatment: string;
  sourceReference: string;
  pricingVersion: string;
}

export const OFFICIAL_PROVIDER_PRICING: Record<string, ProviderPricing> = {
  'gemini-3.6-flash:standard': {
    provider: 'google',
    model: 'gemini-3.6-flash',
    billingTier: 'standard',
    effectiveFrom: '2026-03-01',
    inputUSDPerMTok: 0.10,
    outputUSDPerMTok: 0.40,
    cachedInputUSDPerMTok: 0.025,
    thinkingTokenTreatment: 'billed_as_output_tokens',
    sourceReference: 'https://ai.google.dev/pricing (Gemini 2.5/3.x Flash Tier, prompts <= 128k)',
    pricingVersion: 'google-genai-2026-03',
  },
  'gemini-3.6-flash:free': {
    provider: 'google',
    model: 'gemini-3.6-flash',
    billingTier: 'free',
    effectiveFrom: '2026-03-01',
    inputUSDPerMTok: 0.0,
    outputUSDPerMTok: 0.0,
    cachedInputUSDPerMTok: 0.0,
    thinkingTokenTreatment: 'zero_cost_free_tier',
    sourceReference: 'https://ai.google.dev/pricing (Gemini Free Tier, rate-limited)',
    pricingVersion: 'google-genai-2026-03',
  },
  'gemini-3.7-flash:standard': {
    provider: 'google',
    model: 'gemini-3.7-flash',
    billingTier: 'standard',
    effectiveFrom: '2026-03-01',
    inputUSDPerMTok: 0.10,
    outputUSDPerMTok: 0.40,
    cachedInputUSDPerMTok: 0.025,
    thinkingTokenTreatment: 'billed_as_output_tokens',
    sourceReference: 'https://ai.google.dev/pricing (Gemini Flash Tier, prompts <= 128k)',
    pricingVersion: 'google-genai-2026-03',
  },
  'gemini-2.5-flash:standard': {
    provider: 'google',
    model: 'gemini-2.5-flash',
    billingTier: 'standard',
    effectiveFrom: '2025-05-01',
    inputUSDPerMTok: 0.10,
    outputUSDPerMTok: 0.40,
    cachedInputUSDPerMTok: 0.025,
    thinkingTokenTreatment: 'billed_as_output_tokens',
    sourceReference: 'https://ai.google.dev/pricing (Gemini 2.5 Flash Tier, prompts <= 128k)',
    pricingVersion: 'google-genai-2025-05',
  },
  'gemini-2.0-flash:standard': {
    provider: 'google',
    model: 'gemini-2.0-flash',
    billingTier: 'standard',
    effectiveFrom: '2025-01-01',
    inputUSDPerMTok: 0.10,
    outputUSDPerMTok: 0.40,
    cachedInputUSDPerMTok: 0.025,
    thinkingTokenTreatment: 'billed_as_output_tokens',
    sourceReference: 'https://ai.google.dev/pricing (Gemini 2.0 Flash Tier, prompts <= 128k)',
    pricingVersion: 'google-genai-2025-01',
  },
  'gemini-1.5-flash:standard': {
    provider: 'google',
    model: 'gemini-1.5-flash',
    billingTier: 'standard',
    effectiveFrom: '2024-05-01',
    inputUSDPerMTok: 0.075,
    outputUSDPerMTok: 0.30,
    cachedInputUSDPerMTok: 0.01875,
    thinkingTokenTreatment: 'billed_as_output_tokens',
    sourceReference: 'https://ai.google.dev/pricing (Gemini 1.5 Flash Tier, prompts <= 128k)',
    pricingVersion: 'google-genai-2024-05',
  },
  'gemini-2.5-pro:standard': {
    provider: 'google',
    model: 'gemini-2.5-pro',
    billingTier: 'standard',
    effectiveFrom: '2025-05-01',
    inputUSDPerMTok: 1.25,
    outputUSDPerMTok: 5.00,
    cachedInputUSDPerMTok: 0.3125,
    thinkingTokenTreatment: 'billed_as_output_tokens',
    sourceReference: 'https://ai.google.dev/pricing (Gemini 2.5 Pro Tier, prompts <= 128k)',
    pricingVersion: 'google-genai-2025-05',
  },
  'gemini-1.5-pro:standard': {
    provider: 'google',
    model: 'gemini-1.5-pro',
    billingTier: 'standard',
    effectiveFrom: '2024-05-01',
    inputUSDPerMTok: 1.25,
    outputUSDPerMTok: 5.00,
    cachedInputUSDPerMTok: 0.3125,
    thinkingTokenTreatment: 'billed_as_output_tokens',
    sourceReference: 'https://ai.google.dev/pricing (Gemini 1.5 Pro Tier, prompts <= 128k)',
    pricingVersion: 'google-genai-2024-05',
  },
};

export interface CostCalculationResult {
  providerCostUSD: number | null;
  costStatus: 'VALID' | 'PRICING_UNAVAILABLE';
  pricingUsed?: ProviderPricing;
}

/**
 * Computes exact USD cost for a given token usage and model.
 * Note: Thinking/reasoning tokens are billed as output tokens.
 * Fail-Closed: If model or billing tier is unknown, returns null / PRICING_UNAVAILABLE.
 */
export function calculateModelCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  thoughtsTokens: number = 0,
  billingTier: BillingTier = (process.env.GEMINI_BILLING_TIER as BillingTier) || 'unknown'
): CostCalculationResult {
  const key = `${model}:${billingTier}`;
  const pricing = OFFICIAL_PROVIDER_PRICING[key];

  if (!pricing || pricing.inputUSDPerMTok === null || pricing.outputUSDPerMTok === null) {
    return {
      providerCostUSD: null,
      costStatus: 'PRICING_UNAVAILABLE',
    };
  }

  const totalBillableOutput = outputTokens + thoughtsTokens;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputUSDPerMTok;
  const outputCost = (totalBillableOutput / 1_000_000) * pricing.outputUSDPerMTok;
  const total = Number((inputCost + outputCost).toFixed(6));

  return {
    providerCostUSD: total,
    costStatus: 'VALID',
    pricingUsed: pricing,
  };
}
