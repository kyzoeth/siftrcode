/**
 * SiftrCode V2 - Canonical Training Eligibility Predicate
 *
 * Defines the single authoritative evaluation for whether a TaskEpisodeV1
 * is eligible for training export, readiness audits, and outcome reporting.
 */

import { TaskEpisodeV1, loadVerifiedTaskEpisode } from './task_episode';
import { ContextUnitExposureRecord } from './context_exposure';
import { FORBIDDEN_PRE_OUTCOME_FIELDS } from './pre_outcome_snapshot';

export interface TrainingEligibilityResult {
  eligible: boolean;
  reasons: string[];
}

export interface TrainingEligibilityOptions {
  isRevoked?: (episodeId: string) => boolean;
  exposuresProvider?: (episodeId: string) => ContextUnitExposureRecord[];
}

/**
 * Single canonical evaluation for whether a TaskEpisodeV1 is training eligible.
 * Enforces:
 * 1. Customer rights permit training (trainingAllowed === true)
 * 2. Rights provenance is authoritative and not UNKNOWN or unspecified
 * 3. Episode is not revoked
 * 4. Production ranker only (rankerStatus === 'PRODUCTION', rankerId !== 'custom_unidentified')
 * 5. Full-payload record integrity (loadVerifiedTaskEpisode)
 * 6. Zero post-outcome leakage in candidate features
 * 7. All candidates have authoritative exposure records (if exposuresProvider provided)
 */
export function evaluateEpisodeTrainingEligibility(
  episode: TaskEpisodeV1,
  options: TrainingEligibilityOptions = {}
): TrainingEligibilityResult {
  const reasons: string[] = [];

  // 1. Data Rights: trainingAllowed (fail closed)
  if (!episode.rights || episode.rights.trainingAllowed !== true) {
    reasons.push('RIGHTS_BLOCKED: trainingAllowed is false or unspecified.');
  }

  // 2. Rights Provenance: permissionSource (fail closed)
  const permSource =
    (episode.rights as any)?.rightsProvenance?.permissionSource ||
    episode.rights?.permissionSource;
  if (!permSource || permSource === 'UNKNOWN' || permSource === 'unspecified') {
    reasons.push('RIGHTS_BLOCKED: permissionSource is UNKNOWN or unspecified.');
  }

  // 3. Revocation status (mandatory: missing authority fails closed)
  if (!options.isRevoked) {
    reasons.push(
      'MISSING_REVOCATION_AUTHORITY: Mandatory isRevoked authority is required to evaluate training eligibility (fail closed).'
    );
  } else {
    try {
      if (options.isRevoked(episode.episodeId)) {
        reasons.push('REVOKED_EPISODE: Episode has been revoked/tombstoned by compliance deletion.');
      }
    } catch (err: any) {
      reasons.push(`REVOCATION_CHECK_FAILED: Failed to evaluate revocation authority: ${err.message}`);
    }
  }

  // 4. Ranker Status & Identity
  const rankerStatus = episode.environment?.rankerStatus;
  const rankerId = episode.environment?.rankerId;
  if (rankerStatus !== 'PRODUCTION') {
    reasons.push(
      `POLICY_INELIGIBLE: Ranker status is ${rankerStatus || 'UNKNOWN'} (only PRODUCTION ranker episodes are training eligible).`
    );
  }
  if (rankerId === 'custom_unidentified') {
    reasons.push('POLICY_INELIGIBLE: Ranker is custom_unidentified.');
  }

  // 5. Full-payload tamper-evident verification
  try {
    loadVerifiedTaskEpisode(episode);
  } catch (err: any) {
    reasons.push(`INTEGRITY_TAMPERED: Episode integrity verification failed: ${err.message}`);
  }

  // 6. Zero pre-outcome leakage in features
  if (episode.contextDecision?.candidates) {
    for (const cand of episode.contextDecision.candidates) {
      if (cand.featureSnapshot) {
        for (const field of FORBIDDEN_PRE_OUTCOME_FIELDS) {
          if (field in cand.featureSnapshot && (cand.featureSnapshot as Record<string, unknown>)[field] !== undefined) {
            reasons.push(`LEAKAGE_IN_FEATURES: Feature snapshot contains forbidden field "${field}".`);
            break;
          }
        }
      }
      if (reasons.some((r) => r.startsWith('LEAKAGE_IN_FEATURES'))) break;
    }
  }

  // 7. Authoritative exposure records check (mandatory: missing provider fails closed, episode-bound)
  if (!options.exposuresProvider) {
    reasons.push(
      'MISSING_EXPOSURE_RECORD: Mandatory exposuresProvider is required to evaluate training eligibility (fail closed).'
    );
  } else {
    try {
      const exposures = options.exposuresProvider(episode.episodeId) || [];
      const unboundExposures = exposures.filter(
        (e) => !e.episodeId || e.episodeId !== episode.episodeId
      );
      if (unboundExposures.length > 0) {
        reasons.push(
          `UNBOUND_EXPOSURE_RECORD: ${unboundExposures.length} exposure record(s) are not bound to episode "${episode.episodeId}".`
        );
      }
      const exposureMap = new Map(exposures.map((e) => [e.contextUnitId, e]));
      const unrecorded = (episode.contextDecision?.candidates || []).filter(
        (c) => !exposureMap.has(c.contextUnitId)
      );
      if (unrecorded.length > 0) {
        reasons.push(
          `MISSING_EXPOSURE_RECORD: ${unrecorded.length} candidate(s) lack authoritative exposure records in episode "${episode.episodeId}".`
        );
      }
    } catch (err: any) {
      reasons.push(`MISSING_EXPOSURE_RECORD: Failed to query exposures: ${err.message}`);
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

/**
 * Pure boolean predicate for training eligibility.
 */
export function isEpisodeTrainingEligible(
  episode: TaskEpisodeV1,
  options: TrainingEligibilityOptions = {}
): boolean {
  return evaluateEpisodeTrainingEligibility(episode, options).eligible;
}
