/**
 * SiftrCode V2 - Canonical Task Episode Model (Phase 20A)
 *
 * Defines the durable first-class unit of learning and evaluation: TaskEpisodeV1.
 * Captures the complete journey of a coding task attempt from prompt and candidate
 * universe to agent actions, verified outcome, and token economics.
 */

import * as crypto from 'crypto';
import { TaskEvidence } from '../../context/task_evidence';
import { ContextPolicyIdentity } from '../../engine/context_plan';
import { CandidateObservation, SelectedContextObservation } from './candidate_observation';
import { deepFreeze, canonicalJsonSerialize } from './pre_outcome_snapshot';
import { AgentTrajectorySummary } from './agent_trajectory';
import { TaskOutcomeV1 } from '../outcome/task_outcome';
import { TaskEconomicsV1 } from '../economics/task_economics';

export type TaskType =
  | 'BUG_FIX'
  | 'FEATURE_ADDITION'
  | 'REFACTOR'
  | 'TEST_FAILURE'
  | 'OTHER';

export type RankerStatus =
  | 'PRODUCTION'
  | 'SHADOW'
  | 'RESEARCH';

export interface TaskEpisodeV1 {
  schemaVersion: 'TASK_EPISODE_V1';

  episodeId: string;

  tenantId?: string;
  repositoryId: string;

  sessionId: string;
  taskId: string;

  startedAt: string;
  completedAt?: string;

  workspace: {
    repositoryIdentity: string;
    baseCommit: string;
    dirtyAtStart: boolean;
    workspaceSnapshotId: string;
    branchName?: string;
    sourceProvenanceId?: string;
  };

  task: {
    prompt: string;
    taskType?: TaskType;
    evidence: TaskEvidence[];
    promptSha256: string;
  };

  environment: {
    siftrVersion?: string | null;
    siftrGitSha?: string | null;
    contextPolicyId: string;
    rankerId: string;
    rankerStatus: RankerStatus;
    contextPolicyIdentity?: ContextPolicyIdentity;
    model?: string;
    agentType?: string;
    toolConfigurationHash?: string | null;
    systemConfigurationHash?: string | null;
  };

  rights: {
    serviceProcessingAllowed?: boolean | null;
    trainingAllowed: boolean;
    redistributionAllowed?: boolean | null;
    permissionSource: string;
    decisionTimestamp?: string | null;
  };

  contextDecision: {
    candidateCount: number;
    candidates: CandidateObservation[];
    selectedUnits: SelectedContextObservation[];
    bundleSha256: string;
    actualRenderedTokens: number;
    tokenBudget: number;
    estimatedContextCostUSD?: number | null;
    generationLatencyMs?: number | null;
  };

  trajectory?: AgentTrajectorySummary;

  outcome: TaskOutcomeV1;

  economics?: TaskEconomicsV1;

  integrity: {
    createdAt: string;
    recordSha256: string;
    featureCutoffCommit: string;
    containsPostOutcomeData: boolean;
  };
}

/**
 * Computes record SHA-256 for a TaskEpisodeV1 record over the full canonical payload
 * excluding integrity.recordSha256.
 */
export function computeEpisodeRecordSha256(episode: Omit<TaskEpisodeV1, 'integrity'> & { integrity: Omit<TaskEpisodeV1['integrity'], 'recordSha256'> }): string {
  const fullPayload = {
    schemaVersion: episode.schemaVersion,
    episodeId: episode.episodeId,
    tenantId: episode.tenantId,
    repositoryId: episode.repositoryId,
    sessionId: episode.sessionId,
    taskId: episode.taskId,
    startedAt: episode.startedAt,
    completedAt: episode.completedAt,
    workspace: episode.workspace,
    task: episode.task,
    environment: episode.environment,
    rights: episode.rights,
    contextDecision: episode.contextDecision,
    trajectory: episode.trajectory,
    outcome: episode.outcome,
    economics: episode.economics,
    integrity: {
      createdAt: episode.integrity.createdAt,
      featureCutoffCommit: episode.integrity.featureCutoffCommit,
      containsPostOutcomeData: episode.integrity.containsPostOutcomeData,
    },
  };
  const serialized = canonicalJsonSerialize(fullPayload);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * Loads, verifies, and returns a verified TaskEpisodeV1.
 * Invariants enforced:
 * 1. Checks schemaVersion === 'TASK_EPISODE_V1'.
 * 2. Recomputes SHA-256 over entire canonical payload without stored recordSha256.
 * 3. Fails closed with FAIL_CLOSED_EPISODE_HASH_MISMATCH if payload was tampered with or corrupted.
 * 4. Deeply freezes verified episode.
 */
export function loadVerifiedTaskEpisode(
  rawJsonOrObj: string | Record<string, unknown> | TaskEpisodeV1
): TaskEpisodeV1 {
  let parsed: any;
  if (typeof rawJsonOrObj === 'string') {
    try {
      parsed = JSON.parse(rawJsonOrObj);
    } catch (err) {
      throw new Error(`FAIL_CLOSED_CORRUPT_EPISODE: Failed to parse episode JSON: ${err}`);
    }
  } else {
    parsed = JSON.parse(JSON.stringify(rawJsonOrObj));
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('FAIL_CLOSED_INVALID_EPISODE: Episode payload is not an object.');
  }

  if (parsed.schemaVersion !== 'TASK_EPISODE_V1') {
    throw new Error(`FAIL_CLOSED_INVALID_SCHEMA: Unsupported episode schema version: ${parsed.schemaVersion}`);
  }

  const storedSha = parsed.integrity?.recordSha256;
  if (!storedSha || typeof storedSha !== 'string') {
    throw new Error('FAIL_CLOSED_EPISODE_UNHASHED: Episode missing integrity.recordSha256.');
  }

  const intermediate = {
    ...parsed,
    integrity: {
      ...parsed.integrity,
    },
  };
  delete intermediate.integrity.recordSha256;

  const computedSha = computeEpisodeRecordSha256(intermediate);

  if (computedSha !== storedSha) {
    throw new Error(
      `FAIL_CLOSED_EPISODE_HASH_MISMATCH: Stored episode record hash "${storedSha}" does not match recomputed full-payload hash "${computedSha}". Episode in database has been tampered with or corrupted.`
    );
  }

  deepFreeze(parsed);
  return parsed as TaskEpisodeV1;
}

/**
 * Factory for creating a validated, hashed TaskEpisodeV1.
 */
export function createTaskEpisodeV1(params: {
  episodeId?: string;
  tenantId?: string;
  repositoryId: string;
  sessionId: string;
  taskId: string;
  startedAt?: string;
  completedAt?: string;
  workspace: TaskEpisodeV1['workspace'];
  task: {
    prompt: string;
    taskType?: TaskType;
    evidence?: TaskEvidence[];
  };
  environment: TaskEpisodeV1['environment'];
  rights: TaskEpisodeV1['rights'];
  contextDecision: TaskEpisodeV1['contextDecision'];
  trajectory?: AgentTrajectorySummary;
  outcome: TaskOutcomeV1;
  economics?: TaskEconomicsV1;
  featureCutoffCommit?: string;
}): TaskEpisodeV1 {
  const episodeId = params.episodeId || `ep_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
  const startedAt = params.startedAt || new Date().toISOString();
  const createdAt = new Date().toISOString();
  const promptSha256 = crypto.createHash('sha256').update(params.task.prompt).digest('hex');
  const featureCutoffCommit = params.featureCutoffCommit || params.workspace.baseCommit;

  const intermediate: Omit<TaskEpisodeV1, 'integrity'> & { integrity: Omit<TaskEpisodeV1['integrity'], 'recordSha256'> } = {
    schemaVersion: 'TASK_EPISODE_V1',
    episodeId,
    tenantId: params.tenantId,
    repositoryId: params.repositoryId,
    sessionId: params.sessionId,
    taskId: params.taskId,
    startedAt,
    completedAt: params.completedAt,
    workspace: params.workspace,
    task: {
      prompt: params.task.prompt,
      taskType: params.task.taskType || 'OTHER',
      evidence: params.task.evidence || [],
      promptSha256,
    },
    environment: params.environment,
    rights: params.rights,
    contextDecision: params.contextDecision,
    trajectory: params.trajectory,
    outcome: params.outcome,
    economics: params.economics,
    integrity: {
      createdAt,
      featureCutoffCommit,
      containsPostOutcomeData: true, // Episode record includes trajectory/outcome
    },
  };

  const recordSha256 = computeEpisodeRecordSha256(intermediate);

  const episode: TaskEpisodeV1 = {
    ...intermediate,
    integrity: {
      ...intermediate.integrity,
      recordSha256,
    },
  };
  deepFreeze(episode);
  return episode;
}
