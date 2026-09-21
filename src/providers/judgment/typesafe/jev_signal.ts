/**
 * SiftrCode V2 - JevSignalV1 & Fallback Reasons (Milestone Part X Sections 26-27)
 * Preserves continuous probabilities, provider metadata, and fallback reasons without boolean thresholding.
 */

export enum JevMode {
  OFF = 'OFF',
  SHADOW = 'SHADOW',
  ACTIVE = 'ACTIVE',
}

export enum JevFallbackReason {
  NO_API_KEY = 'NO_API_KEY',
  DISABLED = 'DISABLED',
  RIGHTS_DENIED = 'RIGHTS_DENIED',
  TRUST_DENIED = 'TRUST_DENIED',
  BUDGET_EXHAUSTED = 'BUDGET_EXHAUSTED',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  MALFORMED_RESPONSE = 'MALFORMED_RESPONSE',
}

export interface JevSignalV1 {
  schemaVersion: 'jev-signal-v1';
  taskId: string;
  sessionId?: string;
  workspaceSnapshotId: string;
  agentEnvironmentId?: string;
  contextUnitId: string;
  contextPlanId?: string;
  semanticRelevanceProbability: number | null;
  implementationNeededProbability: number | null;
  likelyEditTargetProbability: number | null;
  likelyRootCauseProbability: number | null;
  model: string | null;
  questionSetVersion: string;
  provider: 'typesafe-jev';
  requestId?: string;
  latencyMs: number;
  inputTokens?: number;
  providerReportedConfidence?: Record<string, number>;
  redactionApplied: boolean;
  fallbackReason?: JevFallbackReason;
  createdAt: string;
}

export function createJevSignalV1(params: Omit<JevSignalV1, 'schemaVersion' | 'provider' | 'createdAt'> & {
  createdAt?: string;
}): JevSignalV1 {
  return {
    ...params,
    schemaVersion: 'jev-signal-v1',
    provider: 'typesafe-jev',
    agentEnvironmentId: params.agentEnvironmentId || 'unknown',
    createdAt: params.createdAt || new Date().toISOString(),
  };
}
