export interface IndexQuality {
  parserCoverage: number;
  preciseIndexAvailable: boolean;
  unresolvedReferences: number;
  parseErrors: number;
  confidence: number;
}

export function createDefaultIndexQuality(overrides: Partial<IndexQuality> = {}): IndexQuality {
  return {
    parserCoverage: 1.0,
    preciseIndexAvailable: false,
    unresolvedReferences: 0,
    parseErrors: 0,
    confidence: 1.0,
    ...overrides,
  };
}
