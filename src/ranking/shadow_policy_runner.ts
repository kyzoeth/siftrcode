/**
 * SiftrCode V2 - Shadow Policy Framework (Phase 20P)
 *
 * Infrastructure for evaluating experimental/shadow ranking policies alongside
 * the production deterministic ContextRanker on identical candidate sets.
 *
 * Invariants:
 * 1. Shadow plan must NOT affect agent-visible context.
 * 2. Shadow plan must NOT affect production outcome.
 * 3. Shadow execution must NOT add significant user latency or cause production failures.
 * 4. Shadow plan maintains independent provenance.
 * 5. Production V2 remains the active default.
 */

import { ContextPlan } from '../engine/context_plan';
import { CandidateObservation } from '../learning/episodes/candidate_observation';

export interface ShadowPolicyComparison {
  taskId: string;
  productionPolicyId: string;
  shadowPolicyId: string;
  candidateCount: number;
  topK: number;
  rankOverlapJaccard: number; // [0.0, 1.0] intersection / union of top-k
  topKDifferences: {
    inProductionOnly: string[];
    inShadowOnly: string[];
    sharedTopKCount: number;
  };
  inclusionDifferences: {
    inProductionOnly: string[];
    inShadowOnly: string[];
    sharedInclusionCount: number;
  };
  resolutionDifferences: Array<{
    contextUnitId: string;
    productionResolution: string;
    shadowResolution: string;
  }>;
  tokenDifference: number; // shadowTokens - productionTokens
  productionTokens: number;
  shadowTokens: number;
  shadowLatencyMs: number;
  evaluatedAt: string;
}

export interface ShadowRanker {
  readonly rankerId: string;
  readonly rankerVersion: string;
  rank(candidates: CandidateObservation[], tokenBudget: number): Promise<{
    rankedCandidates: CandidateObservation[];
    selectedUnitIds: string[];
    allocatedTokens: number;
    resolutions?: Record<string, string>;
  }>;
}

export class ShadowPolicyRunner {
  private shadowRanker?: ShadowRanker;

  constructor(shadowRanker?: ShadowRanker) {
    this.shadowRanker = shadowRanker;
  }

  public setShadowRanker(shadowRanker: ShadowRanker): void {
    this.shadowRanker = shadowRanker;
  }

  public getShadowRanker(): ShadowRanker | undefined {
    return this.shadowRanker;
  }

  /**
   * Compares a shadow ranking policy against the authoritative production plan.
   * Guaranteed to NOT alter the production context plan in any way.
   */
  public async evaluateShadowPolicy(
    productionPlan: ContextPlan,
    candidates: CandidateObservation[],
    topK: number = 10
  ): Promise<ShadowPolicyComparison | null> {
    if (!this.shadowRanker) {
      return null;
    }

    const start = Date.now();
    try {
      const budget = productionPlan.budgetPlan?.totalTokens || 8000;
      const shadowResult = await this.shadowRanker.rank(candidates, budget);
      const latencyMs = Date.now() - start;

      // Extract production top-k and selected
      const prodSelectedIds = new Set(productionPlan.units.map((u) => u.contextUnitId));
      const sortedProdCandidates = [...candidates].sort((a, b) => a.finalRank - b.finalRank);
      const prodTopKIds = sortedProdCandidates.slice(0, topK).map((c) => c.contextUnitId);

      // Extract shadow top-k and selected
      const shadowSelectedIds = new Set(shadowResult.selectedUnitIds);
      const sortedShadowCandidates = [...shadowResult.rankedCandidates].sort(
        (a, b) => a.finalRank - b.finalRank
      );
      const shadowTopKIds = sortedShadowCandidates.slice(0, topK).map((c) => c.contextUnitId);

      // Rank overlap calculation (Jaccard of top-k sets)
      const prodTopKSet = new Set(prodTopKIds);
      const shadowTopKSet = new Set(shadowTopKIds);

      const intersectionTopK = prodTopKIds.filter((id) => shadowTopKSet.has(id));
      const unionTopK = new Set([...prodTopKIds, ...shadowTopKIds]);
      const rankOverlapJaccard =
        unionTopK.size > 0
          ? Math.round((intersectionTopK.length / unionTopK.size) * 1000) / 1000
          : 1.0;

      const topKInProdOnly = prodTopKIds.filter((id) => !shadowTopKSet.has(id));
      const topKInShadowOnly = shadowTopKIds.filter((id) => !prodTopKSet.has(id));

      const incInProdOnly = Array.from(prodSelectedIds).filter((id) => !shadowSelectedIds.has(id));
      const incInShadowOnly = Array.from(shadowSelectedIds).filter((id) => !prodSelectedIds.has(id));
      const sharedInclusion = Array.from(prodSelectedIds).filter((id) => shadowSelectedIds.has(id));

      // Resolution differences
      const resolutionDifferences: Array<{
        contextUnitId: string;
        productionResolution: string;
        shadowResolution: string;
      }> = [];

      if (shadowResult.resolutions) {
        for (const u of productionPlan.units) {
          const shadowRes = shadowResult.resolutions[u.contextUnitId];
          const prodRes = String(u.resolution);
          if (shadowRes && shadowRes !== prodRes) {
            resolutionDifferences.push({
              contextUnitId: u.contextUnitId,
              productionResolution: prodRes,
              shadowResolution: shadowRes,
            });
          }
        }
      }

      const prodTokens = productionPlan.actualRenderedTokens || 0;
      const shadowTokens = shadowResult.allocatedTokens || 0;

      return {
        taskId: productionPlan.taskId,
        productionPolicyId:
          productionPlan.contextPolicyIdentity?.contextPolicyId ||
          productionPlan.contextPolicyId ||
          'production-v2-deterministic-2026-09',
        shadowPolicyId: this.shadowRanker.rankerId,
        candidateCount: candidates.length,
        topK,
        rankOverlapJaccard,
        topKDifferences: {
          inProductionOnly: topKInProdOnly,
          inShadowOnly: topKInShadowOnly,
          sharedTopKCount: intersectionTopK.length,
        },
        inclusionDifferences: {
          inProductionOnly: incInProdOnly,
          inShadowOnly: incInShadowOnly,
          sharedInclusionCount: sharedInclusion.length,
        },
        resolutionDifferences,
        tokenDifference: shadowTokens - prodTokens,
        productionTokens: prodTokens,
        shadowTokens,
        shadowLatencyMs: latencyMs,
        evaluatedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.warn('[ShadowPolicyRunner] Error during shadow policy execution:', err);
      return null;
    }
  }
}
