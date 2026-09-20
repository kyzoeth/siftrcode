/**
 * SiftrCode V2 - ContextRank (Transparent Heuristic Ranker)
 * Ranks Candidate ContextUnits using multi-channel features with explicit, inspectable score breakdowns and reason codes.
 */

import { ContextFeaturesV1 } from './feature_schema';
import { ContextUnitKind } from '../context/context_unit';

export interface ScoreBreakdown {
  runtimeEvidence: number;
  exactMatch: number;
  lexicalRelevance: number;
  graphProximity: number;
  gitCoChange: number;
  penalties: number;
}

export interface RankedCandidate {
  contextUnitId: string;
  finalScore: number;
  rank: number;
  scoreBreakdown: ScoreBreakdown;
  reasons: string[];
  features: ContextFeaturesV1;
}

export interface RankingWeights {
  stackTraceWeight: number;
  testFailureWeight: number;
  compilerErrorWeight: number;
  dirtyDiffWeight: number;
  exactSymbolWeight: number;
  exactPathWeight: number;
  bm25Weight: number;
  tokenOverlapWeight: number;
  graphHop1Weight: number;
  graphHop2Weight: number;
  coChangeWeight: number;
  recentChangeWeight: number;
  lockfilePenalty: number;
  testFileUnrelatedPenalty: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  stackTraceWeight: 45,
  testFailureWeight: 35,
  compilerErrorWeight: 35,
  dirtyDiffWeight: 25,
  exactSymbolWeight: 30,
  exactPathWeight: 25,
  bm25Weight: 2.0, // Multiplied by BM25 score
  tokenOverlapWeight: 15,
  graphHop1Weight: 20,
  graphHop2Weight: 10,
  coChangeWeight: 15,
  recentChangeWeight: 2, // Multiplied by recent frequency
  lockfilePenalty: -30,
  testFileUnrelatedPenalty: -10,
};

export class ContextRanker {
  private weights: RankingWeights;

  constructor(weights: Partial<RankingWeights> = {}) {
    this.weights = { ...DEFAULT_RANKING_WEIGHTS, ...weights };
  }

  /**
   * Rank a list of candidate feature sets with deterministic tie-breaking.
   */
  public rank(candidates: ContextFeaturesV1[]): RankedCandidate[] {
    const scoredList: Array<Omit<RankedCandidate, 'rank'>> = candidates.map((f) => {
      let runtimeEvidence = 0;
      let exactMatch = 0;
      let lexicalRelevance = 0;
      let graphProximity = 0;
      let gitCoChange = 0;
      let penalties = 0;
      const reasons: string[] = [];

      // 1. Runtime Evidence
      if (f.inStackTrace) {
        runtimeEvidence += this.weights.stackTraceWeight;
        reasons.push(`present_in_runtime_stack_trace (+${this.weights.stackTraceWeight})`);
      }
      if (f.isFailingTestTarget) {
        runtimeEvidence += this.weights.testFailureWeight;
        reasons.push(`target_of_failing_test (+${this.weights.testFailureWeight})`);
      }
      if (f.inCompilerError) {
        runtimeEvidence += this.weights.compilerErrorWeight;
        reasons.push(`referenced_in_compiler_error (+${this.weights.compilerErrorWeight})`);
      }
      if (f.inDirtyDiff) {
        runtimeEvidence += this.weights.dirtyDiffWeight;
        reasons.push(`modified_in_active_dirty_diff (+${this.weights.dirtyDiffWeight})`);
      }

      // 2. Exact Match
      if (f.exactSymbolMatch) {
        exactMatch += this.weights.exactSymbolWeight;
        reasons.push(`exact_symbol_name_match (+${this.weights.exactSymbolWeight})`);
      }
      if (f.exactPathMatch) {
        exactMatch += this.weights.exactPathWeight;
        reasons.push(`exact_file_path_match (+${this.weights.exactPathWeight})`);
      }

      // 3. Lexical Relevance
      const bm25Contribution = Math.min(20, f.bm25Score * this.weights.bm25Weight);
      if (bm25Contribution > 0) {
        lexicalRelevance += bm25Contribution;
        reasons.push(`lexical_bm25_relevance (+${bm25Contribution.toFixed(1)})`);
      }
      const overlapContribution = f.tokenOverlapRatio * this.weights.tokenOverlapWeight;
      if (overlapContribution > 0) {
        lexicalRelevance += overlapContribution;
      }

      // 4. Graph Proximity
      if (f.minDistanceToSeed === 1 || f.minDistanceToErrorFrame === 1) {
        graphProximity += this.weights.graphHop1Weight;
        reasons.push(`graph_direct_neighbor (+${this.weights.graphHop1Weight})`);
      } else if (f.minDistanceToSeed === 2 || f.minDistanceToErrorFrame === 2) {
        graphProximity += this.weights.graphHop2Weight;
        reasons.push(`graph_two_hop_neighborhood (+${this.weights.graphHop2Weight})`);
      }

      // 5. Git Co-Change
      const coChangeContribution = f.maxCoChangeWithSeeds * this.weights.coChangeWeight;
      if (coChangeContribution > 0) {
        gitCoChange += coChangeContribution;
        reasons.push(`historical_git_co_change (+${coChangeContribution.toFixed(1)})`);
      }
      const recencyContribution = Math.min(10, f.recentChangeFrequency * this.weights.recentChangeWeight);
      if (recencyContribution > 0) {
        gitCoChange += recencyContribution;
      }

      // 6. Penalties
      if (f.unitKind === ContextUnitKind.LOCKFILE && !f.exactPathMatch) {
        penalties += this.weights.lockfilePenalty;
        reasons.push(`lockfile_penalty (${this.weights.lockfilePenalty})`);
      }
      if (f.isTest && !f.isFailingTestTarget && !f.exactPathMatch && !f.exactSymbolMatch) {
        penalties += this.weights.testFileUnrelatedPenalty;
        reasons.push(`unrelated_test_penalty (${this.weights.testFileUnrelatedPenalty})`);
      }

      const finalScore = Number(
        (runtimeEvidence + exactMatch + lexicalRelevance + graphProximity + gitCoChange + penalties).toFixed(2)
      );

      return {
        contextUnitId: f.contextUnitId,
        finalScore,
        scoreBreakdown: {
          runtimeEvidence,
          exactMatch,
          lexicalRelevance: Number(lexicalRelevance.toFixed(2)),
          graphProximity,
          gitCoChange: Number(gitCoChange.toFixed(2)),
          penalties,
        },
        reasons,
        features: f,
      };
    });

    // Deterministic sorting: higher score first, tie-break by contextUnitId
    scoredList.sort((a, b) => {
      if (b.finalScore !== a.finalScore) {
        return b.finalScore - a.finalScore;
      }
      return a.contextUnitId.localeCompare(b.contextUnitId);
    });

    return scoredList.map((item, idx) => ({
      ...item,
      rank: idx + 1,
    }));
  }
}
