/**
 * SiftrCode V2 - Verified Outcome Model & Confidence Policy (Phase 20E & 20F)
 *
 * Enforces deterministic, tri-state outcome resolution:
 * Invariants:
 * 1. Agent reports "done" != verified success.
 * 2. Build passes != task necessarily succeeded.
 * 3. No verifier result != failure (remains null / UNKNOWN).
 * 4. LLMs are NEVER permitted to self-certify verifiedSuccess.
 */

export type VerifiedSuccess = true | false | null;

export type VerificationConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface TaskOutcomeV1 {
  episodeId: string;
  buildPassed?: boolean | null;
  typecheckPassed?: boolean | null;
  targetedTestsPassed?: boolean | null;
  regressionTestsPassed?: boolean | null;
  hiddenTestsPassed?: boolean | null;
  taskVerifierPassed?: boolean | null;
  humanReview?: 'PASS' | 'FAIL' | 'UNKNOWN';
  verifiedSuccess: VerifiedSuccess;
  verificationConfidence: VerificationConfidence;
  verificationSources: string[];
  completedAt?: string;
  evaluationRationale?: string;
}

export interface ResolveOutcomeInput {
  episodeId: string;
  buildPassed?: boolean | null;
  typecheckPassed?: boolean | null;
  targetedTestsPassed?: boolean | null;
  regressionTestsPassed?: boolean | null;
  hiddenTestsPassed?: boolean | null;
  taskVerifierPassed?: boolean | null;
  humanReview?: 'PASS' | 'FAIL' | 'UNKNOWN';
  agentReportedCompletion?: boolean;
  completedAt?: string;
}

/**
 * Deterministically resolves verifiedSuccess and confidence according to strict policy.
 */
export function resolveTaskOutcome(input: ResolveOutcomeInput): TaskOutcomeV1 {
  const sources: string[] = [];
  let verifiedSuccess: VerifiedSuccess = null;
  let confidence: VerificationConfidence = 'UNKNOWN';
  let rationale = '';

  // 1. Human review has top authority
  if (input.humanReview === 'PASS') {
    sources.push('HUMAN_REVIEW');
    verifiedSuccess = true;
    confidence = 'HIGH';
    rationale = 'Human reviewer explicitly certified task success.';
  } else if (input.humanReview === 'FAIL') {
    sources.push('HUMAN_REVIEW');
    verifiedSuccess = false;
    confidence = 'HIGH';
    rationale = 'Human reviewer explicitly certified task failure.';
  }
  // 2. Task-specific verifier checks
  else if (input.taskVerifierPassed === true) {
    sources.push('TASK_VERIFIER');
    if (input.regressionTestsPassed === false) {
      sources.push('REGRESSION_TESTS');
      verifiedSuccess = false;
      confidence = 'HIGH';
      rationale = 'Task verifier passed but required regression tests failed.';
    } else {
      if (input.regressionTestsPassed === true) {
        sources.push('REGRESSION_TESTS');
      }
      verifiedSuccess = true;
      confidence = 'HIGH';
      rationale = 'Independent task verifier passed cleanly.';
    }
  } else if (input.taskVerifierPassed === false) {
    sources.push('TASK_VERIFIER');
    verifiedSuccess = false;
    confidence = 'HIGH';
    rationale = 'Independent task verifier failed.';
  }
  // 3. Build or compilation breakages
  else if (input.buildPassed === false || input.typecheckPassed === false) {
    if (input.buildPassed === false) sources.push('BUILD');
    if (input.typecheckPassed === false) sources.push('TYPECHECK');
    verifiedSuccess = false;
    confidence = 'HIGH';
    rationale = 'Required build or typecheck checks failed.';
  }
  // 4. Targeted / Unit test passes
  else if (input.targetedTestsPassed === true) {
    sources.push('TARGETED_TESTS');
    if (input.regressionTestsPassed === false) {
      sources.push('REGRESSION_TESTS');
      verifiedSuccess = false;
      confidence = 'HIGH';
      rationale = 'Targeted tests passed but regression tests failed.';
    } else {
      verifiedSuccess = true;
      confidence = 'MEDIUM';
      rationale = 'Targeted test suite passed (medium confidence; no full verifier).';
    }
  } else if (input.targetedTestsPassed === false) {
    sources.push('TARGETED_TESTS');
    verifiedSuccess = false;
    confidence = 'MEDIUM';
    rationale = 'Targeted test suite failed.';
  }
  // 5. Agent claimed completion alone -> UNKNOWN!
  else if (input.agentReportedCompletion) {
    sources.push('AGENT_REPORTED_ONLY');
    verifiedSuccess = null;
    confidence = 'UNKNOWN';
    rationale = 'Agent reported completion, but no verifier or targeted tests ran. Success remains unknown.';
  } else {
    verifiedSuccess = null;
    confidence = 'UNKNOWN';
    rationale = 'No verification evidence available. Preserving UNKNOWN tri-state.';
  }

  return {
    episodeId: input.episodeId,
    buildPassed: input.buildPassed,
    typecheckPassed: input.typecheckPassed,
    targetedTestsPassed: input.targetedTestsPassed,
    regressionTestsPassed: input.regressionTestsPassed,
    hiddenTestsPassed: input.hiddenTestsPassed,
    taskVerifierPassed: input.taskVerifierPassed,
    humanReview: input.humanReview,
    verifiedSuccess,
    verificationConfidence: confidence,
    verificationSources: sources,
    completedAt: input.completedAt || new Date().toISOString(),
    evaluationRationale: rationale,
  };
}

import { OutcomeEvidence } from '../../telemetry/outcome_evidence';

/**
 * Maps authoritative production OutcomeEvidence directly into TaskOutcomeV1.
 * Preserves high-confidence verifier policy and attribution sources.
 */
export function resolveTaskOutcomeFromEvidence(
  evidence: OutcomeEvidence,
  episodeId?: string
): TaskOutcomeV1 {
  const sources: string[] = [];
  if (evidence.humanReview && evidence.humanReview !== 'UNKNOWN') sources.push('HUMAN_REVIEW');
  if (evidence.behavioralOraclePassed !== undefined) sources.push('BEHAVIORAL_ORACLE');
  if (evidence.hiddenTestsPassed !== undefined) sources.push('HIDDEN_TESTS');
  if (evidence.publicTestsPassed !== undefined) sources.push('PUBLIC_TESTS');
  if (evidence.regressionTestsPassed !== undefined) sources.push('REGRESSION_TESTS');
  if (evidence.buildPassed !== undefined) sources.push('BUILD');
  if (evidence.staticChecksPassed !== undefined) sources.push('STATIC_CHECKS');
  if (evidence.securityChecksPassed !== undefined) sources.push('SECURITY_CHECKS');
  if (evidence.agentReportedSuccess && sources.length === 0) sources.push('AGENT_REPORTED_ONLY');

  let conf: VerificationConfidence = 'UNKNOWN';
  if (evidence.confidence >= 0.9) conf = 'HIGH';
  else if (evidence.confidence >= 0.7) conf = 'MEDIUM';
  else if (evidence.confidence > 0.3) conf = 'LOW';

  return {
    episodeId: episodeId || evidence.contextPlanId || evidence.taskId,
    buildPassed: evidence.buildPassed,
    targetedTestsPassed: evidence.publicTestsPassed,
    regressionTestsPassed: evidence.regressionTestsPassed,
    hiddenTestsPassed: evidence.hiddenTestsPassed,
    taskVerifierPassed: evidence.behavioralOraclePassed,
    humanReview: evidence.humanReview,
    verifiedSuccess: evidence.verifiedSuccess,
    verificationConfidence: conf,
    verificationSources: sources,
    completedAt: evidence.recordedAt,
    evaluationRationale: evidence.evaluationRationale,
  };
}
