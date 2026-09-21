/**
 * SiftrCode V2 - Source Provenance & Rights Registry (Section 51)
 *
 * Requirements (Section 51):
 * Every external/open-source task needs:
 * - origin
 * - repository
 * - license
 * - training permission
 * - redistribution permission
 * - cutoff date
 *
 * Invariant: Unknown rights default to REVIEW and are strictly excluded from training by default.
 */

export type PermissionState = 'ALLOWED' | 'FORBIDDEN' | 'REVIEW';

export type TaskOrigin =
  | 'SWE-bench'
  | 'SWE-smith'
  | 'InternalBenchmark'
  | 'Synthetic'
  | 'CustomerSession'
  | 'OpenSource'
  | 'External'
  | string;

export interface SourceProvenance {
  provenanceId: string;
  origin: TaskOrigin;
  repository: string;
  license: string;
  trainingPermission: PermissionState;
  redistributionPermission: PermissionState;
  cutoffDate: string;
  verified: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Creates a SourceProvenance record with privacy-and-compliance-by-default.
 * Unknown rights default to REVIEW.
 */
export function createSourceProvenance(params: {
  provenanceId?: string;
  origin: TaskOrigin;
  repository: string;
  license?: string;
  trainingPermission?: PermissionState;
  redistributionPermission?: PermissionState;
  cutoffDate?: string;
  verified?: boolean;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}): SourceProvenance {
  const license = params.license || 'Unknown';
  const now = new Date().toISOString();

  // Section 51 Invariant: Unknown rights default to REVIEW
  const trainingPermission: PermissionState = params.trainingPermission ?? 'REVIEW';
  const redistributionPermission: PermissionState = params.redistributionPermission ?? 'REVIEW';

  const cleanRepo = params.repository.replace(/[^a-zA-Z0-9_-]/g, '_');
  const provenanceId =
    params.provenanceId ||
    `prov_${params.origin.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${cleanRepo}_${Date.now().toString(36)}`;

  return {
    provenanceId,
    origin: params.origin,
    repository: params.repository,
    license,
    trainingPermission,
    redistributionPermission,
    cutoffDate: params.cutoffDate || '9999-12-31T23:59:59.999Z',
    verified: params.verified ?? false,
    notes: params.notes,
    createdAt: params.createdAt || now,
    updatedAt: params.updatedAt || now,
  };
}

export interface ProvenanceEligibilityResult {
  eligible: boolean;
  reason?: string;
}

/**
 * Evaluates whether a source provenance allows data to be included in training exports.
 * Strictly enforces Section 51 invariants.
 */
export function isProvenanceEligibleForTraining(
  provenance?: SourceProvenance,
  options: { maxCutoffDate?: string; requireVerified?: boolean } = {}
): ProvenanceEligibilityResult {
  if (!provenance) {
    return {
      eligible: false,
      reason: 'MISSING_PROVENANCE: No source provenance provided. Defaults to REVIEW and excluded from training.',
    };
  }

  // Section 51: Unknown rights default to REVIEW and excluded from training
  if (provenance.trainingPermission === 'REVIEW') {
    return {
      eligible: false,
      reason: `TRAINING_PERMISSION_REVIEW: Source rights for repository '${provenance.repository}' are pending review.`,
    };
  }

  if (provenance.trainingPermission === 'FORBIDDEN') {
    return {
      eligible: false,
      reason: `TRAINING_PERMISSION_FORBIDDEN: Repository '${provenance.repository}' license or rights strictly forbid training.`,
    };
  }

  if (provenance.trainingPermission !== 'ALLOWED') {
    return {
      eligible: false,
      reason: `TRAINING_PERMISSION_INVALID: Unknown permission state '${provenance.trainingPermission}'.`,
    };
  }

  // Check verification requirement
  const requireVerified = options.requireVerified ?? true;
  if (requireVerified && !provenance.verified) {
    return {
      eligible: false,
      reason: `UNVERIFIED_PROVENANCE: Provenance for '${provenance.repository}' has not been verified by compliance.`,
    };
  }

  // Temporal cutoff check: cannot train on tasks or commits past cutoff date
  if (options.maxCutoffDate) {
    const provCutoffMs = new Date(provenance.cutoffDate).getTime();
    const maxCutoffMs = new Date(options.maxCutoffDate).getTime();
    if (!isNaN(provCutoffMs) && !isNaN(maxCutoffMs) && provCutoffMs > maxCutoffMs) {
      return {
        eligible: false,
        reason: `CUTOFF_EXCEEDED: Provenance cutoff (${provenance.cutoffDate}) is after requested temporal cutoff (${options.maxCutoffDate}).`,
      };
    }
  }

  return { eligible: true };
}

/**
 * Evaluates whether a source provenance allows data redistribution (e.g. in public benchmarks).
 */
export function isProvenanceEligibleForRedistribution(
  provenance?: SourceProvenance
): ProvenanceEligibilityResult {
  if (!provenance) {
    return {
      eligible: false,
      reason: 'MISSING_PROVENANCE: No source provenance provided. Redistribution forbidden.',
    };
  }

  if (provenance.redistributionPermission !== 'ALLOWED') {
    return {
      eligible: false,
      reason: `REDISTRIBUTION_FORBIDDEN: Redistribution permission is '${provenance.redistributionPermission}'.`,
    };
  }

  if (!provenance.verified) {
    return {
      eligible: false,
      reason: `UNVERIFIED_PROVENANCE: Provenance for '${provenance.repository}' is unverified.`,
    };
  }

  return { eligible: true };
}
