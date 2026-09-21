/**
 * SiftrCode V2 - BudgetSolver (Token & Economic Cost Optimization)
 * Solves constrained allocation optimizing context utility within token and economic budget ceilings.
 */

import { ContextResolution } from './context_resolution';
import { ContextUnit, ContextUnitKind } from './context_unit';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { ResolutionRanker } from './resolution_rank';

export type BudgetProfileName = 'MINIMAL' | 'BALANCED' | 'THOROUGH' | 'MAXIMAL' | 'CUSTOM';

export interface BudgetLimits {
  maxTokens: number;
  maxCostUSD?: number;
  modelName?: string;
}

export const BUDGET_PROFILES: Record<Exclude<BudgetProfileName, 'CUSTOM'>, BudgetLimits> = {
  MINIMAL: { maxTokens: 4000 },
  BALANCED: { maxTokens: 16000 },
  THOROUGH: { maxTokens: 32000 },
  MAXIMAL: { maxTokens: 64000 },
};

// Prompt token cost per 1M tokens in USD
const MODEL_PROMPT_PRICING: Record<string, number> = {
  'claude-3-7-sonnet': 3.0,
  'claude-3-5-sonnet': 3.0,
  'claude-3-opus': 15.0,
  'gpt-4o': 2.5,
  'gpt-4o-mini': 0.15,
  'o1': 15.0,
  'gemini-1.5-pro': 3.5,
  default: 3.0,
};

export function calculateCostUSD(tokens: number, modelName = 'default'): number {
  const normModel = modelName.toLowerCase();
  let ratePerMillion = MODEL_PROMPT_PRICING['default'];

  for (const [key, rate] of Object.entries(MODEL_PROMPT_PRICING)) {
    if (normModel.includes(key)) {
      ratePerMillion = rate;
      break;
    }
  }

  return Number(((tokens / 1_000_000) * ratePerMillion).toFixed(6));
}

export interface SolvedUnitAllocation {
  contextUnitId: string;
  resolution: ContextResolution;
  tokenCost: number;
  rawTokens: number;
  justification: string;
}

export interface BudgetAllocationPlan {
  allocations: SolvedUnitAllocation[];
  totalTokens: number;
  rawTotalTokens: number;
  tokensSaved: number;
  savingsPercentage: number;
  estimatedCostUSD: number;
  baselineCostUSD: number;
  costSavedUSD: number;
  budgetProfile: BudgetProfileName;
}

export class BudgetSolver {
  private resolutionRanker: ResolutionRanker;

  constructor(resolutionRanker?: ResolutionRanker) {
    this.resolutionRanker = resolutionRanker || new ResolutionRanker();
  }

  /**
   * Solves the budget allocation problem for the selected bundle units.
   */
  public solve(params: {
    selectedUnitIds: string[];
    units: Map<string, ContextUnit>;
    features: Map<string, ContextFeaturesV1>;
    limits: BudgetLimits;
    profileName?: BudgetProfileName;
  }): BudgetAllocationPlan {
    const { selectedUnitIds, units, features, limits, profileName = 'CUSTOM' } = params;
    const maxTokens = limits.maxTokens;
    const maxCostUSD = limits.maxCostUSD;
    const modelName = limits.modelName || 'claude-3-7-sonnet';

    // 1. Calculate raw uncompressed baseline
    let rawTotalTokens = 0;
    for (const id of selectedUnitIds) {
      const u = units.get(id);
      const raw = typeof u?.metadata?.tokenEstimate === 'number'
        ? (u.metadata.tokenEstimate as number)
        : features.get(id)?.tokenEstimate || 50;
      rawTotalTokens += raw;
    }

    // 2. Initial resolution allocation using budget pressure
    const budgetPressure = maxTokens > 0 ? rawTotalTokens / maxTokens : 1.0;
    const currentAllocations = new Map<string, SolvedUnitAllocation>();

    for (let i = 0; i < selectedUnitIds.length; i++) {
      const id = selectedUnitIds[i];
      const u = units.get(id);
      const f = features.get(id);
      if (!u || !f) continue;

      const isPriority = i === 0 || f.inStackTrace || f.inDirtyDiff;
      const alloc = this.resolutionRanker.allocateResolution(u, f, isPriority, budgetPressure);

      const raw = (typeof u.metadata?.tokenEstimate === 'number' && u.metadata.tokenEstimate > 0)
        ? (u.metadata.tokenEstimate as number)
        : (f.tokenEstimate || 50);

      currentAllocations.set(id, {
        contextUnitId: id,
        resolution: alloc.resolution,
        tokenCost: alloc.tokenEstimate,
        rawTokens: raw,
        justification: alloc.justification,
      });
    }

    // 3. Constrained optimization loop: if total tokens exceed budget or cost ceiling, progressively degrade non-edit units
    const isEditTarget = (id: string): boolean => {
      const f = features.get(id);
      return Boolean(f?.inStackTrace || f?.inDirtyDiff || f?.isFailingTestTarget || f?.inCompilerError);
    };

    let totalTokens = Array.from(currentAllocations.values()).reduce((sum, a) => sum + a.tokenCost, 0);
    let currentCostUSD = calculateCostUSD(totalTokens, modelName);

    // Progressive degradation steps: BODY -> SKELETON -> SIGNATURE -> NAME -> OMIT
    const degradationOrder: ContextResolution[] = [
      ContextResolution.BODY,
      ContextResolution.SKELETON,
      ContextResolution.SIGNATURE,
      ContextResolution.NAME,
      ContextResolution.OMIT,
    ];

    // Sort candidate IDs for degradation by lowest heuristic score first
    const degradationCandidates = [...selectedUnitIds]
      .filter((id) => !isEditTarget(id))
      .sort((a, b) => (features.get(a)?.heuristicScore || 0) - (features.get(b)?.heuristicScore || 0));

    for (const targetRes of degradationOrder) {
      if (totalTokens <= maxTokens && (!maxCostUSD || currentCostUSD <= maxCostUSD)) {
        break;
      }

      for (const id of degradationCandidates) {
        if (totalTokens <= maxTokens && (!maxCostUSD || currentCostUSD <= maxCostUSD)) {
          break;
        }

        const alloc = currentAllocations.get(id);
        if (!alloc || alloc.resolution <= targetRes) continue;

        const u = units.get(id);
        const isSkeletonUnsafe =
          u &&
          (u.metadata?.skeletonSafety === 'UNSAFE' ||
            u.kind === ContextUnitKind.CONFIG ||
            u.kind === ContextUnitKind.LOCKFILE ||
            u.kind === ContextUnitKind.SCHEMA ||
            u.kind === ContextUnitKind.MIGRATION ||
            u.kind === ContextUnitKind.DOCUMENTATION ||
            u.metadata?.hasDecorators === true ||
            u.metadata?.hasMacros === true ||
            u.metadata?.isModuleInit === true ||
            u.metadata?.isModuleInitialization === true);

        // Section 38: If skeleton safety is UNSAFE, SKELETON must never be selected
        if (targetRes === ContextResolution.SKELETON && isSkeletonUnsafe) {
          continue;
        }

        const newCost = this.resolutionRanker.estimateTokensForResolution(alloc.rawTokens, targetRes);
        const tokensFreed = alloc.tokenCost - newCost;

        alloc.resolution = targetRes;
        alloc.tokenCost = newCost;
        alloc.justification = `budget_solver_degraded_to_${targetRes}`;

        totalTokens -= tokensFreed;
        currentCostUSD = calculateCostUSD(totalTokens, modelName);
      }
    }

    // Invariant verification: Ensure no unit is assigned an unsafe resolution
    for (const alloc of currentAllocations.values()) {
      const u = units.get(alloc.contextUnitId);
      if (!u) continue;
      if (alloc.resolution === ContextResolution.SKELETON) {
        const isSkeletonUnsafe =
          u.metadata?.skeletonSafety === 'UNSAFE' ||
          u.kind === ContextUnitKind.CONFIG ||
          u.kind === ContextUnitKind.LOCKFILE ||
          u.kind === ContextUnitKind.SCHEMA ||
          u.kind === ContextUnitKind.MIGRATION ||
          u.kind === ContextUnitKind.DOCUMENTATION ||
          u.metadata?.hasDecorators === true ||
          u.metadata?.hasMacros === true ||
          u.metadata?.isModuleInit === true ||
          u.metadata?.isModuleInitialization === true;

        if (isSkeletonUnsafe) {
          alloc.resolution = ContextResolution.SIGNATURE;
          alloc.tokenCost = this.resolutionRanker.estimateTokensForResolution(alloc.rawTokens, ContextResolution.SIGNATURE);
          alloc.justification = 'resolution_capabilities_enforced_signature';
        }
      }
    }

    const tokensSaved = Math.max(0, rawTotalTokens - totalTokens);
    const savingsPercentage = rawTotalTokens > 0
      ? Number(((tokensSaved / rawTotalTokens) * 100).toFixed(1))
      : 0;

    const baselineCostUSD = calculateCostUSD(rawTotalTokens, modelName);
    const costSavedUSD = Number(Math.max(0, baselineCostUSD - currentCostUSD).toFixed(6));

    return {
      allocations: Array.from(currentAllocations.values()),
      totalTokens,
      rawTotalTokens,
      tokensSaved,
      savingsPercentage,
      estimatedCostUSD: currentCostUSD,
      baselineCostUSD,
      costSavedUSD,
      budgetProfile: profileName,
    };
  }
}
