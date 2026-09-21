/**
 * SiftrCode V2 - FinalContextAllocation Contract (Final Closure Directive Section 48)
 * Canonical post-degradation and materialization allocation record.
 */

import { ContextResolution } from '../context/context_resolution';

export interface FinalContextAllocationItem {
  contextUnitId: string;
  plannedResolution: ContextResolution;
  actualResolution: ContextResolution;
  estimatedTokens: number;
  materializerVersion: string;
}

export interface FinalContextAllocation {
  planId: string;
  workspaceSnapshotId: string;
  items: FinalContextAllocationItem[];
  totalEstimatedTokens: number;
  tokenizerMethod: string;
  budgetTokens: number;
  overflow: boolean;
  recordedAt: string;
}

export function createFinalContextAllocation(params: {
  planId: string;
  workspaceSnapshotId: string;
  items: FinalContextAllocationItem[];
  totalEstimatedTokens: number;
  tokenizerMethod: string;
  budgetTokens: number;
  overflow: boolean;
  recordedAt?: string;
}): FinalContextAllocation {
  return {
    ...params,
    recordedAt: params.recordedAt || new Date().toISOString(),
  };
}
