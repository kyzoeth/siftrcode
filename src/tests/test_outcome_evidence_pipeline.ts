import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  OutcomeEvidence,
  OutcomePolicy,
  DefaultOutcomePolicyV1,
  createOutcomeEvidence,
} from '../telemetry/outcome_evidence';
import { SqliteStore } from '../storage/sqlite_store';
import { computeLabelEvidence } from '../telemetry/candidate_observation';
import { createExposureDecisionV2 } from '../telemetry/exposure_decision';
import { ContextResolution } from '../context/context_resolution';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

async function runOutcomeEvidencePipelineTests() {
  console.log('\n=== Running V2 OutcomeEvidence Pipeline & Verification Policy Tests (Remediation PR 11) ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-pr11-outcome-'));
  const dbPath = path.join(tempDir, 'telemetry.db');
  const store = new SqliteStore(dbPath);

  try {
    const policy: OutcomePolicy = new DefaultOutcomePolicyV1();

    // =========================================================================
    // TEST 1: OutcomePolicy Rule Invariants (Section 49)
    // =========================================================================
    console.log('--- 1. OutcomePolicy Verification Rules (Section 49) ---');

    // 1a. Human Review PASS / FAIL
    const humanPass = policy.evaluateOutcome({
      taskId: 'task_human_1',
      sessionId: 'sess_1',
      agentEnvironmentId: 'env_1',
      workspaceSnapshotBefore: 'snap_before',
      humanReview: 'PASS',
    });
    assert(humanPass.verifiedSuccess === true, 'Human review PASS yields verifiedSuccess = true');
    assert(humanPass.confidence === 1.0, 'Human review PASS yields absolute confidence 1.0');

    const humanFail = policy.evaluateOutcome({
      taskId: 'task_human_2',
      sessionId: 'sess_1',
      agentEnvironmentId: 'env_1',
      workspaceSnapshotBefore: 'snap_before',
      humanReview: 'FAIL',
    });
    assert(humanFail.verifiedSuccess === false, 'Human review FAIL yields verifiedSuccess = false');
    assert(humanFail.confidence === 1.0, 'Human review FAIL yields absolute confidence 1.0');

    // 1b. Weak Signals & Automated Oracle Failures
    const buildFail = policy.evaluateOutcome({
      taskId: 'task_build_fail',
      sessionId: 'sess_1',
      agentEnvironmentId: 'env_1',
      workspaceSnapshotBefore: 'snap_before',
      buildPassed: false,
      agentReportedSuccess: true, // Agent says done, but build failed!
    });
    assert(buildFail.verifiedSuccess === null, 'Phase 20.4 Invariant: Build failure alone preserves verifiedSuccess = null');

    const regressionFail = policy.evaluateOutcome({
      taskId: 'task_reg_fail',
      sessionId: 'sess_1',
      agentEnvironmentId: 'env_1',
      workspaceSnapshotBefore: 'snap_before',
      buildPassed: true,
      publicTestsPassed: true,
      regressionTestsPassed: false,
    });
    assert(regressionFail.verifiedSuccess === null, 'Phase 20.4 Invariant: Regression failure alone preserves verifiedSuccess = null');

    const hiddenFail = policy.evaluateOutcome({
      taskId: 'task_hidden_fail',
      sessionId: 'sess_1',
      agentEnvironmentId: 'env_1',
      workspaceSnapshotBefore: 'snap_before',
      hiddenTestsPassed: false,
    });
    assert(hiddenFail.verifiedSuccess === false, 'Hidden test failure strictly marks verifiedSuccess = false');
    assert(hiddenFail.confidence >= 0.98, 'Hidden test failure has >= 0.98 confidence');

    const oracleFail = policy.evaluateOutcome({
      taskId: 'task_oracle_fail',
      sessionId: 'sess_1',
      agentEnvironmentId: 'env_1',
      workspaceSnapshotBefore: 'snap_before',
      behavioralOraclePassed: false,
    });
    assert(oracleFail.verifiedSuccess === false, 'Behavioral oracle failure strictly marks verifiedSuccess = false');
    assert(oracleFail.confidence >= 0.98, 'Behavioral oracle failure has >= 0.98 confidence');

    // 1c. Strong Automated Success: Hidden tests pass + regressions pass
    const strongOraclePass = policy.evaluateOutcome({
      taskId: 'task_oracle_pass',
      sessionId: 'sess_1',
      agentEnvironmentId: 'env_1',
      workspaceSnapshotBefore: 'snap_before',
      buildPassed: true,
      hiddenTestsPassed: true,
      regressionTestsPassed: true,
    });
    assert(strongOraclePass.verifiedSuccess === true, 'Hidden tests + regressions pass yields verifiedSuccess = true');
    assert(strongOraclePass.confidence >= 0.98, 'Strong oracle success has >= 0.98 confidence');

    // 1d. Behavioral oracle pass
    const behavioralPass = policy.evaluateOutcome({
      taskId: 'task_behavioral_pass',
      sessionId: 'sess_1',
      agentEnvironmentId: 'env_1',
      workspaceSnapshotBefore: 'snap_before',
      behavioralOraclePassed: true,
      regressionTestsPassed: true,
    });
    assert(behavioralPass.verifiedSuccess === true, 'Behavioral oracle pass yields verifiedSuccess = true');
    assert(behavioralPass.confidence >= 0.95, 'Behavioral oracle pass has >= 0.95 confidence');

    // 1e. Section 49 Critical Invariant: Agent says done alone (weak evidence only)
    const agentAlone = policy.evaluateOutcome({
      taskId: 'task_agent_alone',
      sessionId: 'sess_1',
      agentEnvironmentId: 'env_1',
      workspaceSnapshotBefore: 'snap_before',
      agentReportedSuccess: true,
    });
    assert(
      agentAlone.verifiedSuccess === null,
      'Section 49 invariant: Agent self-reporting success alone MUST NOT yield verifiedSuccess = true'
    );
    assert(
      agentAlone.confidence <= 0.40,
      `Section 49 invariant: Agent claim alone is weak evidence only (confidence ${agentAlone.confidence} <= 0.40)`
    );

    // 1f. Insufficient evidence
    const insufficient = policy.evaluateOutcome({
      taskId: 'task_empty',
      sessionId: 'sess_1',
      agentEnvironmentId: 'env_1',
      workspaceSnapshotBefore: 'snap_before',
    });
    assert(insufficient.verifiedSuccess === null, 'Insufficient evidence yields verifiedSuccess = null');
    assert(insufficient.confidence <= 0.20, 'Insufficient evidence yields low confidence');

    // =========================================================================
    // TEST 2: OutcomeEvidence Object Factory (Section 48)
    // =========================================================================
    console.log('\n--- 2. OutcomeEvidence Object Factory & Integrity (Section 48) ---');

    const outcome1 = createOutcomeEvidence({
      taskId: 'task_benchmark_101',
      sessionId: 'sess_bench_101',
      agentEnvironmentId: 'env_claude_sonnet',
      workspaceSnapshotBefore: 'snap_before_101',
      workspaceSnapshotAfter: 'snap_after_101',
      buildPassed: true,
      publicTestsPassed: true,
      hiddenTestsPassed: true,
      regressionTestsPassed: true,
      staticChecksPassed: true,
      securityChecksPassed: true,
      behavioralOraclePassed: true,
      userAccepted: true,
      agentReportedSuccess: true,
      humanReview: 'PASS',
    });

    assert(outcome1.outcomeId.startsWith('outcome_'), 'Generated outcomeId has valid prefix');
    assert(outcome1.verifiedSuccess === true, 'Factory computes verifiedSuccess = true');
    assert(outcome1.confidence === 1.0, 'Factory computes confidence = 1.0');
    assert(outcome1.policyId === 'siftr-default-outcome', 'Attaches policyId');
    assert(outcome1.policyVersion === '1.0.0', 'Attaches policyVersion');
    assert(typeof outcome1.recordedAt === 'string', 'Attaches ISO timestamp recordedAt');
    assert(Boolean(outcome1.evaluationRationale), 'Attaches evaluationRationale');

    // =========================================================================
    // TEST 3: Durable SQLite Persistence & Retrieval (Section 48)
    // =========================================================================
    console.log('\n--- 3. Durable SQLite Persistence & Retrieval ---');

    store.saveTaskOutcome(outcome1);

    const retrieved1 = store.getTaskOutcome(outcome1.taskId);
    assert(retrieved1 !== null, 'Retrieved saved OutcomeEvidence from SQLite store');
    assert(retrieved1?.outcomeId === outcome1.outcomeId, 'outcomeId preserved across persistence');
    assert(retrieved1?.taskId === outcome1.taskId, 'taskId preserved');
    assert(retrieved1?.sessionId === outcome1.sessionId, 'sessionId preserved');
    assert(retrieved1?.agentEnvironmentId === outcome1.agentEnvironmentId, 'agentEnvironmentId preserved');
    assert(retrieved1?.workspaceSnapshotBefore === outcome1.workspaceSnapshotBefore, 'snapshotBefore preserved');
    assert(retrieved1?.workspaceSnapshotAfter === outcome1.workspaceSnapshotAfter, 'snapshotAfter preserved');
    assert(retrieved1?.buildPassed === true, 'buildPassed boolean preserved');
    assert(retrieved1?.hiddenTestsPassed === true, 'hiddenTestsPassed boolean preserved');
    assert(retrieved1?.verifiedSuccess === true, 'verifiedSuccess = true preserved');
    assert(retrieved1?.confidence === 1.0, 'confidence preserved');
    assert(retrieved1?.humanReview === 'PASS', 'humanReview preserved');

    // Persist a failure outcome with null/undefined fields
    const outcomeFailure = createOutcomeEvidence({
      taskId: 'task_benchmark_102',
      sessionId: 'sess_bench_102',
      agentEnvironmentId: 'env_claude_sonnet',
      workspaceSnapshotBefore: 'snap_before_102',
      buildPassed: false,
      hiddenTestsPassed: false,
      agentReportedSuccess: true,
    });

    store.saveTaskOutcome(outcomeFailure);

    const retrievedFailure = store.getTaskOutcome(outcomeFailure.taskId);
    assert(retrievedFailure !== null, 'Retrieved failure OutcomeEvidence');
    assert(retrievedFailure?.verifiedSuccess === false, 'verifiedSuccess = false preserved');
    assert(retrievedFailure?.buildPassed === false, 'buildPassed = false preserved');
    assert(retrievedFailure?.workspaceSnapshotAfter === undefined, 'Optional undefined field preserved');

    // Persist an ambiguous outcome (verifiedSuccess = null)
    const outcomeAmbiguous = createOutcomeEvidence({
      taskId: 'task_benchmark_103',
      sessionId: 'sess_bench_103',
      agentEnvironmentId: 'env_cursor_small',
      workspaceSnapshotBefore: 'snap_before_103',
      agentReportedSuccess: true,
    });

    store.saveTaskOutcome(outcomeAmbiguous);

    const retrievedAmbiguous = store.getTaskOutcome(outcomeAmbiguous.taskId);
    assert(retrievedAmbiguous !== null, 'Retrieved ambiguous OutcomeEvidence');
    assert(retrievedAmbiguous?.verifiedSuccess === null, 'Tri-state verifiedSuccess = null preserved in SQLite');
    assert((retrievedAmbiguous?.confidence ?? 1.0) <= 0.40, 'Weak confidence preserved');

    // List outcomes
    const allOutcomes = store.listTaskOutcomes(10);
    assert(allOutcomes.length === 3, `Listed 3 task outcome records (got ${allOutcomes.length})`);

    // =========================================================================
    // TEST 4: Integration with Downstream Outcome Labeling
    // =========================================================================
    console.log('\n--- 4. Downstream Outcome Labeling Integration ---');

    const exposedDecision = createExposureDecisionV2({
      contextPlanId: 'cplan_test_1',
      contextUnitId: 'unit_candidate_1',
      eligibleForSelection: true,
      selected: true,
      resolution: ContextResolution.FULL,
    });

    // Scenario A: Verified task success + candidate edited by agent
    const successEditedEvidence = computeLabelEvidence({
      exposure: exposedDecision,
      observabilityLevel: 'FULL_TOOL_TRACE',
      observedBehavior: { edited: true },
      taskSucceeded: outcome1.verifiedSuccess === true,
    });
    assert(
      successEditedEvidence.outcomeLabel === 'POSITIVE',
      'Edited unit in verified successful task labeled POSITIVE'
    );

    // Scenario B: Verified task success + unreferenced candidate in full trace
    const successUnreferencedEvidence = computeLabelEvidence({
      exposure: exposedDecision,
      observabilityLevel: 'FULL_TOOL_TRACE',
      observedBehavior: { edited: false, read: false },
      taskSucceeded: outcome1.verifiedSuccess === true,
    });
    assert(
      successUnreferencedEvidence.outcomeLabel === 'WEAK_NEGATIVE',
      'Unreferenced candidate in verified successful task labeled WEAK_NEGATIVE'
    );

    // Scenario C: Verified task failure + unreferenced candidate in full trace
    const failedUnreferencedEvidence = computeLabelEvidence({
      exposure: exposedDecision,
      observabilityLevel: 'FULL_TOOL_TRACE',
      observedBehavior: { edited: false, read: false },
      taskSucceeded: outcomeFailure.verifiedSuccess === true,
    });
    assert(
      failedUnreferencedEvidence.outcomeLabel === 'UNKNOWN',
      'Unreferenced candidate in failed task remains UNKNOWN'
    );

    console.log('\n🎉 All OutcomeEvidence Pipeline & Verification Policy tests passed successfully!');
  } finally {
    try {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

runOutcomeEvidencePipelineTests().catch((err) => {
  console.error('❌ OutcomeEvidence Pipeline test failed:', err);
  process.exit(1);
});
