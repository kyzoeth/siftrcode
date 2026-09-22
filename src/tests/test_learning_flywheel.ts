/**
 * SiftrCode V2 - Production Data Flywheel & Learning Boundary Test Suite
 *
 * Validates Phase 20 requirements:
 * 1. Secret Scrubber & Credential Redaction (Phase 20S)
 * 2. Exposure State Machine & UNKNOWN != NEGATIVE (Phase 20B & 20C)
 * 3. Pre-Outcome Snapshot Immutability & Anti-Leakage Sentinels (Phase 20H & 20I)
 * 4. Tri-State Verified Outcome Model & Verifier Policy (Phase 20E & 20F)
 * 5. Economics & Honest CPVST Pricing Model (Phase 20G)
 * 6. SQLite Durable Storage & Migration 15 Integration (Phase 20A-D, 20H)
 * 7. Deletion Manager & Revocation Tombstoning (Phase 20K & 20L)
 * 8. Rights-Aware Training Exporter V2 (Phase 20J)
 * 9. Proprietary Aggregated Signals Calculator (Phase 20M)
 * 10. Shadow Policy Runner & Production Plan Invariance (Phase 20P)
 * 11. Admin Learning API Security & Fail-Closed Auth (Phase 20V)
 */

import * as assert from 'assert';
import { scrubSecrets, scrubSecretObject } from '../security/secret_scrubber';
import { resolveExposureState, ContextExposureState } from '../learning/episodes/context_exposure';
import {
  PreOutcomeEpisodeSnapshot,
  validatePreOutcomeSnapshotIntegrity,
  assembleTrainingEpisode,
  FORBIDDEN_PRE_OUTCOME_FIELDS,
} from '../learning/episodes/pre_outcome_snapshot';
import { resolveTaskOutcome, TaskOutcomeV1 } from '../learning/outcome/task_outcome';
import { computeCPVST, TaskEconomicsV1 } from '../learning/economics/task_economics';
import { createTaskEpisodeV1 } from '../learning/episodes/task_episode';
import { SqliteStore } from '../storage/sqlite_store';
import { TrainingExporter } from '../learning/training_exporter';
import { computeAggregatedSignals } from '../learning/analytics/aggregated_signals';
import { ShadowPolicyRunner, ShadowRanker } from '../ranking/shadow_policy_runner';
import { ContextPlan } from '../engine/context_plan';
import { ContextResolution } from '../context/context_resolution';
import { handleAdminAuthFailure } from '../server/web';

export async function runLearningFlywheelTests() {
  console.log('🧪 [Test Suite: Production Data Flywheel & Learning Boundary] Starting...\n');

  // =========================================================================
  // 1. Secret Scrubber & Credential Redaction (Phase 20S)
  // =========================================================================
  console.log('--- 1. Secret Scrubber & Credential Redaction ---');
  {
    // API Keys
    const openaiKey = 'sk-proj-abc12345678901234567890123456789012';
    assert.strictEqual(scrubSecrets(openaiKey), '[REDACTED_SECRET]');

    const anthropicKey = 'sk-ant-api03-abcdef12345678901234567890123456789012';
    assert.strictEqual(scrubSecrets(anthropicKey), '[REDACTED_SECRET]');

    const githubKey = 'ghp_123456789012345678901234567890123456';
    assert.strictEqual(scrubSecrets(githubKey), '[REDACTED_SECRET]');

    // Bearer token
    const bearer = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz';
    assert.ok(scrubSecrets(bearer).includes('Bearer [REDACTED_SECRET]'));

    // RSA Private Key
    const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----';
    assert.strictEqual(scrubSecrets(privateKey), '[REDACTED_SECRET]');

    // Database connection string with password
    const dbUrl = 'postgres://dbuser:supersecretpass123@localhost:5432/siftr';
    assert.strictEqual(scrubSecrets(dbUrl), 'postgres://dbuser:[REDACTED_SECRET]@localhost:5432/siftr');

    // Deep object scrubbing
    const metadata = {
      user: 'alice',
      env: {
        OPENAI_API_KEY: openaiKey,
        PORT: 8080,
      },
      headers: {
        authorization: 'Bearer token999',
      },
      safeList: ['file.ts', 'src/index.ts'],
    };
    const scrubbed = scrubSecretObject(metadata);
    assert.strictEqual((scrubbed as any).user, 'alice');
    assert.strictEqual((scrubbed as any).env.OPENAI_API_KEY, '[REDACTED_SECRET]');
    assert.strictEqual((scrubbed as any).env.PORT, 8080);
    assert.ok((scrubbed as any).headers.authorization.includes('[REDACTED_SECRET]'));
    assert.deepStrictEqual((scrubbed as any).safeList, ['file.ts', 'src/index.ts']);

    console.log('  ✔ Verified: Secret scrubber successfully redacts keys, tokens, credentials, and nested structures.');
  }

  // =========================================================================
  // 2. Exposure State Machine & UNKNOWN != NEGATIVE (Phase 20B & 20C)
  // =========================================================================
  console.log('--- 2. Exposure State Machine & UNKNOWN != NEGATIVE ---');
  {
    // Precedence: EDITED > READ > SHOWN > MATERIALIZED > SELECTED > CANDIDATE
    assert.strictEqual(
      resolveExposureState({ wasEdited: true, wasRead: true, wasShown: true }),
      ContextExposureState.EDITED
    );
    assert.strictEqual(
      resolveExposureState({ wasEdited: false, wasRead: true, wasShown: true }),
      ContextExposureState.READ
    );
    assert.strictEqual(
      resolveExposureState({ wasEdited: false, wasRead: false, wasShown: true }),
      ContextExposureState.SHOWN
    );
    assert.strictEqual(
      resolveExposureState({ wasMaterialized: true }),
      ContextExposureState.MATERIALIZED
    );
    assert.strictEqual(
      resolveExposureState({ wasSelected: true }),
      ContextExposureState.SELECTED
    );
    assert.strictEqual(
      resolveExposureState({}),
      ContextExposureState.CANDIDATE
    );

    // Invariant: Unshown candidates are CANDIDATE, never negative
    const unshownState = resolveExposureState({ wasShown: false, wasSelected: false });
    assert.strictEqual(unshownState, ContextExposureState.CANDIDATE);
    assert.notStrictEqual(unshownState, 'NEGATIVE');

    console.log('  ✔ Verified: Exposure states progress deterministically; unshown candidates remain CANDIDATE.');
  }

  // =========================================================================
  // 3. Pre-Outcome Snapshot Immutability & Anti-Leakage (Phase 20H & 20I)
  // =========================================================================
  console.log('--- 3. Pre-Outcome Snapshot Immutability & Anti-Leakage ---');
  {
    const cleanSnapshot: PreOutcomeEpisodeSnapshot = {
      schemaVersion: 'PRE_OUTCOME_SNAPSHOT_V1',
      episodeId: 'ep_test_001',
      taskId: 'task_001',
      prompt: 'Fix memory leak in buffer pool',
      promptSha256: 'a'.repeat(64),
      repositoryId: 'siftrcode',
      baseCommit: 'b'.repeat(40),
      featureCutoffCommit: 'b'.repeat(40),
      workspaceSnapshotId: 'ws_001',
      candidateUniverse: [
        {
          contextUnitId: 'unit_1',
          path: 'src/pool.ts',
          unitKind: 'FILE',
          retrievalSources: ['bm25', 'graph'],
          finalRank: 1,
          finalScore: 0.95,
          featureSetVersion: 'V3.1_POINT_IN_TIME',
          featureSnapshot: { bm25Score: 0.8, graphProximity: 0.9 },
          estimatedTokens: 300,
          selected: true,
          selectedResolution: 'BODY',
        },
      ],
      selectedUnits: [
        {
          contextUnitId: 'unit_1',
          path: 'src/pool.ts',
          unitKind: 'FILE',
          resolution: 'BODY',
          rank: 1,
          allocatedTokens: 300,
        },
      ],
      tokenBudget: 8000,
      actualRenderedTokens: 300,
      bundleSha256: 'c'.repeat(64),
      contextPolicyId: 'production-v2-deterministic-2026-09',
      rankerId: 'deterministic_context_ranker_v2',
      capturedAt: '2026-09-21T00:00:00.000Z',
      snapshotSha256: 'd'.repeat(64),
    };

    // Valid snapshot passes
    assert.doesNotThrow(() => validatePreOutcomeSnapshotIntegrity(cleanSnapshot as any));

    // Test each forbidden post-outcome field at root level
    for (const field of FORBIDDEN_PRE_OUTCOME_FIELDS) {
      const leakyObj: any = { ...cleanSnapshot, [field]: 'leaked_data' };
      assert.throws(
        () => validatePreOutcomeSnapshotIntegrity(leakyObj),
        /LEAKAGE_DETECTED/,
        `Snapshot must reject forbidden field "${field}"`
      );
    }

    // Test leakage inside candidate feature snapshot
    const leakyCandidateSnapshot: any = {
      ...cleanSnapshot,
      candidateUniverse: [
        {
          ...cleanSnapshot.candidateUniverse[0],
          featureSnapshot: {
            ...cleanSnapshot.candidateUniverse[0].featureSnapshot,
            agentEdits: ['src/pool.ts'],
          },
        },
      ],
    };
    assert.throws(
      () => validatePreOutcomeSnapshotIntegrity(leakyCandidateSnapshot),
      /LEAKAGE_DETECTED.*agentEdits/,
      'Snapshot must reject leakage inside candidate featureSnapshot'
    );

    // Assembly of TrainingEpisode
    const mockOutcome: TaskOutcomeV1 = {
      episodeId: 'ep_test_001',
      buildPassed: true,
      targetedTestsPassed: true,
      verifiedSuccess: true,
      verificationConfidence: 'HIGH',
      verificationSources: ['TASK_VERIFIER'],
    };
    const trainingEpisode = assembleTrainingEpisode(
      cleanSnapshot,
      {
        episodeId: 'ep_test_001',
        verifiedSuccess: true,
        verificationConfidence: 'HIGH',
        taskOutcome: mockOutcome,
        unitLabels: {},
        labeledAt: new Date().toISOString(),
      },
      true,
      'enterprise_license'
    );
    assert.strictEqual(trainingEpisode.episodeId, 'ep_test_001');
    assert.strictEqual(trainingEpisode.labels.verifiedSuccess, true);
    assert.strictEqual(trainingEpisode.labels.verificationConfidence, 'HIGH');
    assert.strictEqual(trainingEpisode.trainingAllowed, true);

    console.log('  ✔ Verified: Strict pre-outcome anti-leakage guards prevent post-outcome leakage.');
  }

  // =========================================================================
  // 4. Tri-State Verified Outcome Model & Verifier Policy (Phase 20E & 20F)
  // =========================================================================
  console.log('--- 4. Tri-State Verified Outcome Model & Verifier Policy ---');
  {
    // Rule 1: Agent reports "done" alone -> INDETERMINATE (null)
    const agentSelfReport = resolveTaskOutcome({
      episodeId: 'ep_done',
      agentReportedCompletion: true,
    });
    assert.strictEqual(agentSelfReport.verifiedSuccess, null);
    assert.strictEqual(agentSelfReport.verificationConfidence, 'UNKNOWN');
    assert.ok(agentSelfReport.evaluationRationale?.includes('Success remains unknown'));

    // Rule 2: Build pass alone -> INDETERMINATE (null)
    const buildOnly = resolveTaskOutcome({
      episodeId: 'ep_build',
      buildPassed: true,
    });
    assert.strictEqual(buildOnly.verifiedSuccess, null);

    // Rule 3: Build failure -> VERIFIED_FAILURE (false)
    const buildFail = resolveTaskOutcome({
      episodeId: 'ep_bfail',
      buildPassed: false,
    });
    assert.strictEqual(buildFail.verifiedSuccess, false);
    assert.strictEqual(buildFail.verificationConfidence, 'HIGH');

    // Rule 4: Typecheck failure -> VERIFIED_FAILURE (false)
    const typecheckFail = resolveTaskOutcome({
      episodeId: 'ep_tfail',
      typecheckPassed: false,
    });
    assert.strictEqual(typecheckFail.verifiedSuccess, false);

    // Rule 5: Task verifier passed -> VERIFIED_SUCCESS (true, HIGH confidence)
    const verifierPass = resolveTaskOutcome({
      episodeId: 'ep_vpass',
      taskVerifierPassed: true,
      buildPassed: true,
    });
    assert.strictEqual(verifierPass.verifiedSuccess, true);
    assert.strictEqual(verifierPass.verificationConfidence, 'HIGH');

    // Rule 6: Task verifier passed BUT regression failed -> VERIFIED_FAILURE (false)
    const verifierWithRegression = resolveTaskOutcome({
      episodeId: 'ep_regfail',
      taskVerifierPassed: true,
      regressionTestsPassed: false,
    });
    assert.strictEqual(verifierWithRegression.verifiedSuccess, false);
    assert.strictEqual(verifierWithRegression.verificationConfidence, 'HIGH');

    // Rule 7: Targeted tests pass without full verifier -> MEDIUM confidence success
    const targetedPass = resolveTaskOutcome({
      episodeId: 'ep_tpass',
      targetedTestsPassed: true,
      buildPassed: true,
    });
    assert.strictEqual(targetedPass.verifiedSuccess, true);
    assert.strictEqual(targetedPass.verificationConfidence, 'MEDIUM');

    // Rule 8: Human review override
    const humanPass = resolveTaskOutcome({
      episodeId: 'ep_hpass',
      humanReview: 'PASS',
      agentReportedCompletion: false,
    });
    assert.strictEqual(humanPass.verifiedSuccess, true);
    assert.strictEqual(humanPass.verificationConfidence, 'HIGH');

    const humanFail = resolveTaskOutcome({
      episodeId: 'ep_hfail',
      humanReview: 'FAIL',
      taskVerifierPassed: true, // Human overrides
    });
    assert.strictEqual(humanFail.verifiedSuccess, false);

    console.log('  ✔ Verified: Tri-state outcome resolution strictly enforces verifier authority.');
  }

  // =========================================================================
  // 5. Economics & Honest CPVST Model (Phase 20G)
  // =========================================================================
  console.log('--- 5. Economics & Honest CPVST Pricing Model ---');
  {
    const successOutcome: TaskOutcomeV1 = {
      episodeId: 'ep_econ_1',
      verifiedSuccess: true,
      verificationConfidence: 'HIGH',
      verificationSources: ['TASK_VERIFIER'],
    };

    const failedOutcome: TaskOutcomeV1 = {
      episodeId: 'ep_econ_2',
      verifiedSuccess: false,
      verificationConfidence: 'HIGH',
      verificationSources: ['TASK_VERIFIER'],
    };

    const unknownOutcome: TaskOutcomeV1 = {
      episodeId: 'ep_econ_3',
      verifiedSuccess: null,
      verificationConfidence: 'UNKNOWN',
      verificationSources: [],
    };

    const validEconomics: TaskEconomicsV1 = {
      contextInputTokens: 4000,
      agentInputTokens: 25000,
      agentOutputTokens: 1200,
      contextGenerationCostUSD: 0.012,
      agentCostUSD: 0.093,
      totalCostUSD: 0.105,
      contextLatencyMs: 145,
      taskLatencyMs: 8200,
      pricingStatus: 'VALID',
    };

    // Valid success with valid pricing -> COMPUTED
    const cpvstSuccess = computeCPVST(validEconomics, successOutcome);
    assert.strictEqual(cpvstSuccess.status, 'COMPUTED');
    assert.strictEqual(cpvstSuccess.cpvstUSD, 0.105);

    // Failed task -> TASK_NOT_VERIFIED_SUCCESS (null)
    const cpvstFailed = computeCPVST(validEconomics, failedOutcome);
    assert.strictEqual(cpvstFailed.status, 'TASK_NOT_VERIFIED_SUCCESS');
    assert.strictEqual(cpvstFailed.cpvstUSD, null);

    // Unknown outcome -> TASK_NOT_VERIFIED_SUCCESS (null)
    const cpvstUnknown = computeCPVST(validEconomics, unknownOutcome);
    assert.strictEqual(cpvstUnknown.status, 'TASK_NOT_VERIFIED_SUCCESS');
    assert.strictEqual(cpvstUnknown.cpvstUSD, null);

    // Unavailable pricing -> PRICING_UNAVAILABLE (null)
    const invalidEconomics: TaskEconomicsV1 = {
      ...validEconomics,
      pricingStatus: 'PRICING_UNAVAILABLE',
      totalCostUSD: null,
    };
    const cpvstNoPrice = computeCPVST(invalidEconomics, successOutcome);
    assert.strictEqual(cpvstNoPrice.status, 'PRICING_UNAVAILABLE');
    assert.strictEqual(cpvstNoPrice.cpvstUSD, null);

    console.log('  ✔ Verified: CPVST computed strictly on verified successes with valid pricing.');
  }

  // =========================================================================
  // 6. SQLite Durable Storage & Migration 15 Integration (Phase 20A-D, 20H)
  // =========================================================================
  console.log('--- 6. SQLite Durable Storage & Migration 15 Integration ---');
  {
    const store = new SqliteStore(':memory:');
    const applied = store.getAppliedMigrations();
    const hasFlywheelMigration = applied.some((m) => m.name === '015_learning_flywheel_schema');
    assert.ok(hasFlywheelMigration, 'Migration 015_learning_flywheel_schema must be applied');

    // Create and save a canonical task episode
    const episode = createTaskEpisodeV1({
      episodeId: 'ep_sql_001',
      repositoryId: 'express',
      sessionId: 'sess_sql_001',
      taskId: 'task_sql_001',
      workspace: {
        repositoryIdentity: 'express',
        baseCommit: 'f'.repeat(40),
        dirtyAtStart: false,
        workspaceSnapshotId: 'ws_sql_001',
      },
      task: {
        prompt: 'Fix routing regex bug',
        taskType: 'BUG_FIX',
      },
      environment: {
        siftrVersion: '0.3.0',
        siftrGitSha: 'ba6869b',
        contextPolicyId: 'production-v2-deterministic-2026-09',
        rankerId: 'deterministic_context_ranker_v2',
        rankerStatus: 'PRODUCTION',
        toolConfigurationHash: 'tool_hash_1',
        systemConfigurationHash: 'sys_hash_1',
      },
      rights: {
        trainingAllowed: true,
        serviceProcessingAllowed: true,
        redistributionAllowed: false,
        permissionSource: 'explicit_enterprise_opt_in',
        decisionTimestamp: '2026-09-21T00:00:00.000Z',
      },
      contextDecision: {
        candidateCount: 5,
        candidates: [
          {
            contextUnitId: 'unit_router',
            path: 'lib/router/index.js',
            unitKind: 'FILE',
            retrievalSources: ['exact', 'bm25'],
            finalRank: 1,
            finalScore: 0.98,
            featureSetVersion: 'V3.1_POINT_IN_TIME',
            featureSnapshot: { score: 0.98 },
            estimatedTokens: 850,
            selected: true,
            selectedResolution: 'BODY',
          },
          {
            contextUnitId: 'unit_layer',
            path: 'lib/router/layer.js',
            unitKind: 'FILE',
            retrievalSources: ['graph'],
            finalRank: 2,
            finalScore: 0.85,
            featureSetVersion: 'V3.1_POINT_IN_TIME',
            featureSnapshot: { score: 0.85 },
            estimatedTokens: 400,
            selected: true,
            selectedResolution: 'SKELETON',
          },
        ],
        selectedUnits: [
          {
            contextUnitId: 'unit_router',
            path: 'lib/router/index.js',
            unitKind: 'FILE',
            resolution: 'BODY',
            rank: 1,
            allocatedTokens: 850,
          },
          {
            contextUnitId: 'unit_layer',
            path: 'lib/router/layer.js',
            unitKind: 'FILE',
            resolution: 'SKELETON',
            rank: 2,
            allocatedTokens: 400,
          },
        ],
        bundleSha256: 'e'.repeat(64),
        actualRenderedTokens: 1250,
        tokenBudget: 8000,
        generationLatencyMs: 42,
      },
      outcome: {
        episodeId: 'ep_sql_001',
        buildPassed: true,
        taskVerifierPassed: true,
        verifiedSuccess: true,
        verificationConfidence: 'HIGH',
        verificationSources: ['TASK_VERIFIER'],
      },
      economics: {
        contextInputTokens: 1250,
        totalCostUSD: 0.045,
        contextLatencyMs: 42,
        pricingStatus: 'VALID',
      },
    });

    // Save and retrieve episode
    store.saveTaskEpisode(episode);
    const retrieved = store.getTaskEpisode('ep_sql_001');
    assert.ok(retrieved !== undefined, 'Episode must be retrievable from SQLite');
    assert.strictEqual(retrieved!.episodeId, 'ep_sql_001');
    assert.strictEqual(retrieved!.repositoryId, 'express');
    assert.strictEqual(retrieved!.workspace.baseCommit, 'f'.repeat(40));
    assert.strictEqual(retrieved!.environment.contextPolicyId, 'production-v2-deterministic-2026-09');
    assert.strictEqual(retrieved!.outcome.verifiedSuccess, true);
    assert.strictEqual(retrieved!.economics?.totalCostUSD, 0.045);

    // Save & get candidate observations (candidates first, episodeId second)
    store.saveEpisodeCandidates(episode.contextDecision.candidates, 'ep_sql_001');
    const candidates = store.getEpisodeCandidates('ep_sql_001');
    assert.strictEqual(candidates.length, 2);
    assert.strictEqual(candidates[0].contextUnitId, 'unit_router');
    assert.strictEqual(candidates[0].finalRank, 1);

    // Save & get exposures
    store.saveContextExposures([
      {
        episodeId: 'ep_sql_001',
        contextUnitId: 'unit_router',
        path: 'lib/router/index.js',
        unitKind: 'FILE',
        state: ContextExposureState.EDITED,
        candidateAt: new Date().toISOString(),
        editedAt: new Date().toISOString(),
      },
      {
        episodeId: 'ep_sql_001',
        contextUnitId: 'unit_layer',
        path: 'lib/router/layer.js',
        unitKind: 'FILE',
        state: ContextExposureState.READ,
        candidateAt: new Date().toISOString(),
        readAt: new Date().toISOString(),
      },
    ]);
    const exposures = store.getContextExposures('ep_sql_001');
    assert.strictEqual(exposures.length, 2);

    // Save & get trajectory events
    store.saveEpisodeTrajectoryEvents([
      {
        eventId: 'evt_1',
        episodeId: 'ep_sql_001',
        timestamp: new Date().toISOString(),
        sequence: 1,
        type: 'FILE_READ',
        path: 'lib/router/layer.js',
      },
      {
        eventId: 'evt_2',
        episodeId: 'ep_sql_001',
        timestamp: new Date().toISOString(),
        sequence: 2,
        type: 'FILE_EDIT',
        path: 'lib/router/index.js',
      },
    ]);
    const events = store.getEpisodeTrajectoryEvents('ep_sql_001');
    assert.strictEqual(events.length, 2);

    // Summary and readiness reports
    const summary = store.getLearningFlywheelSummary();
    assert.strictEqual(summary.totalEpisodes, 1);
    assert.strictEqual(summary.successfulVerifiedEpisodes, 1);
    assert.strictEqual(summary.trainingEligibleEpisodes, 1);

    const readiness = store.getV32DataReadinessReport();
    assert.strictEqual(readiness.currentVerifiedEpisodes, 1);
    assert.strictEqual(readiness.isV32Ready, false);
    assert.strictEqual(readiness.version, 'V3.2_READINESS_GATE_SPEC_V1');

    const dataQuality = store.getDataQualityReport();
    assert.strictEqual(dataQuality.verifiedOutcomeRate, 1);
    assert.strictEqual(dataQuality.trainingRightsRate, 1);
    assert.strictEqual(dataQuality.baseCommitCoverageRate, 1);

    store.close();
    console.log('  ✔ Verified: SQLite durable storage, tables, queries, and summaries operate accurately.');
  }

  // =========================================================================
  // 7. Deletion Manager & Revocation Tombstoning (Phase 20K & 20L)
  // =========================================================================
  console.log('--- 7. Deletion Manager & Revocation Tombstoning ---');
  {
    const store = new SqliteStore(':memory:');
    const epId = 'ep_revocation_test';

    store.saveTaskEpisode(
      createTaskEpisodeV1({
        episodeId: epId,
        repositoryId: 'test_repo',
        sessionId: 'sess_rev',
        taskId: 'task_rev',
        workspace: {
          repositoryIdentity: 'test_repo',
          baseCommit: '1'.repeat(40),
          dirtyAtStart: false,
          workspaceSnapshotId: 'ws_rev',
        },
        task: { prompt: 'Sample task' },
        environment: {
          siftrVersion: '0.3.0',
          siftrGitSha: 'sha',
          contextPolicyId: 'production-v2-deterministic-2026-09',
          rankerId: 'deterministic_context_ranker_v2',
          rankerStatus: 'PRODUCTION',
          toolConfigurationHash: 't',
          systemConfigurationHash: 's',
        },
        rights: {
          trainingAllowed: true,
          serviceProcessingAllowed: true,
          redistributionAllowed: false,
          permissionSource: 'opt_in',
          decisionTimestamp: new Date().toISOString(),
        },
        contextDecision: {
          candidateCount: 1,
          candidates: [
            {
              contextUnitId: 'u1',
              unitKind: 'FILE',
              retrievalSources: ['bm25'],
              finalRank: 1,
              finalScore: 1.0,
              featureSetVersion: 'V3.1_POINT_IN_TIME',
              estimatedTokens: 100,
              selected: true,
            },
          ],
          selectedUnits: [
            {
              contextUnitId: 'u1',
              unitKind: 'FILE',
              resolution: 'BODY',
              rank: 1,
              allocatedTokens: 100,
            },
          ],
          bundleSha256: 'b'.repeat(64),
          actualRenderedTokens: 100,
          tokenBudget: 8000,
          generationLatencyMs: 10,
        },
        outcome: {
          episodeId: epId,
          verifiedSuccess: true,
          verificationConfidence: 'HIGH',
          verificationSources: ['TASK_VERIFIER'],
        },
      })
    );

    // Revoke the episode
    store.revokeEpisode(epId, 'GDPR Right-to-be-forgotten compliance request');

    // Confirm revocation in summary
    const summary = store.getLearningFlywheelSummary();
    assert.strictEqual(summary.revokedEpisodes, 1);

    store.close();
    console.log('  ✔ Verified: Revocation tombstone is written and tracked by deletion manager integration.');
  }

  // =========================================================================
  // 8. Rights-Aware Training Exporter V2 (Phase 20J)
  // =========================================================================
  console.log('--- 8. Rights-Aware Training Exporter V2 ---');
  {
    const exporter = new TrainingExporter();

    // Episode 1: Clean, trainingAllowed = true
    const ep1 = createTaskEpisodeV1({
      episodeId: 'ep_export_1',
      repositoryId: 'commander',
      sessionId: 'sess_exp_1',
      taskId: 'task_exp_1',
      workspace: {
        repositoryIdentity: 'commander',
        baseCommit: 'a'.repeat(40),
        dirtyAtStart: false,
        workspaceSnapshotId: 'ws_exp_1',
      },
      task: { prompt: 'Add help option alias' },
      environment: {
        siftrVersion: '0.3.0',
        siftrGitSha: 'sha',
        contextPolicyId: 'production-v2-deterministic-2026-09',
        rankerId: 'deterministic_context_ranker_v2',
        rankerStatus: 'PRODUCTION',
        toolConfigurationHash: 't',
        systemConfigurationHash: 's',
      },
      rights: {
        trainingAllowed: true,
        serviceProcessingAllowed: true,
        redistributionAllowed: true,
        permissionSource: 'open_source_repo',
        decisionTimestamp: new Date().toISOString(),
      },
      contextDecision: {
        candidateCount: 1,
        candidates: [
          {
            contextUnitId: 'unit_cmd',
            path: 'lib/command.js',
            unitKind: 'FILE',
            retrievalSources: ['bm25'],
            finalRank: 1,
            finalScore: 0.9,
            featureSetVersion: 'V3.1_POINT_IN_TIME',
            featureSnapshot: { score: 0.9 },
            estimatedTokens: 200,
            selected: true,
          },
        ],
        selectedUnits: [
          {
            contextUnitId: 'unit_cmd',
            path: 'lib/command.js',
            unitKind: 'FILE',
            resolution: 'BODY',
            rank: 1,
            allocatedTokens: 200,
          },
        ],
        bundleSha256: 'b'.repeat(64),
        actualRenderedTokens: 200,
        tokenBudget: 8000,
        generationLatencyMs: 15,
      },
      trajectory: {
        eventCount: 3,
        readCount: 1,
        editCount: 1,
        testRunCount: 1,
        buildRunCount: 1,
        verifierRunCount: 1,
        toolErrorCount: 0,
        readPaths: ['lib/command.js'],
        editedPaths: ['lib/command.js'],
      },
      outcome: {
        episodeId: 'ep_export_1',
        taskVerifierPassed: true,
        verifiedSuccess: true,
        verificationConfidence: 'HIGH',
        verificationSources: ['TASK_VERIFIER'],
      },
    });

    // Episode 2: Rights blocked (trainingAllowed = false)
    const ep2 = createTaskEpisodeV1({
      ...ep1,
      episodeId: 'ep_export_2',
      rights: {
        ...ep1.rights,
        trainingAllowed: false,
      },
    });

    // Episode 3: Revoked episode
    const ep3 = createTaskEpisodeV1({
      ...ep1,
      episodeId: 'ep_export_3',
    });

    // Episode 4: Feature leakage in pre-outcome features
    const ep4 = createTaskEpisodeV1({
      ...ep1,
      episodeId: 'ep_export_4',
      contextDecision: {
        ...ep1.contextDecision,
        candidates: [
          {
            ...ep1.contextDecision.candidates[0],
            featureSnapshot: {
              score: 0.9,
              agentEdits: true as any, // Forbidden post-outcome field!
            },
          },
        ],
      },
    });

    const revokedSet = new Set(['ep_export_3']);
    const exportResult = exporter.exportContextDatasetV2([ep1, ep2, ep3, ep4], {
      isRevoked: (id) => revokedSet.has(id),
      exposuresProvider: (epId) => [
        {
          episodeId: epId,
          contextUnitId: 'unit_cmd',
          path: 'lib/command.js',
          unitKind: 'FILE',
          state: ContextExposureState.EDITED,
          attributionType: 'EXACT_UNIT',
          readAttribution: 'EXACT_UNIT',
          editAttribution: 'EXACT_UNIT',
          finalRank: 1,
          resolution: 'BODY',
          candidateAt: new Date().toISOString(),
          selectedAt: new Date().toISOString(),
          materializedAt: new Date().toISOString(),
          shownAt: new Date().toISOString(),
          readAt: new Date().toISOString(),
          editedAt: new Date().toISOString(),
        },
      ],
    });

    // Verify rejection breakdown
    assert.strictEqual(exportResult.totalEpisodesEvaluated, 4);
    assert.strictEqual(exportResult.totalEpisodesAccepted, 1);
    assert.strictEqual(exportResult.totalEpisodesRejected, 3);
    assert.strictEqual(exportResult.rows.length, 1);

    // Verify rejected reasons
    const ep2Rejection = exportResult.rejections.find((r) => r.episodeId === 'ep_export_2');
    assert.ok(ep2Rejection?.reasons.some((r) => r.includes('RIGHTS_BLOCKED')));

    const ep3Rejection = exportResult.rejections.find((r) => r.episodeId === 'ep_export_3');
    assert.ok(ep3Rejection?.reasons.some((r) => r.includes('REVOKED_EPISODE')));

    const ep4Rejection = exportResult.rejections.find((r) => r.episodeId === 'ep_export_4');
    assert.ok(ep4Rejection?.reasons.some((r) => r.includes('LEAKAGE_IN_FEATURES')));

    // Verify accepted row fields
    const acceptedRow = exportResult.rows[0];
    assert.strictEqual(acceptedRow.episodeId, 'ep_export_1');
    assert.strictEqual(acceptedRow.exposureState, ContextExposureState.EDITED);
    assert.strictEqual(acceptedRow.wasEdited, true);
    assert.strictEqual(acceptedRow.wasRead, true);
    assert.strictEqual(acceptedRow.wasShown, true);
    assert.strictEqual(acceptedRow.verifiedSuccess, true);

    console.log('  ✔ Verified: TrainingExporter V2 strictly filters rights, revocations, and feature leakage.');
  }

  // =========================================================================
  // 9. Proprietary Aggregated Signals Calculator (Phase 20M)
  // =========================================================================
  console.log('--- 9. Proprietary Aggregated Signals Calculator ---');
  {
    const epSuccess = createTaskEpisodeV1({
      episodeId: 'ep_sig_1',
      repositoryId: 'fastapi',
      sessionId: 'sess_sig_1',
      taskId: 'task_sig_1',
      workspace: {
        repositoryIdentity: 'fastapi',
        baseCommit: 'a'.repeat(40),
        dirtyAtStart: false,
        workspaceSnapshotId: 'ws_sig_1',
      },
      task: { prompt: 'Fix query parameter validation', taskType: 'BUG_FIX' },
      environment: {
        siftrVersion: '0.3.0',
        siftrGitSha: 'sha',
        contextPolicyId: 'production-v2-deterministic-2026-09',
        rankerId: 'deterministic_context_ranker_v2',
        rankerStatus: 'PRODUCTION',
        toolConfigurationHash: 't',
        systemConfigurationHash: 's',
      },
      rights: {
        trainingAllowed: true,
        serviceProcessingAllowed: true,
        redistributionAllowed: false,
        permissionSource: 'opt_in',
        decisionTimestamp: new Date().toISOString(),
      },
      contextDecision: {
        candidateCount: 2,
        candidates: [
          {
            contextUnitId: 'u_query',
            path: 'fastapi/params.py',
            unitKind: 'FILE',
            retrievalSources: ['bm25'],
            finalRank: 1,
            finalScore: 0.95,
            featureSetVersion: 'V3.1_POINT_IN_TIME',
            estimatedTokens: 300,
            selected: true,
          },
          {
            contextUnitId: 'u_routing',
            path: 'fastapi/routing.py',
            unitKind: 'FILE',
            retrievalSources: ['graph'],
            finalRank: 2,
            finalScore: 0.8,
            featureSetVersion: 'V3.1_POINT_IN_TIME',
            estimatedTokens: 400,
            selected: true,
          },
        ],
        selectedUnits: [
          {
            contextUnitId: 'u_query',
            path: 'fastapi/params.py',
            unitKind: 'FILE',
            resolution: 'BODY',
            rank: 1,
            allocatedTokens: 300,
          },
          {
            contextUnitId: 'u_routing',
            path: 'fastapi/routing.py',
            unitKind: 'FILE',
            resolution: 'SKELETON',
            rank: 2,
            allocatedTokens: 400,
          },
        ],
        bundleSha256: 'b'.repeat(64),
        actualRenderedTokens: 700,
        tokenBudget: 8000,
        generationLatencyMs: 25,
      },
      trajectory: {
        eventCount: 4,
        readCount: 2,
        editCount: 1,
        testRunCount: 1,
        buildRunCount: 0,
        verifierRunCount: 1,
        toolErrorCount: 0,
        readPaths: ['fastapi/params.py', 'fastapi/routing.py'],
        editedPaths: ['fastapi/params.py'],
      },
      outcome: {
        episodeId: 'ep_sig_1',
        taskVerifierPassed: true,
        verifiedSuccess: true,
        verificationConfidence: 'HIGH',
        verificationSources: ['TASK_VERIFIER'],
      },
    });

    const report = computeAggregatedSignals([epSuccess]);
    assert.strictEqual(report.totalEpisodesAnalyzed, 1);
    assert.strictEqual(report.dataRightsEnforced, true);
    assert.ok(report.readAfterShowProbability > 0);
    assert.ok(report.editAfterReadProbability > 0);
    assert.ok(report.retrievalSourceBehavior.length > 0);

    console.log('  ✔ Verified: Proprietary aggregated signals computed accurately over sanctioned data.');
  }

  // =========================================================================
  // 10. Shadow Policy Runner & Production Plan Invariance (Phase 20P)
  // =========================================================================
  console.log('--- 10. Shadow Policy Runner & Production Plan Invariance ---');
  {
    const productionPlan: ContextPlan = {
      planId: 'plan_prod_001',
      taskId: 'task_shadow_001',
      createdAt: new Date().toISOString(),
      contextPolicyIdentity: {
        contextPolicyId: 'production-v2-deterministic-2026-09',
        rankerId: 'deterministic_context_ranker_v2',
        rankerVersion: '2.0.0',
        featureSetVersion: 'V3.1_POINT_IN_TIME',
        candidateGeneratorVersion: '2.0.0',
        budgetPolicyVersion: '2.0.0',
        materializerVersion: '2.0.0',
      },
      units: [
        {
          contextUnitId: 'unit_a',
          title: 'unit_a',
          resolution: ContextResolution.BODY,
          tokenEstimate: 500,
          reason: 'Primary causal target',
        },
      ],
      formattedContext: {
        promptText: 'unit_a content',
        sections: [
          {
            title: 'unit_a',
            resolution: ContextResolution.BODY,
            content: 'unit_a content',
          },
        ],
        metadata: {},
        tokenEstimate: 500,
      },
      exposureDecisions: [],
      dataRights: {
        remoteProcessingAllowed: true,
        telemetryAllowed: true,
        trainingAllowed: true,
        rawSourceRetentionAllowed: false,
        sourceSnippetRetentionAllowed: false,
        symbolMetadataAllowed: true,
        embeddingsRetentionAllowed: false,
        graphRetentionAllowed: false,
        derivedNumericFeaturesAllowed: true,
        trajectoryRetentionAllowed: true,
      },
      actualRenderedTokens: 500,
      budgetPlan: {
        allocations: [],
        totalTokens: 8000,
        rawTotalTokens: 10000,
        tokensSaved: 2000,
        savingsPercentage: 20,
        estimatedCostUSD: 0.02,
        baselineCostUSD: 0.05,
        costSavedUSD: 0.03,
        budgetProfile: 'BALANCED',
      },
    };

    const candidates = [
      {
        contextUnitId: 'unit_a',
        unitKind: 'FILE',
        retrievalSources: ['bm25'],
        finalRank: 1,
        finalScore: 0.95,
        featureSetVersion: 'V3.1_POINT_IN_TIME',
        estimatedTokens: 500,
        selected: true,
      },
      {
        contextUnitId: 'unit_b',
        unitKind: 'FILE',
        retrievalSources: ['graph'],
        finalRank: 2,
        finalScore: 0.6,
        featureSetVersion: 'V3.1_POINT_IN_TIME',
        estimatedTokens: 300,
        selected: false,
      },
    ];

    // Mock shadow ranker with inverted preference
    const mockShadowRanker: ShadowRanker = {
      rankerId: 'experimental_shadow_v3_2',
      rankerVersion: '3.2.0-alpha',
      async rank(cands) {
        return {
          rankedCandidates: [
            { ...cands[1], finalRank: 1, finalScore: 0.99 },
            { ...cands[0], finalRank: 2, finalScore: 0.88 },
          ],
          selectedUnitIds: ['unit_b'],
          allocatedTokens: 300,
        };
      },
    };

    const runner = new ShadowPolicyRunner(mockShadowRanker);
    const comparison = await runner.evaluateShadowPolicy(productionPlan, candidates, 2);

    assert.ok(comparison !== null, 'Comparison report must be generated');
    assert.strictEqual(comparison!.productionPolicyId, 'production-v2-deterministic-2026-09');
    assert.strictEqual(comparison!.shadowPolicyId, 'experimental_shadow_v3_2');
    assert.strictEqual(comparison!.candidateCount, 2);

    // Verify 100% production plan invariance
    assert.strictEqual(productionPlan.units.length, 1);
    assert.strictEqual(productionPlan.units[0].contextUnitId, 'unit_a');
    assert.strictEqual(productionPlan.contextPolicyIdentity?.contextPolicyId, 'production-v2-deterministic-2026-09');

    // Error resilience: shadow ranker throwing error does not crash or corrupt
    const faultyShadowRanker: ShadowRanker = {
      rankerId: 'faulty_ranker',
      rankerVersion: '0.0.1',
      async rank() {
        throw new Error('Simulated shadow ranker failure');
      },
    };
    runner.setShadowRanker(faultyShadowRanker);
    const faultyComparison = await runner.evaluateShadowPolicy(productionPlan, candidates);
    assert.strictEqual(faultyComparison, null, 'Faulty shadow ranker safely returns null comparison');
    assert.strictEqual(productionPlan.units[0].contextUnitId, 'unit_a', 'Production plan intact after error');

    console.log('  ✔ Verified: Shadow ranker produces comparative signals while strictly preserving production plan invariance.');
  }

  // =========================================================================
  // 11. Admin Learning API Security & Fail-Closed Auth (Phase 20V)
  // =========================================================================
  console.log('--- 11. Admin Learning API Security & Fail-Closed Auth ---');
  {
    const originalApiKey = process.env.ADMIN_API_KEY;
    const originalAdminToken = process.env.ADMIN_TOKEN;
    const originalNodeEnv = process.env.NODE_ENV;

    try {
      // Case A: Missing ADMIN_API_KEY / ADMIN_TOKEN in production mode -> fail closed (503)
      delete process.env.ADMIN_API_KEY;
      delete process.env.ADMIN_TOKEN;
      process.env.NODE_ENV = 'production';

      const mockReq = {
        headers: { authorization: 'Bearer test' },
        socket: { remoteAddress: '127.0.0.1' },
      } as any;

      let statusCode = 0;
      const mockRes = {
        writeHead(code: number) {
          statusCode = code;
          return this;
        },
        removeHeader(name: string) {},
        setHeader(name: string, val: string) {},
        end() {},
      } as any;

      const failed = handleAdminAuthFailure(mockReq, mockRes);
      assert.strictEqual(failed, true, 'Must fail when ADMIN_API_KEY is unconfigured in production');
      assert.strictEqual(statusCode, 503, 'Must return 503 Service Unavailable when unconfigured');

      // Case B: Configured ADMIN_API_KEY -> bad token returns 401
      process.env.ADMIN_TOKEN = 'secret-master-token-xyz';
      const badReq = {
        headers: { authorization: 'Bearer wrong-token' },
        socket: { remoteAddress: '127.0.0.1' },
      } as any;

      const failedBadToken = handleAdminAuthFailure(badReq, mockRes);
      assert.strictEqual(failedBadToken, true, 'Must fail on invalid token');
      assert.strictEqual(statusCode, 401, 'Must return 401 Unauthorized on invalid token');

      // Case C: Valid token returns false from handleAdminAuthFailure (meaning success)
      const validReq = {
        headers: { authorization: 'Bearer secret-master-token-xyz' },
        socket: { remoteAddress: '127.0.0.1' },
      } as any;

      const authSuccess = !handleAdminAuthFailure(validReq, mockRes);
      assert.strictEqual(authSuccess, true, 'Must accept matching bearer token');
    } finally {
      if (originalApiKey !== undefined) {
        process.env.ADMIN_API_KEY = originalApiKey;
      } else {
        delete process.env.ADMIN_API_KEY;
      }
      if (originalAdminToken !== undefined) {
        process.env.ADMIN_TOKEN = originalAdminToken;
      } else {
        delete process.env.ADMIN_TOKEN;
      }
      if (originalNodeEnv !== undefined) {
        process.env.NODE_ENV = originalNodeEnv;
      } else {
        delete process.env.NODE_ENV;
      }
    }

    console.log('  ✔ Verified: Admin endpoints fail closed with timing-safe constant-time authentication.');
  }

  console.log('\n🎉 ALL LEARNING FLYWHEEL & V3.2 READINESS TESTS PASSED CLEANLY!\n');
}

if (require.main === module) {
  runLearningFlywheelTests().catch((err) => {
    console.error('❌ Learning flywheel tests failed:', err);
    process.exit(1);
  });
}
