/**
 * SiftrCode V3.1 - Evaluation Context Result Contract (Phase 11 P0-4)
 *
 * Authoritative interface returned by evaluation-side context providers
 * (FrozenV2EvaluationBridge and V3EvaluationContextProvider).
 * Captures internal candidate generation, feature, and ranking counts,
 * token budgets, bundle resolutions, and cryptographic provenance.
 */

export interface EvaluationRankedUnit {
  contextUnitId: string;
  path?: string;
  rank: number;
  score?: number;
  tokenEstimate: number;
}

export interface EvaluationSelectedUnit {
  contextUnitId: string;
  path?: string;
  resolution: 'NAME' | 'SIGNATURE' | 'SKELETON' | 'BODY' | 'FULL';
  actualTokenCount: number;
  contentSha256: string;
}

export interface EvaluationContextResult {
  providerName: string;
  implementationSha: string;
  workspaceBaseCommit: string;

  candidateBudget: number;
  tokenBudget: number;

  generatedCandidateCount: number;
  featuredCandidateCount: number;
  rankedCandidateCount: number;
  selectedBundleUnitCount: number;
  materializedUnitCount: number;

  rankedUnits: EvaluationRankedUnit[];
  selectedUnits: EvaluationSelectedUnit[];

  totalContextTokens: number;

  contextString: string;
  bundleSha256: string;

  featureSchemaSha256?: string;
  modelArtifactSha256?: string;
  trainingCodeGitSha?: string;
  featureBuilderVersion?: string;

  initialGitStatus: string;
  postContextGitStatus: string;
}
