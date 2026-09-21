/**
 * SiftrCode V2 - TypeSafe JEV Real-World Pilot Study
 *
 * Evaluates TypeSafe JEV shadow judgment across 25 audited real-world tasks
 * from 3 real codebases:
 * - Express (10 tasks) - benchmarks/express-repo
 * - FastAPI (10 tasks) - benchmarks/fastapi-repo
 * - SiftrCode (5 tasks) - src/
 *
 * Verifies:
 * 1. Production invariant: 100% bit-for-bit ContextPlan identity in shadow mode
 * 2. Operational metrics: Concurrency <= 4, calls/task <= 20, p50/p95 latency
 * 3. Continuous probability distributions (semantic relevance, implementation needed, edit target, root cause)
 * 4. Pearson correlation with audited ground-truth edit targets & root causes
 * 5. Ranking ablation comparison: Deterministic ContextRank vs JEV-augmented ranker (NDCG@K, Recall@K, MRR)
 * 6. Data rights integrity: rights-aware persistence, numeric field gating, maxInputCharacters enforcement
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { SqliteStore } from '../storage/sqlite_store';
import { ContextEngine } from '../engine/context_engine';
import { ContextPlan } from '../engine/context_plan';
import { RepositoryIndexer } from '../indexing/repository_index';
import { GraphBuilder } from '../graph/graph_builder';
import { GitGraphIntelligence } from '../graph/git_graph';
import { ContextGraph } from '../graph/context_graph';
import { JevShadowRunner } from '../providers/judgment/typesafe/jev_shadow_runner';
import {
  SystemOneClient,
  TypeSafeSystemOneClient,
  FakeSystemOneClient,
  SystemOneEvaluationRequest,
  SystemOneEvaluationResponse,
  TYPESAFE_SDK_VERSION,
} from '../providers/judgment/typesafe/typesafe_client';
import { VERSION as SDK_VERSION, RateLimitError, APITimeoutError, APIConnectionError, APIError } from '@typesafe-ai/sdk';
import { JEV_QUESTIONS_V1, JEV_QUESTION_SET_VERSION_V1 } from '../providers/judgment/typesafe/jev_questions';
import { JevMode, JevSignalV1 } from '../providers/judgment/typesafe/jev_signal';
import { ContextUnit, ContextUnitKind } from '../context/context_unit';
import { createTaskContext, TaskContext } from '../context/task_context';
import { TaskEvidenceKind, UserPromptEvidence } from '../context/task_evidence';
import { createAgentEnvironment } from '../agents/agent_environment';
import { createWorkspaceSnapshot, WorkspaceSnapshot } from '../workspace/workspace_snapshot';
import { WorkspaceManager } from '../workspace/workspace_manager';
import { createDefaultDataRights, createJevPermittedDataRights, DataRights, DataClass } from '../rights/data_rights';
import { ContextRanker, RankedCandidate } from '../ranking/context_rank';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { FeatureBuilderV1 } from '../ranking/feature_builder';
import { CandidateGenerator } from '../retrieval/candidate_generator';
import { RepositoryOrigin, createDefaultRepositoryTrustPolicy } from '../security/trust';
import { JevCallTracker, JevCallStats } from '../providers/judgment/typesafe/jev_budget';

export type PilotTaskType = 'BUG_FIX' | 'TEST_FAILURE' | 'FEATURE_ADDITION' | 'REFACTOR';
export type PilotRepoKind = 'express' | 'fastapi' | 'siftrcode';

export interface AuditedPilotTask {
  taskId: string;
  repo: PilotRepoKind;
  type: PilotTaskType;
  prompt: string;
  expectedTargetPaths: string[];
  expectedRelatedPaths?: string[];
}

export interface MetricSummary {
  mean: number;
  std: number;
  median: number;
  min: number;
  max: number;
  p95: number;
}

export interface PilotMetadata {
  sdk: {
    name: string;
    version: string;
  };
  model: string;
  questionSet: {
    version: string;
    questionCount: number;
    questions: {
      key: string;
      prompt: string;
    }[];
  };
  redaction: {
    rawSourceExcluded: boolean;
    secretsRedacted: boolean;
    tokensOmitted: boolean;
    allowedDataClasses: string[];
    deniedDataClasses: string[];
  };
  fallback: {
    strategy: string;
    retriesConfigured: number;
    failClosedOnZeroRemoteProbabilities: boolean;
  };
  sampleSanitizedPayloadShape?: Record<string, any>;
  sampleRequestId?: string;
}

export interface PerTaskPlanInvariance {
  taskId: string;
  baselinePlanHash: string;
  shadowPlanHash: string;
  invariant: boolean;
}

export interface LineageCoverageReport {
  orphanJevSignals: number;
  totalJevSignals: number;
  joinedJevSignals: number;
  orphanContextPlans: number;
  totalContextPlans: number;
  joinedContextPlans: number;
  orphanCandidateDecisions: number;
  totalCandidateDecisions: number;
  joinedCandidateDecisions: number;
  mismatchedJevAgentEnvs: number;
  mismatchedPlanAgentEnvs: number;
  mismatchedDecisionAgentEnvs: number;
  mismatchedPlanSnapshots: number;
  mismatchedJevSnapshots: number;
  mismatchedDecisionSnapshots?: number;
  completeLineageCoverage: boolean;
  lineageVerificationSucceeded?: boolean;
}

export interface LineageCoverage {
  totalSessions: number;
  totalJudgments: number;
  orphanJudgments: number;
  totalPlans: number;
  orphanPlans: number;
  totalObservations: number;
  orphanObservations: number;
  mismatchedAgentEnvs: number;
  mismatchedSnapshots: number;
  mismatchedDecisionSnapshots?: number;
  lineageVerificationSucceeded?: boolean;
}

export interface LiveMetrics {
  liveMode: boolean;
  totalTasks: number;
  selectedTaskCount?: number;
  startedTaskCount?: number;
  completedTaskCount?: number;
  tasksWithValidProviderSignal?: number;
  harnessException?: string;
  maxHttpRequests: number;
  successfulCalls: number;
  failedCalls: number;
  rateLimitedCalls: number;
  timeoutCalls: number;
  malformedCalls: number;
  connectionErrorCalls: number;
  totalHttpRequests: number;
  totalRetries: number;
  trustDeniedCalls: number;
  rightsDeniedCalls: number;
  planInvarianceHolds: boolean;
  zeroLineageMismatches: boolean;
  zeroUnexpectedEgress: boolean;
  tasksWithSuccessfulSignal?: number;
  endpoint?: string;
  endpointIsProduction?: boolean;
  provenanceClean?: boolean;
  providerAttempts?: number;
  providerSuccesses?: number;
  validSignals?: number;
  syntheticSignals?: number;
  fallbackOnlySignals?: number;
  snapshotMismatches?: number;
  sessionMismatches?: number;
  agentEnvironmentMismatches?: number;
  orphanJevSignals?: number;
  orphanContextPlans?: number;
  orphanCandidateDecisions?: number;
  orphanJevSession?: number;
  orphanJevContextUnit?: number;
  orphanJevContextPlan?: number;
  orphanJevWorkspaceSnapshot?: number;
  orphanContextPlanSession?: number;
  orphanContextPlanWorkspaceSnapshot?: number;
  orphanCandidateDecisionSession?: number;
  orphanCandidateDecisionWorkspaceSnapshot?: number;
  orphanTaskContextSession?: number;
  orphanTaskContextWorkspaceSnapshot?: number;
  mismatchedDecisionSnapshots?: number;
  totalJevSignals?: number;
  joinedJevSignals?: number;
  totalContextPlans?: number;
  joinedContextPlans?: number;
  totalCandidateDecisions?: number;
  joinedCandidateDecisions?: number;
  completeLineageCoverage?: boolean;
  lineageVerificationSucceeded?: boolean;
  perTaskAttemptsExceeded?: boolean;
  httpRequestsExceededBudget?: boolean;
  reportConsistencyCheck?: boolean;
}

export interface LiveAcceptanceConfig {
  minimumValidProviderResponses?: number;      // default 1
  minProviderSuccessFraction?: number;        // default undefined (off)
  excludeProductionEndpointCheck?: boolean;   // test flag
}

export function evaluateLiveAcceptance(
  m: LiveMetrics,
  c?: LiveAcceptanceConfig
): { recommendation: 'PASS_TO_30_TASK_PILOT' | 'FIX_AND_REPEAT_SMOKE'; failed: string[] } {
  const failed: string[] = [];

  if (m.liveMode === false) {
    failed.push('liveMode === true');
  }
  if (!c?.excludeProductionEndpointCheck && m.endpointIsProduction === false) {
    failed.push('endpointIsProduction === true');
  }
  if (m.provenanceClean === false) {
    failed.push('clean build provenance');
  }

  // Harness execution & completion (P0)
  if (m.harnessException) {
    failed.push(`harness execution without error (${m.harnessException})`);
  }
  if (m.startedTaskCount !== undefined && m.selectedTaskCount !== undefined) {
    if (m.startedTaskCount !== m.selectedTaskCount) {
      failed.push(`startedTaskCount === selectedTaskCount (${m.startedTaskCount} vs ${m.selectedTaskCount})`);
    }
  }
  if (m.selectedTaskCount !== undefined && m.completedTaskCount !== undefined) {
    if (m.completedTaskCount !== m.selectedTaskCount) {
      failed.push(`completedTaskCount === selectedTaskCount (${m.completedTaskCount} vs ${m.selectedTaskCount})`);
    }
  }

  // Minimum valid provider responses (P0)
  const minValid = c?.minimumValidProviderResponses ?? 1;
  if (!m.providerAttempts || m.providerAttempts <= 0) {
    failed.push('providerAttempts > 0');
  }
  if ((m.providerSuccesses ?? 0) < minValid) {
    failed.push(`providerSuccesses >= ${minValid} (got ${m.providerSuccesses ?? 0})`);
  }
  if ((m.validSignals ?? 0) < minValid) {
    failed.push(`validSignals >= ${minValid} (got ${m.validSignals ?? 0})`);
  }

  // Strict smoke call health: zero failed calls and zero fallback-only signals
  if (m.failedCalls !== 0) {
    failed.push(`failedCalls === 0 (${m.failedCalls})`);
  }
  if (m.fallbackOnlySignals !== undefined && m.fallbackOnlySignals > 0) {
    failed.push(`fallbackOnlySignals === 0 (${m.fallbackOnlySignals})`);
  }

  // Synthetic signals forbidden in live mode (P0)
  if (m.syntheticSignals !== undefined && m.syntheticSignals > 0) {
    failed.push(`syntheticSignals === 0 (${m.syntheticSignals})`);
  }

  // Budgets (P0)
  if (m.totalHttpRequests > m.maxHttpRequests) {
    failed.push(`totalHttpRequests <= maxHttpRequests (${m.totalHttpRequests} > ${m.maxHttpRequests})`);
  }
  if (m.perTaskAttemptsExceeded === true) {
    failed.push('perTaskAttemptsExceeded === false');
  }
  if (m.httpRequestsExceededBudget === true) {
    failed.push('httpRequestsExceededBudget === false');
  }

  // Plan invariance (100% normalized plan match)
  if (!m.planInvarianceHolds) {
    failed.push('planInvarianceHolds === true');
  }

  // Lineage coverage & referential integrity (P0)
  if (m.lineageVerificationSucceeded === false) {
    failed.push('lineageVerificationSucceeded === true');
  }
  if (m.completeLineageCoverage === false) {
    failed.push('completeLineageCoverage === true');
  }
  if (!m.zeroLineageMismatches) {
    failed.push('zeroLineageMismatches === true');
  }

  // Egress sanitization
  if (!m.zeroUnexpectedEgress) {
    failed.push('zeroUnexpectedEgress === true');
  }

  if (m.reportConsistencyCheck === false) {
    failed.push('reportConsistencyCheck === true');
  }

  if (c?.minProviderSuccessFraction !== undefined && m.providerAttempts && m.providerAttempts > 0) {
    const fraction = (m.providerSuccesses ?? 0) / m.providerAttempts;
    if (fraction < c.minProviderSuccessFraction) {
      failed.push(`successes/attempts >= ${c.minProviderSuccessFraction}`);
    }
  }

  // Final recommendation: strictly calculated from failed criteria
  const recommendation = failed.length === 0 ? 'PASS_TO_30_TASK_PILOT' : 'FIX_AND_REPEAT_SMOKE';
  return { recommendation, failed };
}

export interface PilotReport {
  mode: 'LIVE_PILOT' | 'LIVE_SMOKE' | 'OFFLINE_SYNTHETIC';
  endpoint: string;
  endpointIsProduction: boolean;
  provenance: {
    testedGitCommit?: string;
    dirty?: boolean | null;
    sourceTreeHash?: string;
    isClean: boolean;
  };
  testedGitCommit?: string;
  sdkVersion: string;
  requestedModel: string;
  returnedProviderModels: string[];
  questionSetVersion: string;
  totalTasks: number;
  selectedTaskCount?: number;
  startedTaskCount?: number;
  completedTaskCount?: number;
  tasksWithValidProviderSignal?: number;
  tasksPerRepo: Record<PilotRepoKind, number>;
  tasksPerType: Record<PilotTaskType, number>;
  resolvedMaxCallsPerTask: number;
  selectedCandidates: number;
  provider: {
    attempts: number;
    successes: number;
    retries: number;
    httpRequests: number;
    failuresByCategory: {
      timeouts: number;
      rateLimited: number;
      malformed: number;
      connectionErrors: number;
      providerErrors: number;
    };
    httpAttemptFailures?: {
      timeouts: number;
      rateLimited: number;
      malformed: number;
      connectionErrors: number;
      providerErrors: number;
    };
    rightsDenied: number;
    trustDenied: number;
    budgetSkipped: number;
  };
  signals: {
    total: number;
    validSignals: number;
    fallbackSignals: number;
  };
  operational: {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    fallbackCalls: number;
    trustDeniedCalls: number;
    rightsDeniedCalls: number;
    budgetSkippedCalls: number;
    meanCallsPerTask: number;
    peakConcurrency: number;
    configuredMaxConcurrency?: number;
    latencySummary: MetricSummary;
  };
  redactionCount: number;
  workspaceSnapshotIds: Record<string, string>;
  benchmarkRepoHeadShas: Record<string, string>;
  lineage: LineageCoverageReport;
  lineageCoverage: LineageCoverage;
  zeroLineageMismatches: boolean;
  zeroUnexpectedEgress: boolean;
  liveMetrics?: LiveMetrics;
  perTaskPlanInvariance: PerTaskPlanInvariance[];
  planInvarianceHolds: boolean;
  distributions: {
    semanticRelevance: MetricSummary;
    implementationNeeded: MetricSummary;
    likelyEditTarget: MetricSummary;
    likelyRootCause: MetricSummary;
  };
  correlations: {
    editTargetVsGroundTruth: number;
    rootCauseVsGroundTruth: number;
    semanticRelevanceVsGroundTruth: number;
  };
  rankingAblation: {
    baseline: {
      ndcg5: number;
      ndcg10: number;
      recall5: number;
      recall10: number;
      recall20: number;
      mrr: number;
    };
    jevAugmented: {
      ndcg5: number;
      ndcg10: number;
      recall5: number;
      recall10: number;
      recall20: number;
      mrr: number;
    };
    ndcg10Delta: number;
    recall10Delta: number;
    mrrDelta: number;
  };
  metadata?: PilotMetadata;
  reportConsistency?: {
    consistent: boolean;
    diffs: string[];
  };
  failedCriteria?: string[];
  recommendation: 'PASS_TO_30_TASK_PILOT' | 'FIX_AND_REPEAT_SMOKE' | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// 25 Audited Real-World Tasks Across Express, FastAPI, and SiftrCode
// ---------------------------------------------------------------------------
export const AUDITED_PILOT_TASKS: AuditedPilotTask[] = [
  // Express Tasks (benchmarks/express-repo)
  {
    taskId: 'task_real_exp_01',
    repo: 'express',
    type: 'BUG_FIX',
    prompt: 'Fix res.send handling of buffer encoding and content-type header override',
    expectedTargetPaths: ['lib/response.js'],
    expectedRelatedPaths: ['test/res.send.js'],
  },
  {
    taskId: 'task_real_exp_02',
    repo: 'express',
    type: 'FEATURE_ADDITION',
    prompt: 'Support custom etag hash functions and weak validation caching in response utils',
    expectedTargetPaths: ['lib/utils.js', 'lib/response.js'],
    expectedRelatedPaths: ['test/utils.js'],
  },
  {
    taskId: 'task_real_exp_03',
    repo: 'express',
    type: 'BUG_FIX',
    prompt: 'Resolve trust proxy IP address parsing for req.ips and req.ip when behind reverse proxies',
    expectedTargetPaths: ['lib/request.js'],
    expectedRelatedPaths: ['test/req.ip.js', 'test/req.ips.js'],
  },
  {
    taskId: 'task_real_exp_04',
    repo: 'express',
    type: 'FEATURE_ADDITION',
    prompt: 'Add support for secure samesite cookie serialization in res.cookie',
    expectedTargetPaths: ['lib/response.js'],
    expectedRelatedPaths: ['test/res.cookie.js'],
  },
  {
    taskId: 'task_real_exp_05',
    repo: 'express',
    type: 'BUG_FIX',
    prompt: 'Sub-app routing and mountpath normalization during app.use middleware registration',
    expectedTargetPaths: ['lib/application.js'],
    expectedRelatedPaths: ['test/app.use.js'],
  },
  {
    taskId: 'task_real_exp_06',
    repo: 'express',
    type: 'TEST_FAILURE',
    prompt: 'Fix res.json formatting regression when json replacer and spaces settings are configured',
    expectedTargetPaths: ['lib/response.js'],
    expectedRelatedPaths: ['test/res.json.js'],
  },
  {
    taskId: 'task_real_exp_07',
    repo: 'express',
    type: 'FEATURE_ADDITION',
    prompt: 'View lookup resolution with view cache and custom template engine extension fallback',
    expectedTargetPaths: ['lib/view.js', 'lib/application.js'],
    expectedRelatedPaths: ['test/app.engine.js', 'test/app.render.js'],
  },
  {
    taskId: 'task_real_exp_08',
    repo: 'express',
    type: 'REFACTOR',
    prompt: 'Deconstruct query string parsing options and default application settings normalization',
    expectedTargetPaths: ['lib/application.js', 'lib/utils.js'],
    expectedRelatedPaths: ['lib/request.js'],
  },
  {
    taskId: 'task_real_exp_09',
    repo: 'express',
    type: 'BUG_FIX',
    prompt: 'Fix app.param callback invocation and route parameter mapping error in router handling',
    expectedTargetPaths: ['lib/application.js'],
    expectedRelatedPaths: ['test/app.param.js', 'test/app.router.js'],
  },
  {
    taskId: 'task_real_exp_10',
    repo: 'express',
    type: 'FEATURE_ADDITION',
    prompt: 'Express top-level export factory initialization and router prototype delegation',
    expectedTargetPaths: ['lib/express.js'],
    expectedRelatedPaths: ['index.js'],
  },

  // FastAPI Tasks (benchmarks/fastapi-repo)
  {
    taskId: 'task_real_fa_01',
    repo: 'fastapi',
    type: 'BUG_FIX',
    prompt: 'Async generator dependency cleanup and exception handling during request exit stack unwinding',
    expectedTargetPaths: ['fastapi/dependencies/utils.py'],
    expectedRelatedPaths: ['fastapi/dependencies/models.py'],
  },
  {
    taskId: 'task_real_fa_02',
    repo: 'fastapi',
    type: 'FEATURE_ADDITION',
    prompt: 'APIRouter route inclusion with path prefix, tag inheritance, and default response models',
    expectedTargetPaths: ['fastapi/routing.py', 'fastapi/applications.py'],
    expectedRelatedPaths: ['fastapi/params.py'],
  },
  {
    taskId: 'task_real_fa_03',
    repo: 'fastapi',
    type: 'BUG_FIX',
    prompt: 'OAuth2PasswordBearer token extraction and Authorization header scheme validation',
    expectedTargetPaths: ['fastapi/security/oauth2.py'],
    expectedRelatedPaths: ['fastapi/security/api_key.py'],
  },
  {
    taskId: 'task_real_fa_04',
    repo: 'fastapi',
    type: 'FEATURE_ADDITION',
    prompt: 'Custom response model serialization with exclude_unset and exclude_defaults filtering',
    expectedTargetPaths: ['fastapi/encoders.py', 'fastapi/routing.py'],
    expectedRelatedPaths: ['fastapi/applications.py'],
  },
  {
    taskId: 'task_real_fa_05',
    repo: 'fastapi',
    type: 'BUG_FIX',
    prompt: 'RequestValidationError status code mapping and error detail JSON formatting in exception handlers',
    expectedTargetPaths: ['fastapi/exceptions.py', 'fastapi/applications.py'],
    expectedRelatedPaths: ['fastapi/routing.py'],
  },
  {
    taskId: 'task_real_fa_06',
    repo: 'fastapi',
    type: 'FEATURE_ADDITION',
    prompt: 'Security scope requirement evaluation across nested dependency sub-graphs',
    expectedTargetPaths: ['fastapi/dependencies/utils.py', 'fastapi/dependencies/models.py'],
    expectedRelatedPaths: ['fastapi/security/oauth2.py'],
  },
  {
    taskId: 'task_real_fa_07',
    repo: 'fastapi',
    type: 'BUG_FIX',
    prompt: 'Query parameter alias resolution and default factory evaluation in param extractors',
    expectedTargetPaths: ['fastapi/params.py', 'fastapi/dependencies/utils.py'],
    expectedRelatedPaths: ['fastapi/datastructures.py'],
  },
  {
    taskId: 'task_real_fa_08',
    repo: 'fastapi',
    type: 'FEATURE_ADDITION',
    prompt: 'UploadFile streaming buffer spool threshold and temporary file write handling',
    expectedTargetPaths: ['fastapi/datastructures.py'],
    expectedRelatedPaths: ['fastapi/params.py'],
  },
  {
    taskId: 'task_real_fa_09',
    repo: 'fastapi',
    type: 'FEATURE_ADDITION',
    prompt: 'APIKeyHeader and APIKeyQuery security scheme definition and OpenAPI documentation extraction',
    expectedTargetPaths: ['fastapi/security/api_key.py', 'fastapi/applications.py'],
    expectedRelatedPaths: ['fastapi/security/oauth2.py'],
  },
  {
    taskId: 'task_real_fa_10',
    repo: 'fastapi',
    type: 'REFACTOR',
    prompt: 'HTTPException status code mapping and Starlette error handler integration in application',
    expectedTargetPaths: ['fastapi/applications.py', 'fastapi/exceptions.py'],
    expectedRelatedPaths: ['fastapi/routing.py'],
  },

  // SiftrCode Tasks (src/)
  {
    taskId: 'task_real_siftr_01',
    repo: 'siftrcode',
    type: 'FEATURE_ADDITION',
    prompt: 'DefaultContextUnitMaterializer AST skeleton body excision preserving exported interfaces and method signatures',
    expectedTargetPaths: ['src/materialization/context_unit_materializer.ts'],
    expectedRelatedPaths: ['src/indexing/ast_skeleton_pruner.ts'],
  },
  {
    taskId: 'task_real_siftr_02',
    repo: 'siftrcode',
    type: 'BUG_FIX',
    prompt: 'BudgetSolver linear programming constraint satisfaction under strict token ceilings',
    expectedTargetPaths: ['src/context/budget_solver.ts'],
    expectedRelatedPaths: ['src/engine/context_plan.ts'],
  },
  {
    taskId: 'task_real_siftr_03',
    repo: 'siftrcode',
    type: 'FEATURE_ADDITION',
    prompt: 'Multi-channel CandidateGenerator fusing lexical BM25, graph neighborhood, and git co-change',
    expectedTargetPaths: ['src/retrieval/candidate_generator.ts'],
    expectedRelatedPaths: ['src/retrieval/lexical_retriever.ts', 'src/retrieval/exact_retriever.ts'],
  },
  {
    taskId: 'task_real_siftr_04',
    repo: 'siftrcode',
    type: 'BUG_FIX',
    prompt: 'ContextRank heuristic feature weight normalization and candidate ranking',
    expectedTargetPaths: ['src/ranking/context_rank.ts'],
    expectedRelatedPaths: ['src/ranking/feature_builder.ts'],
  },
  {
    taskId: 'task_real_siftr_05',
    repo: 'siftrcode',
    type: 'FEATURE_ADDITION',
    prompt: 'StructuredEgressGateway data classification sanitization and egress rule enforcement',
    expectedTargetPaths: ['src/security/structured_egress.ts'],
    expectedRelatedPaths: ['src/rights/data_rights.ts'],
  },
];

// ---------------------------------------------------------------------------
// Math & Statistical Helpers
// ---------------------------------------------------------------------------
function computeStats(values: number[]): MetricSummary {
  if (values.length === 0) return { mean: 0, std: 0, median: 0, min: 0, max: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  return {
    mean: Number(mean.toFixed(4)),
    std: Number(Math.sqrt(variance).toFixed(4)),
    median: Number(median.toFixed(4)),
    min: Number(sorted[0].toFixed(4)),
    max: Number(sorted[sorted.length - 1].toFixed(4)),
    p95: Number(p95.toFixed(4)),
  };
}

function computePearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return 0;
  const n = x.length;
  const avgX = x.reduce((a, b) => a + b, 0) / n;
  const avgY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - avgX;
    const dy = y[i] - avgY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return 0;
  return Number((num / Math.sqrt(denX * denY)).toFixed(4));
}

function computeDCG(rankedIds: string[], oracleScores: Map<string, number>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(rankedIds.length, k); i++) {
    const rel = oracleScores.get(rankedIds[i]) || 0;
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  return dcg;
}

function computeNDCG(rankedIds: string[], oracleScores: Map<string, number>, k: number): number {
  const dcg = computeDCG(rankedIds, oracleScores, k);
  const idealIds = Array.from(oracleScores.keys()).sort((a, b) => (oracleScores.get(b) || 0) - (oracleScores.get(a) || 0));
  const idcg = computeDCG(idealIds, oracleScores, k);
  if (idcg === 0) return 1.0;
  return Number((dcg / idcg).toFixed(4));
}

function computeRecall(rankedIds: string[], targetIds: Set<string>, k: number): number {
  if (targetIds.size === 0) return 1.0;
  const topK = new Set(rankedIds.slice(0, k));
  let hits = 0;
  for (const id of targetIds) {
    if (topK.has(id)) hits++;
  }
  return Number((hits / targetIds.size).toFixed(4));
}

function computeMRR(rankedIds: string[], targetIds: Set<string>): number {
  for (let i = 0; i < rankedIds.length; i++) {
    if (targetIds.has(rankedIds[i])) {
      return Number((1 / (i + 1)).toFixed(4));
    }
  }
  return 0;
}

/**
 * Derives a metadata-only descriptor of the egress state or payload shape.
 * Replaces actual source content and credentials with string lengths, array item counts, and primitive types.
 */
export function describeMetadataOnlyPayloadShape(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    return `string (${data.length} chars)`;
  }
  if (typeof data === 'number') {
    return `number (${data.toFixed(4)})`;
  }
  if (typeof data === 'boolean') {
    return `boolean (${data})`;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return 'array [0 items]';
    return `array [${data.length} items of ${typeof data[0]}]`;
  }
  if (typeof data === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = describeMetadataOnlyPayloadShape(value);
    }
    return result;
  }
  return typeof data;
}

/**
 * Validates that dist/ was built cleanly from the current Git HEAD commit.
 */
import { verifyCleanBuild, computeSourceTreeHash, gitState } from '../provenance/build_provenance';
export { verifyCleanBuild, computeSourceTreeHash, gitState };

// ---------------------------------------------------------------------------
// High-Fidelity Evaluator for Real Repositories
function createRealPilotClient(
  unitsMap: Map<string, ContextUnit>,
  options: {
    useLive?: boolean;
    apiKey?: string;
    isSmoke?: boolean;
    model?: string;
    endpoint?: string;
    timeoutMs?: number;
    getTracker?: () => JevCallTracker | undefined;
    maxHttpRequestsPerTask?: number;
    retriesConfigured?: number;
  } = {}
): SystemOneClient {
  const isLive = options.useLive ?? (process.env.JEV_LIVE === 'true' || process.argv.includes('--live'));
  const isSmoke = options.isSmoke ?? process.argv.includes('--smoke');
  const apiKey = options.apiKey || process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;

  let peakConcurrency = 0;
  let activeConcurrentRequests = 0;
  let firstCallPayloadShape: Record<string, any> | undefined;
  let firstRequestId: string | undefined;

  const inspectFirstCall = (req: SystemOneEvaluationRequest, res?: SystemOneEvaluationResponse) => {
    if (!firstCallPayloadShape && req.state) {
      firstCallPayloadShape = describeMetadataOnlyPayloadShape(req.state);
    }
    if (!firstRequestId && res?.requestId) {
      firstRequestId = res.requestId;
    }
  };

  async function trackConcurrency<T>(fn: () => Promise<T>): Promise<T> {
    activeConcurrentRequests++;
    if (activeConcurrentRequests > peakConcurrency) {
      peakConcurrency = activeConcurrentRequests;
    }
    try {
      return await fn();
    } finally {
      activeConcurrentRequests = Math.max(0, activeConcurrentRequests - 1);
    }
  }

  if (isLive) {
    if (!apiKey) {
      throw new Error('Live JEV evaluation requested (--live), but no API key was provided (set TYPESAFE_API_KEY or JEV_API_KEY).');
    }
    console.log(`  [Pilot] Using live TypeSafeSystemOneClient (TypeSafe key configured: true, mode: ${isSmoke ? 'SMOKE (max 1 connection retry)' : 'PILOT (max 2 retries)'})`);
    const resolvedEndpoint = options.endpoint ?? process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai';
    const liveClient = new TypeSafeSystemOneClient({
      apiKey,
      baseURL: resolvedEndpoint,
      defaultModel: options.model || process.env.SIFTR_JEV_MODEL || process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest',
      timeoutMs: options.timeoutMs ?? 15000,
      retry: { maxRetries: 0 },
    });

    const maxHttpRequestsPerTask = options.maxHttpRequestsPerTask ?? (options.isSmoke ? 10 : 40);

    const liveClientWrapper: SystemOneClient = {
      async evaluate(req: SystemOneEvaluationRequest): Promise<SystemOneEvaluationResponse> {
        inspectFirstCall(req);
        let retries = 0;
        const tracker = options.getTracker ? options.getTracker() : undefined;

        while (true) {
          if (tracker && tracker.getStats().httpRequests >= maxHttpRequestsPerTask) {
            throw new Error(`maxHttpRequestsPerTask budget exceeded (${maxHttpRequestsPerTask})`);
          }

          tracker?.recordHttpRequest();
          try {
            const res = await trackConcurrency(() => liveClient.evaluate(req));
            inspectFirstCall(req, res);
            return res;
          } catch (err: any) {
            const isTimeout = err instanceof APITimeoutError || err?.name === 'APITimeoutError';
            const isConnection = (err instanceof APIConnectionError || err?.name === 'APIConnectionError') && !isTimeout;
            const is429 =
              err instanceof RateLimitError ||
              err?.name === 'RateLimitError' ||
              (err instanceof APIError && (err.status === 429 || (err as any).statusCode === 429)) ||
              err?.status === 429 ||
              err?.statusCode === 429;

            let attemptCategory: 'TIMEOUT' | 'RATE_LIMITED' | 'CONNECTION_ERROR' | 'PROVIDER_ERROR' = 'PROVIDER_ERROR';
            if (isTimeout) attemptCategory = 'TIMEOUT';
            else if (is429) attemptCategory = 'RATE_LIMITED';
            else if (isConnection) attemptCategory = 'CONNECTION_ERROR';

            tracker?.recordHttpAttemptFailure(attemptCategory);

            let canRetry = false;
            const maxConfiguredRetries = options.retriesConfigured ?? (options.isSmoke ? 1 : 2);
            if (options.isSmoke) {
              // Smoke: at most maxConfiguredRetries connection retry, only for APIConnectionError (fixes stale keep-alive UND_ERR_SOCKET resets). No retry on timeout or 429.
              canRetry = isConnection && retries < maxConfiguredRetries;
            } else {
              // Pilot: at most maxConfiguredRetries retries for 429 and connection errors, honoring err.retryAfterMs when present
              canRetry = (is429 || isConnection) && retries < maxConfiguredRetries;
            }

            if (canRetry) {
              retries++;
              tracker?.recordRetry();

              let delayMs = 100;
              if (typeof err?.retryAfterMs === 'number') {
                delayMs = err.retryAfterMs;
              } else if (is429) {
                delayMs = retries * 1000;
              }

              if (delayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
              }
              continue;
            }

            throw err;
          }
        }
      },
    };
    (liveClientWrapper as any).getPeakConcurrency = () => peakConcurrency;
    (liveClientWrapper as any).getFirstCallPayloadShape = () => firstCallPayloadShape;
    (liveClientWrapper as any).getFirstRequestId = () => firstRequestId;
    return liveClientWrapper;
  }

  const fakeClient = new FakeSystemOneClient(async (req: SystemOneEvaluationRequest) => {
    inspectFirstCall(req);
    return await trackConcurrency(async () => {
      const startTime = Date.now();
      await new Promise((r) => setTimeout(r, 2 + Math.floor(Math.random() * 5)));

      const stateObj = typeof req.state === 'object' && req.state !== null ? (req.state as any) : {};
      const candidateId = stateObj.candidate?.contextUnitId || '';
      const unit = unitsMap.get(candidateId);
      const prompt = (stateObj.task?.prompt || '').toLowerCase();

      // Semantic lexical overlap on actual real unit text and path
      const unitPath = (unit?.path || stateObj.candidate?.path || '').toLowerCase();
      const unitTitle = (unit?.title || stateObj.candidate?.title || '').toLowerCase();
      const unitSignature = (stateObj.candidate?.signature || '').toLowerCase();

      const promptKeywords = prompt
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((w: string) => w.length > 2);

      let matchCount = 0;
      for (const kw of promptKeywords) {
        if (unitPath.includes(kw) || unitTitle.includes(kw) || unitSignature.includes(kw)) {
          matchCount++;
        }
      }

      const keywordRatio = promptKeywords.length > 0 ? matchCount / promptKeywords.length : 0;
      const isExactFileMatch = promptKeywords.some((kw: string) => unitPath.endsWith(kw) || unitPath.includes(`/${kw}.`));

      let semRel = Math.min(0.98, Math.max(0.08, 0.25 + keywordRatio * 0.65 + (isExactFileMatch ? 0.2 : 0) + (Math.random() * 0.08 - 0.04)));
      let impNeed = Math.min(0.98, Math.max(0.05, 0.2 + keywordRatio * 0.6 + (isExactFileMatch ? 0.25 : 0) + (Math.random() * 0.08 - 0.04)));
      let editTarget = Math.min(0.98, Math.max(0.02, 0.1 + keywordRatio * 0.7 + (isExactFileMatch ? 0.3 : 0) + (Math.random() * 0.08 - 0.04)));
      let rootCause = Math.min(0.98, Math.max(0.02, 0.1 + keywordRatio * 0.65 + (isExactFileMatch ? 0.25 : 0) + (Math.random() * 0.08 - 0.04)));

      const res = {
        model: 'synthetic-fake-client',
        answers: {
          semanticRelevance: { noul: Number(semRel.toFixed(4)) },
          implementationNeeded: { noul: Number(impNeed.toFixed(4)) },
          likelyEditTarget: { noul: Number(editTarget.toFixed(4)) },
          likelyRootCause: { noul: Number(rootCause.toFixed(4)) },
        },
        usage: {
          input_tokens: 120 + Math.floor(Math.random() * 60),
          output_tokens: 24,
        },
        requestId: 'req_' + crypto.randomUUID().slice(0, 12),
      };
      inspectFirstCall(req, res);
      return res;
    });
  });

  (fakeClient as any).getPeakConcurrency = () => peakConcurrency;
  (fakeClient as any).getFirstCallPayloadShape = () => firstCallPayloadShape;
  (fakeClient as any).getFirstRequestId = () => firstRequestId;
  return fakeClient;
}

/**
 * Normalizes the full decision plan by extracting all deterministic fields
 * that define the plan's context, units, resolutions, contents, token budgets, and exposure decisions.
 * Strips ephemeral/random identifiers (planId, timestamps, JEV promise) so true bit-for-bit invariance
 * between baseline (JEV OFF) and shadow (JEV ON) runs can be verified via cryptographic hashing.
 */
export function normalizeFullDecisionPlan(plan: ContextPlan): Record<string, any> {
  return {
    taskId: plan.taskId,
    workspaceSnapshotId: plan.workspaceSnapshotId,
    agentEnvironmentId: plan.agentEnvironmentId,
    budgetPlan: {
      totalTokens: plan.budgetPlan?.totalTokens,
      rawTotalTokens: plan.budgetPlan?.rawTotalTokens,
      tokensSaved: plan.budgetPlan?.tokensSaved,
      savingsPercentage: plan.budgetPlan?.savingsPercentage,
      estimatedCostUSD: plan.budgetPlan?.estimatedCostUSD,
      baselineCostUSD: plan.budgetPlan?.baselineCostUSD,
      costSavedUSD: plan.budgetPlan?.costSavedUSD,
      budgetProfile: plan.budgetPlan?.budgetProfile,
      allocations: (plan.budgetPlan?.allocations || []).map((a) => ({
        contextUnitId: a.contextUnitId,
        resolution: a.resolution,
        tokenCost: a.tokenCost,
        rawTokens: a.rawTokens,
        justification: a.justification,
      })),
    },
    units: (plan.units || []).map((u) => ({
      contextUnitId: u.contextUnitId,
      title: u.title,
      path: u.path,
      resolution: u.resolution,
      content: u.content,
      tokenEstimate: u.tokenEstimate,
      reason: u.reason,
    })),
    formattedContext: {
      promptText: plan.formattedContext?.promptText,
      tokenEstimate: plan.formattedContext?.tokenEstimate,
      sections: (plan.formattedContext?.sections || []).map((s) => ({
        title: s.title,
        filePath: s.filePath,
        resolution: s.resolution,
        content: s.content,
        unitId: s.unitId,
      })),
    },
    exposureDecisions: (plan.exposureDecisions || []).map((e) => ({
      contextUnitId: e.contextUnitId,
      exposureResolution: e.exposureResolution,
      exposureRank: e.exposureRank,
      exposureCostTokens: e.exposureCostTokens,
    })),
    actualRenderedTokens: plan.actualRenderedTokens,
    tokenEstimationMethod: plan.tokenEstimationMethod,
    tokenSafetyMargin: plan.tokenSafetyMargin,
  };
}

export interface PlanComparisonResult {
  equal: boolean;
  hashA: string;
  hashB: string;
  diffs: string[];
}

/**
 * Performs a deep normalized comparison of two ContextPlans, returning whether they are identical
 * in deterministic decisions, token allocations, units, and exposure decisions, along with any diffs.
 */
export function compareNormalizedDecisionPlans(planA: ContextPlan, planB: ContextPlan): PlanComparisonResult {
  const normA = normalizeFullDecisionPlan(planA);
  const normB = normalizeFullDecisionPlan(planB);
  const jsonA = JSON.stringify(normA);
  const jsonB = JSON.stringify(normB);
  const hashA = crypto.createHash('sha256').update(jsonA).digest('hex');
  const hashB = crypto.createHash('sha256').update(jsonB).digest('hex');

  const diffs: string[] = [];
  if (normA.taskId !== normB.taskId) diffs.push(`taskId: ${normA.taskId} !== ${normB.taskId}`);
  if (normA.workspaceSnapshotId !== normB.workspaceSnapshotId) {
    diffs.push(`workspaceSnapshotId: ${normA.workspaceSnapshotId} !== ${normB.workspaceSnapshotId}`);
  }
  if (normA.agentEnvironmentId !== normB.agentEnvironmentId) {
    diffs.push(`agentEnvironmentId: ${normA.agentEnvironmentId} !== ${normB.agentEnvironmentId}`);
  }
  if (normA.budgetPlan?.totalTokens !== normB.budgetPlan?.totalTokens) {
    diffs.push(`budgetPlan.totalTokens: ${normA.budgetPlan?.totalTokens} !== ${normB.budgetPlan?.totalTokens}`);
  }
  if (normA.budgetPlan?.rawTotalTokens !== normB.budgetPlan?.rawTotalTokens) {
    diffs.push(`budgetPlan.rawTotalTokens: ${normA.budgetPlan?.rawTotalTokens} !== ${normB.budgetPlan?.rawTotalTokens}`);
  }
  if (normA.units.length !== normB.units.length) {
    diffs.push(`units.length: ${normA.units.length} !== ${normB.units.length}`);
  } else {
    for (let i = 0; i < normA.units.length; i++) {
      const uA = normA.units[i];
      const uB = normB.units[i];
      if (uA.contextUnitId !== uB.contextUnitId) diffs.push(`unit[${i}].id: ${uA.contextUnitId} !== ${uB.contextUnitId}`);
      if (uA.resolution !== uB.resolution) diffs.push(`unit[${i}].resolution: ${uA.resolution} !== ${uB.resolution}`);
    }
  }
  if (normA.exposureDecisions.length !== normB.exposureDecisions.length) {
    diffs.push(`exposureDecisions.length: ${normA.exposureDecisions.length} !== ${normB.exposureDecisions.length}`);
  }
  if (normA.actualRenderedTokens !== normB.actualRenderedTokens) {
    diffs.push(`actualRenderedTokens: ${normA.actualRenderedTokens} !== ${normB.actualRenderedTokens}`);
  }

  if (hashA !== hashB && diffs.length === 0) {
    diffs.push('Normalized decision plan payload content differs');
  }

  return { equal: hashA === hashB, hashA, hashB, diffs };
}

/**
 * Computes deterministic SHA-256 hash of the normalized full decision plan.
 */
export function hashNormalizedDecisionPlan(plan: ContextPlan): string {
  const normalized = normalizeFullDecisionPlan(plan);
  const jsonStr = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(jsonStr).digest('hex');
}

// ---------------------------------------------------------------------------
// Pilot Execution Engine
// ---------------------------------------------------------------------------
export interface PilotStudyOptions {
  useLive?: boolean;
  maxTasks?: number;
  maxCallsPerTask?: number;
  apiKey?: string;
  verbose?: boolean;
  isSmoke?: boolean;
  smoke?: boolean;
  requireCleanBuild?: boolean;
  endpoint?: string;
  allowNonproductionEndpoint?: boolean;
  timeoutMs?: number;
  maxHttpRequestsPerTask?: number;
  minimumValidProviderResponses?: number;
  minProviderSuccessFraction?: number;
  reportJsonPath?: string;
  reportJson?: string;
  model?: string;
  acceptanceConfig?: LiveAcceptanceConfig;
}

export interface ResolvedPilotConfig {
  readonly isLive: boolean;
  readonly isSmoke: boolean;
  readonly maxTasks: number;
  readonly maxCallsPerTask: number;
  readonly maxHttpRequestsPerTask: number;
  readonly retriesConfigured: number;
  readonly endpoint: string;
  readonly endpointIsProduction: boolean;
  readonly allowNonproductionEndpoint: boolean;
  readonly apiKey?: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly minValidResponses: number;
  readonly minSuccessFraction?: number;
  readonly reportJsonPath?: string;
  readonly verbose: boolean;
  readonly requireCleanBuild: boolean;
}

export function resolvePilotConfig(options: PilotStudyOptions = {}): ResolvedPilotConfig {
  const isLive = options.useLive ?? (process.env.JEV_LIVE === 'true' || process.argv.includes('--live'));
  const isSmoke = options.isSmoke ?? options.smoke ?? process.argv.includes('--smoke');
  const tasksArg = process.argv.find((a) => a.startsWith('--tasks='));
  const maxTasks = options.maxTasks ?? (tasksArg ? parseInt(tasksArg.split('=')[1], 10) : (isSmoke ? 5 : AUDITED_PILOT_TASKS.length));
  const callsArg = process.argv.find((a) => a.startsWith('--max-calls='));
  const envMaxCalls = process.env.SIFTR_JEV_MAX_CALLS ? parseInt(process.env.SIFTR_JEV_MAX_CALLS, 10) : undefined;
  const explicitMaxCalls = options.maxCallsPerTask ?? (callsArg ? parseInt(callsArg.split('=')[1], 10) : undefined);
  const maxCallsPerTask = explicitMaxCalls !== undefined ? explicitMaxCalls : (isSmoke ? 5 : (envMaxCalls ?? 20));
  const maxHttpRequestsPerTask = options.maxHttpRequestsPerTask ?? options.maxCallsPerTask ?? (isSmoke ? 10 : 60);
  const verbose = options.verbose ?? (isSmoke || process.argv.includes('--verbose'));
  const apiKey = options.apiKey || process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;

  const endpoint = options.endpoint || process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai';
  const endpointIsProduction = endpoint === 'https://api.typesafe.ai';
  const allowNonproductionEndpoint = options.allowNonproductionEndpoint ?? process.argv.includes('--allow-nonproduction-endpoint');

  if (isLive && !endpointIsProduction && !allowNonproductionEndpoint) {
    throw new Error(`Non-production endpoint "${endpoint}" rejected. Pass --allow-nonproduction-endpoint to allow.`);
  }

  const minValidArg = process.argv.find((a) => a.startsWith('--min-valid-responses='));
  const minValidResponses = options.minimumValidProviderResponses ?? (minValidArg ? parseInt(minValidArg.split('=')[1], 10) : 1);

  const minFracArg = process.argv.find((a) => a.startsWith('--min-success-fraction='));
  const minSuccessFraction = options.minProviderSuccessFraction ?? (minFracArg ? parseFloat(minFracArg.split('=')[1]) : undefined);

  const reportJsonArg = process.argv.find((a) => a.startsWith('--report-json='));
  const reportJsonPath = options.reportJsonPath ?? options.reportJson ?? (reportJsonArg ? reportJsonArg.split('=')[1].replace(/^["']|["']$/g, '') : undefined);

  const timeoutArg = process.argv.find((a) => a.startsWith('--timeout-ms='));
  const timeoutMs = options.timeoutMs ?? (timeoutArg ? parseInt(timeoutArg.split('=')[1], 10) : 15000);

  const requireCleanBuild = options.requireCleanBuild ?? (process.argv.includes('--require-clean-build') || isLive);
  const model = options.model ?? process.env.SIFTR_JEV_MODEL ?? process.env.TYPESAFE_DEFAULT_MODEL ?? (isLive ? 'jev-latest' : 'synthetic-fake-client');
  const retriesConfigured = isSmoke ? 1 : 2;

  return Object.freeze({
    isLive,
    isSmoke,
    maxTasks,
    maxCallsPerTask,
    maxHttpRequestsPerTask,
    retriesConfigured,
    endpoint,
    endpointIsProduction,
    allowNonproductionEndpoint,
    apiKey,
    model,
    timeoutMs,
    minValidResponses,
    minSuccessFraction,
    reportJsonPath,
    verbose,
    requireCleanBuild,
  });
}

export function validateReportConsistency(
  report: PilotReport,
  config: ResolvedPilotConfig
): { consistent: boolean; diffs: string[] } {
  const diffs: string[] = [];

  // Mode consistency
  const expectedMode = config.isLive ? (config.isSmoke ? 'LIVE_SMOKE' : 'LIVE_PILOT') : 'OFFLINE_SYNTHETIC';
  if (report.mode !== expectedMode) {
    diffs.push(`report.mode "${report.mode}" !== expected "${expectedMode}"`);
  }

  // Endpoint consistency
  if (report.endpoint !== config.endpoint) {
    diffs.push(`report.endpoint "${report.endpoint}" !== expected "${config.endpoint}"`);
  }
  if (report.endpointIsProduction !== config.endpointIsProduction) {
    diffs.push(`report.endpointIsProduction "${report.endpointIsProduction}" !== expected "${config.endpointIsProduction}"`);
  }

  // Max calls per task
  if (report.resolvedMaxCallsPerTask !== config.maxCallsPerTask) {
    diffs.push(`report.resolvedMaxCallsPerTask (${report.resolvedMaxCallsPerTask}) !== config.maxCallsPerTask (${config.maxCallsPerTask})`);
  }

  // Task count consistency
  const expectedSelected = config.isSmoke ? 5 : config.maxTasks;
  if (report.selectedTaskCount !== undefined && report.selectedTaskCount !== expectedSelected) {
    diffs.push(`report.selectedTaskCount (${report.selectedTaskCount}) !== expected (${expectedSelected})`);
  }
  if (report.completedTaskCount !== undefined && report.completedTaskCount > (report.selectedTaskCount ?? expectedSelected)) {
    diffs.push(`report.completedTaskCount (${report.completedTaskCount}) > selectedTaskCount (${report.selectedTaskCount})`);
  }

  // Repo / type count sums must match completedTaskCount
  if (report.completedTaskCount !== undefined) {
    const repoSum = report.tasksPerRepo.express + report.tasksPerRepo.fastapi + report.tasksPerRepo.siftrcode;
    if (repoSum !== report.completedTaskCount) {
      diffs.push(`tasksPerRepo sum (${repoSum}) !== completedTaskCount (${report.completedTaskCount})`);
    }
    const typeSum = report.tasksPerType.BUG_FIX + report.tasksPerType.TEST_FAILURE + report.tasksPerType.FEATURE_ADDITION + report.tasksPerType.REFACTOR;
    if (typeSum !== report.completedTaskCount) {
      diffs.push(`tasksPerType sum (${typeSum}) !== completedTaskCount (${report.completedTaskCount})`);
    }
  }

  // Provider calls arithmetic consistency
  const failuresSum =
    report.provider.failuresByCategory.timeouts +
    report.provider.failuresByCategory.rateLimited +
    report.provider.failuresByCategory.malformed +
    report.provider.failuresByCategory.connectionErrors +
    report.provider.failuresByCategory.providerErrors;
  if (report.provider.attempts !== report.provider.successes + failuresSum) {
    diffs.push(`provider.attempts (${report.provider.attempts}) !== successes (${report.provider.successes}) + failures (${failuresSum})`);
  }

  // Ranking ablation arithmetic consistency
  const expectedNdcg10Delta = +(report.rankingAblation.jevAugmented.ndcg10 - report.rankingAblation.baseline.ndcg10).toFixed(4);
  if (report.rankingAblation.ndcg10Delta !== expectedNdcg10Delta) {
    diffs.push(`ndcg10Delta (${report.rankingAblation.ndcg10Delta}) !== calculated (${expectedNdcg10Delta})`);
  }
  const expectedRecall10Delta = +(report.rankingAblation.jevAugmented.recall10 - report.rankingAblation.baseline.recall10).toFixed(4);
  if (report.rankingAblation.recall10Delta !== expectedRecall10Delta) {
    diffs.push(`recall10Delta (${report.rankingAblation.recall10Delta}) !== calculated (${expectedRecall10Delta})`);
  }
  const expectedMrrDelta = +(report.rankingAblation.jevAugmented.mrr - report.rankingAblation.baseline.mrr).toFixed(4);
  if (report.rankingAblation.mrrDelta !== expectedMrrDelta) {
    diffs.push(`mrrDelta (${report.rankingAblation.mrrDelta}) !== calculated (${expectedMrrDelta})`);
  }

  // Recommendation invariant
  if (report.recommendation === 'PASS_TO_30_TASK_PILOT') {
    if (report.failedCriteria && report.failedCriteria.length > 0) {
      diffs.push(`recommendation PASS_TO_30_TASK_PILOT but failedCriteria is non-empty (${report.failedCriteria.join(', ')})`);
    }
  } else if (report.recommendation === 'FIX_AND_REPEAT_SMOKE') {
    if (!report.failedCriteria || report.failedCriteria.length === 0) {
      diffs.push('recommendation FIX_AND_REPEAT_SMOKE but failedCriteria is empty');
    }
  }

  return {
    consistent: diffs.length === 0,
    diffs,
  };
}

export async function runTypeSafeJevPilotStudy(options: PilotStudyOptions = {}): Promise<PilotReport> {
  const config = resolvePilotConfig(options);
  const isLive = config.isLive;
  const isSmoke = config.isSmoke;
  const maxTasks = config.maxTasks;
  const maxCallsPerTask = config.maxCallsPerTask;
  const resolvedMaxHttpRequestsPerTask = config.maxHttpRequestsPerTask;
  const verbose = config.verbose;
  const apiKey = config.apiKey;
  const endpoint = config.endpoint;
  const endpointIsProduction = config.endpointIsProduction;
  const minValid = config.minValidResponses;
  const minFrac = config.minSuccessFraction;
  const reportJsonPath = config.reportJsonPath;
  const timeoutMs = config.timeoutMs;

  const rootDir = process.cwd();
  const expressDir = path.resolve(rootDir, 'benchmarks/express-repo');
  const fastapiDir = path.resolve(rootDir, 'benchmarks/fastapi-repo');

  // Mandatory clean build verification
  const requireCleanBuild = options.requireCleanBuild ?? (process.argv.includes('--require-clean-build') || isLive);
  const cleanBuildResult = verifyCleanBuild(rootDir, { mandatory: requireCleanBuild });
  let testedGitCommit = cleanBuildResult.buildCommit !== 'unbuilt' ? cleanBuildResult.buildCommit : cleanBuildResult.currentGitCommit;

  if (!isLive) {
    console.log('\n================================================================');
    console.log('OFFLINE SYNTHETIC RUN — NOT JEV EVIDENCE');
    console.log('This run used a local synthetic mock client. It validates');
    console.log('harness plumbing only. It does NOT demonstrate live provider');
    console.log('feasibility, latency, cost, or accuracy.');
    console.log('Mode: OFFLINE CALIBRATED');
    console.log('================================================================\n');
  } else {
    console.log('\n================================================================');
    console.log(`  SIFTRCODE V2: TYPESAFE JEV REAL-WORLD PILOT STUDY (${isSmoke ? 5 : maxTasks} TASKS)   `);
    console.log(`  Mode: LIVE REMOTE (TypeSafe SystemOne) | TypeSafe key configured: ${Boolean(apiKey)}`);
    console.log(`  Endpoint: ${endpoint}${endpointIsProduction ? ' (Production)' : ' (Non-Production)'}`);
    console.log(`  Tested Git Commit: ${testedGitCommit}`);
    console.log(`  Clean Build Verification: ${cleanBuildResult.isClean ? 'PASSED (Stamped & In-Sync)' : 'SKIPPED (Non-Mandatory)'}`);
    console.log('================================================================\n');
  }

  const tempDir = path.join(os.tmpdir(), 'temp_jev_pilot_' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });
  const dbPath = path.join(tempDir, 'pilot_telemetry.sqlite');
  const store = new SqliteStore(dbPath);

  // Build one authoritative WorkspaceSnapshot per benchmark repository from live repository state on disk
  const expressManager = new WorkspaceManager({
    rootDir: expressDir,
    repositories: [{ repositoryId: 'express', path: expressDir }],
  });
  const expressSnapshot = await expressManager.captureSnapshot();

  const fastapiManager = new WorkspaceManager({
    rootDir: fastapiDir,
    repositories: [{ repositoryId: 'fastapi', path: fastapiDir }],
  });
  const fastapiSnapshot = await fastapiManager.captureSnapshot();

  const siftrManager = new WorkspaceManager({
    rootDir: rootDir,
    repositories: [{ repositoryId: 'siftrcode', path: rootDir }],
  });
  const siftrSnapshot = await siftrManager.captureSnapshot();

  const repoSnapshots: Record<PilotRepoKind, WorkspaceSnapshot> = {
    express: expressSnapshot,
    fastapi: fastapiSnapshot,
    siftrcode: siftrSnapshot,
  };

  // 1. Pre-index repositories using authoritative snapshot IDs
  console.log('Indexing real repositories on disk with authoritative WorkspaceSnapshots...');

  // Express
  const expressIndexer = new RepositoryIndexer();
  const expressIndexResult = await expressIndexer.indexRepository(expressDir, {
    repositoryId: 'express',
    workspaceSnapshotId: repoSnapshots.express.workspaceSnapshotId,
    trustPolicy: createDefaultRepositoryTrustPolicy({
      repositoryId: 'express',
      origin: RepositoryOrigin.CLONED_EXTERNAL,
    }),
  });
  const expressUnits = expressIndexResult.units;
  for (const u of expressUnits) {
    if (u.workspaceSnapshotId !== repoSnapshots.express.workspaceSnapshotId) {
      const err = new Error(`WORKSPACE_SNAPSHOT_MISMATCH: Express unit "${u.id}" workspaceSnapshotId "${u.workspaceSnapshotId}" does not match authoritative snapshot id "${repoSnapshots.express.workspaceSnapshotId}"`);
      (err as any).code = 'WORKSPACE_SNAPSHOT_MISMATCH';
      throw err;
    }
  }
  const expressGraph = new GraphBuilder().buildGraph(expressUnits, { repoDir: expressDir });
  const expressGit = new GitGraphIntelligence({ repoDir: expressDir });
  console.log(`  ✔ Express indexed (CLONED_EXTERNAL): ${expressUnits.length} units, ${expressGraph.getAllNodes().length} graph nodes [snapshot: ${repoSnapshots.express.workspaceSnapshotId}]`);

  // FastAPI
  const fastapiIndexer = new RepositoryIndexer();
  const fastapiIndexResult = await fastapiIndexer.indexRepository(fastapiDir, {
    repositoryId: 'fastapi',
    workspaceSnapshotId: repoSnapshots.fastapi.workspaceSnapshotId,
    includePatterns: ['fastapi/**'],
    excludePatterns: ['**/tests/**', '**/docs/**', '**/docs_src/**'],
    trustPolicy: createDefaultRepositoryTrustPolicy({
      repositoryId: 'fastapi',
      origin: RepositoryOrigin.CLONED_EXTERNAL,
    }),
  });
  const fastapiUnits = fastapiIndexResult.units;
  for (const u of fastapiUnits) {
    if (u.workspaceSnapshotId !== repoSnapshots.fastapi.workspaceSnapshotId) {
      const err = new Error(`WORKSPACE_SNAPSHOT_MISMATCH: FastAPI unit "${u.id}" workspaceSnapshotId "${u.workspaceSnapshotId}" does not match authoritative snapshot id "${repoSnapshots.fastapi.workspaceSnapshotId}"`);
      (err as any).code = 'WORKSPACE_SNAPSHOT_MISMATCH';
      throw err;
    }
  }
  const fastapiGraph = new GraphBuilder().buildGraph(fastapiUnits, { repoDir: fastapiDir });
  const fastapiGit = new GitGraphIntelligence({ repoDir: fastapiDir });
  console.log(`  ✔ FastAPI indexed (CLONED_EXTERNAL): ${fastapiUnits.length} units, ${fastapiGraph.getAllNodes().length} graph nodes [snapshot: ${repoSnapshots.fastapi.workspaceSnapshotId}]`);

  // SiftrCode
  const siftrIndexer = new RepositoryIndexer();
  const siftrIndexResult = await siftrIndexer.indexRepository(rootDir, {
    repositoryId: 'siftrcode',
    workspaceSnapshotId: repoSnapshots.siftrcode.workspaceSnapshotId,
    includePatterns: ['src/**'],
    excludePatterns: ['**/node_modules/**', '**/dist/**', '**/temp_*/**', '**/benchmarks/**'],
    trustPolicy: createDefaultRepositoryTrustPolicy({
      repositoryId: 'siftrcode',
      origin: RepositoryOrigin.LOCAL_FIRST_PARTY,
    }),
  });
  const siftrUnits = siftrIndexResult.units;
  for (const u of siftrUnits) {
    if (u.workspaceSnapshotId !== repoSnapshots.siftrcode.workspaceSnapshotId) {
      const err = new Error(`WORKSPACE_SNAPSHOT_MISMATCH: SiftrCode unit "${u.id}" workspaceSnapshotId "${u.workspaceSnapshotId}" does not match authoritative snapshot id "${repoSnapshots.siftrcode.workspaceSnapshotId}"`);
      (err as any).code = 'WORKSPACE_SNAPSHOT_MISMATCH';
      throw err;
    }
  }
  const siftrGraph = new GraphBuilder().buildGraph(siftrUnits, { repoDir: rootDir });
  const siftrGit = new GitGraphIntelligence({ repoDir: rootDir });
  console.log(`  ✔ SiftrCode indexed (LOCAL_FIRST_PARTY): ${siftrUnits.length} units, ${siftrGraph.getAllNodes().length} graph nodes [snapshot: ${repoSnapshots.siftrcode.workspaceSnapshotId}]\n`);

  // Combined master units map for evaluation
  const masterUnitsMap = new Map<string, ContextUnit>();
  for (const u of [...expressUnits, ...fastapiUnits, ...siftrUnits]) {
    masterUnitsMap.set(u.id, u);
  }

  // Benchmark repo HEAD SHAs
  const getRepoCommit = (repoDir: string) => {
    try {
      return execSync('git rev-parse HEAD', { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return 'unknown';
    }
  };
  const benchmarkRepoHeadShas: Record<string, string> = {
    express: getRepoCommit(expressDir),
    fastapi: getRepoCommit(fastapiDir),
    siftrcode: getRepoCommit(rootDir),
  };

  // Create TypeSafe client & runner
  let activeRunner: JevShadowRunner | undefined;
  const client = createRealPilotClient(masterUnitsMap, {
    useLive: config.isLive,
    apiKey: config.apiKey,
    isSmoke: config.isSmoke,
    model: config.model,
    endpoint: config.endpoint,
    timeoutMs: config.timeoutMs,
    maxHttpRequestsPerTask: config.maxHttpRequestsPerTask,
    retriesConfigured: config.retriesConfigured,
    getTracker: () => activeRunner?.getLastTracker(),
  });
  const runner = new JevShadowRunner({
    client,
    mode: JevMode.SHADOW,
    sqliteStore: store,
    model: config.model,
    budget: {
      maxCandidates: Math.min(config.maxCallsPerTask, 20),
      maxCallsPerTask: config.maxCallsPerTask,
      maxHttpRequestsPerTask: config.maxHttpRequestsPerTask,
      maxConcurrency: 4,
      maxInputCharacters: 8000,
    },
  });
  activeRunner = runner;

  const jevPermittedRights = createJevPermittedDataRights();

  // Metric collectors
  const latencies: number[] = [];
  const successfulLatencies: number[] = [];
  const allSignals: JevSignalV1[] = [];
  const perTaskPlanInvariance: PerTaskPlanInvariance[] = [];
  const semRelVals: number[] = [];
  const impNeedVals: number[] = [];
  const editTargetVals: number[] = [];
  const rootCauseVals: number[] = [];

  const corrXEdit: number[] = [];
  const corrYEdit: number[] = [];
  const corrXCause: number[] = [];
  const corrYCause: number[] = [];
  const corrXRel: number[] = [];
  const corrYRel: number[] = [];

  const baselineNdcg5: number[] = [];
  const baselineNdcg10: number[] = [];
  const baselineRecall5: number[] = [];
  const baselineRecall10: number[] = [];
  const baselineRecall20: number[] = [];
  const baselineMrr: number[] = [];

  const augmentedNdcg5: number[] = [];
  const augmentedNdcg10: number[] = [];
  const augmentedRecall5: number[] = [];
  const augmentedRecall10: number[] = [];
  const augmentedRecall20: number[] = [];
  const augmentedMrr: number[] = [];

  const callsPerTask: number[] = [];
  let planInvarianceHolds = true;

  const tasksPerRepo: Record<PilotRepoKind, number> = { express: 0, fastapi: 0, siftrcode: 0 };
  const tasksPerType: Record<PilotTaskType, number> = {
    BUG_FIX: 0,
    TEST_FAILURE: 0,
    FEATURE_ADDITION: 0,
    REFACTOR: 0,
  };

  const expressTasks = AUDITED_PILOT_TASKS.filter((t) => t.repo === 'express');
  const fastapiTasks = AUDITED_PILOT_TASKS.filter((t) => t.repo === 'fastapi');
  const siftrTasks = AUDITED_PILOT_TASKS.filter((t) => t.repo === 'siftrcode');

  // Smoke selection: exactly 2 Express + 2 FastAPI + 1 SiftrCode (5 tasks total)
  const selectedTasks = isSmoke
    ? [
        ...expressTasks.slice(0, 2),
        ...fastapiTasks.slice(0, 2),
        ...siftrTasks.slice(0, 1),
      ]
    : AUDITED_PILOT_TASKS.slice(0, maxTasks);

  console.log(`Executing pilot evaluation across ${selectedTasks.length} audited real tasks...`);
  const pilotStartTime = Date.now();

  let totalSuccessful = 0;
  let totalFailed = 0;
  let totalFallback = 0;
  let totalTrustDenied = 0;
  let totalRightsDenied = 0;
  let totalBudgetSkipped = 0;
  let totalRetries = 0;
  let totalHttpRequests = 0;
  let totalSelectedCandidates = 0;
  let totalTimeouts = 0;
  let totalRateLimited = 0;
  let totalMalformed = 0;
  let totalConnectionErrors = 0;
  let totalProviderErrors = 0;
  let totalRedactionCount = 0;
  let snapshotMismatchesCount = 0;
  let startedTaskCount = 0;
  let completedTaskCount = 0;
  let tasksWithValidProviderSignal = 0;
  let totalHttpAttemptTimeouts = 0;
  let totalHttpAttemptRateLimited = 0;
  let totalHttpAttemptMalformed = 0;
  let totalHttpAttemptConnectionErrors = 0;
  let totalHttpAttemptProviderErrors = 0;

  let taskLoopError: Error | undefined;

  try {
    for (let idx = 0; idx < selectedTasks.length; idx++) {
      const taskSpec = selectedTasks[idx];
      startedTaskCount++;

      // Select repository context
      let repoRootDir: string;
      let repoUnits: ContextUnit[];
      let repoGraph: ContextGraph;
      let repoGit: GitGraphIntelligence;

      if (taskSpec.repo === 'express') {
        repoRootDir = expressDir;
        repoUnits = expressUnits;
        repoGraph = expressGraph;
        repoGit = expressGit;
      } else if (taskSpec.repo === 'fastapi') {
        repoRootDir = fastapiDir;
        repoUnits = fastapiUnits;
        repoGraph = fastapiGraph;
        repoGit = fastapiGit;
      } else {
        repoRootDir = rootDir;
        repoUnits = siftrUnits;
        repoGraph = siftrGraph;
        repoGit = siftrGit;
      }

      const evidenceList: any[] = [
        {
          evidenceId: 'ev_' + crypto.randomUUID().slice(0, 8),
          kind: TaskEvidenceKind.USER_PROMPT,
          timestamp: new Date().toISOString(),
          prompt: taskSpec.prompt,
        },
      ];

      const repoSnapshot = repoSnapshots[taskSpec.repo];

      const task = createTaskContext({
        taskId: taskSpec.taskId,
        sessionId: `session_pilot_${idx + 1}`,
        workspaceSnapshotId: repoSnapshot.workspaceSnapshotId,
        primaryPrompt: taskSpec.prompt,
        agentEnvironment: createAgentEnvironment({
          agentProvider: 'benchmark_harness',
        }),
        evidence: evidenceList,
      });

      const repoUnitsMap = new Map<string, ContextUnit>();
      for (const u of repoUnits) repoUnitsMap.set(u.id, u);

      // Identify ground truth ContextUnits for this task
      const groundTruthTargetUnitIds = new Set<string>();
      const groundTruthRelatedUnitIds = new Set<string>();
      const oracleScores = new Map<string, number>();

      for (const u of repoUnits) {
        if (!u.path) continue;
        const isTarget = taskSpec.expectedTargetPaths.some((tp) => u.path!.endsWith(tp) || u.path!.includes(tp));
        const isRelated = taskSpec.expectedRelatedPaths?.some((rp) => u.path!.endsWith(rp) || u.path!.includes(rp));

        if (isTarget) {
          groundTruthTargetUnitIds.add(u.id);
          oracleScores.set(u.id, 3);
        } else if (isRelated) {
          groundTruthRelatedUnitIds.add(u.id);
          oracleScores.set(u.id, 2);
        }
      }

      // In smoke mode, test the application/Railway path on Task 5 (last task of smoke)
      const isRailwayPathTask = isSmoke && idx === selectedTasks.length - 1;
      let shadowEngine: ContextEngine;
      let origRemoteProcessingEnv: string | undefined;

      if (isRailwayPathTask) {
        origRemoteProcessingEnv = process.env.SIFTR_JEV_REMOTE_PROCESSING;
        process.env.SIFTR_JEV_REMOTE_PROCESSING = 'true';

        shadowEngine = new ContextEngine({
          repoRootDir,
          sqliteStore: store,
          jevShadowRunner: runner,
          enableJevShadow: true,
        });

        if (shadowEngine.getDataRights().remoteProcessingAllowed !== true) {
          throw new Error(
            'Railway path verification failed: Expected ContextEngine to resolve remoteProcessingAllowed: true from SIFTR_JEV_REMOTE_PROCESSING'
          );
        }
      } else {
        shadowEngine = new ContextEngine({
          repoRootDir,
          sqliteStore: store,
          jevShadowRunner: runner,
          enableJevShadow: true,
          dataRights: jevPermittedRights,
        });
      }

      const baselineEngine = new ContextEngine({
        repoRootDir,
        sqliteStore: store,
        enableJevShadow: false,
        dataRights: isRailwayPathTask ? undefined : jevPermittedRights,
      });

      const baselinePlan = baselineEngine.generatePlan({
        task,
        units: repoUnits,
        graph: repoGraph,
        gitIntelligence: repoGit,
        snapshot: repoSnapshot,
      });

      const shadowPlan = shadowEngine.generatePlan({
        task,
        units: repoUnits,
        graph: repoGraph,
        gitIntelligence: repoGit,
        snapshot: repoSnapshot,
      });

      const signals = (await shadowPlan.jevPromise) || [];

      if (isRailwayPathTask) {
        if (origRemoteProcessingEnv !== undefined) {
          process.env.SIFTR_JEV_REMOTE_PROCESSING = origRemoteProcessingEnv;
        } else {
          delete process.env.SIFTR_JEV_REMOTE_PROCESSING;
        }
        console.log(`    ✔ [Railway Path Verification] Task ${idx + 1} verified SIFTR_JEV_REMOTE_PROCESSING application path (dataRights omitted)`);
      }

      const tracker = runner.getLastTracker();
      const stats = tracker ? tracker.getStats() : null;
      const taskCallCount = stats ? stats.attemptedCalls : signals.length;
      callsPerTask.push(taskCallCount);
      if (stats) {
        totalSuccessful += stats.successfulCalls;
        totalFailed += stats.failedCalls;
        totalFallback += stats.fallbackCalls;
        totalTrustDenied += stats.trustDeniedCalls;
        totalRightsDenied += stats.rightsDeniedCalls;
        totalBudgetSkipped += stats.budgetSkippedCandidates;
        totalRetries += stats.retries;
        totalHttpRequests += stats.httpRequests;
        totalSelectedCandidates += stats.eligibleCandidates;
        totalTimeouts += stats.timeouts;
        totalRateLimited += stats.rateLimited;
        totalMalformed += stats.malformed;
        totalConnectionErrors += stats.connectionErrors;
        totalProviderErrors += stats.providerErrors;
        totalHttpAttemptTimeouts += stats.httpAttemptFailures.timeouts;
        totalHttpAttemptRateLimited += stats.httpAttemptFailures.rateLimited;
        totalHttpAttemptMalformed += stats.httpAttemptFailures.malformed;
        totalHttpAttemptConnectionErrors += stats.httpAttemptFailures.connectionErrors;
        totalHttpAttemptProviderErrors += stats.httpAttemptFailures.providerErrors;
      }

      if (idx === 0) {
        console.log('\n================================================================');
        console.log('             TASK 1 SAFE STRUCTURAL SUMMARY                     ');
        console.log('================================================================');
        console.log(`Task ID:                 ${taskSpec.taskId}`);
        console.log(`Repository:              ${taskSpec.repo}`);
        console.log(`Prompt Length:           ${taskSpec.prompt.length} characters`);
        console.log(`Prompt Title / Intent:   "${taskSpec.prompt.slice(0, 80)}..."`);
        console.log(`Candidate Paths:         ${JSON.stringify(shadowPlan.units.slice(0, 5).map((u) => u.path))}`);
        console.log(`Candidate Signatures:    ${JSON.stringify(shadowPlan.units.slice(0, 3).map((u) => u.title))}`);
        console.log(`Raw Source Bodies:       [OMITTED - ZERO REMOTE EGRESS]`);
        console.log(`Secrets / API Keys:      [OMITTED - ZERO EGRESS]`);
        console.log('Rights Profile:');
        console.log('  Allowed (Remote):      TASK_PROMPT, SYMBOL_NAME, SYMBOL_METADATA, PATH, NUMERIC_FEATURE');
        console.log('  Denied (Remote):       RAW_SOURCE, SOURCE_SNIPPET, TRAINING');
        console.log('================================================================');

        const shape = typeof (client as any).getFirstCallPayloadShape === 'function' ? (client as any).getFirstCallPayloadShape() : undefined;
        if (shape) {
          console.log('================================================================');
          console.log('       METADATA-ONLY ACTUAL SANITIZED EGRESS PAYLOAD SHAPE      ');
          console.log('================================================================');
          console.log(JSON.stringify(shape, null, 2));
          console.log('================================================================\n');
        }
      }

      if (verbose) {
        const avgLat = signals.length > 0 ? (signals.reduce((a, s) => a + s.latencyMs, 0) / signals.length).toFixed(0) : '0';
        console.log(`\n  --- [Task ${idx + 1}/${selectedTasks.length}] [${taskSpec.repo}] ${taskSpec.taskId} ---`);
        console.log(`    Prompt: "${taskSpec.prompt.slice(0, 90)}..."`);
        console.log(`    Expected Targets: ${JSON.stringify(taskSpec.expectedTargetPaths)}`);
        console.log(`    Evaluated Signals: ${signals.length} | Avg Latency: ${avgLat}ms`);
        if (stats) {
          console.log(`    JevCallTracker: attempted=${stats.attemptedCalls}, successful=${stats.successfulCalls}, failed=${stats.failedCalls}, fallback=${stats.fallbackCalls}, trustDenied=${stats.trustDeniedCalls}, rightsDenied=${stats.rightsDeniedCalls}, skipped=${stats.budgetSkippedCandidates}`);
        }
        for (const sig of signals.slice(0, 4)) {
          const u = repoUnitsMap.get(sig.contextUnitId);
          const pth = u?.path || sig.contextUnitId;
          const isTarget = groundTruthTargetUnitIds.has(sig.contextUnitId);
          console.log(`      • ${pth} [target=${isTarget}]: semRel=${sig.semanticRelevanceProbability}, impNeed=${sig.implementationNeededProbability}, editTarget=${sig.likelyEditTargetProbability}, rootCause=${sig.likelyRootCauseProbability} (${sig.latencyMs}ms)`);
        }
      }

      // Verify Normalized Decision Plan Invariance via Deep Plan Comparison
      const planComparison = compareNormalizedDecisionPlans(baselinePlan, shadowPlan);
      perTaskPlanInvariance.push({
        taskId: taskSpec.taskId,
        baselinePlanHash: planComparison.hashA,
        shadowPlanHash: planComparison.hashB,
        invariant: planComparison.equal,
      });
      if (!planComparison.equal) {
        planInvarianceHolds = false;
        console.warn(`    ⚠️ Normalized decision plan mismatch on task ${taskSpec.taskId}:`, planComparison.diffs);
      }

      // Verify WorkspaceSnapshot identity consistency across TaskContext, Plans, and JEV Signals
      if (task.workspaceSnapshotId !== repoSnapshot.workspaceSnapshotId) {
        snapshotMismatchesCount++;
        console.warn(`[WorkspaceSnapshot Mismatch] Task ${task.taskId} workspaceSnapshotId "${task.workspaceSnapshotId}" != "${repoSnapshot.workspaceSnapshotId}"`);
      }
      if (baselinePlan.workspaceSnapshotId !== repoSnapshot.workspaceSnapshotId) {
        snapshotMismatchesCount++;
        console.warn(`[WorkspaceSnapshot Mismatch] Baseline plan ${baselinePlan.planId} workspaceSnapshotId "${baselinePlan.workspaceSnapshotId}" != "${repoSnapshot.workspaceSnapshotId}"`);
      }
      if (shadowPlan.workspaceSnapshotId !== repoSnapshot.workspaceSnapshotId) {
        snapshotMismatchesCount++;
        console.warn(`[WorkspaceSnapshot Mismatch] Shadow plan ${shadowPlan.planId} workspaceSnapshotId "${shadowPlan.workspaceSnapshotId}" != "${repoSnapshot.workspaceSnapshotId}"`);
      }
      for (const sig of signals) {
        if (sig.workspaceSnapshotId !== repoSnapshot.workspaceSnapshotId) {
          snapshotMismatchesCount++;
          console.warn(`[WorkspaceSnapshot Mismatch] JEV signal ${sig.contextUnitId} workspaceSnapshotId "${sig.workspaceSnapshotId}" != "${repoSnapshot.workspaceSnapshotId}"`);
        }
      }
      if (shadowPlan.jevError) {
        console.warn(`    ⚠️ JEV shadow error on task ${taskSpec.taskId}:`, shadowPlan.jevError.message);
        if (shadowPlan.jevError.message.includes('WORKSPACE_SNAPSHOT_MISMATCH')) {
          snapshotMismatchesCount++;
        }
      }

      // Record distributions and ground-truth correlations
      const signalsMap = new Map<string, JevSignalV1>();
      for (const sig of signals) {
        signalsMap.set(sig.contextUnitId, sig);
        allSignals.push(sig);
        latencies.push(sig.latencyMs);

        if (typeof sig.redactionCount === 'number') {
          totalRedactionCount += sig.redactionCount;
        }

        const allHeadsValid =
          sig.semanticRelevanceProbability !== null &&
          sig.implementationNeededProbability !== null &&
          sig.likelyEditTargetProbability !== null &&
          sig.likelyRootCauseProbability !== null &&
          typeof sig.semanticRelevanceProbability === 'number' &&
          typeof sig.implementationNeededProbability === 'number' &&
          typeof sig.likelyEditTargetProbability === 'number' &&
          typeof sig.likelyRootCauseProbability === 'number' &&
          sig.semanticRelevanceProbability >= 0 && sig.semanticRelevanceProbability <= 1 &&
          sig.implementationNeededProbability >= 0 && sig.implementationNeededProbability <= 1 &&
          sig.likelyEditTargetProbability >= 0 && sig.likelyEditTargetProbability <= 1 &&
          sig.likelyRootCauseProbability >= 0 && sig.likelyRootCauseProbability <= 1 &&
          sig.fallbackReason === undefined;

        if (allHeadsValid) {
          successfulLatencies.push(sig.latencyMs);
        }

        if (sig.semanticRelevanceProbability !== null) {
          semRelVals.push(sig.semanticRelevanceProbability);
        }
        if (sig.implementationNeededProbability !== null) {
          impNeedVals.push(sig.implementationNeededProbability);
        }
        if (sig.likelyEditTargetProbability !== null) {
          editTargetVals.push(sig.likelyEditTargetProbability);
        }
        if (sig.likelyRootCauseProbability !== null) {
          rootCauseVals.push(sig.likelyRootCauseProbability);
        }

        const isTarget = groundTruthTargetUnitIds.has(sig.contextUnitId);
        const isRelated = groundTruthRelatedUnitIds.has(sig.contextUnitId);
        const targetBinary = isTarget ? 1 : 0;
        const relevanceLevel = isTarget ? 1.0 : isRelated ? 0.6 : 0.0;

        if (sig.likelyEditTargetProbability !== null) {
          corrXEdit.push(sig.likelyEditTargetProbability);
          corrYEdit.push(targetBinary);
        }
        if (sig.likelyRootCauseProbability !== null) {
          corrXCause.push(sig.likelyRootCauseProbability);
          corrYCause.push(targetBinary);
        }
        if (sig.semanticRelevanceProbability !== null) {
          corrXRel.push(sig.semanticRelevanceProbability);
          corrYRel.push(relevanceLevel);
        }
      }

      // Ranking Ablation Evaluation
      const generator = new CandidateGenerator();
      const candidates = generator.generateCandidates(task, repoUnits, repoGraph, repoGit);
      const featuresMap = new Map<string, ContextFeaturesV1>();
      for (const c of candidates) {
        const u = repoUnitsMap.get(c.contextUnitId);
        if (u) {
          featuresMap.set(
            c.contextUnitId,
            FeatureBuilderV1.buildFeatures({
              candidate: c,
              unit: u,
              task,
              graph: repoGraph,
              gitIntelligence: repoGit,
            })
          );
        }
      }

      const ranker = new ContextRanker();
      const featuresList = candidates
        .map((c) => featuresMap.get(c.contextUnitId))
        .filter((f): f is ContextFeaturesV1 => f !== undefined);

      const baselineRanked = ranker.rank(featuresList);
      const baselineRankedIds = baselineRanked.map((r: RankedCandidate) => r.contextUnitId);

      const judgmentsMap = new Map<string, any>();
      for (const [unitId, sig] of signalsMap.entries()) {
        judgmentsMap.set(unitId, {
          semanticRelevance: sig.semanticRelevanceProbability ?? undefined,
          semanticRelevanceProbability: sig.semanticRelevanceProbability ?? undefined,
          likelyEditTarget: sig.likelyEditTargetProbability !== null && sig.likelyEditTargetProbability !== undefined ? sig.likelyEditTargetProbability > 0.5 : undefined,
          likelyEditTargetProbability: sig.likelyEditTargetProbability ?? undefined,
          likelyRootCause: sig.likelyRootCauseProbability !== null && sig.likelyRootCauseProbability !== undefined ? sig.likelyRootCauseProbability > 0.5 : undefined,
          likelyRootCauseProbability: sig.likelyRootCauseProbability ?? undefined,
          confidence: 0.9,
        });
      }

      const augmentedRanked = ranker.rank(featuresList, judgmentsMap);
      const augmentedRankedIds = augmentedRanked.map((r: RankedCandidate) => r.contextUnitId);

      baselineNdcg5.push(computeNDCG(baselineRankedIds, oracleScores, 5));
      baselineNdcg10.push(computeNDCG(baselineRankedIds, oracleScores, 10));
      baselineRecall5.push(computeRecall(baselineRankedIds, groundTruthTargetUnitIds, 5));
      baselineRecall10.push(computeRecall(baselineRankedIds, groundTruthTargetUnitIds, 10));
      baselineRecall20.push(computeRecall(baselineRankedIds, groundTruthTargetUnitIds, 20));
      baselineMrr.push(computeMRR(baselineRankedIds, groundTruthTargetUnitIds));

      augmentedNdcg5.push(computeNDCG(augmentedRankedIds, oracleScores, 5));
      augmentedNdcg10.push(computeNDCG(augmentedRankedIds, oracleScores, 10));
      augmentedRecall5.push(computeRecall(augmentedRankedIds, groundTruthTargetUnitIds, 5));
      augmentedRecall10.push(computeRecall(augmentedRankedIds, groundTruthTargetUnitIds, 10));
      augmentedRecall20.push(computeRecall(augmentedRankedIds, groundTruthTargetUnitIds, 20));
      augmentedMrr.push(computeMRR(augmentedRankedIds, groundTruthTargetUnitIds));

      completedTaskCount++;
      tasksPerRepo[taskSpec.repo]++;
      tasksPerType[taskSpec.type]++;
      const taskHasValidSignal = signals.some((sig) =>
        sig.semanticRelevanceProbability !== null &&
        sig.implementationNeededProbability !== null &&
        sig.likelyEditTargetProbability !== null &&
        sig.likelyRootCauseProbability !== null &&
        typeof sig.semanticRelevanceProbability === 'number' &&
        typeof sig.implementationNeededProbability === 'number' &&
        typeof sig.likelyEditTargetProbability === 'number' &&
        typeof sig.likelyRootCauseProbability === 'number' &&
        Number.isFinite(sig.semanticRelevanceProbability) &&
        Number.isFinite(sig.implementationNeededProbability) &&
        Number.isFinite(sig.likelyEditTargetProbability) &&
        Number.isFinite(sig.likelyRootCauseProbability) &&
        sig.semanticRelevanceProbability >= 0 && sig.semanticRelevanceProbability <= 1 &&
        sig.implementationNeededProbability >= 0 && sig.implementationNeededProbability <= 1 &&
        sig.likelyEditTargetProbability >= 0 && sig.likelyEditTargetProbability <= 1 &&
        sig.likelyRootCauseProbability >= 0 && sig.likelyRootCauseProbability <= 1 &&
        sig.fallbackReason === undefined &&
        (isLive ? sig.model !== 'synthetic-fake-client' : true)
      );
      if (taskHasValidSignal) {
        tasksWithValidProviderSignal++;
      }
    }
  } catch (err: any) {
    taskLoopError = err instanceof Error ? err : new Error(String(err));
    console.error('Error during pilot task execution:', err);
  }

  const elapsedTotal = Date.now() - pilotStartTime;
  console.log(`\nCompleted pilot evaluation in ${elapsedTotal}ms.`);

  // -------------------------------------------------------------------------
  // Lineage Coverage Verification (Section 5 & FINAL-3.1 P0)
  // -------------------------------------------------------------------------
  let totalSessions = 0;
  let totalSnapshots = 0;
  let totalContextUnits = 0;
  let totalTaskContexts = 0;
  let totalJevSignals = 0;
  let joinedJevSignals = 0;
  let orphanJevSignals = 0;
  let orphanJevSession = 0;
  let orphanJevContextUnit = 0;
  let orphanJevContextPlan = 0;
  let orphanJevWorkspaceSnapshot = 0;
  let totalContextPlans = 0;
  let joinedContextPlans = 0;
  let orphanContextPlans = 0;
  let orphanContextPlanSession = 0;
  let orphanContextPlanWorkspaceSnapshot = 0;
  let totalCandidateDecisions = 0;
  let joinedCandidateDecisions = 0;
  let orphanCandidateDecisions = 0;
  let orphanCandidateDecisionSession = 0;
  let orphanCandidateDecisionWorkspaceSnapshot = 0;
  let orphanTaskContextSession = 0;
  let orphanTaskContextWorkspaceSnapshot = 0;
  let mismatchedJevAgentEnvs = 0;
  let mismatchedPlanAgentEnvs = 0;
  let mismatchedDecisionAgentEnvs = 0;
  let mismatchedPlanSnapshots = 0;
  let mismatchedJevSnapshots = 0;
  let mismatchedDecisionSnapshots = 0;
  let completeLineageCoverage = false;
  let lineageVerificationSucceeded = false;

  try {
    const db = (store as any).db;
    if (db) {
      totalSessions = (db.prepare('SELECT COUNT(*) as count FROM sessions').get() as any)?.count ?? 0;
      totalSnapshots = (db.prepare('SELECT COUNT(*) as count FROM snapshots').get() as any)?.count ?? 0;
      totalContextUnits = (db.prepare('SELECT COUNT(*) as count FROM context_units').get() as any)?.count ?? 0;
      totalTaskContexts = (db.prepare('SELECT COUNT(*) as count FROM task_contexts').get() as any)?.count ?? 0;

      totalJevSignals = (db.prepare('SELECT COUNT(*) as count FROM jev_shadow_judgments').get() as any)?.count ?? 0;
      joinedJevSignals = (db.prepare('SELECT COUNT(*) as count FROM jev_shadow_judgments j JOIN sessions s ON j.session_id = s.session_id').get() as any)?.count ?? 0;

      totalContextPlans = (db.prepare('SELECT COUNT(*) as count FROM context_plans').get() as any)?.count ?? 0;
      joinedContextPlans = (db.prepare(`SELECT COUNT(*) as count FROM context_plans p JOIN sessions s ON json_extract(p.raw_json, '$.sessionId') = s.session_id`).get() as any)?.count ?? 0;

      totalCandidateDecisions = (db.prepare('SELECT COUNT(*) as count FROM candidate_decision_observations').get() as any)?.count ?? 0;
      joinedCandidateDecisions = (db.prepare('SELECT COUNT(*) as count FROM candidate_decision_observations d JOIN sessions s ON d.session_id = s.session_id').get() as any)?.count ?? 0;

      // Anti-joins checking missing parents or NULL/blank/'unknown' foreign keys:
      // 1. JEV -> Session
      orphanJevSession = (db.prepare(`
        SELECT COUNT(*) as count FROM jev_shadow_judgments j
        LEFT JOIN sessions s ON j.session_id = s.session_id
        WHERE j.session_id IS NULL OR j.session_id = '' OR j.session_id = 'unknown' OR s.session_id IS NULL
      `).get() as any)?.count ?? 0;

      // 2. JEV -> ContextUnit
      orphanJevContextUnit = (db.prepare(`
        SELECT COUNT(*) as count FROM jev_shadow_judgments j
        LEFT JOIN context_units u ON j.context_unit_id = u.unit_id
        WHERE j.context_unit_id IS NULL OR j.context_unit_id = '' OR j.context_unit_id = 'unknown' OR u.unit_id IS NULL
      `).get() as any)?.count ?? 0;

      // 3. JEV -> ContextPlan
      orphanJevContextPlan = (db.prepare(`
        SELECT COUNT(*) as count FROM jev_shadow_judgments j
        LEFT JOIN context_plans p ON j.context_plan_id = p.plan_id
        WHERE j.context_plan_id IS NULL OR j.context_plan_id = '' OR j.context_plan_id = 'unknown' OR p.plan_id IS NULL
      `).get() as any)?.count ?? 0;

      // 4. JEV -> WorkspaceSnapshot
      orphanJevWorkspaceSnapshot = (db.prepare(`
        SELECT COUNT(*) as count FROM jev_shadow_judgments j
        LEFT JOIN snapshots sn ON j.workspace_snapshot_id = sn.snapshot_id
        WHERE j.workspace_snapshot_id IS NULL OR j.workspace_snapshot_id = '' OR j.workspace_snapshot_id = 'unknown' OR sn.snapshot_id IS NULL
      `).get() as any)?.count ?? 0;

      // 5. ContextPlan -> Session
      orphanContextPlanSession = (db.prepare(`
        SELECT COUNT(*) as count FROM context_plans p
        LEFT JOIN sessions s ON json_extract(p.raw_json, '$.sessionId') = s.session_id
        WHERE json_extract(p.raw_json, '$.sessionId') IS NULL OR json_extract(p.raw_json, '$.sessionId') = '' OR json_extract(p.raw_json, '$.sessionId') = 'unknown' OR s.session_id IS NULL
      `).get() as any)?.count ?? 0;

      // 6. ContextPlan -> WorkspaceSnapshot
      orphanContextPlanWorkspaceSnapshot = (db.prepare(`
        SELECT COUNT(*) as count FROM context_plans p
        LEFT JOIN snapshots sn ON p.snapshot_id = sn.snapshot_id
        WHERE p.snapshot_id IS NULL OR p.snapshot_id = '' OR p.snapshot_id = 'unknown' OR sn.snapshot_id IS NULL
      `).get() as any)?.count ?? 0;

      // 7. CandidateDecision -> Session
      orphanCandidateDecisionSession = (db.prepare(`
        SELECT COUNT(*) as count FROM candidate_decision_observations d
        LEFT JOIN sessions s ON d.session_id = s.session_id
        WHERE d.session_id IS NULL OR d.session_id = '' OR d.session_id = 'unknown' OR s.session_id IS NULL
      `).get() as any)?.count ?? 0;

      // 8. CandidateDecision -> WorkspaceSnapshot
      orphanCandidateDecisionWorkspaceSnapshot = (db.prepare(`
        SELECT COUNT(*) as count FROM candidate_decision_observations d
        LEFT JOIN snapshots sn ON d.snapshot_id = sn.snapshot_id
        WHERE d.snapshot_id IS NULL OR d.snapshot_id = '' OR d.snapshot_id = 'unknown' OR sn.snapshot_id IS NULL
      `).get() as any)?.count ?? 0;

      // 9. TaskContext -> Session
      orphanTaskContextSession = (db.prepare(`
        SELECT COUNT(*) as count FROM task_contexts t
        LEFT JOIN sessions s ON json_extract(t.raw_json, '$.sessionId') = s.session_id
        WHERE json_extract(t.raw_json, '$.sessionId') IS NULL
           OR json_extract(t.raw_json, '$.sessionId') = ''
           OR json_extract(t.raw_json, '$.sessionId') = 'unknown'
           OR s.session_id IS NULL
      `).get() as any)?.count ?? 0;

      // 10. TaskContext -> WorkspaceSnapshot
      orphanTaskContextWorkspaceSnapshot = (db.prepare(`
        SELECT COUNT(*) as count FROM task_contexts t
        LEFT JOIN snapshots sn ON t.snapshot_id = sn.snapshot_id
        WHERE t.snapshot_id IS NULL OR t.snapshot_id = '' OR t.snapshot_id = 'unknown' OR sn.snapshot_id IS NULL
      `).get() as any)?.count ?? 0;

      // AgentEnvironment lineage against Session (canonical identity: systemConfigurationHash)
      mismatchedJevAgentEnvs = (db.prepare(`
        SELECT COUNT(*) as count FROM jev_shadow_judgments j
        LEFT JOIN sessions s ON j.session_id = s.session_id
        WHERE j.agent_environment_id IS NULL OR j.agent_environment_id = '' OR j.agent_environment_id = 'unknown'
           OR s.agent_environment_id IS NULL OR s.agent_environment_id = '' OR s.agent_environment_id = 'unknown'
           OR j.agent_environment_id != s.agent_environment_id
      `).get() as any)?.count ?? 0;

      mismatchedPlanAgentEnvs = (db.prepare(`
        SELECT COUNT(*) as count FROM context_plans p
        LEFT JOIN sessions s ON json_extract(p.raw_json, '$.sessionId') = s.session_id
        WHERE json_extract(p.raw_json, '$.agentEnvironmentId') IS NULL OR json_extract(p.raw_json, '$.agentEnvironmentId') = '' OR json_extract(p.raw_json, '$.agentEnvironmentId') = 'unknown'
           OR s.agent_environment_id IS NULL OR s.agent_environment_id = '' OR s.agent_environment_id = 'unknown'
           OR json_extract(p.raw_json, '$.agentEnvironmentId') != s.agent_environment_id
      `).get() as any)?.count ?? 0;

      mismatchedDecisionAgentEnvs = (db.prepare(`
        SELECT COUNT(*) as count FROM candidate_decision_observations d
        LEFT JOIN sessions s ON d.session_id = s.session_id
        WHERE json_extract(d.raw_json, '$.agentEnvironment.systemConfigurationHash') IS NULL OR json_extract(d.raw_json, '$.agentEnvironment.systemConfigurationHash') = '' OR json_extract(d.raw_json, '$.agentEnvironment.systemConfigurationHash') = 'unknown'
           OR s.agent_environment_id IS NULL OR s.agent_environment_id = '' OR s.agent_environment_id = 'unknown'
           OR json_extract(d.raw_json, '$.agentEnvironment.systemConfigurationHash') != s.agent_environment_id
      `).get() as any)?.count ?? 0;

      // Snapshot lineage against Session initial_snapshot_id
      mismatchedPlanSnapshots = (db.prepare(`
        SELECT COUNT(*) as count FROM context_plans p
        LEFT JOIN sessions s ON json_extract(p.raw_json, '$.sessionId') = s.session_id
        WHERE p.snapshot_id IS NULL OR p.snapshot_id = '' OR p.snapshot_id = 'unknown'
           OR s.initial_snapshot_id IS NULL OR s.initial_snapshot_id = '' OR s.initial_snapshot_id = 'unknown'
           OR p.snapshot_id != s.initial_snapshot_id
      `).get() as any)?.count ?? 0;

      mismatchedJevSnapshots = (db.prepare(`
        SELECT COUNT(*) as count FROM jev_shadow_judgments j
        LEFT JOIN sessions s ON j.session_id = s.session_id
        WHERE j.workspace_snapshot_id IS NULL OR j.workspace_snapshot_id = '' OR j.workspace_snapshot_id = 'unknown'
           OR s.initial_snapshot_id IS NULL OR s.initial_snapshot_id = '' OR s.initial_snapshot_id = 'unknown'
           OR j.workspace_snapshot_id != s.initial_snapshot_id
      `).get() as any)?.count ?? 0;

      mismatchedDecisionSnapshots = (db.prepare(`
        SELECT COUNT(*) as count FROM candidate_decision_observations d
        LEFT JOIN sessions s ON d.session_id = s.session_id
        WHERE d.snapshot_id IS NULL OR d.snapshot_id = '' OR d.snapshot_id = 'unknown'
           OR s.initial_snapshot_id IS NULL OR s.initial_snapshot_id = '' OR s.initial_snapshot_id = 'unknown'
           OR d.snapshot_id != s.initial_snapshot_id
      `).get() as any)?.count ?? 0;

      orphanJevSignals = orphanJevSession + orphanJevContextUnit + orphanJevContextPlan + orphanJevWorkspaceSnapshot;
      orphanContextPlans = orphanContextPlanSession + orphanContextPlanWorkspaceSnapshot;
      orphanCandidateDecisions = orphanCandidateDecisionSession + orphanCandidateDecisionWorkspaceSnapshot;
      const orphanTaskContexts = orphanTaskContextSession + orphanTaskContextWorkspaceSnapshot;

      lineageVerificationSucceeded = true;
      completeLineageCoverage =
        orphanJevSignals === 0 &&
        orphanContextPlans === 0 &&
        orphanCandidateDecisions === 0 &&
        orphanTaskContexts === 0 &&
        mismatchedJevAgentEnvs === 0 &&
        mismatchedPlanAgentEnvs === 0 &&
        mismatchedDecisionAgentEnvs === 0 &&
        mismatchedPlanSnapshots === 0 &&
        mismatchedJevSnapshots === 0 &&
        mismatchedDecisionSnapshots === 0 &&
        totalSessions > 0 &&
        totalContextPlans > 0 &&
        totalCandidateDecisions > 0 &&
        (isLive ? totalJevSignals > 0 : true);
    }
  } catch (dbErr) {
    console.error('Lineage database query error:', dbErr);
    lineageVerificationSucceeded = false;
    completeLineageCoverage = false;
  }

  const mismatchedAgentEnvs = mismatchedJevAgentEnvs + mismatchedPlanAgentEnvs + mismatchedDecisionAgentEnvs;
  const mismatchedSnapshots = mismatchedPlanSnapshots + mismatchedJevSnapshots + mismatchedDecisionSnapshots;
  const zeroLineageMismatches =
    lineageVerificationSucceeded &&
    orphanJevSignals === 0 &&
    orphanContextPlans === 0 &&
    orphanCandidateDecisions === 0 &&
    orphanTaskContextSession === 0 &&
    orphanTaskContextWorkspaceSnapshot === 0 &&
    mismatchedAgentEnvs === 0 &&
    mismatchedSnapshots === 0;

  const zeroUnexpectedEgress = totalTrustDenied === 0 && totalRightsDenied === 0;

  const lineageCoverage: LineageCoverage = {
    totalSessions,
    totalJudgments: totalJevSignals,
    orphanJudgments: orphanJevSignals,
    totalPlans: totalContextPlans,
    orphanPlans: orphanContextPlans,
    totalObservations: totalCandidateDecisions,
    orphanObservations: orphanCandidateDecisions,
    mismatchedAgentEnvs,
    mismatchedSnapshots,
    mismatchedDecisionSnapshots,
    lineageVerificationSucceeded,
  };

  // -------------------------------------------------------------------------
  // Compute Acceptance Metrics & Recommendation
  // -------------------------------------------------------------------------
  const isValidProb = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  const validSignalsCount = allSignals.filter((s) =>
    isValidProb(s.semanticRelevanceProbability) &&
    isValidProb(s.implementationNeededProbability) &&
    isValidProb(s.likelyEditTargetProbability) &&
    isValidProb(s.likelyRootCauseProbability) &&
    s.fallbackReason === undefined &&
    (isLive ? s.model !== 'synthetic-fake-client' : true)
  ).length;
  const fallbackSignalsCount = allSignals.length - validSignalsCount;
  const fallbackOnlySignalsCount = allSignals.filter((s) => s.fallbackReason !== undefined).length;
  const syntheticSignalsCount = isLive ? allSignals.filter((s) => s.model === 'synthetic-fake-client').length : 0;

  const returnedProviderModels = Array.from(
    new Set(allSignals.map((s) => s.model).filter((m): m is string => Boolean(m) && m !== 'synthetic-fake-client'))
  );
  if (returnedProviderModels.length === 0 && !isLive) {
    returnedProviderModels.push('synthetic-fake-client');
  }

  const maxHttpRequests = resolvedMaxHttpRequestsPerTask * selectedTasks.length;

  const liveMetrics: LiveMetrics = {
    liveMode: isLive,
    totalTasks: selectedTasks.length,
    selectedTaskCount: selectedTasks.length,
    startedTaskCount,
    completedTaskCount,
    tasksWithValidProviderSignal,
    harnessException: taskLoopError ? taskLoopError.message : undefined,
    maxHttpRequests,
    successfulCalls: totalSuccessful,
    failedCalls: totalFailed,
    rateLimitedCalls: totalRateLimited,
    timeoutCalls: totalTimeouts,
    malformedCalls: totalMalformed,
    connectionErrorCalls: totalConnectionErrors,
    totalHttpRequests,
    totalRetries,
    trustDeniedCalls: totalTrustDenied,
    rightsDeniedCalls: totalRightsDenied,
    planInvarianceHolds,
    zeroLineageMismatches,
    zeroUnexpectedEgress,
    endpoint,
    endpointIsProduction,
    provenanceClean: cleanBuildResult.isClean,
    providerAttempts: totalSuccessful + totalFailed,
    providerSuccesses: totalSuccessful,
    validSignals: validSignalsCount,
    syntheticSignals: syntheticSignalsCount,
    fallbackOnlySignals: fallbackOnlySignalsCount,
    snapshotMismatches: snapshotMismatchesCount + mismatchedSnapshots,
    sessionMismatches: 0,
    agentEnvironmentMismatches: mismatchedAgentEnvs,
    orphanJevSignals,
    orphanContextPlans,
    orphanCandidateDecisions,
    orphanJevSession,
    orphanJevContextUnit,
    orphanJevContextPlan,
    orphanJevWorkspaceSnapshot,
    orphanContextPlanSession,
    orphanContextPlanWorkspaceSnapshot,
    orphanCandidateDecisionSession,
    orphanCandidateDecisionWorkspaceSnapshot,
    orphanTaskContextSession,
    orphanTaskContextWorkspaceSnapshot,
    mismatchedDecisionSnapshots,
    totalJevSignals,
    joinedJevSignals,
    totalContextPlans,
    joinedContextPlans,
    totalCandidateDecisions,
    joinedCandidateDecisions,
    completeLineageCoverage,
    lineageVerificationSucceeded,
    perTaskAttemptsExceeded: callsPerTask.some((c) => c > maxCallsPerTask),
    httpRequestsExceededBudget: totalHttpRequests > maxHttpRequests,
  };

  let recommendation: 'PASS_TO_30_TASK_PILOT' | 'FIX_AND_REPEAT_SMOKE' | null = null;
  let failedCriteria: string[] | undefined = undefined;

  if (isLive) {
    const acceptanceConfig: LiveAcceptanceConfig = {
      minimumValidProviderResponses: minValid,
      minProviderSuccessFraction: minFrac,
      excludeProductionEndpointCheck: options.acceptanceConfig?.excludeProductionEndpointCheck ?? false,
    };
    const evalResult = evaluateLiveAcceptance(liveMetrics, acceptanceConfig);
    failedCriteria = [...evalResult.failed];
    if (taskLoopError && !failedCriteria.some(fc => fc.includes('harness execution without error') || fc.includes('harness crash'))) {
      failedCriteria.push('harness execution error: ' + taskLoopError.message);
    }
    // Calculate recommendation strictly last
    recommendation = failedCriteria.length === 0 ? 'PASS_TO_30_TASK_PILOT' : 'FIX_AND_REPEAT_SMOKE';
  } else {
    recommendation = null;
    failedCriteria = undefined;
  }

  const requestedModel = options.model ?? process.env.SIFTR_JEV_MODEL ?? process.env.TYPESAFE_DEFAULT_MODEL ?? (isLive ? 'jev-latest' : 'synthetic-fake-client');

  const bNdcg5 = computeStats(baselineNdcg5).mean;
  const bNdcg10 = computeStats(baselineNdcg10).mean;
  const bRec5 = computeStats(baselineRecall5).mean;
  const bRec10 = computeStats(baselineRecall10).mean;
  const bRec20 = computeStats(baselineRecall20).mean;
  const bMrr = computeStats(baselineMrr).mean;

  const aNdcg5 = computeStats(augmentedNdcg5).mean;
  const aNdcg10 = computeStats(augmentedNdcg10).mean;
  const aRec5 = computeStats(augmentedRecall5).mean;
  const aRec10 = computeStats(augmentedRecall10).mean;
  const aRec20 = computeStats(augmentedRecall20).mean;
  const aMrr = computeStats(augmentedMrr).mean;

  const report: PilotReport = {
    mode: isLive ? (isSmoke ? 'LIVE_SMOKE' : 'LIVE_PILOT') : 'OFFLINE_SYNTHETIC',
    endpoint,
    endpointIsProduction,
    provenance: {
      testedGitCommit: testedGitCommit || undefined,
      dirty: cleanBuildResult.dirty,
      sourceTreeHash: cleanBuildResult.sourceTreeHash,
      isClean: cleanBuildResult.isClean,
    },
    testedGitCommit: testedGitCommit || undefined,
    sdkVersion: SDK_VERSION,
    requestedModel,
    returnedProviderModels,
    questionSetVersion: JEV_QUESTION_SET_VERSION_V1,
    totalTasks: selectedTasks.length,
    selectedTaskCount: selectedTasks.length,
    startedTaskCount,
    completedTaskCount,
    tasksWithValidProviderSignal,
    tasksPerRepo,
    tasksPerType,
    resolvedMaxCallsPerTask: maxCallsPerTask,
    selectedCandidates: totalSelectedCandidates,
    provider: {
      attempts: totalSuccessful + totalFailed,
      successes: totalSuccessful,
      retries: totalRetries,
      httpRequests: totalHttpRequests,
      failuresByCategory: {
        timeouts: totalTimeouts,
        rateLimited: totalRateLimited,
        malformed: totalMalformed,
        connectionErrors: totalConnectionErrors,
        providerErrors: totalProviderErrors,
      },
      httpAttemptFailures: {
        timeouts: totalHttpAttemptTimeouts,
        rateLimited: totalHttpAttemptRateLimited,
        malformed: totalHttpAttemptMalformed,
        connectionErrors: totalHttpAttemptConnectionErrors,
        providerErrors: totalHttpAttemptProviderErrors,
      },
      rightsDenied: totalRightsDenied,
      trustDenied: totalTrustDenied,
      budgetSkipped: totalBudgetSkipped,
    },
    signals: {
      total: allSignals.length,
      validSignals: validSignalsCount,
      fallbackSignals: fallbackSignalsCount,
    },
    operational: {
      totalCalls: callsPerTask.reduce((a, b) => a + b, 0),
      successfulCalls: totalSuccessful,
      failedCalls: totalFailed,
      fallbackCalls: totalFallback,
      trustDeniedCalls: totalTrustDenied,
      rightsDeniedCalls: totalRightsDenied,
      budgetSkippedCalls: totalBudgetSkipped,
      meanCallsPerTask: computeStats(callsPerTask).mean,
      peakConcurrency: typeof (client as any).getPeakConcurrency === 'function'
        ? (client as any).getPeakConcurrency()
        : runner.getPeakConcurrency(),
      configuredMaxConcurrency: 4,
      latencySummary: computeStats(successfulLatencies),
    },
    redactionCount: totalRedactionCount,
    workspaceSnapshotIds: {
      express: repoSnapshots.express.workspaceSnapshotId,
      fastapi: repoSnapshots.fastapi.workspaceSnapshotId,
      siftrcode: repoSnapshots.siftrcode.workspaceSnapshotId,
    },
    benchmarkRepoHeadShas,
    lineage: {
      orphanJevSignals,
      totalJevSignals,
      joinedJevSignals,
      orphanContextPlans,
      totalContextPlans,
      joinedContextPlans,
      orphanCandidateDecisions,
      totalCandidateDecisions,
      joinedCandidateDecisions,
      mismatchedJevAgentEnvs,
      mismatchedPlanAgentEnvs,
      mismatchedDecisionAgentEnvs,
      mismatchedPlanSnapshots,
      mismatchedJevSnapshots,
      mismatchedDecisionSnapshots,
      completeLineageCoverage,
      lineageVerificationSucceeded,
    },
    lineageCoverage,
    zeroLineageMismatches,
    zeroUnexpectedEgress,
    liveMetrics,
    perTaskPlanInvariance,
    planInvarianceHolds,
    distributions: {
      semanticRelevance: computeStats(semRelVals),
      implementationNeeded: computeStats(impNeedVals),
      likelyEditTarget: computeStats(editTargetVals),
      likelyRootCause: computeStats(rootCauseVals),
    },
    correlations: {
      editTargetVsGroundTruth: computePearsonCorrelation(corrXEdit, corrYEdit),
      rootCauseVsGroundTruth: computePearsonCorrelation(corrXCause, corrYCause),
      semanticRelevanceVsGroundTruth: computePearsonCorrelation(corrXRel, corrYRel),
    },
    rankingAblation: {
      baseline: {
        ndcg5: bNdcg5,
        ndcg10: bNdcg10,
        recall5: bRec5,
        recall10: bRec10,
        recall20: bRec20,
        mrr: bMrr,
      },
      jevAugmented: {
        ndcg5: aNdcg5,
        ndcg10: aNdcg10,
        recall5: aRec5,
        recall10: aRec10,
        recall20: aRec20,
        mrr: aMrr,
      },
      ndcg10Delta: Number((aNdcg10 - bNdcg10).toFixed(4)),
      recall10Delta: Number((aRec10 - bRec10).toFixed(4)),
      mrrDelta: Number((aMrr - bMrr).toFixed(4)),
    },
    metadata: {
      sdk: {
        name: '@typesafe-ai/sdk',
        version: SDK_VERSION,
      },
      model: requestedModel,
      questionSet: {
        version: JEV_QUESTION_SET_VERSION_V1,
        questionCount: Object.keys(JEV_QUESTIONS_V1).length,
        questions: Object.entries(JEV_QUESTIONS_V1).map(([key, q]) => ({
          key,
          prompt: (q as any).instructions || '',
        })),
      },
      redaction: {
        rawSourceExcluded: true,
        secretsRedacted: true,
        tokensOmitted: true,
        allowedDataClasses: [
          DataClass.TASK_PROMPT,
          DataClass.SYMBOL_NAME,
          DataClass.SYMBOL_METADATA,
          DataClass.PATH,
          DataClass.NUMERIC_FEATURE,
        ],
        deniedDataClasses: [
          DataClass.RAW_SOURCE,
          DataClass.SOURCE_SNIPPET,
          DataClass.PATCH,
        ],
      },
      fallback: {
        strategy: isLive ? (isSmoke ? 'smoke_single_connection_retry' : 'pilot_two_retries_with_backoff') : 'offline_calibrated_lexical',
        retriesConfigured: config.retriesConfigured,
        failClosedOnZeroRemoteProbabilities: true,
      },
      sampleSanitizedPayloadShape: typeof (client as any).getFirstCallPayloadShape === 'function'
        ? (client as any).getFirstCallPayloadShape()
        : undefined,
      sampleRequestId: typeof (client as any).getFirstRequestId === 'function'
        ? (client as any).getFirstRequestId()
        : undefined,
    },
    failedCriteria,
    recommendation,
    error: taskLoopError?.message,
  };

  const consistencyResult = validateReportConsistency(report, config);
  report.reportConsistency = consistencyResult;

  if (isLive) {
    if (!consistencyResult.consistent) {
      if (!failedCriteria) failedCriteria = [];
      for (const diff of consistencyResult.diffs) {
        if (!failedCriteria.some(fc => fc.includes(diff))) {
          failedCriteria.push(`report consistency violation: ${diff}`);
        }
      }
      recommendation = 'FIX_AND_REPEAT_SMOKE';
      report.failedCriteria = failedCriteria;
      report.recommendation = recommendation;
    }

    // Authoritative final assertion: PASS requires 100% zero failed criteria
    if (recommendation === 'PASS_TO_30_TASK_PILOT') {
      if (failedCriteria && failedCriteria.length > 0) {
        throw new Error(`INVALID_ACCEPTANCE_STATE: Invariant violated: recommendation is PASS_TO_30_TASK_PILOT but failedCriteria is non-empty: ${JSON.stringify(failedCriteria)}`);
      }
      if (!consistencyResult.consistent) {
        throw new Error(`INVALID_ACCEPTANCE_STATE: Invariant violated: recommendation is PASS_TO_30_TASK_PILOT but reportConsistency has diffs: ${JSON.stringify(consistencyResult.diffs)}`);
      }
    } else if (recommendation === 'FIX_AND_REPEAT_SMOKE') {
      if (!failedCriteria || failedCriteria.length === 0) {
        throw new Error('INVALID_ACCEPTANCE_STATE: Invariant violated: recommendation is FIX_AND_REPEAT_SMOKE but failedCriteria is empty');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Print Pilot Summary Tables
  // -------------------------------------------------------------------------
  const reportHeader = isLive
    ? (isSmoke ? 'LIVE JEV SMOKE REPORT' : 'LIVE JEV PILOT REPORT')
    : (isSmoke ? 'OFFLINE SYNTHETIC RUN — NOT JEV EVIDENCE' : 'AUDITED PILOT RESULTS SUMMARY (OFFLINE SYNTHETIC)');

  console.log('\n================================================================');
  console.log(`                     ${reportHeader}                      `);
  console.log('================================================================');
  console.log(`Mode:                    ${report.mode === 'LIVE_SMOKE' || report.mode === 'LIVE_PILOT' ? `LIVE REMOTE (TypeSafe SystemOne) | TypeSafe key configured: ${Boolean(apiKey)}` : 'OFFLINE CALIBRATED'}`);
  console.log(`Endpoint:                ${report.endpoint} (${report.endpointIsProduction ? 'Production' : 'Non-Production'})`);
  console.log(`Tested Git Commit:       ${report.testedGitCommit || 'unknown'} (dirty: ${report.provenance.dirty}, hash: ${report.provenance.sourceTreeHash?.slice(0, 12)}...)`);
  console.log(`SDK Version:             ${report.sdkVersion}`);
  console.log(`Requested Model:         ${report.requestedModel}`);
  console.log(`Returned Provider Models:${JSON.stringify(report.returnedProviderModels)}`);
  console.log(`Tasks Evaluated:         ${report.completedTaskCount ?? report.totalTasks}/${report.selectedTaskCount ?? report.totalTasks} (Valid Signals: ${report.tasksWithValidProviderSignal ?? 0}, Express: ${report.tasksPerRepo.express}, FastAPI: ${report.tasksPerRepo.fastapi}, SiftrCode: ${report.tasksPerRepo.siftrcode})`);
  console.log(`Resolved Max Calls/Task: ${report.resolvedMaxCallsPerTask}`);
  console.log(`Selected Candidates:     ${report.selectedCandidates}`);
  console.log(`Decision Plan Invariance:${report.planInvarianceHolds ? 'PASSED (100% normalized decision plan match)' : 'FAILED'}`);
  if (report.perTaskPlanInvariance && report.perTaskPlanInvariance.length > 0) {
    for (const inv of report.perTaskPlanInvariance) {
      console.log(`  Plan Invariance [${inv.taskId}]: baseline=${inv.baselinePlanHash.slice(0, 12)}... shadow=${inv.shadowPlanHash.slice(0, 12)}... match=${inv.invariant}`);
    }
  }
  console.log(`Provider Calls:          Attempts: ${report.provider.attempts}, Successes: ${report.provider.successes}, Retries: ${report.provider.retries}, HTTP Requests: ${report.provider.httpRequests}`);
  console.log(`Terminal Failures:       Timeouts: ${report.provider.failuresByCategory.timeouts}, RateLimited: ${report.provider.failuresByCategory.rateLimited}, Malformed: ${report.provider.failuresByCategory.malformed}, Connection: ${report.provider.failuresByCategory.connectionErrors}, ProviderErrors: ${report.provider.failuresByCategory.providerErrors}`);
  if (report.provider.httpAttemptFailures) {
    console.log(`HTTP Attempt Failures:   Timeouts: ${report.provider.httpAttemptFailures.timeouts}, RateLimited: ${report.provider.httpAttemptFailures.rateLimited}, Malformed: ${report.provider.httpAttemptFailures.malformed}, Connection: ${report.provider.httpAttemptFailures.connectionErrors}, ProviderErrors: ${report.provider.httpAttemptFailures.providerErrors}`);
  }
  console.log(`Rights / Trust / Budget: RightsDenied: ${report.provider.rightsDenied}, TrustDenied: ${report.provider.trustDenied}, BudgetSkipped: ${report.provider.budgetSkipped}`);
  console.log(`Signals Health:          Valid Signals: ${report.signals.validSignals}, Fallback Signals: ${report.signals.fallbackSignals}`);
  console.log(`P50 Latency (Success):   ${report.operational.latencySummary.median}ms (P95: ${report.operational.latencySummary.p95}ms)`);
  console.log(`Redactions Applied:      ${report.redactionCount}`);
  console.log(`Peak Concurrency:        Measured = ${report.operational.peakConcurrency} (Configured Limit: ${report.operational.configuredMaxConcurrency || 4})`);
  console.log(`Per-Repo Snapshots:      ${JSON.stringify(report.workspaceSnapshotIds)}`);
  console.log(`Benchmark Repo Commits:  ${JSON.stringify(report.benchmarkRepoHeadShas)}`);
  console.log(`Lineage Coverage:        JEV: ${report.lineage.joinedJevSignals}/${report.lineage.totalJevSignals} (orphans: ${report.lineage.orphanJevSignals}), Plans: ${report.lineage.joinedContextPlans}/${report.lineage.totalContextPlans} (orphans: ${report.lineage.orphanContextPlans}), Decisions: ${report.lineage.joinedCandidateDecisions}/${report.lineage.totalCandidateDecisions} (orphans: ${report.lineage.orphanCandidateDecisions})`);
  console.log(`Lineage Complete:        ${report.lineage.completeLineageCoverage ? 'YES' : 'NO'}`);
  console.log('----------------------------------------------------------------');
  console.log('Continuous Probability Distributions:');
  console.log(`  Semantic Relevance:    mean=${report.distributions.semanticRelevance.mean}, median=${report.distributions.semanticRelevance.median}, [${report.distributions.semanticRelevance.min} - ${report.distributions.semanticRelevance.max}]`);
  console.log(`  Implementation Needed: mean=${report.distributions.implementationNeeded.mean}, median=${report.distributions.implementationNeeded.median}, [${report.distributions.implementationNeeded.min} - ${report.distributions.implementationNeeded.max}]`);
  console.log(`  Likely Edit Target:    mean=${report.distributions.likelyEditTarget.mean}, median=${report.distributions.likelyEditTarget.median}, [${report.distributions.likelyEditTarget.min} - ${report.distributions.likelyEditTarget.max}]`);
  console.log(`  Likely Root Cause:     mean=${report.distributions.likelyRootCause.mean}, median=${report.distributions.likelyRootCause.median}, [${report.distributions.likelyRootCause.min} - ${report.distributions.likelyRootCause.max}]`);
  console.log('----------------------------------------------------------------');
  console.log(`Correlation with Ground Truth ${isLive ? '' : '(Synthetic Fake Data - Offline Benchmark)'}:`);
  console.log(`  Likely Edit Target:    r = ${report.correlations.editTargetVsGroundTruth}`);
  console.log(`  Likely Root Cause:     r = ${report.correlations.rootCauseVsGroundTruth}`);
  console.log(`  Semantic Relevance:    r = ${report.correlations.semanticRelevanceVsGroundTruth}`);
  console.log('----------------------------------------------------------------');
  console.log(`Ranking Ablation (Baseline ContextRank vs JEV-Augmented) ${isLive ? '' : '(Synthetic Fake Data - Offline Benchmark)'}:`);
  console.log(`  NDCG@5:     Baseline = ${report.rankingAblation.baseline.ndcg5}  | JEV = ${report.rankingAblation.jevAugmented.ndcg5}`);
  console.log(`  NDCG@10:    Baseline = ${report.rankingAblation.baseline.ndcg10}  | JEV = ${report.rankingAblation.jevAugmented.ndcg10} (Delta: ${report.rankingAblation.ndcg10Delta >= 0 ? '+' : ''}${report.rankingAblation.ndcg10Delta})`);
  console.log(`  Recall@5:   Baseline = ${report.rankingAblation.baseline.recall5}  | JEV = ${report.rankingAblation.jevAugmented.recall5}`);
  console.log(`  Recall@10:  Baseline = ${report.rankingAblation.baseline.recall10}  | JEV = ${report.rankingAblation.jevAugmented.recall10} (Delta: ${report.rankingAblation.recall10Delta >= 0 ? '+' : ''}${report.rankingAblation.recall10Delta})`);
  console.log(`  MRR:        Baseline = ${report.rankingAblation.baseline.mrr}  | JEV = ${report.rankingAblation.jevAugmented.mrr} (Delta: ${report.rankingAblation.mrrDelta >= 0 ? '+' : ''}${report.rankingAblation.mrrDelta})`);
  console.log('================================================================');
  if (report.failedCriteria && report.failedCriteria.length > 0) {
    console.log(`Failed Acceptance Criteria (${report.failedCriteria.length}):`);
    for (const fc of report.failedCriteria) {
      console.log(`  ✖ ${fc}`);
    }
  }
  console.log(`FINAL RECOMMENDATION: ${report.recommendation ?? 'NONE (Offline synthetic run)'}`);
  console.log('================================================================\n');

  if (reportJsonPath) {
    try {
      fs.writeFileSync(path.resolve(reportJsonPath), JSON.stringify(report, null, 2), 'utf-8');
      console.log(`Report JSON written to: ${path.resolve(reportJsonPath)}`);
    } catch (writeErr) {
      console.error('Failed to write report JSON:', writeErr);
    }
  }

  // Close SQLite store connection and cleanup temp dir
  try {
    store.close();
  } catch {
    // Ignore close error
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup error
  }

  return report;
}

if (require.main === module) {
  runTypeSafeJevPilotStudy()
    .then((report) => {
      if (report.mode === 'OFFLINE_SYNTHETIC') {
        process.exit(0);
      }
      if (report.recommendation === 'PASS_TO_30_TASK_PILOT') {
        process.exit(0);
      } else {
        process.exit(2);
      }
    })
    .catch((err) => {
      console.error('Pilot study crashed:', err);
      process.exit(1);
    });
}
