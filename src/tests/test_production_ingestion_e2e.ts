/**
 * SiftrCode V2 - End-to-End Production Telemetry & Ingestion Test (Phase 20.1 Closure)
 *
 * Verifies the complete production data flywheel lifecycle:
 * 1. Policy Identity: Deterministic V2 ranker identity is canonical.
 * 2. Pre-Outcome Snapshot: Automatically generated and deeply immutable.
 * 3. Exposure Derivation: Derived strictly from actual context & agent events (no false inference).
 * 4. Outcome Resolution: Attributed to high-confidence verifiers via OutcomeEvidence.
 * 5. verifiedTargetEdit: True ONLY on verified success + edited targets (never read-only).
 * 6. Mandatory Revocation: Fail-closed filtering at storage and export boundaries.
 * 7. Canonical Readiness Gates: All 7 architecture spec gates truthfully evaluated with real DB records.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { ContextEngine } from '../engine/context_engine';
import { PRODUCTION_V2_POLICY_IDENTITY } from '../engine/context_plan';
import { SqliteStore } from '../storage/sqlite_store';
import * as os from 'os';
import { execSync } from 'child_process';
import { EpisodeAssembler } from '../learning/episodes/episode_assembler';
import { ContextExposureState } from '../learning/episodes/context_exposure';
import { AgentTrajectoryEvent } from '../learning/episodes/agent_trajectory';
import { computeSnapshotSha256 } from '../learning/episodes/pre_outcome_snapshot';
import { createOutcomeEvidence, DefaultOutcomePolicyV1 } from '../telemetry/outcome_evidence';
import { resolveTaskOutcomeFromEvidence } from '../learning/outcome/task_outcome';
import { TrainingExporter } from '../learning/training_exporter';
import { createDefaultDataRights } from '../rights/data_rights';

async function runProductionIngestionE2ETests() {
  console.log('\n=== Running Production Telemetry, Assembler & Ingestion E2E Tests (Phase 20.1) ===\n');

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_prod_e2e_'));
  const store = new SqliteStore(':memory:');

  try {
    execSync('git init -b main', { cwd: fixtureDir, stdio: 'ignore' });
    execSync('git config user.name "Test Author"', { cwd: fixtureDir, stdio: 'ignore' });
    execSync('git config user.email "test@siftrcode.com"', { cwd: fixtureDir, stdio: 'ignore' });

    const srcDir = path.join(fixtureDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify({ name: 'auth-service', version: '1.0.0' }, null, 2)
    );

    fs.writeFileSync(
      path.join(srcDir, 'auth_handler.ts'),
      `export class AuthHandler {\n  public authenticate(token: string): boolean {\n    if (!token) return false;\n    return true;\n  }\n}\n`
    );

    fs.writeFileSync(
      path.join(srcDir, 'user_model.ts'),
      `export interface User {\n  id: string;\n  name: string;\n}\n`
    );

    execSync('git add . && git commit -m "initial commit"', { cwd: fixtureDir, stdio: 'ignore' });

    // =========================================================================
    // 1. Policy Identity Verification
    // =========================================================================
    console.log('--- 1. Canonical Policy Identity Verification ---');
    {
      assert.strictEqual(
        PRODUCTION_V2_POLICY_IDENTITY.contextPolicyId,
        'production-v2-deterministic-2026-09',
        'Context policy ID must match production V2 deterministic identifier'
      );
      assert.strictEqual(
        PRODUCTION_V2_POLICY_IDENTITY.rankerId,
        'deterministic_context_ranker_v2',
        'Ranker ID must match deterministic V2 ranker'
      );
      console.log('  ✔ Verified: Canonical production policy identity is truthful and deterministic.');
    }

    // =========================================================================
    // 2. Automatic Deeply Immutable Pre-Outcome Snapshot
    // =========================================================================
    console.log('\n--- 2. Automatic Deeply Immutable Pre-Outcome Snapshot Creation ---');
    const rights = createDefaultDataRights();
    rights.trainingAllowed = true;
    rights.telemetryAllowed = true;
    rights.rightsProvenance = {
      serviceProcessingAllowed: true,
      trainingAllowed: true,
      redistributionAllowed: true,
      permissionSource: 'USER_CONSENT',
      decisionTimestamp: new Date().toISOString(),
    };

    const prompt = 'Fix null pointer exception in authentication route handler auth_handler.ts and review user schema in user_model.ts';
    const optimizeResult = await ContextEngine.optimizeWorkspace({
      workspaceDir: fixtureDir,
      prompt,
      taskId: 'task_closure_e2e_001',
      sqliteStore: store,
      dataRights: rights,
      tokenBudget: 300,
    });

  const plan = optimizeResult.plan;
  const workspaceSnapshot = optimizeResult.snapshot;

  // Verify plan identity
  assert.ok(plan.planId, 'Plan ID must be populated');
  assert.strictEqual(
    plan.contextPolicyIdentity?.contextPolicyId,
    'production-v2-deterministic-2026-09',
    'Plan must retain canonical policy identity'
  );

  // Verify automatic PreOutcomeEpisodeSnapshot creation
  assert.ok(plan.preOutcomeSnapshot, 'ContextEngine must automatically capture PreOutcomeEpisodeSnapshot');
  const snapshot = plan.preOutcomeSnapshot!;
  assert.strictEqual(snapshot.taskId, 'task_closure_e2e_001');
  assert.ok(snapshot.snapshotSha256, 'Snapshot must have deterministic SHA-256 hash');
  assert.ok(snapshot.candidateUniverse.length > 0, 'Candidate universe must be captured');
  assert.ok(snapshot.selectedUnits.length > 0, 'Selected units must be captured');

  // Verify Deep Immutability of PreOutcomeEpisodeSnapshot
  assert.strictEqual(Object.isFrozen(snapshot), true, 'PreOutcomeEpisodeSnapshot must be frozen');
  assert.strictEqual(
    Object.isFrozen(snapshot.candidateUniverse),
    true,
    'candidateUniverse array must be frozen'
  );
  if (snapshot.candidateUniverse.length > 0) {
    assert.strictEqual(
      Object.isFrozen(snapshot.candidateUniverse[0]),
      true,
      'Candidate observations must be deeply frozen'
    );
  }

  // Attempt mutation to confirm fail-closed immutability
  let mutationBlocked = false;
  try {
    (snapshot as any).tokenBudget = 999999;
    // In non-strict mode assignment to frozen property might silently fail, verify property unchanged
    if (snapshot.tokenBudget !== 999999) {
      mutationBlocked = true;
    }
  } catch {
    mutationBlocked = true;
  }
  assert.strictEqual(mutationBlocked, true, 'PreOutcomeEpisodeSnapshot mutation must be strictly blocked');

  // Verify snapshot was saved into SQLite store
  const storedSnapshot = store.getPreOutcomeSnapshot(snapshot.episodeId);
  assert.ok(storedSnapshot, 'PreOutcomeEpisodeSnapshot must be durably persisted in SQLite');
  assert.strictEqual(storedSnapshot!.snapshotSha256, snapshot.snapshotSha256);

  // Full-Payload Snapshot Hashing Verification (Phase 20.2)
  const clonedUniverse = JSON.parse(JSON.stringify(snapshot.candidateUniverse));
  clonedUniverse[0].finalScore = 99999.0;
  const alteredHash = computeSnapshotSha256({
    ...snapshot,
    candidateUniverse: clonedUniverse,
  });
  assert.notStrictEqual(
    alteredHash,
    snapshot.snapshotSha256,
    'Modifying any candidate field in candidateUniverse must produce a different SHA-256 hash'
  );
  console.log('  ✔ Verified: ContextEngine automatically created, durably persisted, and full-payload hashed deeply immutable PreOutcomeEpisodeSnapshot.');

  // =========================================================================
  // 3. Truthful Exposure Derivation from Actual Telemetry (No False Inference)
  // =========================================================================
  console.log('\n--- 3. Truthful Exposure Derivation from Actual Telemetry ---');
  // Select target files from candidate universe
  const selectedCandidate = snapshot.candidateUniverse.find((c: any) => c.selected);
  assert.ok(selectedCandidate, 'At least one candidate must be selected in plan');

  const unselectedCandidate = snapshot.candidateUniverse.find((c: any) => !c.selected);
  assert.ok(unselectedCandidate, 'At least one candidate must remain unselected');

  // Simulate agent execution trajectory events
  const episodeId = snapshot.episodeId;
  const targetPath = selectedCandidate!.path || 'src/index.ts';
  const pathOnlyTarget = unselectedCandidate!.path || 'src/user_model.ts';

  const trajectoryEvents: AgentTrajectoryEvent[] = [
    {
      eventId: 'evt_read_01',
      episodeId,
      timestamp: new Date().toISOString(),
      sequence: 1,
      type: 'FILE_READ',
      path: targetPath,
      contextUnitId: selectedCandidate!.contextUnitId,
    },
    {
      eventId: 'evt_edit_01',
      episodeId,
      timestamp: new Date().toISOString(),
      sequence: 2,
      type: 'FILE_EDIT',
      path: targetPath,
      contextUnitId: selectedCandidate!.contextUnitId,
    },
    {
      eventId: 'evt_read_path_only',
      episodeId,
      timestamp: new Date().toISOString(),
      sequence: 3,
      type: 'FILE_READ',
      path: pathOnlyTarget,
    },
    {
      eventId: 'evt_test_01',
      episodeId,
      timestamp: new Date().toISOString(),
      sequence: 4,
      type: 'TEST_RUN',
    },
  ];

  const derivedExposures = EpisodeAssembler.deriveContextExposures({
    episodeId,
    candidates: snapshot.candidateUniverse,
    plan,
    trajectoryEvents,
  });

  const editedExposure = derivedExposures.find((e) => e.contextUnitId === selectedCandidate!.contextUnitId);
  assert.ok(editedExposure, 'Exposure record must exist for selected target');
  assert.strictEqual(
    editedExposure!.state,
    ContextExposureState.EDITED,
    'Target with FILE_EDIT trajectory event must have state EDITED'
  );
  assert.strictEqual(
    editedExposure!.attributionType,
    'EXACT_UNIT',
    'Explicit unit-level event must have attributionType EXACT_UNIT'
  );
  assert.strictEqual(
    editedExposure!.editAttribution,
    'EXACT_UNIT',
    'Explicit unit edit must have editAttribution EXACT_UNIT'
  );
  assert.strictEqual(
    editedExposure!.readAttribution,
    'EXACT_UNIT',
    'Explicit unit read must have readAttribution EXACT_UNIT'
  );
  assert.ok(editedExposure!.editedAt, 'editedAt must be stamped');
  assert.ok(editedExposure!.readAt, 'readAt must be stamped');
  assert.ok(editedExposure!.shownAt, 'shownAt must be stamped');

  const unselectedExposure = derivedExposures.find((e) => e.contextUnitId === unselectedCandidate!.contextUnitId);
  assert.ok(unselectedExposure, 'Exposure record must exist for unselected candidate');
  assert.strictEqual(
    unselectedExposure!.state,
    ContextExposureState.READ,
    'Unselected candidate with path-level read event must progress to READ'
  );
  assert.strictEqual(
    unselectedExposure!.attributionType,
    'PATH_LEVEL',
    'Path-level event without unitId must have attributionType PATH_LEVEL'
  );
  assert.strictEqual(
    unselectedExposure!.readAttribution,
    'PATH_LEVEL',
    'readAttribution must be PATH_LEVEL'
  );
  assert.strictEqual(
    unselectedExposure!.editAttribution,
    'NONE',
    'editAttribution must remain NONE'
  );
  console.log('  ✔ Verified: Exposures derived strictly from actual events with unit-vs-path attribution.');

  // =========================================================================
  // 4. Outcome Resolution via Authoritative OutcomeEvidence
  // =========================================================================
  console.log('\n--- 4. Outcome Resolution via Authoritative OutcomeEvidence ---');
  const outcomeEvidence = createOutcomeEvidence({
    taskId: 'task_closure_e2e_001',
    sessionId: plan.sessionId!,
    contextPlanId: plan.planId,
    agentEnvironmentId: plan.agentEnvironmentId || 'test_env',
    workspaceSnapshotBefore: snapshot.workspaceSnapshotId,
    buildPassed: true,
    publicTestsPassed: true,
    regressionTestsPassed: true,
    behavioralOraclePassed: true,
    actualProviderInputTokens: 3500,
    actualProviderOutputTokens: 250,
    costUSD: 0.0125,
    wallTimeMs: 1450,
  });

  assert.strictEqual(outcomeEvidence.verifiedSuccess, true);
  assert.strictEqual(outcomeEvidence.confidence >= 0.9, true);

  const resolvedOutcome = resolveTaskOutcomeFromEvidence(outcomeEvidence, episodeId);
  assert.strictEqual(resolvedOutcome.verifiedSuccess, true);
  assert.strictEqual(resolvedOutcome.verificationConfidence, 'HIGH');
  assert.ok(resolvedOutcome.verificationSources.includes('BEHAVIORAL_ORACLE'));
  assert.ok(resolvedOutcome.verificationSources.includes('PUBLIC_TESTS'));
  console.log('  ✔ Verified: OutcomeEvidence accurately mapped into high-confidence TaskOutcomeV1.');

  // =========================================================================
  // 5. Full Production Ingestion via EpisodeAssembler
  // =========================================================================
  console.log('\n--- 5. Full Production Ingestion into SqliteStore ---');
  const ingestionResult = EpisodeAssembler.ingestProductionRun(store, {
    episodeId,
    plan,
    task: optimizeResult.task,
    snapshot: workspaceSnapshot,
    candidates: snapshot.candidateUniverse,
    trajectoryEvents,
    outcomeEvidence,
    dataRights: rights,
    economics: {
      contextInputTokens: plan.actualRenderedTokens,
      agentInputTokens: 3500,
      agentOutputTokens: 250,
      contextLatencyMs: 15,
      taskLatencyMs: 1450,
      contextGenerationCostUSD: 0.001,
      agentCostUSD: 0.0125,
      totalCostUSD: 0.0135,
      pricingStatus: 'VALID',
    },
  });

  const assembledEpisode = ingestionResult.episode;
  assert.strictEqual(assembledEpisode.episodeId, episodeId);
  assert.strictEqual(assembledEpisode.outcome.verifiedSuccess, true);
  assert.strictEqual(assembledEpisode.rights.trainingAllowed, true);
  assert.strictEqual(
    assembledEpisode.environment.contextPolicyIdentity?.contextPolicyId,
    'production-v2-deterministic-2026-09'
  );
  assert.strictEqual(Object.isFrozen(assembledEpisode), true, 'Assembled episode must be deeply frozen');

  // Verify persistence in SQLite store
  const loadedEpisode = store.getTaskEpisode(episodeId);
  assert.ok(loadedEpisode, 'TaskEpisode must be retrievable from SQLite');
  assert.strictEqual(loadedEpisode!.episodeId, episodeId);
  assert.strictEqual(loadedEpisode!.outcome.verifiedSuccess, true);

  const loadedExposures = store.getContextExposures(episodeId);
  assert.strictEqual(loadedExposures.length, snapshot.candidateUniverse.length);

  const loadedCandidates = store.getEpisodeCandidates(episodeId);
  assert.strictEqual(loadedCandidates.length, snapshot.candidateUniverse.length);
  console.log('  ✔ Verified: Complete production run ingested cleanly with deep immutability.');

  // =========================================================================
  // 5b. Automatic Episode Finalization on Real Outcome Submission (Phase 20.2)
  // =========================================================================
  console.log('\n--- 5b. Automatic Episode Finalization via store.saveTaskOutcome ---');
  const optimizeResult2 = await ContextEngine.optimizeWorkspace({
    workspaceDir: fixtureDir,
    prompt: 'Review user schema and validate index exports',
    taskId: 'task_closure_e2e_002',
    sqliteStore: store,
    dataRights: rights,
    tokenBudget: 300,
  });

  const plan2 = optimizeResult2.plan;
  const snapshot2 = plan2.preOutcomeSnapshot!;
  assert.ok(snapshot2, 'Plan 2 must have preOutcomeSnapshot');

  // Record trajectory events for episode 2
  store.saveEpisodeTrajectoryEvents([
    {
      eventId: 'evt_task2_edit',
      episodeId: snapshot2.episodeId,
      timestamp: new Date().toISOString(),
      sequence: 1,
      type: 'FILE_EDIT',
      path: snapshot2.candidateUniverse[0]?.path,
      contextUnitId: snapshot2.candidateUniverse[0]?.contextUnitId,
    },
  ]);

  const outcomeEvidence2 = createOutcomeEvidence({
    taskId: 'task_closure_e2e_002',
    sessionId: plan2.sessionId!,
    contextPlanId: plan2.planId,
    agentEnvironmentId: plan2.agentEnvironmentId || 'test_env_2',
    workspaceSnapshotBefore: snapshot2.workspaceSnapshotId,
    buildPassed: true,
    publicTestsPassed: true,
    regressionTestsPassed: true,
    behavioralOraclePassed: true,
    actualProviderInputTokens: 2800,
    actualProviderOutputTokens: 180,
    costUSD: 0.0095,
    wallTimeMs: 1200,
  });

  // Calling store.saveTaskOutcome automatically resolves outcome, derives exposures, computes economics, and finalizes episode!
  store.saveTaskOutcome(outcomeEvidence2);

  const autoFinalizedEpisode = store.getTaskEpisode(snapshot2.episodeId);
  assert.ok(autoFinalizedEpisode, 'TaskEpisode must be automatically finalized and retrievable');
  assert.strictEqual(autoFinalizedEpisode!.episodeId, snapshot2.episodeId);
  assert.strictEqual(autoFinalizedEpisode!.outcome.verifiedSuccess, true);
  assert.strictEqual(autoFinalizedEpisode!.economics?.totalCostUSD, 0.0095);
  console.log('  ✔ Verified: store.saveTaskOutcome automatically finalized and persisted TaskEpisode.');

  // =========================================================================
  // 6. verifiedTargetEdit & Rights-Aware Dataset Export
  // =========================================================================
  console.log('\n--- 6. verifiedTargetEdit & Dataset V2 Export Verification ---');
  const exporter = new TrainingExporter();

  // Export dataset using real store episodes and mandatory revocation check
  const exportResult = exporter.exportContextDatasetV2([assembledEpisode], {
    isRevoked: (epId) => store.isEpisodeRevoked(epId),
    exposuresProvider: (epId) => store.getContextExposures(epId),
  });

  assert.strictEqual(exportResult.totalEpisodesAccepted, 1);
  assert.ok(exportResult.rows.length > 0);

  // Check rows: edited target MUST have verifiedTargetEdit = true AND verifiedTargetEvidence must be undefined (removed)
  const editedRow = exportResult.rows.find((r) => r.contextUnitId === selectedCandidate!.contextUnitId);
  assert.ok(editedRow, 'Row for edited target must exist');
  assert.strictEqual(editedRow!.wasEdited, true);
  assert.strictEqual(
    editedRow!.verifiedTargetEdit,
    true,
    'Target with verifiedSuccess === true && wasEdited must have verifiedTargetEdit === true'
  );
  assert.strictEqual(
    (editedRow as any).verifiedTargetEvidence,
    undefined,
    'verifiedTargetEvidence property has been completely removed'
  );
  assert.strictEqual(
    editedRow!.attributionType,
    'EXACT_UNIT',
    'Attribution type must be EXACT_UNIT'
  );
  assert.strictEqual(
    editedRow!.editAttribution,
    'EXACT_UNIT',
    'Edit attribution must be EXACT_UNIT'
  );

  // Check rows: unedited candidates MUST NOT have verifiedTargetEdit = true even if in successful task
  const uneditedRow = exportResult.rows.find((r) => r.contextUnitId === unselectedCandidate!.contextUnitId);
  assert.ok(uneditedRow, 'Row for unedited candidate must exist');
  assert.strictEqual(uneditedRow!.wasEdited, false);
  assert.strictEqual(
    uneditedRow!.verifiedTargetEdit,
    false,
    'Unedited candidate must NEVER have verifiedTargetEdit === true'
  );
  assert.strictEqual(
    (uneditedRow as any).verifiedTargetEvidence,
    undefined,
    'Unedited candidate must have verifiedTargetEvidence === undefined'
  );
  assert.strictEqual(
    uneditedRow!.readAttribution,
    'PATH_LEVEL',
    'Read attribution must be PATH_LEVEL'
  );
  assert.strictEqual(
    uneditedRow!.editAttribution,
    'NONE',
    'Edit attribution must be NONE'
  );
  console.log('  ✔ Verified: verifiedTargetEdit is true strictly for edited units in verified successes.');

  // =========================================================================
  // 7. Mandatory Revocation Enforcement
  // =========================================================================
  console.log('\n--- 7. Mandatory Revocation Enforcement Across Store & Exporter ---');
  // Revoke the episode
  store.revokeEpisode(episodeId, 'Customer data deletion request');

  // Verify store query excludes revoked episodes by default
  const activeEpisodes = store.listTaskEpisodes({ trainingAllowed: true });
  assert.strictEqual(
    activeEpisodes.some((e) => e.episodeId === episodeId),
    false,
    'listTaskEpisodes must automatically exclude revoked episode'
  );

  // If explicitly requested without exclusion, it is visible for audit
  const auditEpisodes = store.listTaskEpisodes({ excludeRevoked: false });
  assert.strictEqual(
    auditEpisodes.some((e) => e.episodeId === episodeId),
    true,
    'listTaskEpisodes with excludeRevoked: false allows audit queries'
  );

  // Verify TrainingExporter rejects revoked episode
  const exportAfterRevocation = exporter.exportContextDatasetV2([assembledEpisode], {
    isRevoked: (epId) => store.isEpisodeRevoked(epId),
    exposuresProvider: (epId) => store.getContextExposures(epId),
  });
  assert.strictEqual(
    exportAfterRevocation.totalEpisodesAccepted,
    0,
    'Revoked episode must be rejected by TrainingExporter'
  );
  assert.strictEqual(exportAfterRevocation.rejections.length, 1);
  assert.ok(
    exportAfterRevocation.rejections[0].reasons.some((r) => r.includes('REVOKED_EPISODE')),
    'Rejection reason must cite REVOKED_EPISODE'
  );

  // Verify TrainingExporter fails closed if isRevoked is omitted
  let failClosedTriggered = false;
  try {
    (exporter as any).exportContextDatasetV2([assembledEpisode], {});
  } catch (err) {
    failClosedTriggered = true;
    assert.ok(String(err).includes('FAIL_CLOSED'));
  }
  assert.strictEqual(failClosedTriggered, true, 'Export must fail closed if revocation checker is omitted');
  console.log('  ✔ Verified: Revocation is mandatory and fails closed at store and export boundaries.');

  // =========================================================================
  // 8. Canonical Readiness Gates Evaluation
  // =========================================================================
  console.log('\n--- 8. Canonical Readiness Gates Evaluation ---');
  // Record real shadow policy evaluations (Migration 16)
  store.saveShadowPolicyEvaluation(
    {
      taskId: 'task_closure_e2e_001',
      productionPolicyId: 'production-v2-deterministic-2026-09',
      shadowPolicyId: 'shadow-candidate-v3',
      candidateCount: 10,
      topK: 10,
      rankOverlapJaccard: 0.95,
      topKDifferences: { inProductionOnly: [], inShadowOnly: [], sharedTopKCount: 10 },
      inclusionDifferences: { inProductionOnly: [], inShadowOnly: [], sharedInclusionCount: 10 },
      resolutionDifferences: [],
      tokenDifference: 0,
      productionTokens: 1000,
      shadowTokens: 1000,
      shadowLatencyMs: 18,
      evaluatedAt: new Date().toISOString(),
    },
    false,
    undefined,
    'PRODUCTION',
    false
  );

  const summary = store.getLearningFlywheelSummary();
  // With 2 total episodes created, and 1 revoked, totalEpisodes must be exactly 1!
  assert.strictEqual(summary.totalEpisodes, 1, 'Summary totalEpisodes must exclude revoked episodes');
  assert.strictEqual(summary.revokedEpisodes, 1, 'Revoked episodes count must be recorded');

  const readiness = store.getV32DataReadinessReport();
  assert.strictEqual(readiness.version, 'V3.2_READINESS_GATE_SPEC_V1');
  assert.ok(readiness.canonicalGates, 'Canonical gates must be evaluated');
  assert.strictEqual(readiness.canonicalGates!.length, 7, 'All 7 canonical architecture gates must be present');

  const gateIds = readiness.canonicalGates!.map((g) => g.gateId);
  assert.ok(gateIds.includes('GATE_1_TOTAL_EPISODES'));
  assert.ok(gateIds.includes('GATE_2_VERIFIED_OUTCOMES'));
  assert.ok(gateIds.includes('GATE_3_CANDIDATE_LOGGING_COVERAGE'));
  assert.ok(gateIds.includes('GATE_4_RIGHTS_CLEARANCE'));
  assert.ok(gateIds.includes('GATE_5_SUPERVISION_DIVERSITY'));
  assert.ok(gateIds.includes('GATE_6_ZERO_LEAKAGE_AUDIT'));
  assert.ok(gateIds.includes('GATE_7_SHADOW_POLICY_PARITY'));

  const gate1 = readiness.canonicalGates!.find((g) => g.gateId === 'GATE_1_TOTAL_EPISODES');
  assert.strictEqual(gate1!.currentValue, 1, 'Gate 1 must exclude revoked episodes from count');

  const gate7 = readiness.canonicalGates!.find((g) => g.gateId === 'GATE_7_SHADOW_POLICY_PARITY');
  assert.strictEqual(gate7!.currentValue, '1 runs, 0 crashes', 'Gate 7 must measure real shadow evaluation runs from database');

  // Truthfulness check: with only 1 active test episode in DB, gates must NOT falsely pass
  assert.strictEqual(readiness.isV32Ready, false, 'V3.2 must not falsely report ready');
  console.log('  ✔ Verified: Canonical 7 readiness gates truthfully evaluated without fake data.');

  store.close();
  console.log('\n🎉 ALL PRODUCTION TELEMETRY, ASSEMBLER & INGESTION E2E TESTS PASSED CLEANLY!\n');
  } finally {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

runProductionIngestionE2ETests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
