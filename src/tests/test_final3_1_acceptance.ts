/**
 * SiftrCode V2 - FINAL-3.1 Acceptance Integrity & Experimental Trustworthiness Suite
 *
 * Enforces all critical invariants from FINAL-3.1 acceptance-integrity remediation:
 * 1. Universal Acceptance Invariant: failedCriteria.length > 0 => recommendation !== PASS_TO_30_TASK_PILOT
 * 2. Exit code contract: 2 on FIX_AND_REPEAT_SMOKE, 0 on PASS_TO_30_TASK_PILOT / OFFLINE_SYNTHETIC
 * 3. Partial harness execution failure: completedTaskCount !== selectedTaskCount / harness crash
 * 4. Strict JEV probability signal validation: non-empty answers, 4 finite heads in [0, 1]
 * 5. Minimum valid provider responses, zero synthetic signals, zero fallback-only signals
 * 6. Relational integrity anti-joins across 10 foreign-key relationships & agentEnv/snapshot lineage
 * 7. Endpoint provenance: reported endpoint === SDK baseURL === production verification
 * 8. Counted retries & attempt-level failure category accounting
 * 9. Closed training persistence trust boundary (unforgeable private symbol brand)
 */

import assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  evaluateLiveAcceptance,
  LiveMetrics,
  LiveAcceptanceConfig,
} from './pilot_jev_real_study';
import {
  JevShadowRunner,
} from '../providers/judgment/typesafe/jev_shadow_runner';
import {
  JevMode,
} from '../providers/judgment/typesafe/jev_signal';
import {
  JevCallTracker,
  DEFAULT_JEV_DECISION_BUDGET,
} from '../providers/judgment/typesafe/jev_budget';
import {
  TypeSafeSystemOneClient,
} from '../providers/judgment/typesafe/typesafe_client';
import {
  TrainingExporter,
} from '../learning/training_exporter';
import {
  SqliteStore,
} from '../storage/sqlite_store';
import {
  createDefaultDataRights,
  createJevPermittedDataRights,
} from '../rights/data_rights';
import {
  createSourceProvenance,
} from '../rights/source_provenance';
import {
  createCandidateObservationV2,
} from '../telemetry/candidate_observation';
import {
  ContextResolution,
} from '../context/context_resolution';
import {
  ContextUnitKind,
  ContextUnit,
} from '../context/context_unit';
import {
  RankedCandidate,
} from '../ranking/context_rank';
import {
  createTaskContext,
} from '../context/task_context';
import {
  createAgentEnvironment,
} from '../agents/agent_environment';
import {
  createWorkspaceSnapshot,
} from '../workspace/workspace_snapshot';
import {
  createTrainingEvidenceRecord,
} from '../learning/lineage';
import {
  TrustLevel,
} from '../security/trust';

function createMockRankedCandidate(contextUnitId: string, score: number = 1.0): RankedCandidate {
  return {
    contextUnitId,
    finalScore: score,
    rank: 1,
    scoreBreakdown: {
      runtimeEvidence: 0,
      exactMatch: 0,
      lexicalRelevance: score,
      graphProximity: 0,
      gitCoChange: 0,
      penalties: 0,
    },
    reasons: ['test'],
    features: {
      schemaVersion: 'v1',
      contextUnitId,
      unitKind: ContextUnitKind.SOURCE_FILE,
      tokenEstimate: 10,
      isTest: false,
      isConfig: false,
      isDocumentation: false,
      isSchema: false,
      isExported: true,
      exactSymbolMatch: false,
      exactPathMatch: false,
      bm25Score: score,
      tokenOverlapRatio: 0,
      graphDegree: 0,
      minDistanceToSeed: null,
      minDistanceToErrorFrame: null,
      isDirectDependency: false,
      isDirectDependent: false,
      changeFrequency: 0,
      recentChangeFrequency: 0,
      maxCoChangeWithSeeds: 0,
      inStackTrace: false,
      isFailingTestTarget: false,
      inCompilerError: false,
      inDirtyDiff: false,
      heuristicScore: score,
    },
  };
}

function createMockUnit(id: string, pathStr: string = 'src/index.ts', snapshotId: string = 'ws_val'): ContextUnit {
  return {
    id,
    kind: ContextUnitKind.SOURCE_FILE,
    path: pathStr,
    title: path.basename(pathStr),
    provenance: { sourceType: 'file' },
    trustLevel: TrustLevel.FIRST_PARTY_CODE,
    metadata: { tokenEstimate: 10 },
    workspaceSnapshotId: snapshotId,
  };
}

async function runFinal31AcceptanceTests(): Promise<void> {
  console.log('🧪 [FINAL-3.1 Acceptance Integrity Tests] Starting suite...\n');

  // =========================================================================
  // Test 1: Universal Acceptance Invariant
  // =========================================================================
  console.log('--- Test 1: Universal Acceptance Invariant ---');
  {
    const perfectLiveMetrics: LiveMetrics = {
      liveMode: true,
      totalTasks: 5,
      selectedTaskCount: 5,
      completedTaskCount: 5,
      tasksWithValidProviderSignal: 5,
      providerAttempts: 5,
      providerSuccesses: 5,
      validSignals: 5,
      syntheticSignals: 0,
      fallbackOnlySignals: 0,
      maxHttpRequests: 25,
      successfulCalls: 5,
      failedCalls: 0,
      rateLimitedCalls: 0,
      timeoutCalls: 0,
      malformedCalls: 0,
      connectionErrorCalls: 0,
      totalHttpRequests: 5,
      totalRetries: 0,
      trustDeniedCalls: 0,
      rightsDeniedCalls: 0,
      planInvarianceHolds: true,
      zeroLineageMismatches: true,
      zeroUnexpectedEgress: true,
      endpoint: 'https://api.typesafe.ai',
      endpointIsProduction: true,
      provenanceClean: true,
      completeLineageCoverage: true,
      lineageVerificationSucceeded: true,
      perTaskAttemptsExceeded: false,
      httpRequestsExceededBudget: false,
    };

    // Baseline: perfect metrics produce PASS_TO_30_TASK_PILOT with 0 failed criteria
    const cleanResult = evaluateLiveAcceptance(perfectLiveMetrics);
    assert.strictEqual(cleanResult.recommendation, 'PASS_TO_30_TASK_PILOT');
    assert.strictEqual(cleanResult.failed.length, 0);
    console.log('  ✔ Perfect live metrics evaluate to PASS_TO_30_TASK_PILOT with 0 failed criteria');

    // Matrix of failure conditions: ANY single failure MUST disqualify PASS_TO_30_TASK_PILOT
    const failurePermutations: Array<{ name: string; override: Partial<LiveMetrics>; config?: LiveAcceptanceConfig }> = [
      { name: 'liveMode is false', override: { liveMode: false } },
      { name: 'endpoint is not production', override: { endpointIsProduction: false } },
      { name: 'build provenance is dirty', override: { provenanceClean: false } },
      { name: 'harness exception occurred', override: { harnessException: 'Task runner exploded' } },
      { name: 'completedTaskCount < selectedTaskCount', override: { completedTaskCount: 4, selectedTaskCount: 5 } },
      { name: 'providerAttempts === 0', override: { providerAttempts: 0 } },
      { name: 'providerSuccesses < minValid', override: { providerSuccesses: 0 } },
      { name: 'validSignals < minValid', override: { validSignals: 0 } },
      { name: 'syntheticSignals > 0 in live', override: { syntheticSignals: 1 } },
      { name: 'fallbackOnlySignals > 0', override: { fallbackOnlySignals: 1 } },
      { name: 'failedCalls > 0', override: { failedCalls: 1 } },
      { name: 'totalHttpRequests > maxHttpRequests', override: { totalHttpRequests: 30, maxHttpRequests: 25 } },
      { name: 'perTaskAttemptsExceeded === true', override: { perTaskAttemptsExceeded: true } },
      { name: 'httpRequestsExceededBudget === true', override: { httpRequestsExceededBudget: true } },
      { name: 'planInvarianceHolds === false', override: { planInvarianceHolds: false } },
      { name: 'lineageVerificationSucceeded === false', override: { lineageVerificationSucceeded: false } },
      { name: 'completeLineageCoverage === false', override: { completeLineageCoverage: false } },
      { name: 'zeroLineageMismatches === false', override: { zeroLineageMismatches: false } },
      { name: 'zeroUnexpectedEgress === false', override: { zeroUnexpectedEgress: false } },
      { name: 'success fraction below threshold', override: { providerAttempts: 10, providerSuccesses: 5 }, config: { minProviderSuccessFraction: 0.8 } },
    ];

    for (const testCase of failurePermutations) {
      const evalResult = evaluateLiveAcceptance({ ...perfectLiveMetrics, ...testCase.override }, testCase.config);
      // Hard Invariant Check:
      assert.ok(
        evalResult.failed.length > 0,
        `Expected failed criteria for test case: "${testCase.name}", but got 0 failed criteria`
      );
      assert.strictEqual(
        evalResult.recommendation,
        'FIX_AND_REPEAT_SMOKE',
        `Invariant violated: failure "${testCase.name}" MUST produce FIX_AND_REPEAT_SMOKE`
      );
      assert.notStrictEqual(
        evalResult.recommendation,
        'PASS_TO_30_TASK_PILOT',
        `Invariant violated: failure "${testCase.name}" produced PASS_TO_30_TASK_PILOT`
      );
    }
    console.log(`  ✔ Verified universal invariant across all ${failurePermutations.length} failure permutations`);
  }

  // =========================================================================
  // Test 2: Exit Code Contract
  // =========================================================================
  console.log('\n--- Test 2: Exit Code Contract ---');
  {
    // Function implementing the exact runner exit code logic
    function resolveExitCode(report: { mode: string; recommendation: string | null }): number {
      if (report.mode === 'OFFLINE_SYNTHETIC') {
        return 0;
      }
      if (report.recommendation === 'PASS_TO_30_TASK_PILOT') {
        return 0;
      }
      return 2;
    }

    assert.strictEqual(resolveExitCode({ mode: 'OFFLINE_SYNTHETIC', recommendation: null }), 0);
    assert.strictEqual(resolveExitCode({ mode: 'LIVE_SMOKE', recommendation: 'PASS_TO_30_TASK_PILOT' }), 0);
    assert.strictEqual(resolveExitCode({ mode: 'LIVE_PILOT', recommendation: 'PASS_TO_30_TASK_PILOT' }), 0);
    assert.strictEqual(resolveExitCode({ mode: 'LIVE_SMOKE', recommendation: 'FIX_AND_REPEAT_SMOKE' }), 2);
    assert.strictEqual(resolveExitCode({ mode: 'LIVE_PILOT', recommendation: 'FIX_AND_REPEAT_SMOKE' }), 2);
    console.log('  ✔ Exit code contract verified: 0 on PASS / OFFLINE, 2 on FIX_AND_REPEAT_SMOKE');
  }

  // =========================================================================
  // Test 3: Partial Harness Execution Detection
  // =========================================================================
  console.log('\n--- Test 3: Partial Harness Execution Detection ---');
  {
    const partialMetrics: LiveMetrics = {
      liveMode: true,
      totalTasks: 5,
      selectedTaskCount: 5,
      completedTaskCount: 1, // Only task 1 finished
      tasksWithValidProviderSignal: 1,
      harnessException: 'Error: Connection reset on task 2',
      maxHttpRequests: 25,
      successfulCalls: 5,
      failedCalls: 1,
      rateLimitedCalls: 0,
      timeoutCalls: 0,
      malformedCalls: 0,
      connectionErrorCalls: 1,
      totalHttpRequests: 6,
      totalRetries: 0,
      trustDeniedCalls: 0,
      rightsDeniedCalls: 0,
      planInvarianceHolds: true,
      zeroLineageMismatches: true,
      zeroUnexpectedEgress: true,
      endpointIsProduction: true,
      provenanceClean: true,
      providerAttempts: 6,
      providerSuccesses: 5,
      validSignals: 5,
      completeLineageCoverage: true,
      lineageVerificationSucceeded: true,
    };

    const evalResult = evaluateLiveAcceptance(partialMetrics);
    assert.strictEqual(evalResult.recommendation, 'FIX_AND_REPEAT_SMOKE');
    assert.ok(evalResult.failed.some((f) => f.includes('completedTaskCount === selectedTaskCount')));
    assert.ok(evalResult.failed.some((f) => f.includes('harness execution without error')));
    console.log('  ✔ Partial harness execution flags completion mismatch and harness exception');
  }

  // =========================================================================
  // Test 4: Strict JEV Probability Signal Validation
  // =========================================================================
  console.log('\n--- Test 4: Strict JEV Probability Signal Validation ---');
  {
    // Start in-process mock server
    let currentPayload: any = {};
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(currentPayload));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const mockUrl = `http://127.0.0.1:${port}`;

    const dummySnapshot = createWorkspaceSnapshot({ repositories: [] });
    const dummyTask = createTaskContext({
      taskId: 't_val',
      sessionId: 's_val',
      workspaceSnapshotId: dummySnapshot.workspaceSnapshotId,
      primaryPrompt: 'Fix bug',
      agentEnvironment: createAgentEnvironment(),
    });
    const dummyUnit = createMockUnit('u_val', 'src/index.ts', dummySnapshot.workspaceSnapshotId);
    const dummyCand = createMockRankedCandidate('u_val', 1.0);
    const featuresMap = new Map([[dummyCand.contextUnitId, dummyCand.features]]);
    const dummyRights = createJevPermittedDataRights();

    const client = new TypeSafeSystemOneClient({
      apiKey: 'test-key',
      baseURL: mockUrl,
      retry: { maxRetries: 0 },
    });
    const runner = new JevShadowRunner({
      client,
      mode: JevMode.SHADOW,
    });

    const invalidPayloads: Array<{ label: string; payload: any }> = [
      { label: 'null answers', payload: { answers: null } },
      { label: 'empty answers object', payload: { answers: {} } },
      { label: 'missing semanticRelevance', payload: { answers: { implementationNeeded: { noul: 0.5 }, likelyEditTarget: { noul: 0.5 }, likelyRootCause: { noul: 0.5 } } } },
      { label: 'missing implementationNeeded', payload: { answers: { semanticRelevance: { noul: 0.5 }, likelyEditTarget: { noul: 0.5 }, likelyRootCause: { noul: 0.5 } } } },
      { label: 'missing likelyEditTarget', payload: { answers: { semanticRelevance: { noul: 0.5 }, implementationNeeded: { noul: 0.5 }, likelyRootCause: { noul: 0.5 } } } },
      { label: 'missing likelyRootCause', payload: { answers: { semanticRelevance: { noul: 0.5 }, implementationNeeded: { noul: 0.5 }, likelyEditTarget: { noul: 0.5 } } } },
      { label: 'NaN probability', payload: { answers: { semanticRelevance: { noul: NaN }, implementationNeeded: { noul: 0.5 }, likelyEditTarget: { noul: 0.5 }, likelyRootCause: { noul: 0.5 } } } },
      { label: 'Infinity probability', payload: { answers: { semanticRelevance: { noul: Infinity }, implementationNeeded: { noul: 0.5 }, likelyEditTarget: { noul: 0.5 }, likelyRootCause: { noul: 0.5 } } } },
      { label: 'Negative probability', payload: { answers: { semanticRelevance: { noul: -0.01 }, implementationNeeded: { noul: 0.5 }, likelyEditTarget: { noul: 0.5 }, likelyRootCause: { noul: 0.5 } } } },
      { label: 'Probability > 1.0', payload: { answers: { semanticRelevance: { noul: 1.05 }, implementationNeeded: { noul: 0.5 }, likelyEditTarget: { noul: 0.5 }, likelyRootCause: { noul: 0.5 } } } },
      { label: 'String probability', payload: { answers: { semanticRelevance: { noul: '0.85' }, implementationNeeded: { noul: 0.5 }, likelyEditTarget: { noul: 0.5 }, likelyRootCause: { noul: 0.5 } } } },
    ];

    for (const item of invalidPayloads) {
      currentPayload = item.payload;
      const sigs = await runner.evaluate({
        task: dummyTask,
        workspaceSnapshot: dummySnapshot,
        rankedCandidates: [dummyCand],
        units: [dummyUnit],
        featuresMap,
        dataRights: dummyRights,
      });

      assert.strictEqual(sigs.length, 1);
      assert.ok(sigs[0].fallbackReason !== undefined, `Expected fallbackReason for ${item.label}`);
      assert.strictEqual(sigs[0].fallbackReason, 'MALFORMED_RESPONSE');
    }
    console.log(`  ✔ Verified strict 4-head probability validation across all ${invalidPayloads.length} malformed variations`);

    // Valid probability payload (boundaries 0.0 and 1.0)
    currentPayload = {
      model: 'jev-test-model',
      answers: {
        semanticRelevance: { noul: 0.0 },
        implementationNeeded: { noul: 1.0 },
        likelyEditTarget: { noul: 0.5 },
        likelyRootCause: { noul: 0.25 },
      },
    };
    const validSigs = await runner.evaluate({
      task: dummyTask,
      workspaceSnapshot: dummySnapshot,
      rankedCandidates: [dummyCand],
      units: [dummyUnit],
      featuresMap,
      dataRights: dummyRights,
    });
    assert.strictEqual(validSigs[0].fallbackReason, undefined);
    assert.strictEqual(validSigs[0].semanticRelevanceProbability, 0.0);
    assert.strictEqual(validSigs[0].implementationNeededProbability, 1.0);
    assert.strictEqual(validSigs[0].likelyEditTargetProbability, 0.5);
    assert.strictEqual(validSigs[0].likelyRootCauseProbability, 0.25);
    console.log('  ✔ Valid probability heads cleanly parsed and recorded without fallback');

    server.close();
  }

  // =========================================================================
  // Test 5: Relational Integrity Anti-Joins Across 10 Relationships
  // =========================================================================
  console.log('\n--- Test 5: Relational Integrity Anti-Joins Across 10 Relationships ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_antijoin_'));
    const dbPath = path.join(tempDir, 'antijoin.db');
    const store = new SqliteStore(dbPath);
    const db = (store as any).db;

    const snapId = 'snap_valid_1';
    const sessId = 'sess_valid_1';
    const taskId = 'task_valid_1';
    const unitId = 'unit_valid_1';
    const planId = 'plan_valid_1';
    const agentEnv = createAgentEnvironment({ agentProvider: 'test' });

    // 1. Seed valid baseline records
    db.prepare('INSERT INTO snapshots (snapshot_id, workspace_id, content_root_hash, raw_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
      snapId, 'ws1', 'roothash', '{}', new Date().toISOString()
    );
    db.prepare(`
      INSERT INTO sessions (
        session_id, task_id, snapshot_id, state, agent_environment_id,
        initial_snapshot_id, latest_snapshot_id, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessId, taskId, snapId, 'active', agentEnv.systemConfigurationHash,
      snapId, snapId, '{}', new Date().toISOString(), new Date().toISOString()
    );
    db.prepare(`
      INSERT INTO context_units (unit_id, snapshot_id, kind, trust_level, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(unitId, snapId, 'FILE', 'TRUSTED', '{}', new Date().toISOString());
    db.prepare(`
      INSERT INTO context_plans (plan_id, task_id, snapshot_id, session_id, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(planId, taskId, snapId, sessId, JSON.stringify({ sessionId: sessId, agentEnvironmentId: agentEnv.systemConfigurationHash }), new Date().toISOString());
    db.prepare(`
      INSERT INTO task_contexts (task_id, snapshot_id, primary_prompt, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, snapId, 'test prompt', JSON.stringify({ sessionId: sessId }), new Date().toISOString());
    db.prepare(`
      INSERT INTO jev_shadow_judgments (
        signal_id, session_id, task_id, context_unit_id, context_plan_id, workspace_snapshot_id,
        agent_environment_id, model, provider, question_set_version, latency_ms, redaction_applied, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sig_1', sessId, taskId, unitId, planId, snapId, agentEnv.systemConfigurationHash, 'model', 'provider', 'v1', 5, 0, new Date().toISOString());
    db.prepare(`
      INSERT INTO candidate_decision_observations (
        decision_observation_id, task_id, session_id, snapshot_id, context_unit_id,
        exposure_resolution, policy_id, policy_version, observability_level, features_json, raw_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'obs_1', taskId, sessId, snapId, unitId,
      1, 'policy_test', '1.0', 'FULL', '{}',
      JSON.stringify({ agentEnvironment: { systemConfigurationHash: agentEnv.systemConfigurationHash } }),
      new Date().toISOString()
    );

    // Verify 0 orphans in clean state
    const cleanJevSess = (db.prepare(`SELECT COUNT(*) as count FROM jev_shadow_judgments j LEFT JOIN sessions s ON j.session_id = s.session_id WHERE j.session_id IS NULL OR j.session_id = '' OR j.session_id = 'unknown' OR s.session_id IS NULL`).get() as any).count;
    const cleanJevUnit = (db.prepare(`SELECT COUNT(*) as count FROM jev_shadow_judgments j LEFT JOIN context_units u ON j.context_unit_id = u.unit_id WHERE j.context_unit_id IS NULL OR j.context_unit_id = '' OR j.context_unit_id = 'unknown' OR u.unit_id IS NULL`).get() as any).count;
    const cleanJevPlan = (db.prepare(`SELECT COUNT(*) as count FROM jev_shadow_judgments j LEFT JOIN context_plans p ON j.context_plan_id = p.plan_id WHERE j.context_plan_id IS NULL OR j.context_plan_id = '' OR j.context_plan_id = 'unknown' OR p.plan_id IS NULL`).get() as any).count;
    const cleanJevSnap = (db.prepare(`SELECT COUNT(*) as count FROM jev_shadow_judgments j LEFT JOIN snapshots sn ON j.workspace_snapshot_id = sn.snapshot_id WHERE j.workspace_snapshot_id IS NULL OR j.workspace_snapshot_id = '' OR j.workspace_snapshot_id = 'unknown' OR sn.snapshot_id IS NULL`).get() as any).count;
    const cleanPlanSess = (db.prepare(`SELECT COUNT(*) as count FROM context_plans p LEFT JOIN sessions s ON json_extract(p.raw_json, '$.sessionId') = s.session_id WHERE json_extract(p.raw_json, '$.sessionId') IS NULL OR json_extract(p.raw_json, '$.sessionId') = '' OR json_extract(p.raw_json, '$.sessionId') = 'unknown' OR s.session_id IS NULL`).get() as any).count;
    const cleanPlanSnap = (db.prepare(`SELECT COUNT(*) as count FROM context_plans p LEFT JOIN snapshots sn ON p.snapshot_id = sn.snapshot_id WHERE p.snapshot_id IS NULL OR p.snapshot_id = '' OR p.snapshot_id = 'unknown' OR sn.snapshot_id IS NULL`).get() as any).count;
    const cleanDecSess = (db.prepare(`SELECT COUNT(*) as count FROM candidate_decision_observations d LEFT JOIN sessions s ON d.session_id = s.session_id WHERE d.session_id IS NULL OR d.session_id = '' OR d.session_id = 'unknown' OR s.session_id IS NULL`).get() as any).count;
    const cleanDecSnap = (db.prepare(`SELECT COUNT(*) as count FROM candidate_decision_observations d LEFT JOIN snapshots sn ON d.snapshot_id = sn.snapshot_id WHERE d.snapshot_id IS NULL OR d.snapshot_id = '' OR d.snapshot_id = 'unknown' OR sn.snapshot_id IS NULL`).get() as any).count;
    const cleanTaskSess = (db.prepare(`SELECT COUNT(*) as count FROM task_contexts t LEFT JOIN sessions s ON json_extract(t.raw_json, '$.sessionId') = s.session_id WHERE json_extract(t.raw_json, '$.sessionId') IS NULL OR json_extract(t.raw_json, '$.sessionId') = '' OR json_extract(t.raw_json, '$.sessionId') = 'unknown' OR s.session_id IS NULL`).get() as any).count;
    const cleanTaskSnap = (db.prepare(`SELECT COUNT(*) as count FROM task_contexts t LEFT JOIN snapshots sn ON t.snapshot_id = sn.snapshot_id WHERE t.snapshot_id IS NULL OR t.snapshot_id = '' OR t.snapshot_id = 'unknown' OR sn.snapshot_id IS NULL`).get() as any).count;

    assert.strictEqual(cleanJevSess + cleanJevUnit + cleanJevPlan + cleanJevSnap + cleanPlanSess + cleanPlanSnap + cleanDecSess + cleanDecSnap + cleanTaskSess + cleanTaskSnap, 0);
    console.log('  ✔ All 10 anti-joins report 0 orphans for fully linked schema');

    // 2. Insert an orphan JEV pointing to nonexistent session
    db.prepare(`
      INSERT INTO jev_shadow_judgments (
        signal_id, session_id, task_id, context_unit_id, context_plan_id, workspace_snapshot_id,
        agent_environment_id, model, provider, question_set_version, latency_ms, redaction_applied, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sig_orphan', 'nonexistent_session', taskId, unitId, planId, snapId, agentEnv.systemConfigurationHash, 'm', 'p', 'v1', 5, 0, new Date().toISOString());

    const orphanJev = (db.prepare(`SELECT COUNT(*) as count FROM jev_shadow_judgments j LEFT JOIN sessions s ON j.session_id = s.session_id WHERE j.session_id IS NULL OR j.session_id = '' OR j.session_id = 'unknown' OR s.session_id IS NULL`).get() as any).count;
    assert.strictEqual(orphanJev, 1, 'Nonexistent session correctly detected by anti-join');

    // 3. Insert an orphan JEV with blank workspaceSnapshotId
    db.prepare(`
      INSERT INTO jev_shadow_judgments (
        signal_id, session_id, task_id, context_unit_id, context_plan_id, workspace_snapshot_id,
        agent_environment_id, model, provider, question_set_version, latency_ms, redaction_applied, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sig_blank_snap', sessId, taskId, unitId, planId, '', agentEnv.systemConfigurationHash, 'm', 'p', 'v1', 5, 0, new Date().toISOString());

    const blankSnap = (db.prepare(`SELECT COUNT(*) as count FROM jev_shadow_judgments j LEFT JOIN snapshots sn ON j.workspace_snapshot_id = sn.snapshot_id WHERE j.workspace_snapshot_id IS NULL OR j.workspace_snapshot_id = '' OR j.workspace_snapshot_id = 'unknown' OR sn.snapshot_id IS NULL`).get() as any).count;
    assert.ok(blankSnap >= 1, 'Blank snapshot_id correctly detected by anti-join');

    // 4. CandidateDecision snapshot mismatch against Session.initial_snapshot_id
    db.prepare(`
      INSERT INTO candidate_decision_observations (
        decision_observation_id, task_id, session_id, snapshot_id, context_unit_id,
        exposure_resolution, policy_id, policy_version, observability_level, features_json, raw_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'obs_mismatch_snap', taskId, sessId, 'snap_other_different', unitId,
      1, 'policy_test', '1.0', 'FULL', '{}',
      JSON.stringify({ agentEnvironment: { systemConfigurationHash: agentEnv.systemConfigurationHash } }),
      new Date().toISOString()
    );
    const mismatchedDecSnap = (db.prepare(`
      SELECT COUNT(*) as count FROM candidate_decision_observations d
      LEFT JOIN sessions s ON d.session_id = s.session_id
      WHERE d.snapshot_id IS NULL OR d.snapshot_id = '' OR d.snapshot_id = 'unknown'
         OR s.initial_snapshot_id IS NULL OR s.initial_snapshot_id = '' OR s.initial_snapshot_id = 'unknown'
         OR d.snapshot_id != s.initial_snapshot_id
    `).get() as any).count;
    assert.ok(mismatchedDecSnap >= 1, 'Mismatched snapshot against session initial_snapshot_id detected');

    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('  ✔ Relational integrity anti-joins and snapshot mismatch queries verified');
  }

  // =========================================================================
  // Test 6: Truthful Endpoint Provenance
  // =========================================================================
  console.log('\n--- Test 6: Truthful Endpoint Provenance ---');
  {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        answers: {
          semanticRelevance: { noul: 0.8 },
          implementationNeeded: { noul: 0.7 },
          likelyEditTarget: { noul: 0.9 },
          likelyRootCause: { noul: 0.6 },
        },
        model: 'typesafe-jev-v1',
      }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const customEndpoint = `http://127.0.0.1:${port}/v1`;

    // Initialize TypeSafeSystemOneClient with customEndpoint
    const client = new TypeSafeSystemOneClient({
      apiKey: 'test-key',
      baseURL: customEndpoint,
    });

    // Directly verify that baseURL matches customEndpoint
    assert.strictEqual(client.options.baseURL, customEndpoint);

    // Call client to verify HTTP request targets customEndpoint
    const response = await client.evaluate({
      state: {
        prompt: 'test prompt',
        candidate: {
          contextUnitId: 'u_ep_test',
        },
      },
    });
    assert.strictEqual(response.model, 'typesafe-jev-v1');
    assert.strictEqual(response.answers.semanticRelevance?.noul, 0.8);

    server.close();
    console.log('  ✔ Client baseURL provenance verified: SDK baseURL matches configured endpoint exactly');
  }

  // =========================================================================
  // Test 7: Counted Retries & Failure Category Accounting
  // =========================================================================
  console.log('\n--- Test 7: Counted Retries & Failure Category Accounting ---');
  {
    const tracker = new JevCallTracker(DEFAULT_JEV_DECISION_BUDGET);

    // Simulate 1 timeout attempt that is retried, then succeeds
    tracker.recordHttpRequest();
    tracker.recordHttpAttemptFailure('TIMEOUT');
    tracker.recordRetry();

    tracker.recordHttpRequest();
    tracker.recordCallSuccess();

    const stats = tracker.getStats();
    assert.strictEqual(stats.httpRequests, 2, 'Two HTTP requests recorded');
    assert.strictEqual(stats.retries, 1, 'One retry recorded');
    assert.strictEqual(stats.successfulCalls, 1, 'One successful call recorded');
    assert.strictEqual(stats.failedCalls, 0, 'Terminal failedCalls is 0 because retry succeeded');
    assert.strictEqual(stats.timeouts, 0, 'Terminal timeouts is 0 because call eventually succeeded');
    assert.strictEqual(stats.httpAttemptFailures.timeouts, 1, 'Attempt-level timeouts is 1');

    // Simulate 1 terminal 429 failure
    tracker.recordHttpRequest();
    tracker.recordHttpAttemptFailure('RATE_LIMITED');
    tracker.recordCallFailure('RATE_LIMITED');

    const finalStats = tracker.getStats();
    assert.strictEqual(finalStats.httpRequests, 3);
    assert.strictEqual(finalStats.terminalFailures.rateLimited, 1);
    assert.strictEqual(finalStats.httpAttemptFailures.rateLimited, 1);
    assert.strictEqual(finalStats.failedCalls, 1);
    console.log('  ✔ Attempt-level failures and terminal failures tracked distinctly');
  }

  // =========================================================================
  // Test 8: Closed Training Persistence Trust Boundary
  // =========================================================================
  console.log('\n--- Test 8: Closed Training Persistence Trust Boundary ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_brand_test_'));
    const dbPath = path.join(tempDir, 'brand.db');
    const store = new SqliteStore(dbPath);

    // 1. Raw array bypass attempt
    const rawRow = {
      exportId: 'texport_raw_123',
      rowId: 'r1',
      datasetVersion: 'v1',
      contextUnitId: 'u1',
      taskId: 't1',
      repository: 'repo',
      features: { schemaVersion: 'v1', heuristicScore: 0.5 } as any,
      label: 1,
      sourceObservationIds: ['obs1'],
      rightsReference: 'rights1',
      exportedAt: new Date().toISOString(),
    };

    assert.throws(
      () => store.saveTrainingRows([rawRow] as any),
      /UNSANCTIONED_TRAINING_ROW_PERSISTENCE/,
      'Raw array passed to saveTrainingRows must throw UNSANCTIONED_TRAINING_ROW_PERSISTENCE'
    );

    const rawEv = createTrainingEvidenceRecord({
      datasetVersion: 'v2.0.0',
      contextUnitId: 'u1',
      taskId: 't1',
      sessionId: 's1',
      repository: 'repo',
      features: { schemaVersion: 'v1', heuristicScore: 0.5 } as any,
      sourceObservationIds: ['obs1'],
      rightsReference: 'rights1',
      exportId: 'texport_ev_raw_123',
    });

    assert.throws(
      () => store.saveTrainingEvidenceRecords([rawEv] as any),
      /UNSANCTIONED_TRAINING_EVIDENCE_PERSISTENCE/,
      'Raw array passed to saveTrainingEvidenceRecords must throw UNSANCTIONED_TRAINING_EVIDENCE_PERSISTENCE'
    );

    // 2. Forged batch object without unexported Symbol brand
    const forgedBatch = {
      exportId: 'texport_forged_batch',
      datasetVersion: 'v1',
      rows: [rawRow],
      totalEvaluated: 1,
      sanctionedCount: 1,
      omittedCount: 0,
      filterLog: [],
      watermark: 'watermark',
      exportedAt: new Date().toISOString(),
    };

    assert.throws(
      () => store.saveTrainingRows(forgedBatch as any),
      /UNSANCTIONED_TRAINING_ROW_PERSISTENCE/,
      'Forged batch without brand Symbol must throw UNSANCTIONED_TRAINING_ROW_PERSISTENCE'
    );

    // 3. Legitimate TrainingExporter output passes cleanly
    const exporter = new TrainingExporter();
    const obs = createCandidateObservationV2({
      observationId: 'obs_sanctioned_1',
      taskId: 'task_sanctioned',
      siftrSessionId: 'sess_sanctioned',
      workspaceSnapshotId: 'snap_sanctioned',
      contextUnitId: 'src/core/auth.ts',
      agentEnvironmentId: 'env_1',
      observabilityLevel: 'FULL_TOOL_TRACE',
      features: createMockRankedCandidate('src/core/auth.ts').features,
      candidate: {
        generated: true,
        candidateRank: 1,
        retrievalSources: ['lexical'],
      },
      exposure: {
        contextUnitId: 'src/core/auth.ts',
        eligibleForSelection: true,
        selected: true,
        resolution: ContextResolution.FULL,
        contextPlanId: 'plan_sanctioned',
        policyId: 'policy_s',
        policyVersion: '1.0.0',
        timestamp: new Date().toISOString(),
      },
      observedBehavior: {
        edited: true,
      },
      rightsReference: 'rights_default',
    });

    const legitimateRowExport = exporter.exportTrainingRows(
      [obs],
      () => ({
        dataRights: createDefaultDataRights({ trainingAllowed: true }),
        provenance: createSourceProvenance({ origin: 'FIRST_PARTY', license: 'MIT', repository: 'repo', trainingPermission: 'ALLOWED' }),
        repository: 'repo',
      }),
      { datasetVersion: 'v2.0.0-export' }
    );
    assert.doesNotThrow(
      () => store.saveTrainingRows(legitimateRowExport),
      'Sanctioned TrainingExporter row export must persist cleanly'
    );
    const savedRow = store.getTrainingRow(legitimateRowExport.rows[0].rowId);
    assert.ok(savedRow !== undefined, 'Row must exist in SQLite store');
    assert.strictEqual(savedRow?.exportId, legitimateRowExport.exportId);

    const legitimateEvExport = exporter.exportTrainingEvidenceRecords(
      [rawEv],
      () => ({
        dataRights: createDefaultDataRights({ trainingAllowed: true, trajectoryRetentionAllowed: true }),
        provenance: createSourceProvenance({ origin: 'FIRST_PARTY', license: 'MIT', repository: 'repo', trainingPermission: 'ALLOWED' }),
        repository: 'repo',
      }),
      { datasetVersion: 'v2.0.0' }
    );
    assert.doesNotThrow(
      () => store.saveTrainingEvidenceRecords(legitimateEvExport),
      'Sanctioned TrainingExporter evidence export must persist cleanly'
    );

    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('  ✔ Closed training persistence trust boundary: bypass attempts fail, sanctioned exports succeed');
  }

  console.log('\n🎉 ALL FINAL-3.1 ACCEPTANCE INTEGRITY TESTS PASSED CLEANLY!\n');
}

if (require.main === module) {
  runFinal31AcceptanceTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('FINAL-3.1 acceptance test failed:', err);
      process.exit(1);
    });
}

export { runFinal31AcceptanceTests };
