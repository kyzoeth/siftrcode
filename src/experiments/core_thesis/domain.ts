/**
 * Phase 21 — Core Thesis Experiment Domain Model
 *
 * The only manipulated variable in a valid experiment is context policy.
 * Experiment metadata and assignments are immutable once frozen/persisted.
 */
import * as crypto from 'crypto';
import { canonicalJsonSerialize, deepFreeze } from '../../learning/episodes/pre_outcome_snapshot';

export type ContextPolicyExperimentStatus = 'DRAFT' | 'FROZEN' | 'RUNNING' | 'COMPLETE';
export type ExperimentAssignmentMode = 'PAIRED_OFFLINE' | 'RANDOMIZED_LIVE';
export type ExperimentArm = 'CONTROL' | 'SIFTRCODE';
export type CoreThesisDecision =
  | 'CORE_THESIS_SUPPORTED'
  | 'CORE_THESIS_NOT_DEMONSTRATED'
  | 'CORE_THESIS_CHALLENGED'
  | 'INSUFFICIENT_VERIFIED_DATA';

export interface ContextPolicyDescriptor {
  contextPolicyId: string;
  implementationVersion: string;
  description: string;
}

export interface ContextPolicyExperiment {
  schemaVersion: 'CONTEXT_POLICY_EXPERIMENT_V1';
  experimentId: string;
  experimentVersion: string;
  hypothesis: string;
  primaryMetric: 'VERIFIED_TASK_SUCCESS';
  controlPolicy: ContextPolicyDescriptor;
  treatmentPolicy: ContextPolicyDescriptor;
  assignmentMode: ExperimentAssignmentMode;
  status: ContextPolicyExperimentStatus;
  startedAt?: string;
  frozenAt?: string;
  protocolSha256?: string;
  seed: string;
}

export interface ExperimentAssignment {
  schemaVersion: 'EXPERIMENT_ASSIGNMENT_V1';
  experimentId: string;
  experimentVersion: string;
  assignmentId: string;
  taskId: string;
  episodeId: string;
  arm: ExperimentArm;
  contextPolicyId: string;
  assignedAt: string;
  assignmentSha256: string;
}

export interface ExperimentParityFingerprint {
  sourceBaseCommit: string;
  agentConfigSha256: string;
  modelConfigSha256: string;
  toolConfigSha256: string;
  verificationConfigSha256: string;
  executionBudgetSha256: string;
  workspaceStateSha256: string;
  contextPolicyId: string;
}

export interface ExperimentIntegrityViolation {
  code: string;
  message: string;
}

export function sha256Canonical(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJsonSerialize(value)).digest('hex');
}

export function createExperimentAssignment(params: {
  experiment: ContextPolicyExperiment;
  taskId: string;
  episodeId: string;
  arm: ExperimentArm;
  assignedAt?: string;
}): ExperimentAssignment {
  const contextPolicyId =
    params.arm === 'CONTROL'
      ? params.experiment.controlPolicy.contextPolicyId
      : params.experiment.treatmentPolicy.contextPolicyId;
  const core = {
    schemaVersion: 'EXPERIMENT_ASSIGNMENT_V1' as const,
    experimentId: params.experiment.experimentId,
    experimentVersion: params.experiment.experimentVersion,
    assignmentId: `assign_${sha256Canonical({
      experimentId: params.experiment.experimentId,
      experimentVersion: params.experiment.experimentVersion,
      taskId: params.taskId,
      episodeId: params.episodeId,
      arm: params.arm,
      seed: params.experiment.seed,
    }).slice(0, 24)}`,
    taskId: params.taskId,
    episodeId: params.episodeId,
    arm: params.arm,
    contextPolicyId,
    assignedAt: params.assignedAt || new Date().toISOString(),
  };
  return deepFreeze({
    ...core,
    assignmentSha256: sha256Canonical(core),
  }) as ExperimentAssignment;
}

export function deterministicLiveArm(
  experiment: ContextPolicyExperiment,
  taskId: string,
  episodeId: string
): ExperimentArm {
  if (experiment.assignmentMode !== 'RANDOMIZED_LIVE') {
    throw new Error('FAIL_CLOSED_EXPERIMENT_MODE: deterministicLiveArm requires RANDOMIZED_LIVE.');
  }
  const digest = crypto
    .createHash('sha256')
    .update(`${experiment.seed}\0${experiment.experimentId}\0${experiment.experimentVersion}\0${taskId}\0${episodeId}`)
    .digest();
  return (digest[0] & 1) === 0 ? 'CONTROL' : 'SIFTRCODE';
}

export function assertExperimentFrozen(experiment: ContextPolicyExperiment): void {
  if (experiment.status !== 'FROZEN' && experiment.status !== 'RUNNING' && experiment.status !== 'COMPLETE') {
    throw new Error('FAIL_CLOSED_EXPERIMENT_NOT_FROZEN: Experiment protocol must be frozen before execution.');
  }
  if (!experiment.protocolSha256) {
    throw new Error('FAIL_CLOSED_EXPERIMENT_PROTOCOL_UNHASHED: Frozen experiment is missing protocolSha256.');
  }
}
