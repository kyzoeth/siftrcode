/**
 * SiftrCode V3 - SiftrBench Episode Contract (Section V3.1A)
 *
 * Defines the immutable contract for an independent task episode in SiftrBench v1.
 * Invariant: The unit of learning and evaluation is an independent TaskEpisode,
 * NOT a ContextUnit. Context candidates from the same task episode are correlated.
 */

export type SiftrTaskType =
  | 'BUG_FIX'
  | 'TEST_FAILURE'
  | 'FEATURE_ADDITION'
  | 'REFACTOR'
  | 'CONFIG_CHANGE'
  | 'API_CHANGE'
  | 'MULTI_FILE_COORDINATION';

export interface SiftrBenchVerifier {
  type: 'npm_test' | 'pytest' | 'custom_command' | 'deterministic_oracle';
  command?: string;
  testFiles?: string[];
  expectedExitCode?: number;
  metadata?: Record<string, unknown>;
}

export interface SiftrBenchVerifiedOutcome {
  verifiedSuccess: boolean | null;
  evidenceType: 'TEST_SUITE' | 'ASSERTION' | 'COMPILATION' | 'ORACLE';
  evidenceReference?: string;
  details?: Record<string, unknown>;
}

export interface SiftrBenchEpisode {
  schemaVersion: 'siftrbench-v1';
  episodeId: string;
  taskId: string;
  repositoryId: string;
  repositoryOrigin: string;
  baseCommit: string;
  workspaceSnapshotId: string;
  taskPrompt: string;
  agentEnvironmentId?: string;
  taskType: SiftrTaskType;
  expectedTargetPaths: string[];
  expectedTargetSymbols?: string[];
  expectedRelatedPaths?: string[];
  verifier: SiftrBenchVerifier;
  verifiedOutcome?: SiftrBenchVerifiedOutcome;
  temporalCutoff: string;
  rightsReference: string;
  provenance: {
    source: string;
    sourceVersion?: string;
    importedAt: string;
  };
  splitGroupId: string;
  metadata?: Record<string, unknown>;
}

export interface SiftrBenchManifest {
  schemaVersion: 'siftrbench-manifest-v1';
  benchmarkVersion: 'siftrbench-v1';
  createdAt: string;
  totalEpisodes: number;
  repositoryDistribution: Record<string, number>;
  taskTypeDistribution: Record<string, number>;
  checksum: string;
  episodes: SiftrBenchEpisode[];
}
