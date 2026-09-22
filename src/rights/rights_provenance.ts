/**
 * SiftrCode V2 - Rights Decision Provenance (Phase 20.3)
 *
 * Captures explicit, truthful provenance for all data rights decisions.
 * Invariants:
 * 1. Never fabricate favorable permission sources (e.g. enterprise_agreement) if unknown.
 * 2. Never infer service processing permission from telemetry retention.
 * 3. Training export requires known permission source (UNKNOWN fails closed).
 */

export type PermissionSourceType =
  | 'USER_CONSENT'
  | 'ENTERPRISE_AGREEMENT'
  | 'LICENSE'
  | 'OPEN_SOURCE_LICENSE'
  | 'ADMIN_POLICY'
  | 'UNKNOWN';

export interface RightsDecisionProvenance {
  serviceProcessingAllowed: boolean | null;
  trainingAllowed: boolean;
  redistributionAllowed: boolean | null;
  permissionSource: PermissionSourceType;
  decisionTimestamp: string | null;
  policyVersion?: string;
}
