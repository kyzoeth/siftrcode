/**
 * SiftrCode V2 - Rights-Aware Storage DTOs (Audit Section 12)
 *
 * Privacy-by-Default Invariant:
 * When persisting ContextPlans or telemetry to durable SQLite storage,
 * do NOT serialize full source code contents or raw prompts unless the applicable
 * DataRights explicitly permit rawSourceRetentionAllowed or sourceSnippetRetentionAllowed.
 */

import { ContextPlan, PlannedUnit } from '../engine/context_plan';
import { ContextUnit } from '../context/context_unit';
import { DataRights, DataClass, isDataClassPermitted } from '../rights/data_rights';
import { ContextResolution } from '../context/context_resolution';
import { BudgetAllocationPlan } from '../context/budget_solver';
import { ExposureDecision, ExposureDecisionV2 } from '../telemetry/exposure_decision';
import { CandidateDecisionObservation } from '../telemetry/decision_observation';
import { TokenEstimationMethod } from '../token/tokenizer_registry';

export interface PlannedUnitMetadata {
  contextUnitId: string;
  resolution: ContextResolution;
  tokenEstimate: number;
  reason: string;
  title?: string;
  path?: string;
  content?: string;
}

export interface ContextPlanMetadataRecord {
  planId: string;
  taskId: string;
  sessionId?: string;
  snapshotId: string;
  workspaceSnapshotId?: string;
  agentEnvironmentId?: string;
  budgetPlan: BudgetAllocationPlan;
  units: PlannedUnitMetadata[];
  formattedContext: {
    promptText?: string;
    totalTokens?: number;
  };
  exposureDecisions: ExposureDecision[];
  exposureDecisionsV2?: ExposureDecisionV2[];
  decisionObservations?: CandidateDecisionObservation[];
  policyId?: string;
  policyVersion?: string;
  dataRights: DataRights;
  estimatedRenderedTokens?: number;
  actualRenderedTokens: number;
  actualProviderInputTokens?: number;
  tokenEstimationMethod?: TokenEstimationMethod;
  tokenSafetyMargin?: number;
  overflowReason?: string;
  replanningAttempts?: number;
  createdAt: string;
}

/**
 * Sanitizes a ContextPlan before SQLite insertion, guaranteeing zero raw source retention
 * unless customer explicitly grants permissions.
 */
export function sanitizeContextPlanForPersistence(
  plan: ContextPlan,
  rights: DataRights,
  snapshotId: string = 'default'
): ContextPlanMetadataRecord {
  const allowRawSource = isDataClassPermitted(rights, DataClass.RAW_SOURCE);
  const allowSnippet = isDataClassPermitted(rights, DataClass.SOURCE_SNIPPET);
  const allowSymbolMetadata = isDataClassPermitted(rights, DataClass.SYMBOL_NAME);
  const allowNumericFeatures = isDataClassPermitted(rights, DataClass.NUMERIC_FEATURE);

  const sanitizedUnits: PlannedUnitMetadata[] = (plan.units || []).map((u) => {
    const unitMeta: PlannedUnitMetadata = {
      contextUnitId: u.contextUnitId,
      resolution: u.resolution,
      tokenEstimate: u.tokenEstimate,
      reason: u.reason,
    };

    if (allowSymbolMetadata) {
      unitMeta.title = u.title;
      unitMeta.path = u.path;
    }

    if (allowRawSource || allowSnippet) {
      unitMeta.content = u.content;
    }

    return unitMeta;
  });

  const sanitizedFormattedContext: { promptText?: string; totalTokens?: number } = {};
  if (allowRawSource || allowSnippet) {
    sanitizedFormattedContext.promptText = plan.formattedContext?.promptText;
  }
  if (plan.formattedContext && 'totalTokens' in plan.formattedContext) {
    sanitizedFormattedContext.totalTokens = (plan.formattedContext as any).totalTokens;
  }

  let sanitizedDecisionObservations = plan.decisionObservations;
  if (sanitizedDecisionObservations && !allowNumericFeatures) {
    sanitizedDecisionObservations = sanitizedDecisionObservations.map((obs) => ({
      ...obs,
      features: {
        schemaVersion: obs.features.schemaVersion,
        contextUnitId: obs.features.contextUnitId,
      } as any,
    }));
  }

  return {
    planId: plan.planId,
    taskId: plan.taskId,
    sessionId: plan.sessionId,
    workspaceSnapshotId: plan.workspaceSnapshotId || snapshotId,
    snapshotId: plan.workspaceSnapshotId || snapshotId,
    agentEnvironmentId: plan.agentEnvironmentId,
    budgetPlan: plan.budgetPlan,
    units: sanitizedUnits,
    formattedContext: sanitizedFormattedContext,
    exposureDecisions: plan.exposureDecisions,
    exposureDecisionsV2: plan.exposureDecisionsV2,
    decisionObservations: sanitizedDecisionObservations,
    policyId: plan.policyId,
    policyVersion: plan.policyVersion,
    dataRights: rights,
    estimatedRenderedTokens: plan.estimatedRenderedTokens,
    actualRenderedTokens: plan.actualRenderedTokens,
    actualProviderInputTokens: plan.actualProviderInputTokens,
    tokenEstimationMethod: plan.tokenEstimationMethod,
    tokenSafetyMargin: plan.tokenSafetyMargin,
    overflowReason: plan.overflowReason,
    replanningAttempts: plan.replanningAttempts,
    createdAt: plan.createdAt,
  };
}

/**
 * Sanitizes a ContextUnit before SQLite insertion, guaranteeing zero raw source or snippet retention
 * unless customer explicitly grants permissions.
 */
export function sanitizeContextUnitForPersistence(
  unit: ContextUnit,
  rights: DataRights
): ContextUnit {
  const allowRawSource = isDataClassPermitted(rights, DataClass.RAW_SOURCE);
  const allowSnippet = isDataClassPermitted(rights, DataClass.SOURCE_SNIPPET);
  const allowSymbolMetadata = isDataClassPermitted(rights, DataClass.SYMBOL_NAME);
  const allowPath = isDataClassPermitted(rights, DataClass.PATH);

  const cleanMetadata: Record<string, unknown> = { ...(unit.metadata || {}) };

  if (!allowRawSource && !allowSnippet) {
    delete cleanMetadata.rawContent;
    delete cleanMetadata.content;
    delete cleanMetadata.body;
    delete cleanMetadata.snippet;
    delete cleanMetadata.sourceCode;
    delete cleanMetadata.code;
    delete cleanMetadata.text;
  }

  const sanitized: ContextUnit = {
    ...unit,
    title: unit.title,
    path: unit.path,
    metadata: cleanMetadata,
  };

  if (!allowRawSource && !allowSnippet) {
    if ('content' in sanitized) {
      delete (sanitized as any).content;
    }
    if ('rawContent' in sanitized) {
      delete (sanitized as any).rawContent;
    }
    if ('body' in sanitized) {
      delete (sanitized as any).body;
    }
    if ('snippet' in sanitized) {
      delete (sanitized as any).snippet;
    }
    if ('sourceCode' in sanitized) {
      delete (sanitized as any).sourceCode;
    }
  }

  return sanitized;
}
