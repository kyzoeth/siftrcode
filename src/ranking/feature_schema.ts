/**
 * SiftrCode V2 - Versioned Features Schema (ContextFeaturesV1)
 * Formal feature schema representing multi-dimensional relevance of a ContextUnit for a TaskContext.
 */

import { ContextUnitKind } from '../context/context_unit';

export interface ContextFeaturesV1 {
  schemaVersion: 'v1';
  contextUnitId: string;

  // Static Unit Features
  unitKind: ContextUnitKind;
  tokenEstimate: number;
  isTest: boolean;
  isConfig: boolean;
  isDocumentation: boolean;
  isSchema: boolean;
  isExported: boolean;

  // Lexical & Query Match Features
  exactSymbolMatch: boolean;
  exactPathMatch: boolean;
  bm25Score: number;
  tokenOverlapRatio: number;

  // Graph Topology Features
  graphDegree: number;
  minDistanceToSeed: number | null; // null if unreachable
  minDistanceToErrorFrame: number | null; // null if no error frames or unreachable
  isDirectDependency: boolean;
  isDirectDependent: boolean;

  // Point-in-Time Git Features (strictly cutoff-aware)
  changeFrequency: number;
  recentChangeFrequency: number;
  maxCoChangeWithSeeds: number; // [0.0, 1.0]

  // Runtime Evidence Features
  inStackTrace: boolean;
  isFailingTestTarget: boolean;
  inCompilerError: boolean;
  inDirtyDiff: boolean;

  // Composite Heuristic Priority Hint
  heuristicScore: number;
}
