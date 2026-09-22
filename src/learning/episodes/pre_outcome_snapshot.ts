/**
 * SiftrCode V2 - Pre-Outcome Snapshot Boundary & Post-Outcome Labels (Phase 20H & 20I)
 *
 * Establishes an immutable point-in-time boundary captured BEFORE agent execution.
 * Invariant: Never allow solution commits, future diffs, agent edits, or post-task outcomes
 * into pre-outcome snapshots.
 */

import * as crypto from 'crypto';
import { CandidateObservation, SelectedContextObservation } from './candidate_observation';
import { TaskOutcomeV1 } from '../outcome/task_outcome';

import { ContextPolicyIdentity } from '../../engine/context_plan';

export const FORBIDDEN_PRE_OUTCOME_FIELDS = [
  'solutionCommit',
  'solutionDiff',
  'futurePatch',
  'futureChangedFiles',
  'futureTests',
  'postTaskReads',
  'postTaskEdits',
  'agentEdits',
  'agentTrajectory',
  'verifiedSuccess',
  'verifiedOutcome',
  'humanReview',
] as const;

export interface PreOutcomeEpisodeSnapshot {
  schemaVersion: 'PRE_OUTCOME_SNAPSHOT_V1';
  episodeId: string;
  taskId: string;
  prompt: string;
  promptSha256: string;
  repositoryId: string;
  baseCommit: string;
  featureCutoffCommit: string;
  workspaceSnapshotId: string;
  candidateUniverse: CandidateObservation[];
  selectedUnits: SelectedContextObservation[];
  tokenBudget: number;
  actualRenderedTokens: number;
  bundleSha256: string;
  contextPolicyId: string;
  rankerId: string;
  contextPolicyIdentity?: ContextPolicyIdentity;
  capturedAt: string;
  snapshotSha256: string;
}

/**
 * Recursively freezes an object and all nested properties for deep immutability.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const prop = (obj as any)[key];
    if (prop !== null && typeof prop === 'object') {
      deepFreeze(prop);
    }
  }
  return obj;
}

/**
 * Validates that an object contains no post-outcome or solution-leakage fields.
 * Throws an explicit Error if any leakage is detected.
 */
export function validatePreOutcomeSnapshotIntegrity(obj: Record<string, unknown>): void {
  for (const field of FORBIDDEN_PRE_OUTCOME_FIELDS) {
    if (field in obj && obj[field] !== undefined) {
      throw new Error(
        `LEAKAGE_DETECTED: Forbidden post-outcome field "${field}" cannot be present in PreOutcomeEpisodeSnapshot!`
      );
    }
  }

  // Check candidates for leakage fields inside feature snapshots
  if (Array.isArray(obj.candidateUniverse)) {
    for (const candidate of obj.candidateUniverse) {
      if (candidate && typeof candidate === 'object') {
        for (const field of FORBIDDEN_PRE_OUTCOME_FIELDS) {
          if (field in candidate && (candidate as Record<string, unknown>)[field] !== undefined) {
            throw new Error(
              `LEAKAGE_DETECTED: Forbidden post-outcome field "${field}" found in candidateObservation!`
            );
          }
        }
        if (candidate.featureSnapshot && typeof candidate.featureSnapshot === 'object') {
          for (const field of FORBIDDEN_PRE_OUTCOME_FIELDS) {
            if (field in candidate.featureSnapshot && candidate.featureSnapshot[field] !== undefined) {
              throw new Error(
                `LEAKAGE_DETECTED: Forbidden post-outcome field "${field}" found in candidate featureSnapshot!`
              );
            }
          }
        }
      }
    }
  }
}

/**
 * Recursively serializes any JavaScript object into canonical JSON with sorted keys.
 */
export function canonicalJsonSerialize(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map((item) => canonicalJsonSerialize(item)).join(',') + ']';
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of sortedKeys) {
    if (obj[k] !== undefined) {
      entries.push(JSON.stringify(k) + ':' + canonicalJsonSerialize(obj[k]));
    }
  }
  return '{' + entries.join(',') + '}';
}

/**
 * Computes a deterministic SHA-256 hash over the FULL snapshot payload (including all candidates).
 */
export function computeSnapshotSha256(snapshot: Omit<PreOutcomeEpisodeSnapshot, 'snapshotSha256'>): string {
  const fullPayload = {
    schemaVersion: snapshot.schemaVersion,
    episodeId: snapshot.episodeId,
    taskId: snapshot.taskId,
    promptSha256: snapshot.promptSha256,
    repositoryId: snapshot.repositoryId,
    baseCommit: snapshot.baseCommit,
    featureCutoffCommit: snapshot.featureCutoffCommit,
    workspaceSnapshotId: snapshot.workspaceSnapshotId,
    candidateUniverse: snapshot.candidateUniverse,
    selectedUnits: snapshot.selectedUnits,
    tokenBudget: snapshot.tokenBudget,
    actualRenderedTokens: snapshot.actualRenderedTokens,
    bundleSha256: snapshot.bundleSha256,
    contextPolicyId: snapshot.contextPolicyId,
    rankerId: snapshot.rankerId,
    capturedAt: snapshot.capturedAt,
  };
  const serialized = canonicalJsonSerialize(fullPayload);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * Factory for creating an immutable, validated PreOutcomeEpisodeSnapshot.
 */
export function createPreOutcomeEpisodeSnapshot(
  params: Omit<PreOutcomeEpisodeSnapshot, 'schemaVersion' | 'snapshotSha256'>
): PreOutcomeEpisodeSnapshot {
  validatePreOutcomeSnapshotIntegrity(params as unknown as Record<string, unknown>);

  const intermediate = {
    schemaVersion: 'PRE_OUTCOME_SNAPSHOT_V1' as const,
    ...params,
  };

  const snapshotSha256 = computeSnapshotSha256(intermediate);
  const snapshot: PreOutcomeEpisodeSnapshot = {
    ...intermediate,
    snapshotSha256,
  };

  deepFreeze(snapshot);
  return snapshot;
}

// =============================================================================
// Phase 20I - Post-Outcome Label Layer
// =============================================================================

export interface UnitOutcomeLabel {
  wasShown: boolean;
  wasRead: boolean;
  wasEdited: boolean;
  wasInSuccessfulTask: boolean;
  wasInFailedTask: boolean;
  wasSelected: boolean;
  verifiedTargetEdit?: boolean;
  /** @deprecated Backward-compatible alias for verifiedTargetEdit */
  verifiedTargetEvidence?: boolean;
  humanRelevanceLabel?: 'RELEVANT' | 'IRRELEVANT' | 'UNKNOWN';
}

export interface OutcomeLabels {
  episodeId: string;
  verifiedSuccess: boolean | null;
  verificationConfidence: string;
  taskOutcome: TaskOutcomeV1;
  unitLabels: Record<string, UnitOutcomeLabel>;
  labeledAt: string;
}

export interface TrainingEpisode {
  episodeId: string;
  preOutcomeSnapshot: PreOutcomeEpisodeSnapshot;
  labels: OutcomeLabels;
  rightsReference: string;
  trainingAllowed: boolean;
}

/**
 * Combines an immutable PreOutcomeEpisodeSnapshot with separate OutcomeLabels.
 * Crucial invariant: Never mutates the original snapshot.
 */
export function assembleTrainingEpisode(
  snapshot: PreOutcomeEpisodeSnapshot,
  labels: OutcomeLabels,
  trainingAllowed: boolean,
  rightsReference: string
): TrainingEpisode {
  if (snapshot.episodeId !== labels.episodeId) {
    throw new Error(
      `EPISODE_MISMATCH: Snapshot episodeId (${snapshot.episodeId}) !== Labels episodeId (${labels.episodeId})`
    );
  }

  const episode: TrainingEpisode = {
    episodeId: snapshot.episodeId,
    preOutcomeSnapshot: snapshot,
    labels,
    rightsReference,
    trainingAllowed,
  };

  Object.freeze(episode);
  return episode;
}
