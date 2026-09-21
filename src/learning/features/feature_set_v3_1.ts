/**
 * SiftrCode V3 - Feature Schema V3.1 (CONTEXT_RANK_FEATURES_V3_1)
 *
 * Formal feature schema representing point-in-time multi-channel relevance
 * for ranking candidate ContextUnits.
 *
 * Invariant:
 * Strictly point-in-time (<= C0).
 * Never include future git commits, post-outcome traces, ground-truth targets, or diffs.
 */

import { ContextUnitKind } from '../../context/context_unit';

export const CONTEXT_RANK_FEATURES_V3_1_SCHEMA = 'CONTEXT_RANK_FEATURES_V3_1';

export const PROHIBITED_FEATURE_FIELDS = [
  'verifiedOutcome',
  'verifiedSuccess',
  'futurePatch',
  'futureChangedFiles',
  'futureTests',
  'postTaskReads',
  'postTaskEdits',
  'futureGitCommits',
  'groundTruthTarget',
  'groundTruthSymbol',
  'solutionDiff',
] as const;

export interface ContextFeaturesV3_1 {
  schemaVersion: typeof CONTEXT_RANK_FEATURES_V3_1_SCHEMA;
  contextUnitId: string;
  temporalCutoff: string;

  // 1. Static Unit Features
  unitKind: ContextUnitKind;
  tokenEstimate: number;
  isTest: boolean;
  isConfig: boolean;
  isDocumentation: boolean;
  isSchema: boolean;
  isExported: boolean;

  // 2. Lexical & Query Match Features
  exactSymbolMatch: boolean;
  exactPathMatch: boolean;
  bm25Score: number;
  tokenOverlapRatio: number;

  // 3. Graph Topology Features
  graphDegree: number;
  minDistanceToSeed: number | null; // null if unreachable
  minDistanceToErrorFrame: number | null;
  isDirectDependency: boolean;
  isDirectDependent: boolean;

  // 4. Point-in-Time Git Features (strictly commit <= C0)
  changeFrequency: number;
  recentChangeFrequency: number;
  maxCoChangeWithSeeds: number; // [0.0, 1.0]

  // 5. Runtime Evidence Features
  inStackTrace: boolean;
  isFailingTestTarget: boolean;
  inCompilerError: boolean;
  inDirtyDiff: boolean;

  // 6. Retrieval Source Indicators
  fromExactRetrieval: boolean;
  fromLexicalRetrieval: boolean;
  fromGraphRetrieval: boolean;
  fromGitRetrieval: boolean;
  fromRuntimeRetrieval: boolean;

  // 7. Composite Deterministic Baseline Score
  heuristicScore: number;

  // 8. Continuous JEV Probabilities (Teacher / Feature heads, NOT label)
  hasJevSignals: boolean;
  semanticRelevanceProbability: number | null;
  implementationNeededProbability: number | null;
  likelyEditTargetProbability: number | null;
  likelyRootCauseProbability: number | null;
}

export const FEATURE_NAMES: Array<keyof Omit<ContextFeaturesV3_1, 'schemaVersion' | 'contextUnitId' | 'temporalCutoff'>> = [
  'tokenEstimate',
  'isTest',
  'isConfig',
  'isDocumentation',
  'isSchema',
  'isExported',
  'exactSymbolMatch',
  'exactPathMatch',
  'bm25Score',
  'tokenOverlapRatio',
  'graphDegree',
  'minDistanceToSeed',
  'minDistanceToErrorFrame',
  'isDirectDependency',
  'isDirectDependent',
  'changeFrequency',
  'recentChangeFrequency',
  'maxCoChangeWithSeeds',
  'inStackTrace',
  'isFailingTestTarget',
  'inCompilerError',
  'inDirtyDiff',
  'fromExactRetrieval',
  'fromLexicalRetrieval',
  'fromGraphRetrieval',
  'fromGitRetrieval',
  'fromRuntimeRetrieval',
  'heuristicScore',
  'hasJevSignals',
  'semanticRelevanceProbability',
  'implementationNeededProbability',
  'likelyEditTargetProbability',
  'likelyRootCauseProbability',
];

/**
 * Converts a ContextFeaturesV3_1 instance into a normalized numeric vector for model consumption.
 * Null values are represented with explicit missingness conventions (e.g. -1 for distance, 0 for missing probabilities).
 */
export function featuresToVector(f: ContextFeaturesV3_1, includeJev: boolean = true): number[] {
  const vec: number[] = [
    Math.min(1.0, f.tokenEstimate / 2000),
    f.isTest ? 1.0 : 0.0,
    f.isConfig ? 1.0 : 0.0,
    f.isDocumentation ? 1.0 : 0.0,
    f.isSchema ? 1.0 : 0.0,
    f.isExported ? 1.0 : 0.0,
    f.exactSymbolMatch ? 1.0 : 0.0,
    f.exactPathMatch ? 1.0 : 0.0,
    Math.min(1.0, f.bm25Score / 25.0),
    f.tokenOverlapRatio,
    Math.min(1.0, f.graphDegree / 20.0),
    f.minDistanceToSeed === null ? -1.0 : (f.minDistanceToSeed === 1 ? 1.0 : (f.minDistanceToSeed === 2 ? 0.5 : 0.2)),
    f.minDistanceToErrorFrame === null ? -1.0 : (f.minDistanceToErrorFrame === 1 ? 1.0 : (f.minDistanceToErrorFrame === 2 ? 0.5 : 0.2)),
    f.isDirectDependency ? 1.0 : 0.0,
    f.isDirectDependent ? 1.0 : 0.0,
    Math.min(1.0, f.changeFrequency / 50.0),
    Math.min(1.0, f.recentChangeFrequency / 10.0),
    f.maxCoChangeWithSeeds,
    f.inStackTrace ? 1.0 : 0.0,
    f.isFailingTestTarget ? 1.0 : 0.0,
    f.inCompilerError ? 1.0 : 0.0,
    f.inDirtyDiff ? 1.0 : 0.0,
    f.fromExactRetrieval ? 1.0 : 0.0,
    f.fromLexicalRetrieval ? 1.0 : 0.0,
    f.fromGraphRetrieval ? 1.0 : 0.0,
    f.fromGitRetrieval ? 1.0 : 0.0,
    f.fromRuntimeRetrieval ? 1.0 : 0.0,
    Math.min(1.0, f.heuristicScore / 100.0),
  ];

  if (includeJev) {
    vec.push(
      f.hasJevSignals ? 1.0 : 0.0,
      f.semanticRelevanceProbability !== null && f.semanticRelevanceProbability !== undefined ? f.semanticRelevanceProbability : 0.0,
      f.implementationNeededProbability !== null && f.implementationNeededProbability !== undefined ? f.implementationNeededProbability : 0.0,
      f.likelyEditTargetProbability !== null && f.likelyEditTargetProbability !== undefined ? f.likelyEditTargetProbability : 0.0,
      f.likelyRootCauseProbability !== null && f.likelyRootCauseProbability !== undefined ? f.likelyRootCauseProbability : 0.0
    );
  }

  return vec;
}
