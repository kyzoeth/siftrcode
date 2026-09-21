/**
 * SiftrCode V2 - Rights-Aware Storage DTOs (Audit Section 12)
 *
 * Privacy-by-Default Invariant:
 * When persisting ContextPlans or telemetry to durable SQLite storage,
 * do NOT serialize full source code contents or raw prompts unless the applicable
 * DataRights explicitly permit rawSourceRetentionAllowed or sourceSnippetRetentionAllowed.
 */

import { ContextPlan, PlannedUnit } from '../engine/context_plan';
import { ContextUnit, CodeSymbolUnit, ContextUnitKind } from '../context/context_unit';
import { DataRights, DataClass, isDataClassPermitted } from '../rights/data_rights';
import { TaskContext } from '../context/task_context';
import {
  TaskEvidence,
  TaskEvidenceKind,
  UserPromptEvidence,
  IssueEvidence,
  StackTraceEvidence,
  TestFailureEvidence,
  CompilerErrorEvidence,
  DiffEvidence,
  TicketEvidence,
} from '../context/task_evidence';
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
  const allowSymbolMetadata = isDataClassPermitted(rights, DataClass.SYMBOL_METADATA);
  const allowSymbolName = isDataClassPermitted(rights, DataClass.SYMBOL_NAME);
  const allowPath = isDataClassPermitted(rights, DataClass.PATH);
  const allowPrompt = isDataClassPermitted(rights, DataClass.TASK_PROMPT);
  const allowNumericFeatures = isDataClassPermitted(rights, DataClass.NUMERIC_FEATURE);

  const sanitizedUnits: PlannedUnitMetadata[] = (plan.units || []).map((u) => {
    const unitMeta: PlannedUnitMetadata = {
      contextUnitId: u.contextUnitId,
      resolution: u.resolution,
      tokenEstimate: u.tokenEstimate,
      reason: u.reason,
    };

    if (allowSymbolName) {
      unitMeta.title = u.title;
    }
    if (allowPath) {
      unitMeta.path = u.path;
    }

    if (allowRawSource || allowSnippet) {
      unitMeta.content = u.content;
    }

    return unitMeta;
  });

  const sanitizedFormattedContext: { promptText?: string; totalTokens?: number } = {};
  if (allowPrompt && (allowRawSource || allowSnippet)) {
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
/**
 * Sanitizes a ContextUnit before SQLite insertion, enforcing zero raw source, snippet,
 * path, symbol name, or symbol metadata retention unless permitted by DataRights.
 */
export function sanitizeContextUnitForPersistence(
  unit: ContextUnit,
  rights: DataRights
): ContextUnit {
  const allowRawSource = isDataClassPermitted(rights, DataClass.RAW_SOURCE);
  const allowSnippet = isDataClassPermitted(rights, DataClass.SOURCE_SNIPPET);
  const allowSymbolMetadata = isDataClassPermitted(rights, DataClass.SYMBOL_METADATA);
  const allowSymbolName = isDataClassPermitted(rights, DataClass.SYMBOL_NAME);
  const allowPath = isDataClassPermitted(rights, DataClass.PATH);
  const allowNumeric = isDataClassPermitted(rights, DataClass.NUMERIC_FEATURE);

  const cleanMetadata: Record<string, unknown> = { ...(unit.metadata || {}) };

  // 1. Raw source & snippets
  if (!allowRawSource && !allowSnippet) {
    delete cleanMetadata.rawContent;
    delete cleanMetadata.content;
    delete cleanMetadata.body;
    delete cleanMetadata.snippet;
    delete cleanMetadata.sourceCode;
    delete cleanMetadata.code;
    delete cleanMetadata.text;
  }

  // 2. Path enforcement
  let sanitizedPath = unit.path;
  const cleanProvenance = { ...unit.provenance };
  if (!allowPath) {
    sanitizedPath = undefined;
    delete cleanMetadata.path;
    delete cleanMetadata.filePath;
    delete cleanMetadata.relativePath;
    delete cleanMetadata.targetPath;
    delete cleanMetadata.fullPath;
    delete cleanMetadata.absPath;
    if (cleanProvenance.sourceUri) {
      delete cleanProvenance.sourceUri;
    }
  }

  // 3. Symbol Name enforcement
  let sanitizedTitle = unit.title;
  if (!allowSymbolName) {
    if (unit.kind === ContextUnitKind.CODE_SYMBOL) {
      sanitizedTitle = '[REDACTED_SYMBOL]';
    }
    delete cleanMetadata.symbolName;
    delete cleanMetadata.qualifiedName;
    delete cleanMetadata.functionName;
    delete cleanMetadata.className;
    delete cleanMetadata.identifier;
  }

  // 4. Symbol Metadata enforcement
  if (!allowSymbolMetadata) {
    delete cleanMetadata.ast;
    delete cleanMetadata.astNode;
    delete cleanMetadata.docstring;
    delete cleanMetadata.parameters;
    delete cleanMetadata.returnType;
    delete cleanMetadata.visibility;
    delete cleanMetadata.modifiers;
  }

  // 5. Numeric features
  if (!allowNumeric) {
    delete cleanMetadata.jevScore;
    delete cleanMetadata.semanticRelevanceProbability;
    delete cleanMetadata.implementationNeededProbability;
    delete cleanMetadata.likelyEditTargetProbability;
    delete cleanMetadata.likelyRootCauseProbability;
  }

  const sanitized: ContextUnit = {
    ...unit,
    title: sanitizedTitle,
    path: sanitizedPath,
    provenance: cleanProvenance,
    metadata: cleanMetadata,
  };

  if (!allowRawSource && !allowSnippet) {
    delete (sanitized as any).content;
    delete (sanitized as any).rawContent;
    delete (sanitized as any).body;
    delete (sanitized as any).snippet;
    delete (sanitized as any).sourceCode;
  }

  // If this is a CodeSymbolUnit, enforce on top-level symbol fields
  if (unit.kind === ContextUnitKind.CODE_SYMBOL) {
    const sym = sanitized as CodeSymbolUnit;
    if (!allowSymbolName) {
      sym.symbolName = '[REDACTED_SYMBOL]';
      sym.qualifiedName = '[REDACTED_SYMBOL]';
    }
    if (!allowSymbolMetadata) {
      delete sym.signature;
      delete sym.sourceRange;
      sym.startLine = 0;
      sym.endLine = 0;
    }
  }

  return sanitized;
}

/**
 * Sanitizes a TaskContext before SQLite insertion, guaranteeing that prompts,
 * paths, symbol names, and raw error snippets comply with customer DataRights.
 */
export function sanitizeTaskContextForPersistence(
  task: TaskContext,
  rights: DataRights
): TaskContext {
  const allowPrompt = isDataClassPermitted(rights, DataClass.TASK_PROMPT);
  const allowPath = isDataClassPermitted(rights, DataClass.PATH);
  const allowSymbolName = isDataClassPermitted(rights, DataClass.SYMBOL_NAME);
  const allowRawSource = isDataClassPermitted(rights, DataClass.RAW_SOURCE);
  const allowSnippet = isDataClassPermitted(rights, DataClass.SOURCE_SNIPPET);

  const primaryPrompt = allowPrompt ? task.primaryPrompt : '[REDACTED_PROMPT]';

  const cleanEvidence: TaskEvidence[] = (task.evidence || []).map((ev) => {
    switch (ev.kind) {
      case TaskEvidenceKind.USER_PROMPT: {
        return {
          ...ev,
          prompt: allowPrompt ? (ev as UserPromptEvidence).prompt : '[REDACTED_PROMPT]',
        };
      }
      case TaskEvidenceKind.ISSUE: {
        const issueEv = ev as IssueEvidence;
        return {
          ...issueEv,
          title: allowPrompt ? issueEv.title : '[REDACTED_ISSUE]',
          body: (allowRawSource || allowSnippet) ? issueEv.body : '[REDACTED_BODY]',
          issueUrl: allowPath ? issueEv.issueUrl : undefined,
        };
      }
      case TaskEvidenceKind.STACK_TRACE: {
        const stackEv = ev as StackTraceEvidence;
        return {
          ...stackEv,
          rawTrace: (allowRawSource || allowSnippet) ? stackEv.rawTrace : '[REDACTED_STACK_TRACE]',
          frames: (stackEv.frames || []).map((f) => ({
            ...f,
            file: allowPath ? f.file : '[REDACTED_PATH]',
            functionName: allowSymbolName ? f.functionName : (f.functionName ? '[REDACTED_SYMBOL]' : undefined),
          })),
        };
      }
      case TaskEvidenceKind.TEST_FAILURE: {
        const tfEv = ev as TestFailureEvidence;
        return {
          ...tfEv,
          testFilePath: allowPath ? tfEv.testFilePath : (tfEv.testFilePath ? '[REDACTED_PATH]' : undefined),
          stackTrace: (allowRawSource || allowSnippet) ? tfEv.stackTrace : (tfEv.stackTrace ? '[REDACTED_STACK_TRACE]' : undefined),
          failureMessage: allowPrompt ? tfEv.failureMessage : '[REDACTED_FAILURE_MESSAGE]',
        };
      }
      case TaskEvidenceKind.COMPILER_ERROR: {
        const ceEv = ev as CompilerErrorEvidence;
        return {
          ...ceEv,
          filePath: allowPath ? ceEv.filePath : (ceEv.filePath ? '[REDACTED_PATH]' : undefined),
          message: allowPrompt ? ceEv.message : '[REDACTED_COMPILER_MESSAGE]',
        };
      }
      case TaskEvidenceKind.DIFF: {
        const diffEv = ev as DiffEvidence;
        return {
          ...diffEv,
          patchText: (allowRawSource || allowSnippet) ? diffEv.patchText : '[REDACTED_PATCH]',
          changedFiles: allowPath ? diffEv.changedFiles : diffEv.changedFiles.map(() => '[REDACTED_PATH]'),
        };
      }
      case TaskEvidenceKind.TICKET: {
        const ticketEv = ev as TicketEvidence;
        return {
          ...ticketEv,
          title: allowPrompt ? ticketEv.title : '[REDACTED_TICKET]',
          description: allowPrompt ? ticketEv.description : '[REDACTED_DESCRIPTION]',
        };
      }
      default:
        return { ...ev };
    }
  });

  return {
    ...task,
    primaryPrompt,
    evidence: cleanEvidence,
  };
}
