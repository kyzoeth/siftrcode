import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createCandidateDecisionObservation,
  CandidateDecisionObservation,
} from '../telemetry/decision_observation';
import { createExposureDecisionV2 } from '../telemetry/exposure_decision';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { ContextUnitKind } from '../context/context_unit';
import { createAgentEnvironment } from '../agents/agent_environment';
import { ContextResolution } from '../context/context_resolution';
import { SqliteStore } from '../storage/sqlite_store';
import { DatasetBuilder } from '../learning/dataset_builder';
import { ContextEngine } from '../engine/context_engine';
import { createDefaultDataRights } from '../rights/data_rights';

function createMockFeatures(unitId: string, overrides: Partial<ContextFeaturesV1> = {}): ContextFeaturesV1 {
  return {
    schemaVersion: 'v1',
    contextUnitId: unitId,
    unitKind: ContextUnitKind.CODE_SYMBOL,
    tokenEstimate: 120,
    isTest: false,
    isConfig: false,
    isDocumentation: false,
    isSchema: false,
    isExported: true,
    exactSymbolMatch: true,
    exactPathMatch: false,
    bm25Score: 0.8,
    tokenOverlapRatio: 0.5,
    graphDegree: 2,
    minDistanceToSeed: 1,
    minDistanceToErrorFrame: null,
    isDirectDependency: true,
    isDirectDependent: false,
    changeFrequency: 3,
    recentChangeFrequency: 1,
    maxCoChangeWithSeeds: 0.5,
    inStackTrace: true,
    isFailingTestTarget: false,
    inCompilerError: false,
    inDirtyDiff: false,
    heuristicScore: 75.0,
    ...overrides,
  };
}

export async function runLearningPlaneRuntimeTests(): Promise<void> {
  console.log('🧪 Testing Learning Plane Wire-up & Decision Observations (Closure PR 0.4)...');

  // ---------------------------------------------------------------------------
  // 1. CandidateDecisionObservation Contract & Immutability
  // ---------------------------------------------------------------------------
  console.log('\n--- 1. CandidateDecisionObservation Contract ---');
  {
    const env = createAgentEnvironment({
      model: 'claude-3-5-sonnet',
      agentProvider: 'anthropic',
    });

    const expDec = createExposureDecisionV2({
      contextUnitId: 'unit_auth_handler',
      eligibleForSelection: true,
      selected: true,
      candidateRank: 1,
      resolution: ContextResolution.BODY,
      contextPlanId: 'cplan_001',
    });

    const dummyFeatures = createMockFeatures('unit_auth_handler', {
      bm25Score: 0.8,
      exactSymbolMatch: true,
      graphDegree: 1,
      inStackTrace: true,
    });

    const decObs = createCandidateDecisionObservation({
      taskId: 'task_learn_001',
      workspaceSnapshotId: 'ws_snap_001',
      contextUnitId: 'unit_auth_handler',
      candidate: {
        generated: true,
        candidateRank: 1,
        retrievalSources: ['exact', 'graph'],
      },
      features: dummyFeatures,
      rank: 1,
      exposureDecision: expDec,
      policyId: 'context_rank_v2',
      policyVersion: '2.0.0',
      agentEnvironment: env,
      observabilityLevel: 'FULL_TOOL_TRACE',
    });

    assert.ok(decObs.decisionObservationId.startsWith('cdec_'), 'decisionObservationId has valid prefix');
    assert.strictEqual(decObs.taskId, 'task_learn_001');
    assert.strictEqual(decObs.workspaceSnapshotId, 'ws_snap_001');
    assert.strictEqual(decObs.contextUnitId, 'unit_auth_handler');
    assert.strictEqual(decObs.rank, 1);
    assert.strictEqual(decObs.exposureDecision.resolution, ContextResolution.BODY);
    assert.strictEqual(decObs.observabilityLevel, 'FULL_TOOL_TRACE');
    assert.strictEqual(decObs.policyId, 'context_rank_v2');

    console.log('  ✔ CandidateDecisionObservation contract captures all decision-time signals');
  }

  // ---------------------------------------------------------------------------
  // 2. SQLite Store Persistence for Decision Observations
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. SQLite Store Decision Observation Persistence ---');
  {
    const store = new SqliteStore(':memory:');
    const env = createAgentEnvironment({ model: 'gpt-4o' });

    const exp1 = createExposureDecisionV2({
      contextUnitId: 'unit_jwt_verify',
      eligibleForSelection: true,
      selected: true,
      resolution: ContextResolution.FULL,
      contextPlanId: 'cplan_002',
    });

    const exp2 = createExposureDecisionV2({
      contextUnitId: 'unit_logger',
      eligibleForSelection: true,
      selected: false,
      resolution: ContextResolution.OMIT,
      contextPlanId: 'cplan_002',
    });

    const features = createMockFeatures('unit_jwt_verify', {
      bm25Score: 0.5,
      exactSymbolMatch: true,
      graphDegree: 2,
    });

    const dec1 = createCandidateDecisionObservation({
      taskId: 'task_store_test',
      workspaceSnapshotId: 'ws_snap_store',
      contextUnitId: 'unit_jwt_verify',
      candidate: { generated: true, candidateRank: 1, retrievalSources: ['exact'] },
      features,
      rank: 1,
      exposureDecision: exp1,
      agentEnvironment: env,
      observabilityLevel: 'SIFTR_CALLS_ONLY',
    });

    const dec2 = createCandidateDecisionObservation({
      taskId: 'task_store_test',
      workspaceSnapshotId: 'ws_snap_store',
      contextUnitId: 'unit_logger',
      candidate: { generated: true, candidateRank: 2, retrievalSources: ['graph'] },
      features,
      rank: 2,
      exposureDecision: exp2,
      agentEnvironment: env,
      observabilityLevel: 'SIFTR_CALLS_ONLY',
    });

    store.saveCandidateDecisionObservations([dec1, dec2]);

    const retrieved1 = store.getCandidateDecisionObservation(dec1.decisionObservationId);
    assert.ok(retrieved1, 'Must retrieve stored decision observation');
    assert.strictEqual(retrieved1.contextUnitId, 'unit_jwt_verify');
    assert.strictEqual(retrieved1.rank, 1);

    const listByTask = store.listCandidateDecisionObservations({ taskId: 'task_store_test' });
    assert.strictEqual(listByTask.length, 2, 'Must list all decisions for task');

    store.close();
    console.log('  ✔ SqliteStore durably persists and indexes CandidateDecisionObservations');
  }

  // ---------------------------------------------------------------------------
  // 3. DatasetBuilder: Joining Decisions with Downstream Evidence
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. DatasetBuilder Evidence Joining ---');
  {
    const env = createAgentEnvironment({ model: 'claude-3-5-sonnet' });

    const expExposed = createExposureDecisionV2({
      contextUnitId: 'unit_core_service',
      eligibleForSelection: true,
      selected: true,
      resolution: ContextResolution.BODY,
      contextPlanId: 'cplan_join_01',
    });

    const expUnexposed = createExposureDecisionV2({
      contextUnitId: 'unit_unrelated_doc',
      eligibleForSelection: false,
      selected: false,
      resolution: ContextResolution.OMIT,
      contextPlanId: 'cplan_join_01',
    });

    const features = createMockFeatures('unit_core_service', {
      bm25Score: 0.9,
      tokenEstimate: 200,
    });

    const decExposed = createCandidateDecisionObservation({
      taskId: 'task_join_01',
      workspaceSnapshotId: 'ws_join_01',
      contextUnitId: 'unit_core_service',
      candidate: { generated: true, candidateRank: 1, retrievalSources: ['bm25'] },
      features,
      rank: 1,
      exposureDecision: expExposed,
      agentEnvironment: env,
      observabilityLevel: 'FULL_TOOL_TRACE',
    });

    const decUnexposed = createCandidateDecisionObservation({
      taskId: 'task_join_01',
      workspaceSnapshotId: 'ws_join_01',
      contextUnitId: 'unit_unrelated_doc',
      candidate: { generated: true, candidateRank: 2, retrievalSources: ['bm25'] },
      features,
      rank: 2,
      exposureDecision: expUnexposed,
      agentEnvironment: env,
      observabilityLevel: 'FULL_TOOL_TRACE',
    });

    // Case A: Exposed unit was edited by agent -> POSITIVE label
    const obsPositive = DatasetBuilder.buildCandidateObservation({
      decision: decExposed,
      behavior: { read: true, edited: true },
      taskSucceeded: true,
    });
    assert.strictEqual(obsPositive.outcomeLabel, 'POSITIVE', 'Edited exposed unit must yield POSITIVE');
    assert.strictEqual(obsPositive.contextUnitId, 'unit_core_service');

    // Case B: Unexposed unit -> UNEXPOSED_UNKNOWN (Never negative)
    const obsUnexposed = DatasetBuilder.buildCandidateObservation({
      decision: decUnexposed,
      behavior: { read: false, edited: false },
      taskSucceeded: true,
    });
    assert.strictEqual(obsUnexposed.outcomeLabel, 'UNEXPOSED_UNKNOWN', 'Unexposed unit must be UNEXPOSED_UNKNOWN');

    // Case C: Batch buildDataset
    const dataset = DatasetBuilder.buildDataset({
      decisions: [decExposed, decUnexposed],
      behaviorsByUnitId: new Map([
        ['unit_core_service', { read: true, edited: true }],
        ['unit_unrelated_doc', { read: false, edited: false }],
      ]),
      taskSucceeded: true,
    });
    assert.strictEqual(dataset.length, 2);
    assert.strictEqual(dataset[0].outcomeLabel, 'POSITIVE');
    assert.strictEqual(dataset[1].outcomeLabel, 'UNEXPOSED_UNKNOWN');

    // Verify original decision was NOT mutated
    assert.strictEqual(decExposed.rank, 1);
    assert.strictEqual((decExposed as any).outcomeLabel, undefined);

    console.log('  ✔ DatasetBuilder cleanly joins decision records with behavior and outcomes');
    console.log('  ✔ Original CandidateDecisionObservation remains immutable');
  }

  // ---------------------------------------------------------------------------
  // 4. ContextEngine Runtime Learning Store Auto-Creation
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. ContextEngine Runtime Learning Store Auto-Creation ---');
  {
    const tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_learn_allowed_'));
    const testFileA = path.join(tmpDirA, 'service.ts');
    fs.writeFileSync(
      testFileA,
      'export class AuthService {\n  verify(token: string): boolean { return token.length > 0; }\n}\n'
    );

    try {
      // Run optimizeWorkspace with default telemetryAllowed = true
      const resultA = await ContextEngine.optimizeWorkspace({
        workspaceDir: tmpDirA,
        prompt: 'Fix token validation in AuthService',
        tokenBudget: 5000,
      });

      const dbPathA = path.join(tmpDirA, '.siftr', 'observations.sqlite');
      assert.ok(fs.existsSync(dbPathA), 'Default runtime must create .siftr/observations.sqlite');

      // Verify persisted records inside the database
      const diskStoreA = new SqliteStore(dbPathA);
      const storedPlan = diskStoreA.getContextPlan(resultA.plan.planId);
      assert.ok(storedPlan, 'ContextPlan must be persisted in local store');

      const storedTask = diskStoreA.getTaskContext(resultA.task.taskId);
      assert.ok(storedTask, 'TaskContext must be persisted in local store');

      const storedDecisions = diskStoreA.listCandidateDecisionObservations({ taskId: resultA.task.taskId });
      assert.ok(storedDecisions.length > 0, 'CandidateDecisionObservations must be persisted automatically');
      assert.strictEqual(storedDecisions[0].taskId, resultA.task.taskId);

      diskStoreA.close();
      if (resultA.sqliteStore) {
        resultA.sqliteStore.close();
      }
      console.log('  ✔ Normal product usage automatically creates and persists to .siftr/observations.sqlite');
    } finally {
      fs.rmSync(tmpDirA, { recursive: true, force: true });
    }

    // -------------------------------------------------------------------------
    // 5. Zero Persistence When Telemetry Prohibited
    // -------------------------------------------------------------------------
    console.log('\n--- 5. Zero Persistence When Telemetry Prohibited ---');
    const tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_learn_prohibited_'));
    const testFileB = path.join(tmpDirB, 'secret_service.ts');
    fs.writeFileSync(
      testFileB,
      'export class SecretService {\n  run(): void {}\n}\n'
    );

    try {
      const strictRights = createDefaultDataRights({ telemetryAllowed: false });
      const resultB = await ContextEngine.optimizeWorkspace({
        workspaceDir: tmpDirB,
        prompt: 'Audit SecretService',
        tokenBudget: 5000,
        dataRights: strictRights,
      });

      const dbPathB = path.join(tmpDirB, '.siftr', 'observations.sqlite');
      assert.ok(!fs.existsSync(dbPathB), 'When telemetryAllowed=false, .siftr/observations.sqlite must NEVER be created');
      assert.strictEqual(resultB.sqliteStore, undefined, 'sqliteStore must be undefined when telemetry is prohibited');

      console.log('  ✔ Zero local store or observations written when telemetryAllowed = false');
    } finally {
      fs.rmSync(tmpDirB, { recursive: true, force: true });
    }
  }

  console.log('\n🎉 All Learning Plane Runtime & Decision Observation tests passed successfully!');
}

if (require.main === module) {
  runLearningPlaneRuntimeTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}
