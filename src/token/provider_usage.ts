/**
 * SiftrCode V2 - ProviderUsageEvent Contract (Final Closure Directive Section 50)
 * Immutable event recording actual downstream provider-reported token usage.
 */

import * as crypto from 'crypto';

export interface ProviderUsageEvent {
  eventId: string;
  sessionId: string;
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens?: number | null;
  costUsd?: number | null;
  timestamp: string;
}

export function createProviderUsageEvent(params: {
  eventId?: string;
  sessionId: string;
  provider: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  costUsd?: number | null;
  timestamp?: string;
}): ProviderUsageEvent {
  return {
    eventId: params.eventId || `pusage_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.model ?? null,
    inputTokens: params.inputTokens ?? null,
    outputTokens: params.outputTokens ?? null,
    cachedInputTokens: params.cachedInputTokens ?? null,
    costUsd: params.costUsd ?? null,
    timestamp: params.timestamp || new Date().toISOString(),
  };
}
