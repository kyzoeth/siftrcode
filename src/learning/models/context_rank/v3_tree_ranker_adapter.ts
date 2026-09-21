/**
 * SiftrCode V3 - V3TreeRankerAdapter
 *
 * Plugs the trained pairwise GBDT TreeRanker into the ContextEngine product pipeline,
 * producing RankedCandidate[] for BudgetSolver, ResolutionRanker, ContextUnitMaterializer,
 * and BundleComposer.
 */

import { ContextFeaturesV1 } from '../../../ranking/feature_schema';
import { RankedCandidate } from '../../../ranking/context_rank';
import { ContextFeaturesV3_1, featuresToVector } from '../../features/feature_set_v3_1';
import { TreeRanker } from './tree_ranker';

export class V3TreeRankerAdapter {
  private treeRanker: TreeRanker;

  constructor(treeRanker: TreeRanker) {
    this.treeRanker = treeRanker;
  }

  public rank(candidates: ContextFeaturesV1[], _judgments?: Map<string, any>): RankedCandidate[] {
    const scoredList: Array<Omit<RankedCandidate, 'rank'>> = candidates.map((f1) => {
      const f31: ContextFeaturesV3_1 = {
        schemaVersion: 'CONTEXT_RANK_FEATURES_V3_1',
        contextUnitId: f1.contextUnitId,
        temporalCutoff: new Date().toISOString(),
        unitKind: f1.unitKind,
        tokenEstimate: f1.tokenEstimate,
        isTest: f1.isTest,
        isConfig: f1.isConfig,
        isDocumentation: f1.isDocumentation,
        isSchema: f1.isSchema,
        isExported: f1.isExported,
        exactSymbolMatch: f1.exactSymbolMatch,
        exactPathMatch: f1.exactPathMatch,
        bm25Score: f1.bm25Score,
        tokenOverlapRatio: f1.tokenOverlapRatio,
        graphDegree: f1.graphDegree,
        minDistanceToSeed: f1.minDistanceToSeed,
        minDistanceToErrorFrame: f1.minDistanceToErrorFrame,
        isDirectDependency: f1.isDirectDependency,
        isDirectDependent: f1.isDirectDependent,
        changeFrequency: f1.changeFrequency,
        recentChangeFrequency: f1.recentChangeFrequency,
        maxCoChangeWithSeeds: f1.maxCoChangeWithSeeds,
        inStackTrace: f1.inStackTrace,
        isFailingTestTarget: f1.isFailingTestTarget,
        inCompilerError: f1.inCompilerError,
        inDirtyDiff: f1.inDirtyDiff,
        fromExactRetrieval: f1.exactSymbolMatch || f1.exactPathMatch,
        fromLexicalRetrieval: f1.bm25Score > 0,
        fromGraphRetrieval: f1.graphDegree > 0,
        fromGitRetrieval: f1.changeFrequency > 0,
        fromRuntimeRetrieval: f1.inStackTrace || f1.isFailingTestTarget,
        heuristicScore: f1.heuristicScore,
        hasJevSignals: false,
        semanticRelevanceProbability: null,
        implementationNeededProbability: null,
        likelyEditTargetProbability: null,
        likelyRootCauseProbability: null,
      };

      const vec = featuresToVector(f31, true);
      const rawScore = this.treeRanker.scoreVector(vec);
      const finalScore = Number((rawScore * 10.0 + f1.heuristicScore * 0.1).toFixed(3));

      return {
        contextUnitId: f1.contextUnitId,
        finalScore,
        scoreBreakdown: {
          runtimeEvidence: 0,
          exactMatch: 0,
          lexicalRelevance: 0,
          graphProximity: 0,
          gitCoChange: 0,
          penalties: 0,
        },
        reasons: [`gbdt_pairwise_score(${rawScore.toFixed(3)})`],
        features: f1,
      };
    });

    // Deterministic sort: score DESC, contextUnitId ASC
    scoredList.sort((a, b) => {
      if (b.finalScore !== a.finalScore) {
        return b.finalScore - a.finalScore;
      }
      return a.contextUnitId.localeCompare(b.contextUnitId);
    });

    return scoredList.map((s, idx) => ({ ...s, rank: idx + 1 }));
  }
}
