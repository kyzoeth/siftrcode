/**
 * Official Model Provider Pricing Definitions
 *
 * Tracks per-token input and output costs for calculating
 * Cost Per Verified Successful Task (CPVST).
 */

export interface ModelPricing {
  provider: 'google' | 'openai' | 'anthropic';
  model: string;
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
  effectiveDate: string;
}

export const PROVIDER_PRICING: Record<string, ModelPricing> = {
  'gemini-1.5-flash': {
    provider: 'google',
    model: 'gemini-1.5-flash',
    inputCostPerMillionTokens: 0.075,
    outputCostPerMillionTokens: 0.30,
    effectiveDate: '2024-05-01',
  },
  'gemini-2.0-flash': {
    provider: 'google',
    model: 'gemini-2.0-flash',
    inputCostPerMillionTokens: 0.10,
    outputCostPerMillionTokens: 0.40,
    effectiveDate: '2025-01-01',
  },
  'gemini-2.5-flash': {
    provider: 'google',
    model: 'gemini-2.5-flash',
    inputCostPerMillionTokens: 0.10,
    outputCostPerMillionTokens: 0.40,
    effectiveDate: '2025-05-01',
  },
  'gemini-1.5-pro': {
    provider: 'google',
    model: 'gemini-1.5-pro',
    inputCostPerMillionTokens: 1.25,
    outputCostPerMillionTokens: 5.00,
    effectiveDate: '2024-05-01',
  },
  'gemini-2.5-pro': {
    provider: 'google',
    model: 'gemini-2.5-pro',
    inputCostPerMillionTokens: 1.25,
    outputCostPerMillionTokens: 5.00,
    effectiveDate: '2025-05-01',
  },
  'gemini-3.6-flash': {
    provider: 'google',
    model: 'gemini-3.6-flash',
    inputCostPerMillionTokens: 0.10,
    outputCostPerMillionTokens: 0.40,
    effectiveDate: '2026-03-01',
  },
  'gemini-3.7-flash': {
    provider: 'google',
    model: 'gemini-3.7-flash',
    inputCostPerMillionTokens: 0.10,
    outputCostPerMillionTokens: 0.40,
    effectiveDate: '2026-03-01',
  },
};

/**
 * Computes exact USD cost for a given token usage and model.
 * Note: Thoughts/reasoning tokens are billed as output tokens.
 */
export function calculateModelCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  thoughtsTokens: number = 0
): number {
  const pricing = PROVIDER_PRICING[model] ?? PROVIDER_PRICING['gemini-3.6-flash'];
  const totalBillableOutput = outputTokens + thoughtsTokens;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPerMillionTokens;
  const outputCost = (totalBillableOutput / 1_000_000) * pricing.outputCostPerMillionTokens;
  return Number((inputCost + outputCost).toFixed(6));
}
