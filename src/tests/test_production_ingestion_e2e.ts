/**
 * SiftrCode V2 - End-to-End Production Telemetry & Ingestion Test (Phase 20.1 Closure)
 *
 * Verifies the complete production data flywheel lifecycle:
 * 1. Policy Identity: Deterministic V2 ranker identity is canonical.
 * 2. Pre-Outcome Snapshot: Automatically generated and deeply immutable.
 * 3. Exposure Derivation: Derived strictly from actual context & agent events (no false inference).
 * 4. Outcome Resolution: Attributed to high-confidence verifiers via OutcomeEvidence.
 * 5. verifiedTargetEvidence: True ONLY on verified success + edited targets (never read-only).
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
  console.log('  ✔ Verified: ContextEngine automatically created and durably persisted deeply immutable PreOutcomeEpisodeSnapshot.');

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
      eventId: 'evt_test_01',
      episodeId,
      timestamp: new Date().toISOString(),
      sequence: 3,
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
  assert.ok(editedExposure!.editedAt, 'editedAt must be stamped');
  assert.ok(editedExposure!.readAt, 'readAt must be stamped');
  assert.ok(editedExposure!.shownAt, 'shownAt must be stamped');

  const unselectedExposure = derivedExposures.find((e) => e.contextUnitId === unselectedCandidate!.contextUnitId);
  assert.ok(unselectedExposure, 'Exposure record must exist for unselected candidate');
  assert.strictEqual(
    unselectedExposure!.state,
    ContextExposureState.CANDIDATE,
    'Unselected candidate must remain CANDIDATE (never inferred as negative or shown)'
  );
  assert.strictEqual(unselectedExposure!.shownAt, undefined, 'Unselected candidate must have no shownAt');
  console.log('  ✔ Verified: Exposures derived strictly from actual events; unshown candidates remain CANDIDATE.');

  // =========================================================================
  // 4. Outcome Resolution via Authoritative OutcomeEvidence
  // =========================================================================
  console.log('\n--- 4. Outcome Resolution via Authoritative OutcomeEvidence ---');
  const outcomeEvidence = createOutcomeEvidence({
    taskId: 'task_closure_e2e_001',
    sessionId: plan.sessionId || 'sess_default',
    contextPlanId: plan.planId,
    agentEnvironmentId: 'test_env',
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
  // 6. verifiedTargetEvidence & Rights-Aware Dataset Export
  // =========================================================================
  console.log('\n--- 6. verifiedTargetEvidence & Dataset V2 Export Verification ---');
  const exporter = new TrainingExporter();

  // Export dataset using real store episodes and mandatory revocation check
  const exportResult = exporter.exportContextDatasetV2([assembledEpisode], {
    isRevoked: (epId) => store.isEpisodeRevoked(epId),
    exposuresProvider: (epId) => store.getContextExposures(epId),
  });

  assert.strictEqual(exportResult.totalEpisodesAccepted, 1);
  assert.ok(exportResult.rows.length > 0);

  // Check rows: edited target MUST have verifiedTargetEvidence = true
  const editedRow = exportResult.rows.find((r) => r.contextUnitId === selectedCandidate!.contextUnitId);
  assert.ok(editedRow, 'Row for edited target must exist');
  assert.strictEqual(editedRow!.wasEdited, true);
  assert.strictEqual(
    editedRow!.verifiedTargetEvidence,
    true,
    'Target with verifiedSuccess === true && wasEdited must have verifiedTargetEvidence === true'
  );

  // Check rows: unedited candidates MUST NOT have verifiedTargetEvidence = true even if in successful task
  const uneditedRow = exportResult.rows.find((r) => r.contextUnitId === unselectedCandidate!.contextUnitId);
  assert.ok(uneditedRow, 'Row for unedited candidate must exist');
  assert.strictEqual(uneditedRow!.wasEdited, false);
  assert.strictEqual(
    uneditedRow!.verifiedTargetEvidence,
    false,
    'Unedited candidate must NEVER have verifiedTargetEvidence === true'
  );
  console.log('  ✔ Verified: verifiedTargetEvidence is true strictly for edited units in verified successes.');

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

  // Truthfulness check: with only 1 test episode in DB, gates must NOT falsely pass
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
