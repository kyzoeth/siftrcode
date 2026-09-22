/**
 * SiftrCode V2 - Canonical Task Episode Model (Phase 20A)
 *
 * Defines the durable first-class unit of learning and evaluation: TaskEpisodeV1.
 * Captures the complete journey of a coding task attempt from prompt and candidate
 * universe to agent actions, verified outcome, and token economics.
 */

import * as crypto from 'crypto';
import { TaskEvidence } from '../../context/task_evidence';
import { CandidateObservation, SelectedContextObservation } from './candidate_observation';
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
    siftrVersion: string;
    siftrGitSha: string;
    contextPolicyId: string;
    rankerId: string;
    rankerStatus: RankerStatus;
    model?: string;
    agentType?: string;
    toolConfigurationHash: string;
    systemConfigurationHash: string;
  };

  rights: {
    serviceProcessingAllowed: boolean;
    trainingAllowed: boolean;
    redistributionAllowed: boolean;
    permissionSource: string;
    decisionTimestamp: string;
  };

  contextDecision: {
    candidateCount: number;
    candidates: CandidateObservation[];
    selectedUnits: SelectedContextObservation[];
    bundleSha256: string;
    actualRenderedTokens: number;
    tokenBudget: number;
    estimatedContextCostUSD?: number | null;
    generationLatencyMs: number;
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
 * Computes record SHA-256 for a TaskEpisodeV1 record.
 */
export function computeEpisodeRecordSha256(episode: Omit<TaskEpisodeV1, 'integrity'> & { integrity: Omit<TaskEpisodeV1['integrity'], 'recordSha256'> }): string {
  const content = JSON.stringify({
    schemaVersion: episode.schemaVersion,
    episodeId: episode.episodeId,
    repositoryId: episode.repositoryId,
    taskId: episode.taskId,
    sessionId: episode.sessionId,
    baseCommit: episode.workspace.baseCommit,
    promptSha256: episode.task.promptSha256,
    bundleSha256: episode.contextDecision.bundleSha256,
    contextPolicyId: episode.environment.contextPolicyId,
    rankerId: episode.environment.rankerId,
    rankerStatus: episode.environment.rankerStatus,
    trainingAllowed: episode.rights.trainingAllowed,
    verifiedSuccess: episode.outcome.verifiedSuccess,
    verificationConfidence: episode.outcome.verificationConfidence,
    featureCutoffCommit: episode.integrity.featureCutoffCommit,
    createdAt: episode.integrity.createdAt,
  });
  return crypto.createHash('sha256').update(content).digest('hex');
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

  return {
    ...intermediate,
    integrity: {
      ...intermediate.integrity,
      recordSha256,
    },
  };
}
