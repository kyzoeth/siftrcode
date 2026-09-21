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

export interface PlannedUnit {
  contextUnitId: string;
  title: string;
  path?: string;
  resolution: ContextResolution;
  content?: string;
  tokenEstimate: number;
  reason: string;
}

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
  dataRights: DataRights;
  estimatedRenderedTokens?: number;
  actualRenderedTokens: number; // Backward-compatible alias for estimatedRenderedTokens
  actualProviderInputTokens?: number; // Measured input tokens reported downstream by LLM provider
  tokenEstimationMethod?: TokenEstimationMethod;
  tokenSafetyMargin?: number;
  overflowReason?: string;
  replanningAttempts?: number;
  createdAt: string;
}

