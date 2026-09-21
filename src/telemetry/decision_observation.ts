import * as crypto from 'crypto';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { ExposureDecisionV2 } from './exposure_decision';
import { AgentEnvironment } from '../agents/agent_environment';
import { ObservabilityLevel } from '../agents/agent_adapter';

export interface CandidateDecisionObservation {
  decisionObservationId: string;
  taskId: string;
  sessionId: string;
  workspaceSnapshotId: string;
  contextUnitId: string;
  candidate: {
    generated: boolean;
    candidateRank?: number;
    retrievalSources: string[];
  };
  features: ContextFeaturesV1;
  rank: number;
  exposureDecision: ExposureDecisionV2;
  policyId: string;
  policyVersion: string;
  agentEnvironment: AgentEnvironment;
  observabilityLevel: ObservabilityLevel;
  recordedAt: string;
}

export function createCandidateDecisionObservation(params: {
  decisionObservationId?: string;
  taskId: string;
  sessionId: string;
  workspaceSnapshotId: string;
  contextUnitId: string;
  candidate: {
    generated: boolean;
    candidateRank?: number;
    retrievalSources: string[];
  };
  features: ContextFeaturesV1;
  rank: number;
  exposureDecision: ExposureDecisionV2;
  policyId?: string;
  policyVersion?: string;
  agentEnvironment: AgentEnvironment;
  observabilityLevel: ObservabilityLevel;
  recordedAt?: string;
}): CandidateDecisionObservation {
  if (!params.sessionId || typeof params.sessionId !== 'string' || params.sessionId.trim().length === 0) {
    throw new Error('CandidateDecisionObservation requires a valid, non-empty sessionId at construction.');
  }

  const decisionObservationId =
    params.decisionObservationId ||
    `cdec_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

  return {
    decisionObservationId,
    taskId: params.taskId,
    sessionId: params.sessionId.trim(),
    workspaceSnapshotId: params.workspaceSnapshotId,
    contextUnitId: params.contextUnitId,
    candidate: {
      generated: params.candidate.generated,
      candidateRank: params.candidate.candidateRank,
      retrievalSources: [...params.candidate.retrievalSources],
    },
    features: params.features,
    rank: params.rank,
    exposureDecision: params.exposureDecision,
    policyId: params.policyId || 'heuristic_ranker_v2',
    policyVersion: params.policyVersion || '2.0.0',
    agentEnvironment: params.agentEnvironment,
    observabilityLevel: params.observabilityLevel,
    recordedAt: params.recordedAt || new Date().toISOString(),
  };
}
