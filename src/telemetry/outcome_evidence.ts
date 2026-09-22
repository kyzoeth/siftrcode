import * as crypto from 'crypto';

/**
 * Section 48: Durable OutcomeEvidence object capturing comprehensive task verification signals.
 */
export interface OutcomeEvidence {
  outcomeId: string;
  taskId: string;
  sessionId: string;
  contextPlanId?: string;
  agentEnvironmentId: string;
  workspaceSnapshotBefore: string;
  workspaceSnapshotAfter?: string;
  buildPassed?: boolean;
  publicTestsPassed?: boolean;
  hiddenTestsPassed?: boolean;
  regressionTestsPassed?: boolean;
  staticChecksPassed?: boolean;
  securityChecksPassed?: boolean;
  behavioralOraclePassed?: boolean;
  userAccepted?: boolean;
  agentReportedSuccess?: boolean;
  humanReview?: 'PASS' | 'FAIL' | 'UNKNOWN';
  actualProviderInputTokens?: number;
  actualProviderOutputTokens?: number;
  costUSD?: number;
  wallTimeMs?: number;
  verifiedSuccess: true | false | null;
  confidence: number;
  recordedAt: string;
  policyId?: string;
  policyVersion?: string;
  evaluationRationale?: string;
}

/**
 * Section 49: Single versioned OutcomePolicy converting verification evidence into
 * verifiedSuccess and confidence. Prevents scattered outcome logic across the codebase.
 */
export interface OutcomePolicy {
  policyId: string;
  policyVersion: string;
  evaluateOutcome(
    evidence: Omit<OutcomeEvidence, 'outcomeId' | 'verifiedSuccess' | 'confidence' | 'recordedAt'>
  ): {
    verifiedSuccess: true | false | null;
    confidence: number;
    rationale: string;
  };
}

export class DefaultOutcomePolicyV1 implements OutcomePolicy {
  public policyId = 'siftr-default-outcome';
  public policyVersion = '1.0.0';

  public evaluateOutcome(
    evidence: Omit<OutcomeEvidence, 'outcomeId' | 'verifiedSuccess' | 'confidence' | 'recordedAt'>
  ): {
    verifiedSuccess: true | false | null;
    confidence: number;
    rationale: string;
  } {
    // 1. Authoritative Human Review
    if (evidence.humanReview === 'PASS') {
      return {
        verifiedSuccess: true,
        confidence: 1.0,
        rationale: 'Human reviewer explicitly certified task success (PASS)',
      };
    }
    if (evidence.humanReview === 'FAIL') {
      return {
        verifiedSuccess: false,
        confidence: 1.0,
        rationale: 'Human reviewer explicitly rejected task solution (FAIL)',
      };
    }

    // 2. Strong Automated Success Oracles
    // Requires authoritative oracle (hidden tests or behavioral oracle) AND regressions / security not failing
    if (
      evidence.hiddenTestsPassed === true &&
      evidence.regressionTestsPassed !== false &&
      evidence.securityChecksPassed !== false
    ) {
      return {
        verifiedSuccess: true,
        confidence: 0.98,
        rationale: 'Strong success: hidden behavioral evaluation tests passed without regression or security failures',
      };
    }

    if (
      evidence.behavioralOraclePassed === true &&
      evidence.regressionTestsPassed !== false &&
      evidence.securityChecksPassed !== false
    ) {
      return {
        verifiedSuccess: true,
        confidence: 0.95,
        rationale: 'High confidence: independent behavioral oracle passed without regression or security failures',
      };
    }

    // 3. Strong Automated Oracle Failures
    if (evidence.hiddenTestsPassed === false) {
      return {
        verifiedSuccess: false,
        confidence: 0.98,
        rationale: 'Automated verification failure: hidden tests failed',
      };
    }
    if (evidence.behavioralOraclePassed === false) {
      return {
        verifiedSuccess: false,
        confidence: 0.98,
        rationale: 'Automated verification failure: behavioral oracle failed',
      };
    }

    // 4. Weak / Unverified Signals (NEVER certify verifiedSuccess = true or false alone)
    // Section 49 & Phase 20.4 Invariant: build failure/pass, public tests, regression failure alone,
    // agent self-report, and unverified user acceptance yield verifiedSuccess = null (UNKNOWN).
    if (evidence.regressionTestsPassed === false) {
      return {
        verifiedSuccess: null,
        confidence: 0.50,
        rationale: 'Unverified: regression tests failed without authoritative oracle verification; verifiedSuccess remains UNKNOWN.',
      };
    }

    if (evidence.buildPassed === false) {
      return {
        verifiedSuccess: null,
        confidence: 0.40,
        rationale: 'Weak evidence: project build failed without authoritative oracle verification; verifiedSuccess remains UNKNOWN.',
      };
    }

    if (evidence.publicTestsPassed === false) {
      return {
        verifiedSuccess: null,
        confidence: 0.50,
        rationale: 'Weak evidence: public test suite failed without authoritative behavioral oracle; verifiedSuccess remains UNKNOWN.',
      };
    }

    if (evidence.publicTestsPassed === true) {
      return {
        verifiedSuccess: null,
        confidence: 0.60,
        rationale: 'Weak evidence: public tests passed, but no authoritative behavioral oracle or hidden verifier; verifiedSuccess remains UNKNOWN.',
      };
    }

    if (evidence.buildPassed === true) {
      return {
        verifiedSuccess: null,
        confidence: 0.40,
        rationale: 'Weak evidence: build passed, but no behavioral verification performed; verifiedSuccess remains UNKNOWN.',
      };
    }

    if (evidence.userAccepted === false) {
      return {
        verifiedSuccess: null,
        confidence: 0.50,
        rationale: 'Unverified: user rejected solution without authoritative review certification; verifiedSuccess remains UNKNOWN.',
      };
    }

    if (evidence.userAccepted === true) {
      return {
        verifiedSuccess: null,
        confidence: 0.50,
        rationale: 'Unverified: user accepted solution without authoritative review certification; verifiedSuccess remains UNKNOWN.',
      };
    }

    if (evidence.agentReportedSuccess === true || evidence.agentReportedSuccess === false) {
      return {
        verifiedSuccess: null,
        confidence: 0.35,
        rationale: 'Unverified: agent reported completion/failure alone; verifiedSuccess remains UNKNOWN.',
      };
    }

    // 5. Insufficient Evidence
    return {
      verifiedSuccess: null,
      confidence: 0.1,
      rationale: 'Insufficient outcome evidence: no tests, builds, or oracles available; verifiedSuccess remains UNKNOWN.',
    };
  }
}

/**
 * Creates a fully resolved OutcomeEvidence object using a versioned OutcomePolicy.
 */
export function createOutcomeEvidence(
  params: Omit<OutcomeEvidence, 'outcomeId' | 'verifiedSuccess' | 'confidence' | 'recordedAt'> & {
    outcomeId?: string;
    recordedAt?: string;
  },
  policy: OutcomePolicy = new DefaultOutcomePolicyV1()
): OutcomeEvidence {
  const evalResult = policy.evaluateOutcome(params);
  const outcomeId = params.outcomeId || `outcome_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const recordedAt = params.recordedAt || new Date().toISOString();

  return {
    ...params,
    outcomeId,
    verifiedSuccess: evalResult.verifiedSuccess,
    confidence: evalResult.confidence,
    recordedAt,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    evaluationRationale: evalResult.rationale,
  };
}
