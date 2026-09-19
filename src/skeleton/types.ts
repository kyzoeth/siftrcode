export interface SkeletonResult {
  filePath: string;
  language: 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'unknown';
  originalContent: string;
  skeletonContent: string;
  originalLines: number;
  skeletonLines: number;
  originalTokensEstimate: number;
  skeletonTokensEstimate: number;
  reductionRatio: number; // e.g. 0.85 = 85% reduction
  symbols: string[];
}

export interface PruneDecision {
  filePath: string;
  classification: 'RootCandidate' | 'TypeDependencyOnly' | 'DeadWeight';
  score: number; // 1-10
  isCriticalPath: boolean;
  reason: string;
}
