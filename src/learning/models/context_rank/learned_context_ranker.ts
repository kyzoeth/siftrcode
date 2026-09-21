/**
 * SiftrCode V3 - Learned Context Ranker Interface & Safe Fallback (Phase V3.1F)
 *
 * Invariants:
 * 1. Model failure (load error, exception, NaN, timeout) MUST fall back safely
 *    to deterministic V2 ContextRanker with zero disruption.
 * 2. Deterministic ordering: identical inputs return identical rankings.
 * 3. Tie-breaking is explicit: finalScore DESC, contextUnitId ASC.
 */

import { TaskContext } from '../../../context/task_context';
import { Candidate } from '../../../retrieval/candidate';
import { ContextFeaturesV3_1 } from '../../features/feature_set_v3_1';
import { ContextRanker, RankedCandidate } from '../../../ranking/context_rank';
import { ContextFeaturesV1 } from '../../../ranking/feature_schema';

export interface ScoredCandidate {
  contextUnitId: string;
  finalScore: number;
  rank: number;
  modelId: string;
  fallbackUsed: boolean;
  scoreBreakdown?: Record<string, number>;
  reasons: string[];
}

export interface LearnedContextRanker {
  modelId: string;
  modelType: string;
  featureSetVersion: string;
  score(
    task: TaskContext,
    candidates: Candidate[],
    features: ContextFeaturesV3_1[]
  ): Promise<ScoredCandidate[]>;
}

export class SafeFallbackRanker implements LearnedContextRanker {
  public readonly modelId: string;
  public readonly modelType: string;
  public readonly featureSetVersion: string;
  private primaryRanker: LearnedContextRanker;
  private fallbackRanker: ContextRanker;

  constructor(primaryRanker: LearnedContextRanker) {
    this.primaryRanker = primaryRanker;
    this.modelId = `safe_${primaryRanker.modelId}`;
    this.modelType = primaryRanker.modelType;
    this.featureSetVersion = primaryRanker.featureSetVersion;
    this.fallbackRanker = new ContextRanker();
  }

  public async score(
    task: TaskContext,
    candidates: Candidate[],
    features: ContextFeaturesV3_1[]
  ): Promise<ScoredCandidate[]> {
    try {
      const results = await this.primaryRanker.score(task, candidates, features);

      // Validate output integrity
      if (!Array.isArray(results) || results.length !== features.length) {
        throw new Error(`Incomplete output from primary ranker: got ${results?.length}, expected ${features.length}`);
      }

      for (const r of results) {
        if (typeof r.finalScore !== 'number' || Number.isNaN(r.finalScore) || !Number.isFinite(r.finalScore)) {
          throw new Error(`Invalid non-finite score for unit ${r.contextUnitId}: ${r.finalScore}`);
        }
      }

      // Enforce deterministic sorting: finalScore DESC, contextUnitId ASC
      results.sort((a, b) => {
        if (b.finalScore !== a.finalScore) {
          return b.finalScore - a.finalScore;
        }
        return a.contextUnitId.localeCompare(b.contextUnitId);
      });

      return results.map((r, idx) => ({ ...r, rank: idx + 1 }));
    } catch (err: any) {
      console.warn(`⚠️ [LearnedContextRanker Fallback] Primary model "${this.primaryRanker.modelId}" failed: ${err?.message || err}. Falling back to deterministic V2 ContextRank.`);
      return this.executeV2Fallback(features);
    }
  }

  private executeV2Fallback(features: ContextFeaturesV3_1[]): ScoredCandidate[] {
    // Map ContextFeaturesV3_1 to ContextFeaturesV1 for deterministic V2 ranker
    const v1Features: ContextFeaturesV1[] = features.map((f) => ({
      schemaVersion: 'v1',
      contextUnitId: f.contextUnitId,
      unitKind: f.unitKind,
      tokenEstimate: f.tokenEstimate,
      isTest: f.isTest,
      isConfig: f.isConfig,
      isDocumentation: f.isDocumentation,
      isSchema: f.isSchema,
      isExported: f.isExported,
      exactSymbolMatch: f.exactSymbolMatch,
      exactPathMatch: f.exactPathMatch,
      bm25Score: f.bm25Score,
      tokenOverlapRatio: f.tokenOverlapRatio,
      graphDegree: f.graphDegree,
      minDistanceToSeed: f.minDistanceToSeed,
      minDistanceToErrorFrame: f.minDistanceToErrorFrame,
      isDirectDependency: f.isDirectDependency,
      isDirectDependent: f.isDirectDependent,
      changeFrequency: f.changeFrequency,
      recentChangeFrequency: f.recentChangeFrequency,
      maxCoChangeWithSeeds: f.maxCoChangeWithSeeds,
      inStackTrace: f.inStackTrace,
      isFailingTestTarget: f.isFailingTestTarget,
      inCompilerError: f.inCompilerError,
      inDirtyDiff: f.inDirtyDiff,
      heuristicScore: f.heuristicScore,
    }));

    const v2Ranked = this.fallbackRanker.rank(v1Features);

    return v2Ranked.map((item: RankedCandidate) => ({
      contextUnitId: item.contextUnitId,
      finalScore: item.finalScore,
      rank: item.rank,
      modelId: 'deterministic_v2_fallback',
      fallbackUsed: true,
      scoreBreakdown: item.scoreBreakdown as any,
      reasons: [...item.reasons, 'fallback_to_v2_deterministic'],
    }));
  }
}
