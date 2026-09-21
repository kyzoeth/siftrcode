/**
 * SiftrCode V2 - ContextPlan Contract
 * Formal output of the ContextEngine containing allocated units, rendered representations, and exposure decisions.
 */

import { ContextResolution } from '../context/context_resolution';
import { BudgetAllocationPlan } from '../context/budget_solver';
import { FormattedContext } from '../agents/agent_adapter';
import { ExposureDecision, ExposureDecisionV2 } from '../telemetry/exposure_decision';
import { DataRights } from '../rights/data_rights';

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
  budgetPlan: BudgetAllocationPlan;
  units: PlannedUnit[];
  formattedContext: FormattedContext;
  exposureDecisions: ExposureDecision[];
  exposureDecisionsV2?: ExposureDecisionV2[];
  policyId?: string;
  policyVersion?: string;
  dataRights: DataRights;
  actualRenderedTokens: number;
  overflowReason?: string;
  createdAt: string;
}

