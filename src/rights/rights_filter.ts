/**
 * SiftrCode V2 - Rights Filter & Training Export Boundary (Section 50)
 *
 * Strict Architecture:
 * Raw Observation Store
 *         ↓
 *   Rights Filter
 *         ↓
 *  Training Export
 *
 * Requirements:
 * 1. No dataset builder may operate directly on raw tables.
 * 2. If trainingAllowed = false, the observation cannot enter the training export.
 * 3. Provenance with REVIEW or FORBIDDEN status is rejected.
 * 4. Expired observations beyond retention days are rejected.
 * 5. Unexposed or ambiguous labels (UNEXPOSED_UNKNOWN, UNKNOWN) cannot enter training rows.
 */

import { DataRights, isDataClassPermitted, isOperationPermitted, DataClass } from './data_rights';
import { CandidateObservationV2 } from '../telemetry/candidate_observation';
import { SourceProvenance, isProvenanceEligibleForTraining } from './source_provenance';
import { ContextFeaturesV1 } from '../ranking/feature_schema';

export interface RightsFilterConfig {
  requireVerifiedProvenance?: boolean;
  temporalCutoff?: string;
  enforceRetentionExpiry?: boolean;
  allowWeakNegatives?: boolean;
}

export interface RightsFilterResult {
  passed: boolean;
  observationId: string;
  status: 'ACCEPTED' | 'REJECTED';
  reasons: string[];
  sanitizedFeatures?: ContextFeaturesV1;
  appliedDataRights?: DataRights;
  provenance?: SourceProvenance;
}

export class RightsFilter {
  private config: Required<RightsFilterConfig>;

  constructor(config: RightsFilterConfig = {}) {
    this.config = {
      requireVerifiedProvenance: config.requireVerifiedProvenance ?? false,
      temporalCutoff: config.temporalCutoff || '9999-12-31T23:59:59.999Z',
      enforceRetentionExpiry: config.enforceRetentionExpiry ?? true,
      allowWeakNegatives: config.allowWeakNegatives ?? true,
    };
  }

  /**
   * Evaluates an individual observation for training export eligibility.
   */
  public evaluate(params: {
    observation: CandidateObservationV2;
    dataRights: DataRights;
    provenance?: SourceProvenance;
  }): RightsFilterResult {
    const { observation, dataRights, provenance } = params;
    const reasons: string[] = [];

    // 1. Section 50 Hard Invariant: trainingAllowed must be true
    if (!dataRights.trainingAllowed) {
      reasons.push(
        `TRAINING_NOT_ALLOWED: Customer DataRights forbids training (trainingAllowed = false).`
      );
    } else if (
      dataRights.operationRights &&
      !isOperationPermitted(dataRights.operationRights, DataClass.NUMERIC_FEATURE, 'training')
    ) {
      reasons.push(
        `TRAINING_OPERATION_FORBIDDEN: operationRights forbids training on NUMERIC_FEATURE.`
      );
    }

    // 2. Data Class Permission Check: Numeric features must be permitted
    if (!isDataClassPermitted(dataRights, DataClass.NUMERIC_FEATURE)) {
      reasons.push(
        `DATA_CLASS_FORBIDDEN: Customer DataRights forbids NUMERIC_FEATURE retention.`
      );
    }

    // 3. Source Provenance Verification (Section 51)
    if (provenance) {
      const provCheck = isProvenanceEligibleForTraining(provenance, {
        maxCutoffDate: this.config.temporalCutoff,
        requireVerified: this.config.requireVerifiedProvenance,
      });
      if (!provCheck.eligible) {
        reasons.push(provCheck.reason || 'PROVENANCE_INELIGIBLE');
      }
    }

    // 4. Retention Expiry Check
    if (this.config.enforceRetentionExpiry && dataRights.retentionDays !== undefined) {
      const recordedMs = new Date(observation.recordedAt).getTime();
      const nowMs = Date.now();
      const ageDays = (nowMs - recordedMs) / (1000 * 60 * 60 * 24);
      if (ageDays > dataRights.retentionDays) {
        reasons.push(
          `RETENTION_EXPIRED: Observation age (${ageDays.toFixed(1)} days) exceeds retention policy limit of ${dataRights.retentionDays} days.`
        );
      }
    }

    // 5. Outcome Label Validity Check: Unexposed or unresolved candidates cannot enter training
    if (observation.outcomeLabel === 'UNEXPOSED_UNKNOWN') {
      reasons.push(
        `INVALID_LABEL_UNEXPOSED: Unexposed candidates cannot be exported to training (Section 21 Invariant).`
      );
    } else if (observation.outcomeLabel === 'UNKNOWN') {
      reasons.push(
        `INVALID_LABEL_UNKNOWN: Observations with ambiguous outcome cannot be exported without resolved outcome evidence.`
      );
    } else if (observation.outcomeLabel === 'WEAK_NEGATIVE' && !this.config.allowWeakNegatives) {
      reasons.push(
        `CONFIG_EXCLUDED_WEAK_NEGATIVE: Weak negatives disabled by filter configuration.`
      );
    }

    // 6. Feature Integrity Check
    if (!observation.features) {
      reasons.push('MISSING_FEATURES: CandidateObservation lacks ContextFeaturesV1 payload.');
    }

    if (reasons.length > 0) {
      return {
        passed: false,
        observationId: observation.observationId,
        status: 'REJECTED',
        reasons,
        appliedDataRights: dataRights,
        provenance,
      };
    }

    // Sanitized features clone (ensuring clean numeric attributes)
    const sanitizedFeatures: ContextFeaturesV1 = {
      ...observation.features,
    };

    return {
      passed: true,
      observationId: observation.observationId,
      status: 'ACCEPTED',
      reasons: [],
      sanitizedFeatures,
      appliedDataRights: dataRights,
      provenance,
    };
  }

  /**
   * Filters an array of observations, partition into accepted and rejected results.
   */
  public filterBatch(
    items: Array<{
      observation: CandidateObservationV2;
      dataRights: DataRights;
      provenance?: SourceProvenance;
    }>
  ): {
    accepted: Array<{ observation: CandidateObservationV2; sanitizedFeatures: ContextFeaturesV1; provenance?: SourceProvenance }>;
    rejected: Array<{ observation: CandidateObservationV2; reasons: string[] }>;
  } {
    const accepted: Array<{
      observation: CandidateObservationV2;
      sanitizedFeatures: ContextFeaturesV1;
      provenance?: SourceProvenance;
    }> = [];

    const rejected: Array<{ observation: CandidateObservationV2; reasons: string[] }> = [];

    for (const item of items) {
      const result = this.evaluate(item);
      if (result.passed && result.sanitizedFeatures) {
        accepted.push({
          observation: item.observation,
          sanitizedFeatures: result.sanitizedFeatures,
          provenance: item.provenance,
        });
      } else {
        rejected.push({
          observation: item.observation,
          reasons: result.reasons,
        });
      }
    }

    return { accepted, rejected };
  }
}
