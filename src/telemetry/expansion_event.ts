/**
 * SiftrCode V2 - ContextExpansionEvent Contract (Final Closure Directive Section 13, 46, 47)
 * Immutable audit trail recording runtime expansion requests and fallback reasons without modifying historical plans.
 */

import * as crypto from 'crypto';
import { ContextResolution } from '../context/context_resolution';

export enum ExpansionReason {
  AGENT_EXPLICIT_REQUEST = 'AGENT_EXPLICIT_REQUEST',
  SIFTR_POLICY = 'SIFTR_POLICY',
  TOOL_ERROR_RECOVERY = 'TOOL_ERROR_RECOVERY',
  DEBUGGING = 'DEBUGGING',
  USER_REQUEST = 'USER_REQUEST',
  UNKNOWN = 'UNKNOWN',
}

export interface ContextExpansionEvent {
  eventId: string;
  taskId: string;
  sessionId: string;
  contextPlanId: string;
  workspaceSnapshotId: string;
  agentEnvironmentId: string;
  contextUnitId: string;
  previousResolution: ContextResolution | null;
  requestedResolution: ContextResolution;
  actualResolution: ContextResolution;
  tokenEstimate: number;
  fallbackReason?: string;
  reason: ExpansionReason;
  timestamp: string;
}

export function createContextExpansionEvent(params: {
  eventId?: string;
  taskId: string;
  sessionId: string;
  contextPlanId: string;
  workspaceSnapshotId: string;
  agentEnvironmentId: string;
  contextUnitId: string;
  previousResolution?: ContextResolution | null;
  requestedResolution: ContextResolution;
  actualResolution: ContextResolution;
  tokenEstimate: number;
  fallbackReason?: string;
  reason?: ExpansionReason;
  timestamp?: string;
}): ContextExpansionEvent {
  return {
    eventId: params.eventId || `exp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    taskId: params.taskId,
    sessionId: params.sessionId,
    contextPlanId: params.contextPlanId,
    workspaceSnapshotId: params.workspaceSnapshotId,
    agentEnvironmentId: params.agentEnvironmentId,
    contextUnitId: params.contextUnitId,
    previousResolution: params.previousResolution ?? null,
    requestedResolution: params.requestedResolution,
    actualResolution: params.actualResolution,
    tokenEstimate: params.tokenEstimate,
    fallbackReason: params.fallbackReason,
    reason: params.reason || ExpansionReason.AGENT_EXPLICIT_REQUEST,
    timestamp: params.timestamp || new Date().toISOString(),
  };
}
