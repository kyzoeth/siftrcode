import * as crypto from 'crypto';

/**
 * Section 48: Durable OutcomeEvidence object capturing comprehensive task verification signals.
 */
export interface OutcomeEvidence {
  outcomeId: string;
  taskId: string;
  sessionId: string;
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

    // 2. Hard Failures (Build broken, regressions broken, security check failed)
    if (evidence.buildPassed === false) {
      return {
        verifiedSuccess: false,
        confidence: 0.99,
        rationale: 'Hard failure: project build failed',
      };
    }
    if (evidence.regressionTestsPassed === false) {
      return {
        verifiedSuccess: false,
        confidence: 0.99,
        rationale: 'Hard failure: regression tests failed',
      };
    }
    if (evidence.securityChecksPassed === false) {
      return {
        verifiedSuccess: false,
        confidence: 0.99,
        rationale: 'Hard failure: security verification failed',
      };
    }

    // 3. Strong Automated Success Oracles
    // 3a. Hidden behavioral tests pass + regressions pass
    if (evidence.hiddenTestsPassed === true) {
      return {
        verifiedSuccess: true,
        confidence: 0.98,
        rationale: 'Strong success: hidden behavioral evaluation tests and regressions passed',
      };
    }

    // 3b. User accepted + public tests passed
    if (evidence.userAccepted === true && evidence.publicTestsPassed === true) {
      return {
        verifiedSuccess: true,
        confidence: 0.95,
        rationale: 'Strong success: user accepted changes and public test suite passed',
      };
    }

    // 3c. Behavioral oracle passed + public tests passed
    if (evidence.behavioralOraclePassed === true) {
      return {
        verifiedSuccess: true,
        confidence: 0.94,
        rationale: 'High confidence: independent behavioral oracle passed',
      };
    }

    // 3d. Public tests + static checks passed
    if (evidence.publicTestsPassed === true && evidence.staticChecksPassed === true) {
      return {
        verifiedSuccess: true,
        confidence: 0.90,
        rationale: 'Public tests and static analysis checks passed cleanly',
      };
    }

    // 3e. Public tests passed alone
    if (evidence.publicTestsPassed === true) {
      return {
        verifiedSuccess: true,
        confidence: 0.85,
        rationale: 'Public tests passed without negative regression signals',
      };
    }

    // 4. Automated Oracle Failures
    if (evidence.hiddenTestsPassed === false) {
      return {
        verifiedSuccess: false,
        confidence: 0.98,
        rationale: 'Automated verification failure: hidden tests failed',
      };
    }
    if (evidence.publicTestsPassed === false) {
      return {
        verifiedSuccess: false,
        confidence: 0.95,
        rationale: 'Automated verification failure: public test suite failed',
      };
    }
    if (evidence.behavioralOraclePassed === false) {
      return {
        verifiedSuccess: false,
        confidence: 0.92,
        rationale: 'Automated verification failure: behavioral oracle failed',
      };
    }
    if (evidence.userAccepted === false) {
      return {
        verifiedSuccess: false,
        confidence: 0.90,
        rationale: 'User explicitly rejected proposed task solution',
      };
    }

    // 5. Weak Evidence: Agent self-reported success alone (Section 49)
    // Never treat "agent says done" as verified success!
    if (evidence.agentReportedSuccess === true) {
      return {
        verifiedSuccess: null,
        confidence: 0.35,
        rationale: 'Unverified: agent reported task complete but no automated tests/oracles verified the solution',
      };
    }

    if (evidence.agentReportedSuccess === false) {
      return {
        verifiedSuccess: false,
        confidence: 0.70,
        rationale: 'Agent self-reported task failure or unresolvable error',
      };
    }

    // 6. Insufficient Evidence
    return {
      verifiedSuccess: null,
      confidence: 0.1,
      rationale: 'Insufficient outcome evidence: no tests, builds, or user feedback available',
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
