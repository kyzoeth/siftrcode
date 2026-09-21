/**
 * SiftrCode V2 - FinalContextAllocation Contract (Final Closure Directive Section 48 & Milestone Part XVII)
 * Canonical post-degradation and materialization allocation record preserving 3-stage resolution lineage.
 */

import { ContextResolution } from '../context/context_resolution';

export interface ResolutionLineage {
  contextUnitId: string;
  rankerResolution: ContextResolution;
  budgetedResolution: ContextResolution;
  finalResolution: ContextResolution;
}

export interface FinalContextAllocationItem {
  contextUnitId: string;
  plannedResolution: ContextResolution; // backward-compatible alias to budgetedResolution
  actualResolution: ContextResolution;  // backward-compatible alias to finalResolution
  rankerResolution?: ContextResolution;
  budgetedResolution?: ContextResolution;
  finalResolution?: ContextResolution;
  estimatedTokens: number;
  materializerVersion: string;
}

export interface FinalContextAllocation {
  planId: string;
  workspaceSnapshotId: string;
  items: FinalContextAllocationItem[];
  budgetLimitTokens: number;
  allocatedEstimatedTokens: number;
  renderedEstimatedTokens: number;
  providerReportedInputTokens?: number;
  totalEstimatedTokens: number; // backward-compatible alias to renderedEstimatedTokens
  tokenizerMethod: string;
  budgetTokens: number;         // backward-compatible alias to budgetLimitTokens
  overflow: boolean;
  recordedAt: string;
}

export function createFinalContextAllocation(params: {
  planId: string;
  workspaceSnapshotId: string;
  items: FinalContextAllocationItem[];
  budgetLimitTokens?: number;
  allocatedEstimatedTokens?: number;
  renderedEstimatedTokens?: number;
  providerReportedInputTokens?: number;
  totalEstimatedTokens?: number;
  tokenizerMethod: string;
  budgetTokens?: number;
  overflow: boolean;
  recordedAt?: string;
}): FinalContextAllocation {
  const budgetLimit = params.budgetLimitTokens ?? params.budgetTokens ?? 0;
  const renderedEstimate = params.renderedEstimatedTokens ?? params.totalEstimatedTokens ?? 0;
  const allocatedEstimate = params.allocatedEstimatedTokens ?? renderedEstimate;

  const normalizedItems = params.items.map((item) => ({
    ...item,
    rankerResolution: item.rankerResolution ?? item.plannedResolution,
    budgetedResolution: item.budgetedResolution ?? item.plannedResolution,
    finalResolution: item.finalResolution ?? item.actualResolution,
  }));

  return {
    planId: params.planId,
    workspaceSnapshotId: params.workspaceSnapshotId,
    items: normalizedItems,
    budgetLimitTokens: budgetLimit,
    allocatedEstimatedTokens: allocatedEstimate,
    renderedEstimatedTokens: renderedEstimate,
    providerReportedInputTokens: params.providerReportedInputTokens,
    totalEstimatedTokens: renderedEstimate,
    tokenizerMethod: params.tokenizerMethod,
    budgetTokens: budgetLimit,
    overflow: params.overflow,
    recordedAt: params.recordedAt || new Date().toISOString(),
  };
}

