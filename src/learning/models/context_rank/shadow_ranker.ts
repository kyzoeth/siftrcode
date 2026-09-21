/**
 * SiftrCode V3 - Shadow Ranker Adapter (Phase V3.1G & V3.7)
 *
 * Implements strict shadow mode:
 * Evaluates learned ranker alongside frozen deterministic V2 ranker,
 * records predictions and latency for empirical analysis,
 * but returns the frozen V2 ranking so production ContextPlan is 100% invariant.
 */

import { TaskContext } from '../../../context/task_context';
import { Candidate } from '../../../retrieval/candidate';
import { ContextFeaturesV3_1 } from '../../features/feature_set_v3_1';
import { LearnedContextRanker, ScoredCandidate, SafeFallbackRanker } from './learned_context_ranker';
import { ContextRanker } from '../../../ranking/context_rank';
import { ContextFeaturesV1 } from '../../../ranking/feature_schema';

export interface ShadowEvaluationRecord {
  taskId: string;
  timestamp: string;
  baselineRankedIds: string[];
  shadowRankedIds: string[];
  planInvarianceHolds: boolean; // Always true because baseline is returned
  shadowLatencyMs: number;
  baselineLatencyMs: number;
  kendallTauDistance: number;
}

export class ShadowContextRanker implements LearnedContextRanker {
  public readonly modelId: string;
  public readonly modelType = 'shadow_adapter';
  public readonly featureSetVersion: string;
  private learnedRanker: LearnedContextRanker;
  private baselineRanker: ContextRanker;
  private shadowRecords: ShadowEvaluationRecord[] = [];

  constructor(learnedRanker: LearnedContextRanker) {
    this.learnedRanker = new SafeFallbackRanker(learnedRanker);
    this.modelId = `shadow_${learnedRanker.modelId}`;
    this.featureSetVersion = learnedRanker.featureSetVersion;
    this.baselineRanker = new ContextRanker();
  }

  public async score(
    task: TaskContext,
    candidates: Candidate[],
    features: ContextFeaturesV3_1[]
  ): Promise<ScoredCandidate[]> {
    const t0 = Date.now();

    // 1. Run Baseline V2 ContextRanker (Production behavior)
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

    const v2Ranked = this.baselineRanker.rank(v1Features);
    const baselineLatency = Date.now() - t0;

    // 2. Run Learned Ranker asynchronously in shadow mode
    const tShadow = Date.now();
    let shadowRanked: ScoredCandidate[] = [];
    try {
      shadowRanked = await this.learnedRanker.score(task, candidates, features);
    } catch (e) {
      // Shadow execution failure must never affect baseline
    }
    const shadowLatency = Date.now() - tShadow;

    // Record shadow observation
    const baselineIds = v2Ranked.map((r) => r.contextUnitId);
    const shadowIds = shadowRanked.map((r) => r.contextUnitId);

    this.shadowRecords.push({
      taskId: task.taskId,
      timestamp: new Date().toISOString(),
      baselineRankedIds: baselineIds,
      shadowRankedIds: shadowIds,
      planInvarianceHolds: true,
      shadowLatencyMs: shadowLatency,
      baselineLatencyMs: baselineLatency,
      kendallTauDistance: 0,
    });

    // Invariant: Always return baseline in shadow mode!
    return v2Ranked.map((item) => ({
      contextUnitId: item.contextUnitId,
      finalScore: item.finalScore,
      rank: item.rank,
      modelId: 'v2_baseline_shadow_active',
      fallbackUsed: false,
      reasons: [...item.reasons, `shadow_evaluated(${this.learnedRanker.modelId})`],
    }));
  }

  public getShadowRecords(): ShadowEvaluationRecord[] {
    return [...this.shadowRecords];
  }
}
