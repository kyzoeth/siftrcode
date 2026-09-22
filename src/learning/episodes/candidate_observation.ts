/**
 * SiftrCode V2 - Candidate Observation Contract (Phase 20B)
 *
 * Persists all candidates considered during context ranking along with
 * their retrieval provenance, features, and ranking outcomes.
 *
 * Invariant: Never persist raw source code merely because a candidate was evaluated.
 * Persist identifiers and features separately from content.
 */

export interface CandidateObservation {
  contextUnitId: string;
  path?: string;
  unitKind: string;
  retrievalSources: string[];
  preRankPosition?: number;
  finalRank: number;
  finalScore: number;
  featureSetVersion: string;
  featureSnapshot?: Record<string, number | boolean | null>;
  estimatedTokens: number;
  selected: boolean;
  selectedResolution?: string;
}

export interface SelectedContextObservation {
  contextUnitId: string;
  path?: string;
  unitKind: string;
  resolution: string;
  rank: number;
  allocatedTokens: number;
}
