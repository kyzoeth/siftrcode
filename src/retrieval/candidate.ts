export interface Candidate {
  contextUnitId: string;
  lexicalScore?: number;
  semanticScore?: number;
  graphDistance?: number;
  graphStrength?: number;
  coChangeScore?: number;
  exactMatch: boolean;
  testRelationship: boolean;
  runtimeEvidenceMatch: boolean;
  retrievalSources: string[];
}

export function createInitialCandidate(unitId: string): Candidate {
  return {
    contextUnitId: unitId,
    exactMatch: false,
    testRelationship: false,
    runtimeEvidenceMatch: false,
    retrievalSources: [],
  };
}

export function computeRecallAtK(
  candidates: Candidate[],
  groundTruthUnitIds: string[],
  k: number
): number {
  if (groundTruthUnitIds.length === 0) return 1.0;

  const topK = candidates.slice(0, k);
  const retrievedSet = new Set(topK.map((c) => c.contextUnitId));

  let found = 0;
  for (const targetId of groundTruthUnitIds) {
    if (retrievedSet.has(targetId)) {
      found++;
    }
  }

  return Number((found / groundTruthUnitIds.length).toFixed(4));
}
