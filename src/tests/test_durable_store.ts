/**
 * SiftrCode V2 - Durable Observation Store Tests
 * Verifies Remediation PR 7:
 * 1. Schema migration 002_durable_observation_store (Section 25)
 * 2. ContextPlan durable persistence & retrieval (Section 25)
 * 3. Append-only CandidateObservationV2 persistence (Section 25, 26)
 * 4. ExposureDecisionV2 durable persistence (Section 25)
 * 5. TrajectoryEvent durable persistence (Section 25)
 * 6. OutcomeEvidence durable persistence (Section 25)
 * 7. ProviderCall records persistence (Section 25)
 * 8. ContextEngine automatic durable persistence via injected SqliteStore
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SqliteStore } from '../storage/sqlite_store';
import { createWorkspaceSnapshot } from '../workspace/workspace_snapshot';
import { createTaskContext } from '../context/task_context';
import { createAgentEnvironment } from '../agents/agent_environment';
import { ContextResolution } from '../context/context_resolution';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import {
  CandidateObservationV2,
  createCandidateObservationV2,
} from '../telemetry/candidate_observation';
import {
  ExposureDecisionV2,
  createExposureDecisionV2,
} from '../telemetry/exposure_decision';
import { TrajectoryEvent } from '../telemetry/trajectory_event';
import { createDefaultDataRights } from '../rights/data_rights';
import { ContextPlan } from '../engine/context_plan';
import { ContextEngine } from '../engine/context_engine';
import { CodeSymbolUnit, ContextUnitKind, SymbolKind } from '../context/context_unit';
import { TrustLevel } from '../security/trust';
import { DefaultWorkspaceSourceReader } from '../workspace/workspace_source_reader';
import { DefaultContextUnitMaterializer } from '../materialization/context_unit_materializer';
import { DefaultTokenCostEstimator } from '../token/token_cost_estimator';

export async function runDurableStoreTests(): Promise<void> {
  console.log('\n=== Running V2 Durable Observation Store Tests (Remediation PR 7) ===');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_durable_store_'));
  const dbFile = path.join(tempDir, 'durable_siftr.db');

  const mockFeatures: ContextFeaturesV1 = {
    schemaVersion: 'v1',
    contextUnitId: 'unit_redis_lock',
    unitKind: ContextUnitKind.CODE_SYMBOL,
    tokenEstimate: 150,
    isTest: false,
    isConfig: false,
    isDocumentation: false,
    isSchema: false,
    isExported: true,
    exactSymbolMatch: true,
    exactPathMatch: true,
    bm25Score: 0.95,
    tokenOverlapRatio: 0.8,
    graphDegree: 4,
    minDistanceToSeed: 0,
    minDistanceToErrorFrame: 0,
    isDirectDependency: true,
    isDirectDependent: false,
    changeFrequency: 5,
    recentChangeFrequency: 2,
    maxCoChangeWithSeeds: 0.7,
    inStackTrace: true,
    isFailingTestTarget: false,
    inCompilerError: false,
    inDirtyDiff: false,
    heuristicScore: 85.0,
  };

  try {
    const store = new SqliteStore(dbFile);

    // ---------------------------------------------------------------------------
    // 1. Schema Migrations Verification
    // ---------------------------------------------------------------------------
    console.log('\n--- 1. Schema Migrations Verification ---');
    {
      const applied = store.getAppliedMigrations();
      assert.ok(applied.length >= 2, 'At least 2 migrations must be applied');
      assert.strictEqual(applied[0].name, '001_initial_schema');
      assert.strictEqual(applied[1].name, '002_durable_observation_store');
      console.log('  ✔ Migration 002_durable_observation_store applied successfully');
    }

    // ---------------------------------------------------------------------------
    // 2. ContextPlan Durable Persistence & Retrieval
    // ---------------------------------------------------------------------------
    console.log('\n--- 2. ContextPlan Durable Persistence & Retrieval ---');
    {
      const dummyPlan: ContextPlan = {
        taskId: 'task_plan_001',
        planId: 'cplan_durable_001',
        budgetPlan: {
          totalTokens: 1200,
          rawTotalTokens: 3500,
          tokensSaved: 2300,
          savingsPercentage: 65.5,
          costSavedUSD: 0.0069,
          estimatedCostUSD: 0.0036,
          baselineCostUSD: 0.0105,
          budgetProfile: 'BALANCED',
          allocations: [],
        },
        units: [
          {
            contextUnitId: 'unit_auth',
            title: 'AuthService',
            path: 'src/auth.ts',
            resolution: ContextResolution.BODY,
            tokenEstimate: 450,
            reason: 'seed_unit',
          },
        ],
        formattedContext: {
          promptText: '<context_unit>AuthService</context_unit>',
          sections: [],
          metadata: {},
          tokenEstimate: 450,
        },
        exposureDecisions: [],
        policyId: 'siftr-deterministic',
        policyVersion: '2.1.0',
        dataRights: createDefaultDataRights(),
        actualRenderedTokens: 460,
        createdAt: new Date().toISOString(),
      };

      store.saveContextPlan(dummyPlan, 'snap_001');

      const retrieved = store.getContextPlan('cplan_durable_001');
      assert.ok(retrieved !== undefined, 'ContextPlan must be retrieved');
      assert.strictEqual(retrieved!.planId, 'cplan_durable_001');
      assert.strictEqual(retrieved!.taskId, 'task_plan_001');
      assert.strictEqual(retrieved!.policyId, 'siftr-deterministic');
      assert.strictEqual(retrieved!.actualRenderedTokens, 460);

      const list = store.listContextPlans('task_plan_001');
      assert.strictEqual(list.length, 1);
      console.log('  ✔ ContextPlan successfully stored and retrieved from durable SQLite');
    }

    // ---------------------------------------------------------------------------
    // 3. Append-Only CandidateObservationV2 Persistence (Section 25, 26)
    // ---------------------------------------------------------------------------
    console.log('\n--- 3. Append-Only CandidateObservationV2 Persistence ---');
    {
      const exp1 = createExposureDecisionV2({
        contextUnitId: 'u_obs_1',
        eligibleForSelection: true,
        selected: true,
        candidateRank: 1,
        finalBundleRank: 1,
        resolution: ContextResolution.BODY,
        actualTokenCost: 150,
        contextPlanId: 'cplan_durable_001',
      });

      const exp2 = createExposureDecisionV2({
        contextUnitId: 'u_obs_2',
        eligibleForSelection: false,
        selected: false,
        resolution: ContextResolution.OMIT,
        actualTokenCost: 0,
        contextPlanId: 'cplan_durable_001',
      });

      const obs1 = createCandidateObservationV2({
        taskId: 'task_obs_001',
        siftrSessionId: 'sess_obs_001',
        workspaceSnapshotId: 'snap_001',
        contextUnitId: 'u_obs_1',
        agentEnvironmentId: 'env_claude',
        observabilityLevel: 'FULL_TOOL_TRACE',
        features: mockFeatures,
        candidate: { generated: true, candidateRank: 1, retrievalSources: ['SEED'] },
        exposure: exp1,
        observedBehavior: { edited: true },
        rightsReference: 'customer_rights_default',
      });

      const obs2 = createCandidateObservationV2({
        taskId: 'task_obs_001',
        siftrSessionId: 'sess_obs_001',
        workspaceSnapshotId: 'snap_001',
        contextUnitId: 'u_obs_2',
        agentEnvironmentId: 'env_claude',
        observabilityLevel: 'FULL_TOOL_TRACE',
        features: mockFeatures,
        candidate: { generated: false, retrievalSources: [] },
        exposure: exp2,
        rightsReference: 'customer_rights_default',
      });

      store.saveCandidateObservations([obs1, obs2]);

      const retrievedObs1 = store.getCandidateObservation(obs1.observationId);
      assert.ok(retrievedObs1 !== undefined, 'Observation 1 retrieved');
      assert.strictEqual(retrievedObs1!.contextUnitId, 'u_obs_1');
      assert.strictEqual(retrievedObs1!.outcomeLabel, 'POSITIVE');
      assert.strictEqual(retrievedObs1!.schemaVersion, '2');

      const byTask = store.listCandidateObservations({ taskId: 'task_obs_001' });
      assert.strictEqual(byTask.length, 2, 'Listed 2 observations for task');

      const byLabelPos = store.listCandidateObservations({ outcomeLabel: 'POSITIVE' });
      assert.strictEqual(byLabelPos.length, 1);

      const byLabelUnexp = store.listCandidateObservations({ outcomeLabel: 'UNEXPOSED_UNKNOWN' });
      assert.strictEqual(byLabelUnexp.length, 1);

      console.log('  ✔ CandidateObservationV2 records durably persisted and indexed by task/unit/label');
    }

    // ---------------------------------------------------------------------------
    // 4. ExposureDecisionV2 Durable Persistence
    // ---------------------------------------------------------------------------
    console.log('\n--- 4. ExposureDecisionV2 Durable Persistence ---');
    {
      const decision1 = createExposureDecisionV2({
        contextUnitId: 'unit_ed_1',
        eligibleForSelection: true,
        selected: true,
        candidateRank: 1,
        finalBundleRank: 1,
        resolution: ContextResolution.FULL,
        actualTokenCost: 350,
        contextPlanId: 'cplan_ed_test',
        policyId: 'siftr-deterministic',
        policyVersion: '2.1.0',
      });

      const decision2 = createExposureDecisionV2({
        contextUnitId: 'unit_ed_2',
        eligibleForSelection: true,
        selected: false,
        candidateRank: 10,
        resolution: ContextResolution.OMIT,
        actualTokenCost: 0,
        contextPlanId: 'cplan_ed_test',
        policyId: 'siftr-deterministic',
        policyVersion: '2.1.0',
      });

      store.saveExposureDecisions([decision1, decision2], 'task_ed_test');

      const listEd = store.listExposureDecisions('cplan_ed_test');
      assert.strictEqual(listEd.length, 2);
      assert.strictEqual(listEd[0].contextUnitId, 'unit_ed_1');
      assert.strictEqual(listEd[0].selected, true);
      assert.strictEqual(listEd[0].selectionProbability, 1.0);
      assert.strictEqual(listEd[1].selected, false);

      console.log('  ✔ ExposureDecisionV2 records successfully persisted and retrieved');
    }

    // ---------------------------------------------------------------------------
    // 5. TrajectoryEvent Durable Persistence
    // ---------------------------------------------------------------------------
    console.log('\n--- 5. TrajectoryEvent Durable Persistence ---');
    {
      const ev1: TrajectoryEvent = {
        eventId: 'evt_traj_001',
        taskId: 'task_traj_001',
        kind: 'CONTEXT_ALLOCATED',
        payload: { planId: 'cplan_1', tokens: 500 },
        timestamp: 1000,
        dataRights: createDefaultDataRights(),
      };

      const ev2: TrajectoryEvent = {
        eventId: 'evt_traj_002',
        taskId: 'task_traj_001',
        kind: 'TOOL_CALL',
        payload: { tool: 'edit_file', path: 'src/auth.ts' },
        timestamp: 2000,
        dataRights: createDefaultDataRights(),
      };

      store.saveTrajectoryEvents([ev1, ev2], 'sess_traj', 'snap_traj');

      const trajList = store.listTrajectoryEvents('task_traj_001');
      assert.strictEqual(trajList.length, 2);
      assert.strictEqual(trajList[0].kind, 'CONTEXT_ALLOCATED');
      assert.strictEqual(trajList[1].kind, 'TOOL_CALL');
      assert.strictEqual(trajList[1].payload.tool, 'edit_file');

      console.log('  ✔ TrajectoryEvent stream durably persisted in chronological order');
    }

    // ---------------------------------------------------------------------------
    // 6. OutcomeEvidence Durable Persistence
    // ---------------------------------------------------------------------------
    console.log('\n--- 6. OutcomeEvidence Durable Persistence ---');
    {
      store.saveOutcomeEvidence([
        {
          evidenceId: 'ev_001',
          taskId: 'task_outcome_001',
          sessionId: 'sess_1',
          contextUnitId: 'u_target',
          labelType: 'EDITED',
          value: 1.0,
          confidence: 0.95,
          strength: 'STRONG',
          source: 'agent_edit',
          details: { linesChanged: 12 },
        },
        {
          evidenceId: 'ev_002',
          taskId: 'task_outcome_001',
          sessionId: 'sess_1',
          contextUnitId: 'u_target',
          labelType: 'TEST_RELATED',
          value: 1.0,
          confidence: 0.8,
          strength: 'MEDIUM',
          source: 'test_runner',
        },
      ]);

      const evidenceList = store.listOutcomeEvidence('task_outcome_001');
      assert.strictEqual(evidenceList.length, 2);
      assert.strictEqual(evidenceList[0].labelType, 'EDITED');
      assert.strictEqual(evidenceList[0].strength, 'STRONG');
      assert.strictEqual(evidenceList[1].labelType, 'TEST_RELATED');
      console.log('  ✔ OutcomeEvidence records durably persisted with confidence & strength');
    }

    // ---------------------------------------------------------------------------
    // 7. ProviderCall Durable Records
    // ---------------------------------------------------------------------------
    console.log('\n--- 7. ProviderCall Durable Records ---');
    {
      store.saveProviderCall({
        callId: 'call_001',
        taskId: 'task_call_001',
        providerName: 'anthropic_claude',
        allowed: true,
      });

      store.saveProviderCall({
        callId: 'call_002',
        taskId: 'task_call_001',
        providerName: 'openai_gpt4o',
        allowed: false,
        reason: 'trust level UNTRUSTED is prohibited from external egress',
        blockedUnits: ['unit_malicious_issue'],
      });

      const calls = store.listProviderCalls('task_call_001');
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls[0].allowed, true);
      assert.strictEqual(calls[1].allowed, false);
      assert.strictEqual(calls[1].blockedUnits![0], 'unit_malicious_issue');
      console.log('  ✔ ProviderCall records and egress enforcement audit trail persisted');
    }

    // ---------------------------------------------------------------------------
    // 8. ContextEngine End-to-End Automatic Persistence
    // ---------------------------------------------------------------------------
    console.log('\n--- 8. ContextEngine End-to-End Automatic Persistence ---');
    {
      const wsDir = fs.mkdtempSync(path.join(tempDir, 'ws_'));
      const srcDir = path.join(wsDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'lock.ts'), 'export class Lock { acquire() {} }\n');

      const snapshot = createWorkspaceSnapshot({
        repositories: [
          {
            repositoryId: 'root',
            baseCommitSha: 'sha_durable',
            trackedTreeHash: 'tree_durable',
            dirtyPatchHash: 'clean',
          },
        ],
      });

      const reader = new DefaultWorkspaceSourceReader(wsDir);
      const materializer = new DefaultContextUnitMaterializer(reader);
      const estimator = new DefaultTokenCostEstimator(materializer);

      const engine = new ContextEngine({
        repoRootDir: wsDir,
        materializer,
        tokenCostEstimator: estimator,
        dataRights: createDefaultDataRights({ trajectoryRetentionAllowed: true }),
        sqliteStore: store, // Inject durable store!
      });

      const unit: CodeSymbolUnit = {
        id: 'unit_lock_durable',
        kind: ContextUnitKind.CODE_SYMBOL,
        symbolName: 'acquire',
        symbolKind: SymbolKind.METHOD,
        qualifiedName: 'Lock.acquire',
        language: 'typescript',
        contentHash: 'hash_lock',
        workspaceSnapshotId: snapshot.workspaceSnapshotId,
        path: 'src/lock.ts',
        title: 'Lock.acquire',
        provenance: { sourceType: 'file' },
        trustLevel: TrustLevel.FIRST_PARTY_CODE,
        metadata: {},
        startLine: 1,
        endLine: 1,
      };

      const task = createTaskContext({
        taskId: 'task_auto_durable',
        workspaceSnapshotId: snapshot.workspaceSnapshotId,
        primaryPrompt: 'Fix lock acquire timeout',
        agentEnvironment: createAgentEnvironment({
          agentProvider: 'anthropic',
          agentVersion: '1.0.0',
          model: 'claude-3-5-sonnet-20241022',
          harnessVersion: 'v2',
          availableTools: ['read_file', 'edit_file'],
        }),
      });

      const plan = engine.generatePlan({
        task,
        units: [unit],
        snapshot,
      });

      // Verify ContextEngine automatically saved plan and exposure decisions to store
      const persistedPlan = store.getContextPlan(plan.planId);
      assert.ok(persistedPlan !== undefined, 'Plan must be automatically persisted to SqliteStore');
      assert.strictEqual(persistedPlan!.taskId, 'task_auto_durable');

      const persistedEd = store.listExposureDecisions(plan.planId);
      assert.ok(persistedEd.length >= 1, 'Exposure decisions must be automatically persisted');
      assert.strictEqual(persistedEd[0].contextUnitId, 'unit_lock_durable');

      const persistedTraj = store.listTrajectoryEvents('task_auto_durable');
      assert.ok(persistedTraj.length >= 1, 'Trajectory events must be automatically persisted');
      assert.strictEqual(persistedTraj[0].kind, 'CONTEXT_ALLOCATED');

      console.log('  ✔ ContextEngine seamlessly writes plans, exposure decisions, and trajectories to durable store');
    }

    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('\n🎉 All Durable Observation Store tests passed successfully!');
}

if (require.main === module) {
  runDurableStoreTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}
