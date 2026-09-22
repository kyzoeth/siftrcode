/**
 * SiftrCode V2 - ContextPlan Contract
 * Formal output of the ContextEngine containing allocated units, rendered representations, and exposure decisions.
 */

import { ContextResolution } from '../context/context_resolution';
import { BudgetAllocationPlan } from '../context/budget_solver';
import { FormattedContext } from '../agents/agent_adapter';
import { ExposureDecision, ExposureDecisionV2 } from '../telemetry/exposure_decision';
import { CandidateDecisionObservation } from '../telemetry/decision_observation';
import { DataRights } from '../rights/data_rights';
import { TokenEstimationMethod } from '../token/tokenizer_registry';
import { JevSignalV1 } from '../providers/judgment/typesafe/jev_signal';
import { CandidateObservation } from '../learning/episodes/candidate_observation';
import { PreOutcomeEpisodeSnapshot } from '../learning/episodes/pre_outcome_snapshot';

export interface PlannedUnit {
  contextUnitId: string;
  title: string;
  path?: string;
  resolution: ContextResolution;
  content?: string;
  tokenEstimate: number;
  reason: string;
}

export interface ContextPolicyIdentity {
  contextPolicyId: string;
  rankerId: string;
  rankerVersion: string;
  featureSetVersion: string;
  candidateGeneratorVersion: string;
  budgetPolicyVersion: string;
  materializerVersion: string;
}

export const PRODUCTION_V2_POLICY_IDENTITY: ContextPolicyIdentity = {
  contextPolicyId: 'production-v2-deterministic-2026-09',
  rankerId: 'deterministic_context_ranker_v2',
  rankerVersion: '2.0.0',
  featureSetVersion: 'CONTEXT_FEATURES_V1',
  candidateGeneratorVersion: '2.0.0',
  budgetPolicyVersion: '2.0.0',
  materializerVersion: '2.0.0',
};

export interface ContextPlan {
  taskId: string;
  planId: string;
  sessionId?: string;
  workspaceSnapshotId?: string;
  agentEnvironmentId?: string;
  budgetPlan: BudgetAllocationPlan;
  units: PlannedUnit[];
  formattedContext: FormattedContext;
  exposureDecisions: ExposureDecision[];
  exposureDecisionsV2?: ExposureDecisionV2[];
  decisionObservations?: CandidateDecisionObservation[];
  policyId?: string;
  policyVersion?: string;
  contextPolicyIdentity?: ContextPolicyIdentity;
  policyIdentity?: ContextPolicyIdentity;
  contextPolicyId?: string;
  rankerId?: string;
  rankerVersion?: string;
  featureSetVersion?: string;
  candidateGeneratorVersion?: string;
  budgetPolicyVersion?: string;
  materializerVersion?: string;
  dataRights: DataRights;
  estimatedRenderedTokens?: number;
  actualRenderedTokens: number; // Backward-compatible alias for estimatedRenderedTokens
  actualProviderInputTokens?: number; // Measured input tokens reported downstream by LLM provider
  tokenEstimationMethod?: TokenEstimationMethod;
  tokenSafetyMargin?: number;
  overflowReason?: string;
  replanningAttempts?: number;
  candidateUniverse?: CandidateObservation[];
  preOutcomeSnapshot?: PreOutcomeEpisodeSnapshot;
  jevSignals?: JevSignalV1[];
  jevPromise?: Promise<JevSignalV1[]>;
  jevError?: Error;
  generationLatencyMs?: number;
  createdAt: string;
}

