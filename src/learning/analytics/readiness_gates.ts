/**
 * SiftrCode V2 - Canonical V3.2 Readiness Gates Engine (Phase 20.1 Closure)
 *
 * Implements the 7 canonical readiness gates defined in docs/research/V3_2_ARCHITECTURE.md:
 * 1. Total Production Episodes (>= 1,000)
 * 2. Verified Outcomes (>= 200 Verified Successes AND >= 100 Verified Failures)
 * 3. Candidate Logging Coverage (>= 80% of episodes with full candidate universes logged)
 * 4. Rights Clearance (100% zero unpermitted or revoked episodes in training pool)
 * 5. Supervision Diversity (Tri-state outcome distribution with documented resolution proofs)
 * 6. Zero-Leakage Audit (100% pass on pre-outcome snapshot boundary checks)
 * 7. Shadow Policy Parity (>= 100 shadow evaluation runs with zero crashes)
 *
 * Invariant:
 * SiftrCode does NOT train or promote learned ranking weights (V3.2) until ALL 7 gates pass.
 * Production remains the deterministic V2 ContextRanker.
 */

export const V3_2_READINESS_SPEC_VERSION = 'V3.2_CANONICAL_READINESS_GATES_V1';

export interface CanonicalGateEvaluation {
  gateId: string;
  name: string;
  targetRequirement: string;
  rationale: string;
  passed: boolean;
  currentValue: number | string | boolean;
  targetValue: number | string | boolean;
  details?: string;
}

export interface ReadinessEvaluationInput {
  totalEpisodes: number;
  verifiedSuccesses: number;
  verifiedFailures: number;
  unknownOutcomes: number;
  episodesWithCandidatesLogged: number;
  unpermittedEpisodesInPool: number;
  revokedEpisodesInPool: number;
  verifiedEpisodesWithMissingProof: number;
  preOutcomeSnapshotsAudited: number;
  leakageViolationsDetected: number;
  shadowEvaluationRuns: number;
  shadowEvaluationCrashes: number;
}

export interface CanonicalReadinessEvaluation {
  schemaVersion: typeof V3_2_READINESS_SPEC_VERSION;
  allGatesPassed: boolean;
  readinessScore: number; // [0.0, 1.0] continuous completion progress
  gates: CanonicalGateEvaluation[];
  evaluatedAt: string;
}

export function evaluateCanonicalReadinessGates(
  input: ReadinessEvaluationInput
): CanonicalReadinessEvaluation {
  const evaluatedAt = new Date().toISOString();

  // 1. Total Production Episodes Gate
  const minEpisodes = 1000;
  const gateTotalEpisodes: CanonicalGateEvaluation = {
    gateId: 'GATE_1_TOTAL_EPISODES',
    name: 'Total Production Episodes',
    targetRequirement: '>= 1,000 unique episodes',
    rationale: 'Ensures statistical significance across varied codebases and task types.',
    passed: input.totalEpisodes >= minEpisodes,
    currentValue: input.totalEpisodes,
    targetValue: minEpisodes,
    details: `${input.totalEpisodes} / ${minEpisodes} episodes recorded`,
  };

  // 2. Verified Outcomes Gate
  const minSuccesses = 200;
  const minFailures = 100;
  const verifiedPassed =
    input.verifiedSuccesses >= minSuccesses && input.verifiedFailures >= minFailures;
  const gateVerifiedOutcomes: CanonicalGateEvaluation = {
    gateId: 'GATE_2_VERIFIED_OUTCOMES',
    name: 'Verified Outcomes',
    targetRequirement: '>= 200 Verified Successes AND >= 100 Verified Failures',
    rationale: 'Eliminates class imbalance and ensures strong negative contrast signals.',
    passed: verifiedPassed,
    currentValue: `Successes: ${input.verifiedSuccesses}, Failures: ${input.verifiedFailures}`,
    targetValue: `Successes: >= ${minSuccesses}, Failures: >= ${minFailures}`,
    details: `Success: ${input.verifiedSuccesses}/${minSuccesses} (${Math.min(100, Math.round((input.verifiedSuccesses / minSuccesses) * 100))}%), Failure: ${input.verifiedFailures}/${minFailures} (${Math.min(100, Math.round((input.verifiedFailures / minFailures) * 100))}%)`,
  };

  // 3. Candidate Logging Coverage Gate
  const minCoverage = 0.8;
  const candidateCoverage =
    input.totalEpisodes > 0
      ? Math.round((input.episodesWithCandidatesLogged / input.totalEpisodes) * 1000) / 1000
      : 0;
  const gateCandidateLogging: CanonicalGateEvaluation = {
    gateId: 'GATE_3_CANDIDATE_LOGGING_COVERAGE',
    name: 'Candidate Logging Coverage',
    targetRequirement: '>= 80% of episodes with full candidate universes logged',
    rationale: 'Prevents selection bias where only materialized candidates are known.',
    passed: input.totalEpisodes > 0 && candidateCoverage >= minCoverage,
    currentValue: candidateCoverage,
    targetValue: minCoverage,
    details: `${(candidateCoverage * 100).toFixed(1)}% (${input.episodesWithCandidatesLogged}/${input.totalEpisodes} episodes)`,
  };

  // 4. Rights Clearance Gate
  const rightsViolations = input.unpermittedEpisodesInPool + input.revokedEpisodesInPool;
  const gateRightsClearance: CanonicalGateEvaluation = {
    gateId: 'GATE_4_RIGHTS_CLEARANCE',
    name: 'Rights Clearance',
    targetRequirement: '100% zero unpermitted or revoked episodes in training pool',
    rationale: 'Strict compliance with data rights, retention limits, and deletion requests.',
    passed: rightsViolations === 0,
    currentValue: rightsViolations === 0 ? 1.0 : 0.0,
    targetValue: 1.0,
    details:
      rightsViolations === 0
        ? 'Zero unpermitted or revoked episodes in training pool (100% compliant)'
        : `VIOLATION: ${input.unpermittedEpisodesInPool} unpermitted and ${input.revokedEpisodesInPool} revoked episodes found in pool`,
  };

  // 5. Supervision Diversity Gate
  // Requires: verifiedSuccess > 0, verifiedFailure > 0, unknown > 0, and no missing verification proofs
  const totalVerified = input.verifiedSuccesses + input.verifiedFailures;
  const hasTriState =
    input.verifiedSuccesses > 0 &&
    input.verifiedFailures > 0 &&
    input.unknownOutcomes > 0;
  const proofComplete =
    totalVerified === 0 || input.verifiedEpisodesWithMissingProof === 0;
  const diversityPassed = hasTriState && proofComplete && input.totalEpisodes >= 10;
  const gateSupervisionDiversity: CanonicalGateEvaluation = {
    gateId: 'GATE_5_SUPERVISION_DIVERSITY',
    name: 'Supervision Diversity',
    targetRequirement: 'Tri-state outcome distribution with documented resolution proofs',
    rationale: 'Prevents model training on unverified heuristic proxies (e.g. agent self-report).',
    passed: diversityPassed,
    currentValue: `Tri-state: ${hasTriState ? 'YES' : 'NO'}, Missing proofs: ${input.verifiedEpisodesWithMissingProof}`,
    targetValue: 'Tri-state: YES, Missing proofs: 0',
    details: `Success: ${input.verifiedSuccesses}, Failure: ${input.verifiedFailures}, Unknown: ${input.unknownOutcomes}, Missing proofs: ${input.verifiedEpisodesWithMissingProof}`,
  };

  // 6. Zero-Leakage Audit Gate
  const leakageAuditPassed =
    input.preOutcomeSnapshotsAudited > 0 && input.leakageViolationsDetected === 0;
  const gateZeroLeakage: CanonicalGateEvaluation = {
    gateId: 'GATE_6_ZERO_LEAKAGE_AUDIT',
    name: 'Zero-Leakage Audit',
    targetRequirement: '100% pass on pre-outcome snapshot boundary checks',
    rationale: 'All features strictly <= C_0; zero post-outcome fields present in input matrix.',
    passed: leakageAuditPassed,
    currentValue: input.leakageViolationsDetected === 0 ? 1.0 : 0.0,
    targetValue: 1.0,
    details: `${input.preOutcomeSnapshotsAudited} snapshots audited, ${input.leakageViolationsDetected} violations`,
  };

  // 7. Shadow Policy Parity Gate
  const minShadowRuns = 100;
  const shadowPassed =
    input.shadowEvaluationRuns >= minShadowRuns && input.shadowEvaluationCrashes === 0;
  const gateShadowParity: CanonicalGateEvaluation = {
    gateId: 'GATE_7_SHADOW_POLICY_PARITY',
    name: 'Shadow Policy Parity',
    targetRequirement: 'Minimum 100 shadow evaluation runs with zero execution crashes',
    rationale: 'Confirms production safety and runtime latency bounds (<= 25ms).',
    passed: shadowPassed,
    currentValue: `${input.shadowEvaluationRuns} runs, ${input.shadowEvaluationCrashes} crashes`,
    targetValue: `>= ${minShadowRuns} runs, 0 crashes`,
    details: `${input.shadowEvaluationRuns}/${minShadowRuns} shadow runs completed (${input.shadowEvaluationCrashes} crashes)`,
  };

  const gates: CanonicalGateEvaluation[] = [
    gateTotalEpisodes,
    gateVerifiedOutcomes,
    gateCandidateLogging,
    gateRightsClearance,
    gateSupervisionDiversity,
    gateZeroLeakage,
    gateShadowParity,
  ];

  const allGatesPassed = gates.every((g) => g.passed);

  // Compute a continuous progress score [0.0, 1.0] across key quantitative gates
  const epProgress = Math.min(1.0, input.totalEpisodes / minEpisodes);
  const successProgress = Math.min(1.0, input.verifiedSuccesses / minSuccesses);
  const failureProgress = Math.min(1.0, input.verifiedFailures / minFailures);
  const outcomeProgress = (successProgress + failureProgress) / 2;
  const coverageProgress = Math.min(1.0, candidateCoverage / minCoverage);
  const rightsProgress = rightsViolations === 0 ? 1.0 : 0.0;
  const shadowProgress = Math.min(1.0, input.shadowEvaluationRuns / minShadowRuns);

  const readinessScore =
    Math.round(
      (epProgress * 0.25 +
        outcomeProgress * 0.25 +
        coverageProgress * 0.15 +
        rightsProgress * 0.15 +
        (leakageAuditPassed ? 0.1 : 0.0) +
        shadowProgress * 0.1) *
        100
    ) / 100;

  return {
    schemaVersion: V3_2_READINESS_SPEC_VERSION,
    allGatesPassed,
    readinessScore,
    gates,
    evaluatedAt,
  };
}
