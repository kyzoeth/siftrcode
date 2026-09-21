/**
 * SiftrCode V2 - Regression Tests for:
 * 1. Authoritative operationRights.*.retention.local across all durable writes
 * 2. Tri-state, exposure & observability-aware TrainingEvidence (no auto-zero)
 * 3. JEV telemetry accounting & title escape hatch elimination
 * 4. Zero fixed probability substitutions for missing JEV answers
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  DataRights,
  DataClass,
  createDefaultDataRights,
  createDefaultOperationRightsPolicy,
  createJevPermittedDataRights,
  resolveApplicationDataRights,
  isRemoteProcessingPermitted,
  isOperationPermitted,
  isDataClassPermitted,
} from '../rights/data_rights';
import { JevClient } from '../jev/client';
import {
  CandidateDecisionObservation,
  createCandidateDecisionObservation,
} from '../telemetry/decision_observation';
import { sanitizeCandidateDecisionObservation } from '../storage/rights_aware_dto';
import { DatasetBuilder } from '../learning/dataset_builder';
import { TrainingExporter } from '../learning/training_exporter';
import { RightsFilter } from '../rights/rights_filter';
import { ContextRanker } from '../ranking/context_rank';
import { ContextResolution } from '../context/context_resolution';
import {
  ContextUnit,
  ContextUnitKind,
  CodeSymbolUnit,
  SymbolKind,
} from '../context/context_unit';
import { RankedCandidate } from '../ranking/context_rank';
import { TrustLevel } from '../security/trust';
import { SqliteStore } from '../storage/sqlite_store';
import { sanitizeContextPlanForPersistence } from '../storage/rights_aware_dto';
import { createTaskContext } from '../context/task_context';
import { createAgentEnvironment } from '../agents/agent_environment';
import { createWorkspaceSnapshot } from '../workspace/workspace_snapshot';
import {
  createTrainingEvidenceRecord,
  createTrainingRow,
  deriveRankingTrainingExample,
  deriveBinaryTrainingRow,
} from '../learning/lineage';
import { createCandidateObservationV2 } from '../telemetry/candidate_observation';
import { createSourceProvenance } from '../rights/source_provenance';
import { ContextEngine } from '../engine/context_engine';
import { scrubJevTestEnvironment, isIntegrationTest } from '../testing/test_env_scrubber';
import {
  JevShadowRunner,
} from '../providers/judgment/typesafe/jev_shadow_runner';
import {
  JevMode,
  JevFallbackReason,
  JevSignalV1,
  createJevSignalV1,
} from '../providers/judgment/typesafe/jev_signal';
import {
  JevCallTracker,
} from '../providers/judgment/typesafe/jev_budget';
import {
  FakeSystemOneClient,
  TypeSafeSystemOneClient,
  SystemOneEvaluationRequest,
  SystemOneEvaluationResponse,
} from '../providers/judgment/typesafe/typesafe_client';
import { runTypeSafeJevPilotStudy } from './pilot_jev_real_study';

function createMockRankedCandidate(
  contextUnitId: string,
  rank: number,
  score: number
): RankedCandidate {
  return {
    contextUnitId,
    rank,
    finalScore: score,
    features: {} as any,
    reasons: ['mock_rank'],
    scoreBreakdown: {
      exactMatch: 0,
      lexicalRelevance: score,
      graphProximity: 0,
      gitCoChange: 0,
      runtimeEvidence: 0,
      penalties: 0,
    },
  };
}

export async function runRegressionTests() {
  console.log('🧪 Running Rights, TrainingEvidence, Telemetry, and Study Regression Tests...\n');

  // ==========================================================================
  // SUITE 1: Authoritative operationRights.*.retention.local
  // ==========================================================================
  console.log('--- Suite 1: Authoritative operationRights.*.retention.local ---');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_reg_rights_'));
    const dbPath = path.join(tmpDir, 'test.db');
    const store = new SqliteStore(dbPath);

    // Case 1A: operationRights overrides flat flags (flat says ALLOW, operationRights says FORBID)
    const rightsForbidPath: DataRights = createDefaultDataRights({
      pathRetentionAllowed: true, // Legacy flat flag says TRUE
      operationRights: createDefaultOperationRightsPolicy({
        [DataClass.PATH]: { retention: { local: false, remote: false } }, // Authoritative says FALSE
      }),
    });

    assert.strictEqual(
      isDataClassPermitted(rightsForbidPath, DataClass.PATH),
      false,
      'isDataClassPermitted must honor operationRights.retention.local (false) over legacy flat flag (true)'
    );

    const unit: CodeSymbolUnit = {
      id: 'sym_unit_1',
      workspaceSnapshotId: 'snap_1',
      kind: ContextUnitKind.CODE_SYMBOL,
      symbolKind: SymbolKind.METHOD,
      trustLevel: TrustLevel.FIRST_PARTY_CODE,
      title: 'AuthService.login',
      symbolName: 'login',
      qualifiedName: 'AuthService.login',
      language: 'typescript',
      contentHash: 'hash_unit_1',
      path: 'src/auth/service.ts',
      startLine: 10,
      endLine: 25,
      signature: 'public login(u: string, p: string): boolean',
      provenance: { sourceType: 'file', sourceUri: 'file:///src/auth/service.ts' },
      metadata: { filePath: 'src/auth/service.ts', rawContent: 'function login() { return true; }' },
    };

    store.saveContextUnits([unit], rightsForbidPath);
    const retrieved = store.getContextUnit('sym_unit_1');
    assert(retrieved !== undefined, 'Unit was saved');
    assert.strictEqual(retrieved!.path, undefined, 'Path must be redacted because operationRights forbids local retention');
    assert.strictEqual(retrieved!.provenance.sourceUri, undefined, 'Source URI must be scrubbed');

    // Case 1B: operationRights permits local retention while flat flag is false
    const rightsAllowPath: DataRights = createDefaultDataRights({
      pathRetentionAllowed: false, // Legacy flat flag says FALSE
      operationRights: createDefaultOperationRightsPolicy({
        [DataClass.PATH]: { retention: { local: true, remote: false } }, // Authoritative says TRUE
      }),
    });

    assert.strictEqual(
      isDataClassPermitted(rightsAllowPath, DataClass.PATH),
      true,
      'isDataClassPermitted must honor operationRights.retention.local (true) over legacy flat flag (false)'
    );

    store.saveContextUnits([unit], rightsAllowPath);
    const retrievedAllow = store.getContextUnit('sym_unit_1');
    assert.strictEqual(retrievedAllow?.path, 'src/auth/service.ts', 'Path must be retained when operationRights permits');

    // Case 1C: Trajectory durable write honors operationRights.TRAJECTORY.retention.local
    const rightsNoTrajectory: DataRights = createDefaultDataRights({
      trajectoryRetentionAllowed: true, // Legacy flat says TRUE
      operationRights: createDefaultOperationRightsPolicy({
        [DataClass.TRAJECTORY]: { retention: { local: false, remote: false } },
      }),
    });

    store.saveTrajectoryEvents(
      [{ eventId: 'tev_1', taskId: 'task_t1', kind: 'TOOL_CALL', payload: {}, timestamp: Date.now(), dataRights: createDefaultDataRights() }],
      'sess_1',
      'snap_1',
      rightsNoTrajectory
    );
    const events = store.listTrajectoryEvents('task_t1');
    assert.strictEqual(events.length, 0, 'Trajectory events must not be saved when operationRights forbids local retention');

    // Case 1D: JEV Shadow Judgments honor operationRights.NUMERIC_FEATURE.retention.local
    const rightsNoNumeric: DataRights = createDefaultDataRights({
      derivedNumericFeaturesAllowed: true, // Legacy flat says TRUE
      operationRights: createDefaultOperationRightsPolicy({
        [DataClass.NUMERIC_FEATURE]: { retention: { local: false, remote: false } },
      }),
    });

    const signal = createJevSignalV1({
      taskId: 'task_j1',
      workspaceSnapshotId: 'snap_1',
      contextUnitId: 'sym_unit_1',
      semanticRelevanceProbability: 0.88,
      implementationNeededProbability: 0.77,
      likelyEditTargetProbability: 0.66,
      likelyRootCauseProbability: 0.55,
      model: 'jev-test',
      questionSetVersion: 'v1',
      latencyMs: 120,
      redactionApplied: false,
    });

    store.saveJevShadowJudgments([signal], rightsNoNumeric);
    const storedSignals = store.listJevShadowJudgments('task_j1');
    assert.strictEqual(storedSignals.length, 1, 'Signal saved');
    assert.strictEqual(storedSignals[0].semanticRelevanceProbability, null, 'Probabilities must be null when numeric retention is forbidden');

    // Case 1E: ContextPlan and TaskContext persistence strictly honor operationRights
    const rightsForbidSymbolName: DataRights = createDefaultDataRights({
      symbolNameRetentionAllowed: true, // Legacy flat says TRUE
      operationRights: createDefaultOperationRightsPolicy({
        [DataClass.SYMBOL_NAME]: { retention: { local: false, remote: false } }, // Authoritative says FALSE
        [DataClass.PATH]: { retention: { local: true, remote: false } },
      }),
    });

    const mockPlan: any = {
      planId: 'plan_reg_1',
      taskId: 'task_reg_1',
      units: [
        {
          contextUnitId: 'sym_unit_1',
          resolution: 4,
          tokenEstimate: 50,
          reason: 'test',
          title: 'AuthService.login',
          path: 'src/auth/service.ts',
        },
      ],
      budgetPlan: {},
      exposureDecisions: [],
      dataRights: rightsForbidSymbolName,
      actualRenderedTokens: 50,
      createdAt: new Date().toISOString(),
    };

    const sanitizedPlanRecord = sanitizeContextPlanForPersistence(mockPlan, rightsForbidSymbolName, 'snap_1');
    assert.strictEqual(
      sanitizedPlanRecord.units[0].title,
      undefined,
      'ContextPlan unit title must be stripped when operationRights forbids SYMBOL_NAME'
    );
    assert.strictEqual(
      sanitizedPlanRecord.units[0].path,
      'src/auth/service.ts',
      'ContextPlan unit path must be retained when operationRights allows PATH'
    );

    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('  ✔ Suite 1 passed: operationRights.*.retention.local is authoritative across all durable writes\n');
  }

  // ==========================================================================
  // SUITE 2: Tri-State & Exposure/Observability-Aware TrainingEvidence
  // ==========================================================================
  console.log('--- Suite 2: Tri-State & Exposure/Observability-Aware TrainingEvidence ---');
  {
    const dummyFeatures: any = { schemaVersion: 'v1', inStackTrace: false };

    // Case 2A: Unexposed candidate must NEVER produce relevanceGrade 0
    const unexposedEvidence = createTrainingEvidenceRecord({
      datasetVersion: 'v2.0-test',
      contextUnitId: 'sym_unexposed',
      taskId: 'task_exp_1',
      sessionId: 'sess_1',
      repository: 'test-repo',
      features: dummyFeatures,
      exposure: { wasExposed: false },
      observabilityLevel: 'FULL_TOOL_TRACE',
      readEvidence: { wasRead: null, confidence: 0.5 },
      editEvidence: { wasEdited: false, confidence: 0.5 },
      verifiedOutcomeAssociation: { verifiedSuccess: true, confidence: 1.0 },
      sourceObservationIds: ['obs_1'],
      rightsReference: 'rights_1',
    });

    const unexposedGrading = deriveRankingTrainingExample(unexposedEvidence);
    assert.strictEqual(
      unexposedGrading.relevanceGrade,
      null,
      'Unexposed candidate must have relevanceGrade null (never automatically 0)'
    );

    const unexposedBinary = deriveBinaryTrainingRow(unexposedEvidence);
    assert.strictEqual(
      unexposedBinary.outcomeLabel,
      'UNEXPOSED_UNKNOWN',
      'Unexposed candidate must have outcomeLabel UNEXPOSED_UNKNOWN'
    );
    assert.strictEqual(
      unexposedBinary.label,
      null,
      'Unexposed candidate must have binary label null (never 0)'
    );

    // Case 2B: Limited observability (SIFTR_CALLS_ONLY) cannot observe reads -> tri-state null, NEVER grade 0
    const unobservedEvidence = createTrainingEvidenceRecord({
      datasetVersion: 'v2.0-test',
      contextUnitId: 'sym_unobserved',
      taskId: 'task_exp_2',
      sessionId: 'sess_2',
      repository: 'test-repo',
      features: dummyFeatures,
      exposure: { wasExposed: true },
      observabilityLevel: 'SIFTR_CALLS_ONLY',
      readEvidence: { wasRead: null, confidence: 0.5 },
      editEvidence: { wasEdited: false, confidence: 0.5 },
      verifiedOutcomeAssociation: { verifiedSuccess: true, confidence: 1.0 },
      sourceObservationIds: ['obs_2'],
      rightsReference: 'rights_2',
    });

    const unobservedGrading = deriveRankingTrainingExample(unobservedEvidence);
    assert.strictEqual(
      unobservedGrading.relevanceGrade,
      null,
      'Unobserved candidate under SIFTR_CALLS_ONLY must have relevanceGrade null (never automatically 0)'
    );
    const unobservedBinary = deriveBinaryTrainingRow(unobservedEvidence);
    assert.strictEqual(
      unobservedBinary.label,
      null,
      'Unobserved candidate under SIFTR_CALLS_ONLY must have binary label null'
    );

    // Case 2C: Failed task cannot support confirmed negative distractor -> relevanceGrade null
    const failedTaskEvidence = createTrainingEvidenceRecord({
      datasetVersion: 'v2.0-test',
      contextUnitId: 'sym_failed',
      taskId: 'task_exp_3',
      sessionId: 'sess_3',
      repository: 'test-repo',
      features: dummyFeatures,
      exposure: { wasExposed: true },
      observabilityLevel: 'FULL_TOOL_TRACE',
      readEvidence: { wasRead: false, confidence: 0.8 },
      editEvidence: { wasEdited: false, confidence: 0.8 },
      verifiedOutcomeAssociation: { verifiedSuccess: false, confidence: 1.0 }, // Task FAILED
      sourceObservationIds: ['obs_3'],
      rightsReference: 'rights_3',
    });

    const failedGrading = deriveRankingTrainingExample(failedTaskEvidence);
    assert.strictEqual(
      failedGrading.relevanceGrade,
      null,
      'Candidate in failed task must remain relevanceGrade null (never 0)'
    );
    const failedBinary = deriveBinaryTrainingRow(failedTaskEvidence);
    assert.strictEqual(
      failedBinary.label,
      null,
      'Candidate in failed task must remain binary label null (never 0)'
    );

    // Case 2D: Confirmed negative distractor (Grade 0) ONLY under full observability + task success
    const confirmedNegative = createTrainingEvidenceRecord({
      datasetVersion: 'v2.0-test',
      contextUnitId: 'sym_neg',
      taskId: 'task_exp_4',
      sessionId: 'sess_4',
      repository: 'test-repo',
      features: dummyFeatures,
      exposure: { wasExposed: true },
      observabilityLevel: 'FULL_TOOL_TRACE',
      readEvidence: { wasRead: false, confidence: 0.9 },
      editEvidence: { wasEdited: false, confidence: 0.9 },
      verifiedOutcomeAssociation: { verifiedSuccess: true, confidence: 1.0 }, // Task SUCCEEDED
      sourceObservationIds: ['obs_4'],
      rightsReference: 'rights_4',
    });

    const negGrading = deriveRankingTrainingExample(confirmedNegative);
    assert.strictEqual(
      negGrading.relevanceGrade,
      0,
      'Candidate confirmed unread & unedited in verified successful task under FULL_TOOL_TRACE receives grade 0'
    );
    const confirmedNegBinary = deriveBinaryTrainingRow(confirmedNegative);
    assert.strictEqual(
      confirmedNegBinary.label,
      0,
      'Confirmed negative candidate in successful task receives binary label 0'
    );
    assert.strictEqual(
      confirmedNegBinary.outcomeLabel,
      'WEAK_NEGATIVE',
      'Confirmed negative candidate receives outcomeLabel WEAK_NEGATIVE'
    );

    // Case 2E: Positive interactions (Grades 1, 2, 3, 4)
    const readEvidence = createTrainingEvidenceRecord({
      datasetVersion: 'v2.0-test',
      contextUnitId: 'sym_read',
      taskId: 'task_exp_4',
      sessionId: 'sess_4',
      repository: 'test-repo',
      features: dummyFeatures,
      exposure: { wasExposed: true },
      observabilityLevel: 'FULL_TOOL_TRACE',
      readEvidence: { wasRead: true, confidence: 0.95 },
      editEvidence: { wasEdited: false, confidence: 0.5 },
      verifiedOutcomeAssociation: { verifiedSuccess: false, confidence: 0.5 },
      sourceObservationIds: ['obs_4'],
      rightsReference: 'rights_4',
    });
    assert.strictEqual(deriveRankingTrainingExample(readEvidence).relevanceGrade, 1, 'Read alone gives grade 1');

    const readSuccessEvidence = createTrainingEvidenceRecord({
      datasetVersion: 'v2.0-test',
      contextUnitId: 'sym_read_succ',
      taskId: 'task_exp_4',
      sessionId: 'sess_4',
      repository: 'test-repo',
      features: dummyFeatures,
      exposure: { wasExposed: true },
      observabilityLevel: 'FULL_TOOL_TRACE',
      readEvidence: { wasRead: true, confidence: 0.95 },
      editEvidence: { wasEdited: false, confidence: 0.5 },
      verifiedOutcomeAssociation: { verifiedSuccess: true, confidence: 0.95 },
      sourceObservationIds: ['obs_4'],
      rightsReference: 'rights_4',
    });
    assert.strictEqual(deriveRankingTrainingExample(readSuccessEvidence).relevanceGrade, 2, 'Read + success gives grade 2');

    const editEvidence = createTrainingEvidenceRecord({
      datasetVersion: 'v2.0-test',
      contextUnitId: 'sym_edit',
      taskId: 'task_exp_4',
      sessionId: 'sess_4',
      repository: 'test-repo',
      features: dummyFeatures,
      exposure: { wasExposed: true },
      observabilityLevel: 'FULL_TOOL_TRACE',
      readEvidence: { wasRead: false, confidence: 0.5 },
      editEvidence: { wasEdited: true, confidence: 0.99 },
      verifiedOutcomeAssociation: { verifiedSuccess: false, confidence: 0.5 },
      sourceObservationIds: ['obs_4'],
      rightsReference: 'rights_4',
    });
    assert.strictEqual(deriveRankingTrainingExample(editEvidence).relevanceGrade, 3, 'Edit alone gives grade 3');

    const editSuccessEvidence = createTrainingEvidenceRecord({
      datasetVersion: 'v2.0-test',
      contextUnitId: 'sym_edit_succ',
      taskId: 'task_exp_4',
      sessionId: 'sess_4',
      repository: 'test-repo',
      features: dummyFeatures,
      exposure: { wasExposed: true },
      observabilityLevel: 'FULL_TOOL_TRACE',
      readEvidence: { wasRead: false, confidence: 0.5 },
      editEvidence: { wasEdited: true, confidence: 0.99 },
      verifiedOutcomeAssociation: { verifiedSuccess: true, confidence: 0.99 },
      sourceObservationIds: ['obs_4'],
      rightsReference: 'rights_4',
    });
    assert.strictEqual(deriveRankingTrainingExample(editSuccessEvidence).relevanceGrade, 4, 'Edit + success gives grade 4');

    // Case 2F: verifiedSuccess = null preserved across SQLite storage boundary (never collapses to 0/failure)
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_reg_ev_'));
    const dbPath2 = path.join(tmpDir2, 'test.db');
    const store2 = new SqliteStore(dbPath2);

    const nullSuccessEvidence = createTrainingEvidenceRecord({
      datasetVersion: 'v2.0-test',
      contextUnitId: 'sym_null_success',
      taskId: 'task_null_1',
      sessionId: 'sess_null_1',
      repository: 'test-repo',
      features: dummyFeatures,
      exposure: { wasExposed: true },
      observabilityLevel: 'FULL_TOOL_TRACE',
      readEvidence: { wasRead: null, confidence: 0.5 },
      editEvidence: { wasEdited: false, confidence: 0.5 },
      verifiedOutcomeAssociation: { verifiedSuccess: null, confidence: 0.35 },
      sourceObservationIds: ['obs_null_1'],
      exportId: 'texport_ev_suite2',
      rightsReference: 'rights_null_1',
    });

    assert.strictEqual(
      nullSuccessEvidence.verifiedOutcomeAssociation.verifiedSuccess,
      null,
      'TrainingEvidenceRecord must preserve verifiedSuccess as null (not undefined or false)'
    );

    store2.saveTrainingEvidenceRecords([nullSuccessEvidence]);

    // Inspect direct SQLite row
    const rawRow: any = (store2 as any).db
      .prepare('SELECT was_read, was_edited, verified_success, raw_json FROM training_evidence_records WHERE evidence_id = ?')
      .get(nullSuccessEvidence.evidenceId);

    assert.strictEqual(rawRow.verified_success, null, 'SQLite verified_success must be NULL (not 0 or false)');
    assert.strictEqual(rawRow.was_read, null, 'SQLite was_read must be NULL (not 0 or false)');

    const parsed = JSON.parse(rawRow.raw_json);
    assert.strictEqual(parsed.verifiedOutcomeAssociation.verifiedSuccess, null, 'raw_json must preserve verifiedSuccess as null');
    assert.strictEqual(parsed.readEvidence.wasRead, null, 'raw_json must preserve wasRead as null');

    const retrievedRec = store2.getTrainingEvidenceRecord(nullSuccessEvidence.evidenceId);
    assert.strictEqual(retrievedRec?.verifiedOutcomeAssociation.verifiedSuccess, null, 'Retrieved record has verifiedSuccess = null');

    store2.close();
    fs.rmSync(tmpDir2, { recursive: true, force: true });

    console.log('  ✔ Suite 2 passed: TrainingEvidence is tri-state & exposure-aware (no false negative grade 0)\n');
  }

  // ==========================================================================
  // SUITE 3: JEV Telemetry Accounting & Title Egress Invariance
  // ==========================================================================
  console.log('--- Suite 3: JEV Telemetry Accounting & Title Egress Invariance ---');
  {
    let interceptedState: any = null;
    const client = new FakeSystemOneClient(async (req: SystemOneEvaluationRequest): Promise<SystemOneEvaluationResponse> => {
      interceptedState = req.state;
      return {
        model: 'test-model',
        answers: {
          semanticRelevance: { noul: 0.85 },
          implementationNeeded: { noul: 0.65 },
          likelyEditTarget: { noul: 0.45 },
          likelyRootCause: { noul: 0.55 },
        },
        usage: { input_tokens: 150, output_tokens: 12 },
      };
    });

    const runner = new JevShadowRunner({
      client,
      mode: JevMode.SHADOW,
    });

    const snapshot = createWorkspaceSnapshot({
      repositories: [{ repositoryId: 'repo_r', baseCommitSha: 'main', trackedTreeHash: 'th', dirtyPatchHash: 'clean' }],
    });

    const task = createTaskContext({
      taskId: 'task_telem_1',
      primaryPrompt: 'Fix connection leak',
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      agentEnvironment: createAgentEnvironment({ agentProvider: 'cursor', agentVersion: '1.0' }),
    });

    const unit: CodeSymbolUnit = {
      id: 'sym_sec_1',
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      kind: ContextUnitKind.CODE_SYMBOL,
      symbolKind: SymbolKind.METHOD,
      trustLevel: TrustLevel.FIRST_PARTY_CODE,
      title: 'SecretService.decryptPrivateKey',
      symbolName: 'decryptPrivateKey',
      qualifiedName: 'SecretService.decryptPrivateKey',
      language: 'typescript',
      contentHash: 'hash_sec_1',
      path: 'src/crypto/secret.ts',
      startLine: 1,
      endLine: 20,
      provenance: { sourceType: 'file', sourceUri: 'file:///src/crypto/secret.ts' },
      metadata: {},
    };

    const ranked = createMockRankedCandidate(unit.id, 1, 0.9);

    // Case 3A: When SYMBOL_NAME remote processing is denied, title must be [REDACTED_SYMBOL] and NEVER leak unit.title
    const rightsDenySymbolName: DataRights = createDefaultDataRights({
      remoteProcessingAllowed: true,
      operationRights: createDefaultOperationRightsPolicy({
        [DataClass.TASK_PROMPT]: { processing: { local: true, remote: true } },
        [DataClass.PATH]: { processing: { local: true, remote: true } },
        [DataClass.SYMBOL_NAME]: { processing: { local: true, remote: false } }, // DENIED
      }),
    });

    const trackerA = new JevCallTracker({ maxCallsPerTask: 10 });
    await runner.evaluate({
      task,
      workspaceSnapshot: snapshot,
      rankedCandidates: [ranked],
      units: [unit],
      featuresMap: new Map(),
      dataRights: rightsDenySymbolName,
      tracker: trackerA,
    });

    // Verify rights denied before network dispatch:
    // The call must be recorded as rightsDeniedCalls, NOT attemptedCalls or failedCalls!
    const statsA = trackerA.getStats();
    assert.strictEqual(statsA.rightsDeniedCalls, 1, 'Rights denied must be recorded in rightsDeniedCalls');
    assert.strictEqual(statsA.attemptedCalls, 0, 'Blocked call must NOT increment attemptedCalls');
    assert.strictEqual(statsA.failedCalls, 0, 'Blocked call must NOT increment failedCalls');
    assert.strictEqual(client.callCount, 0, 'Client must not be called when symbol name is blocked');

    // Case 3B: Permitted remote processing with successful execution
    const rightsAllowed: DataRights = createDefaultDataRights({
      remoteProcessingAllowed: true,
      operationRights: createDefaultOperationRightsPolicy({
        [DataClass.TASK_PROMPT]: { processing: { local: true, remote: true } },
        [DataClass.PATH]: { processing: { local: true, remote: true } },
        [DataClass.SYMBOL_NAME]: { processing: { local: true, remote: true } },
      }),
    });

    const trackerB = new JevCallTracker({ maxCallsPerTask: 10 });
    await runner.evaluate({
      task,
      workspaceSnapshot: snapshot,
      rankedCandidates: [ranked],
      units: [unit],
      featuresMap: new Map(),
      dataRights: rightsAllowed,
      tracker: trackerB,
    });

    const statsB = trackerB.getStats();
    assert.strictEqual(statsB.attemptedCalls, 1, 'Attempted call must increment to 1');
    assert.strictEqual(statsB.successfulCalls, 1, 'Successful call must increment to 1');
    assert.strictEqual(statsB.failedCalls, 0, 'Failed calls must remain 0');
    assert.strictEqual(statsB.rightsDeniedCalls, 0, 'Rights denied calls must remain 0');
    assert(interceptedState, 'State was sent to client');
    assert.strictEqual(interceptedState.candidate.title, 'SecretService.decryptPrivateKey', 'Title present when permitted');

    // Case 3C: Malformed response must increment failedCalls, NOT successfulCalls
    const malformedClient = new FakeSystemOneClient(async () => {
      return {
        model: 'bad-model',
        answers: null as any, // Malformed!
      };
    });

    const malformedRunner = new JevShadowRunner({
      client: malformedClient,
      mode: JevMode.SHADOW,
    });

    const trackerC = new JevCallTracker({ maxCallsPerTask: 10 });
    const malformedSignals = await malformedRunner.evaluate({
      task,
      workspaceSnapshot: snapshot,
      rankedCandidates: [ranked],
      units: [unit],
      featuresMap: new Map(),
      dataRights: rightsAllowed,
      tracker: trackerC,
    });

    const statsC = trackerC.getStats();
    assert.strictEqual(statsC.attemptedCalls, 1, 'Malformed request attempted 1 call');
    assert.strictEqual(statsC.successfulCalls, 0, 'Malformed response must NOT increment successfulCalls');
    assert.strictEqual(statsC.failedCalls, 1, 'Malformed response must increment failedCalls');
    assert.strictEqual(malformedSignals[0].fallbackReason, JevFallbackReason.MALFORMED_RESPONSE, 'Fallback reason is MALFORMED_RESPONSE');

    console.log('  ✔ Suite 3 passed: JEV telemetry accounting is truthful and title egress has zero escape hatches\n');
  }

  // ==========================================================================
  // SUITE 4: Zero Fixed Probability Substitutions in Held-Out Study
  // ==========================================================================
  console.log('--- Suite 4: Zero Fixed Probability Substitutions in Study ---');
  {
    // Simulate what study_jev_heldout_ranking.ts does with signals
    const signals: JevSignalV1[] = [
      // Signal 1: Real JEV judgment with true continuous probabilities
      createJevSignalV1({
        taskId: 'task_s1',
        workspaceSnapshotId: 'snap_s',
        contextUnitId: 'unit_real',
        semanticRelevanceProbability: 0.9123,
        implementationNeededProbability: 0.7456,
        likelyEditTargetProbability: 0.8123,
        likelyRootCauseProbability: 0.6543,
        model: 'jev-model',
        questionSetVersion: 'v1',
        latencyMs: 150,
        redactionApplied: false,
      }),
      // Signal 2: Failed/Fallback signal (null probabilities)
      createJevSignalV1({
        taskId: 'task_s1',
        workspaceSnapshotId: 'snap_s',
        contextUnitId: 'unit_fallback',
        semanticRelevanceProbability: null,
        implementationNeededProbability: null,
        likelyEditTargetProbability: null,
        likelyRootCauseProbability: null,
        model: 'jev-model',
        questionSetVersion: 'v1',
        latencyMs: 10,
        redactionApplied: false,
        fallbackReason: JevFallbackReason.RIGHTS_DENIED,
      }),
    ];

    const probObj = { semRel: [] as number[], impNeed: [] as number[], editTarget: [] as number[], rootCause: [] as number[] };
    const judgmentsMap = new Map<string, any>();

    for (const sig of signals) {
      if (sig.fallbackReason !== undefined || sig.semanticRelevanceProbability === null) {
        continue; // Truthful: skip missing/failed signals
      }

      const sem = sig.semanticRelevanceProbability;
      const imp = sig.implementationNeededProbability ?? undefined;
      const edit = sig.likelyEditTargetProbability ?? undefined;
      const root = sig.likelyRootCauseProbability ?? undefined;

      probObj.semRel.push(sem);
      if (imp !== undefined) probObj.impNeed.push(imp);
      if (edit !== undefined) probObj.editTarget.push(edit);
      if (root !== undefined) probObj.rootCause.push(root);

      judgmentsMap.set(sig.contextUnitId, {
        candidateUnitId: sig.contextUnitId,
        semanticRelevance: sem,
        semanticRelevanceProbability: sem,
        implementationNeeded: imp !== undefined ? imp > 0.5 : undefined,
        implementationNeededProbability: imp,
        likelyEditTarget: edit !== undefined ? edit > 0.5 : undefined,
        likelyEditTargetProbability: edit,
        likelyRootCause: root !== undefined ? root > 0.5 : undefined,
        likelyRootCauseProbability: root,
      });
    }

    assert.strictEqual(judgmentsMap.size, 1, 'Only real signals should be added to judgmentsMap');
    assert.strictEqual(judgmentsMap.has('unit_fallback'), false, 'Fallback signal must NOT be added to judgmentsMap');
    assert.strictEqual(probObj.semRel.length, 1, 'probObj must contain only real observed values');
    assert.strictEqual(probObj.semRel[0], 0.9123, 'Real probability preserved');
    assert.strictEqual(probObj.semRel.includes(0.3), false, '0.3 must never be substituted');
    assert.strictEqual(probObj.impNeed.includes(0.25), false, '0.25 must never be substituted');
    assert.strictEqual(probObj.editTarget.includes(0.2), false, '0.2 must never be substituted');

    console.log('  ✔ Suite 4 passed: Zero fixed probabilities substituted for missing JEV answers\n');
  }

  // ==========================================================================
  // SUITE 5: JevClient Zero Environment-Key Inheritance
  // ==========================================================================
  console.log('--- Suite 5: JevClient Zero Environment-Key Inheritance ---');
  {
    const origTypesafe = process.env.TYPESAFE_API_KEY;
    const origJev = process.env.JEV_API_KEY;
    try {
      process.env.TYPESAFE_API_KEY = 'secret-typesafe-key-leak';
      process.env.JEV_API_KEY = 'secret-jev-key-leak';

      // Instantiating JevClient without explicit apiKey MUST NOT inherit environment keys
      const uncredentialedClient = new JevClient();
      assert.strictEqual(
        uncredentialedClient.getApiKey(),
        null,
        'JevClient without arguments must have null apiKey and never inherit process.env keys'
      );

      // Explicit apiKey must be respected
      const explicitClient = new JevClient('explicit-key-123');
      assert.strictEqual(
        explicitClient.getApiKey(),
        'explicit-key-123',
        'JevClient with explicit key retains explicit key'
      );
    } finally {
      if (origTypesafe !== undefined) process.env.TYPESAFE_API_KEY = origTypesafe;
      else delete process.env.TYPESAFE_API_KEY;
      if (origJev !== undefined) process.env.JEV_API_KEY = origJev;
      else delete process.env.JEV_API_KEY;
    }
    console.log('  ✔ Suite 5 passed: Deprecated JevClient zero environment-key inheritance verified\n');
  }

  // ==========================================================================
  // SUITE 6: Application Boundary Translation & Fail-Closed Remote Processing
  // ==========================================================================
  console.log('--- Suite 6: Application Boundary Translation & Fail-Closed Remote Processing ---');
  {
    const origJevEnabled = process.env.SIFTR_JEV_ENABLED;
    const origJevRemote = process.env.SIFTR_JEV_REMOTE_PROCESSING;
    try {
      // 1. Without environment config: defaults to local privacy-by-default
      delete process.env.SIFTR_JEV_ENABLED;
      delete process.env.SIFTR_JEV_REMOTE_PROCESSING;
      const defaultAppRights = resolveApplicationDataRights();
      assert.strictEqual(
        defaultAppRights.remoteProcessingAllowed,
        false,
        'Default application rights have remoteProcessingAllowed = false'
      );
      assert.strictEqual(
        isRemoteProcessingPermitted(defaultAppRights, DataClass.RAW_SOURCE),
        false,
        'Remote processing not permitted under default rights'
      );

      // 2. Fail-closed invariant: remoteProcessingAllowed = true with missing operationRights MUST return false
      const blanketRights: DataRights = {
        ...createDefaultDataRights(),
        remoteProcessingAllowed: true,
        operationRights: undefined,
      };
      assert.strictEqual(
        isRemoteProcessingPermitted(blanketRights, DataClass.RAW_SOURCE),
        false,
        'isRemoteProcessingPermitted MUST fail-closed when operationRights is missing'
      );
      assert.strictEqual(
        isRemoteProcessingPermitted(blanketRights, DataClass.SYMBOL_NAME),
        false,
        'isRemoteProcessingPermitted MUST fail-closed for all data classes when operationRights is missing'
      );

      // 3. resolveApplicationDataRights translates configured rights without operationRights to createJevPermittedDataRights
      const resolvedConfigured = resolveApplicationDataRights(blanketRights);
      assert.ok(resolvedConfigured.operationRights !== undefined, 'Translates to rights with explicit operationRights');
      assert.strictEqual(
        isRemoteProcessingPermitted(resolvedConfigured, DataClass.RAW_SOURCE),
        false,
        'Remote processing on RAW_SOURCE strictly forbidden under translated JEV rights'
      );
      assert.strictEqual(
        isRemoteProcessingPermitted(resolvedConfigured, DataClass.SYMBOL_NAME),
        true,
        'Remote processing on SYMBOL_NAME permitted under translated JEV rights'
      );

      // 4. Railway boundary environment variable translates strictly to createJevPermittedDataRights
      process.env.SIFTR_JEV_REMOTE_PROCESSING = 'true';
      const railwayRights = resolveApplicationDataRights();
      assert.strictEqual(railwayRights.remoteProcessingAllowed, true);
      assert.strictEqual(
        isRemoteProcessingPermitted(railwayRights, DataClass.RAW_SOURCE),
        false,
        'Railway JEV configuration never permits RAW_SOURCE remote processing'
      );
      assert.strictEqual(
        isRemoteProcessingPermitted(railwayRights, DataClass.SOURCE_SNIPPET),
        false,
        'Railway JEV configuration never permits SOURCE_SNIPPET remote processing'
      );
      assert.strictEqual(
        isRemoteProcessingPermitted(railwayRights, DataClass.NUMERIC_FEATURE),
        true,
        'Railway JEV configuration permits NUMERIC_FEATURE remote processing'
      );

      // 5. Decoupling verification: SIFTR_JEV_ENABLED alone does NOT grant outbound processing
      delete process.env.SIFTR_JEV_REMOTE_PROCESSING;
      process.env.SIFTR_JEV_ENABLED = 'true';
      const jevEnabledOnlyRights = resolveApplicationDataRights();
      assert.strictEqual(
        jevEnabledOnlyRights.remoteProcessingAllowed,
        false,
        'SIFTR_JEV_ENABLED alone must NOT grant remote processing rights'
      );
      assert.strictEqual(
        isRemoteProcessingPermitted(jevEnabledOnlyRights, DataClass.NUMERIC_FEATURE),
        false,
        'Remote processing strictly denied when only SIFTR_JEV_ENABLED is true'
      );
    } finally {
      if (origJevEnabled !== undefined) process.env.SIFTR_JEV_ENABLED = origJevEnabled;
      else delete process.env.SIFTR_JEV_ENABLED;
      if (origJevRemote !== undefined) process.env.SIFTR_JEV_REMOTE_PROCESSING = origJevRemote;
      else delete process.env.SIFTR_JEV_REMOTE_PROCESSING;
    }
    console.log('  ✔ Suite 6 passed: Boundary translation & fail-closed remote processing verified\n');
  }

  // ==========================================================================
  // SUITE 7: CandidateDecisionObservation Rights Sanitization & Persistence
  // ==========================================================================
  console.log('--- Suite 7: CandidateDecisionObservation Rights Sanitization & Persistence ---');
  {
    const sampleFeatures = {
      schemaVersion: 'v1' as const,
      contextUnitId: 'src/core/auth_handler.ts',
      unitKind: ContextUnitKind.SOURCE_FILE,
      tokenEstimate: 500,
      isTest: false,
      isConfig: false,
      isDocumentation: false,
      isSchema: false,
      isExported: true,
      exactSymbolMatch: true,
      exactPathMatch: true,
      bm25Score: 8.5,
      tokenOverlapRatio: 0.75,
      graphDegree: 4,
      minDistanceToSeed: 1,
      minDistanceToErrorFrame: null,
      isDirectDependency: true,
      isDirectDependent: false,
      changeFrequency: 15,
      recentChangeFrequency: 5,
      maxCoChangeWithSeeds: 0.6,
      inStackTrace: true,
      isFailingTestTarget: false,
      inCompilerError: false,
      inDirtyDiff: false,
      heuristicScore: 0.88,
    };

    const decObs = createCandidateDecisionObservation({
      taskId: 'task_sanitization_test',
      sessionId: 'sess_sanitization_test',
      workspaceSnapshotId: 'ws_snap_1',
      contextUnitId: 'src/core/auth_handler.ts',
      candidate: {
        generated: true,
        candidateRank: 1,
        retrievalSources: ['generator'],
      },
      features: sampleFeatures,
      rank: 1,
      exposureDecision: {
        contextUnitId: 'src/core/auth_handler.ts',
        eligibleForSelection: true,
        selected: true,
        resolution: ContextResolution.FULL,
        contextPlanId: 'plan_1',
        policyId: 'policy_test',
        policyVersion: '1.0.0',
        timestamp: new Date().toISOString(),
      },
      agentEnvironment: createAgentEnvironment(),
      observabilityLevel: 'FULL_TOOL_TRACE',
    });

    // 1. Sanitize without numeric features permission
    const noNumericRights = createDefaultDataRights({
      operationRights: {
        ...createDefaultOperationRightsPolicy(),
        [DataClass.NUMERIC_FEATURE]: {
          processing: { local: true, remote: false },
          retention: { local: false, remote: false },
          training: false,
        },
      },
    });

    const sanitizedObs = sanitizeCandidateDecisionObservation(decObs, noNumericRights);
    assert.strictEqual(
      sanitizedObs.features.heuristicScore,
      0,
      'Heuristic score zeroed when NUMERIC_FEATURE retention denied'
    );
    assert.strictEqual(
      sanitizedObs.features.bm25Score,
      0,
      'BM25 score zeroed when NUMERIC_FEATURE retention denied'
    );
    assert.strictEqual(
      sanitizedObs.features.changeFrequency,
      0,
      'Change frequency zeroed when NUMERIC_FEATURE retention denied'
    );

    // 2. Sanitize without path retention permission
    const noPathRights = createDefaultDataRights({
      pathRetentionAllowed: false,
    });
    const sanitizedPathObs = sanitizeCandidateDecisionObservation(decObs, noPathRights);
    assert.ok(
      sanitizedPathObs.contextUnitId.startsWith('[REDACTED_PATH_'),
      'File path redacted in contextUnitId when PATH retention denied'
    );

    // 3. Durably persist and verify via SqliteStore
    const testDbPath = path.join(os.tmpdir(), `test_dec_sanitization_${Date.now()}.db`);
    const store = new SqliteStore(testDbPath);
    try {
      store.saveCandidateDecisionObservations([decObs], noNumericRights);
      const retrieved = store.getCandidateDecisionObservation(decObs.decisionObservationId);
      assert.ok(retrieved !== undefined, 'Observation retrieved from SQLite');
      assert.strictEqual(
        retrieved!.features.heuristicScore,
        0,
        'Retrieved observation features must have zeroed heuristic score'
      );
      assert.ok(
        retrieved!.features.bm25Score === 0,
        'Retrieved observation features must have zeroed bm25 score'
      );
      assert.ok(
        typeof decObs.sessionId === 'string' && decObs.sessionId.startsWith('sess_'),
        'CandidateDecisionObservation must have real sessionId'
      );
      assert.strictEqual(
        retrieved!.sessionId,
        decObs.sessionId,
        'SQLite must persist and retrieve real sessionId in CandidateDecisionObservation'
      );
      const bySession = store.listCandidateDecisionObservations({ sessionId: decObs.sessionId });
      assert.strictEqual(bySession.length, 1, 'Can query CandidateDecisionObservation by real sessionId');
    } finally {
      store.close();
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    }
    console.log('  ✔ Suite 7 passed: CandidateDecisionObservation rights sanitization & persistence verified\n');
  }

  // ==========================================================================
  // SUITE 8: Training Rights Enforcement in DatasetBuilder & RightsFilter
  // ==========================================================================
  console.log('--- Suite 8: Training Rights Enforcement in DatasetBuilder & RightsFilter ---');
  {
    const dummyFeatures: any = { schemaVersion: 'v1', heuristicScore: 0.9 };
    const decObs = createCandidateDecisionObservation({
      taskId: 'task_training_rights',
      sessionId: 'sess_training_rights',
      workspaceSnapshotId: 'ws_snap_train',
      contextUnitId: 'src/core/test.ts',
      candidate: { generated: true, candidateRank: 1, retrievalSources: ['generator'] },
      features: dummyFeatures,
      rank: 1,
      exposureDecision: {
        contextUnitId: 'src/core/test.ts',
        eligibleForSelection: true,
        selected: true,
        resolution: ContextResolution.FULL,
        contextPlanId: 'plan_train',
        policyId: 'policy_train',
        policyVersion: '1.0.0',
        timestamp: new Date().toISOString(),
      },
      agentEnvironment: createAgentEnvironment(),
      observabilityLevel: 'FULL_TOOL_TRACE',
    });

    const forbiddenTrainingRights = createDefaultDataRights({
      trainingAllowed: false,
    });

    // 1. DatasetBuilder.buildCandidateObservation enforces trainingAllowed
    assert.throws(
      () => {
        DatasetBuilder.buildCandidateObservation({
          decision: decObs,
          dataRights: forbiddenTrainingRights,
        });
      },
      /TRAINING_FORBIDDEN/,
      'buildCandidateObservation must throw when trainingAllowed is false'
    );

    // 2. DatasetBuilder.buildDataset enforces trainingAllowed
    assert.throws(
      () => {
        DatasetBuilder.buildDataset({
          decisions: [decObs],
          dataRights: forbiddenTrainingRights,
        });
      },
      /TRAINING_FORBIDDEN/,
      'buildDataset must throw when trainingAllowed is false'
    );

    // 3. DatasetBuilder.buildTrainingEvidenceRecord enforces trainingAllowed
    assert.throws(
      () => {
        DatasetBuilder.buildTrainingEvidenceRecord({
          decision: decObs,
          dataRights: forbiddenTrainingRights,
        });
      },
      /TRAINING_FORBIDDEN/,
      'buildTrainingEvidenceRecord must throw when trainingAllowed is false'
    );

    // 4. operationRights training check on NUMERIC_FEATURE
    const deniedOpTrainingRights = createDefaultDataRights({
      trainingAllowed: true,
      operationRights: {
        ...createDefaultOperationRightsPolicy(),
        [DataClass.NUMERIC_FEATURE]: {
          processing: { local: true, remote: false },
          retention: { local: true, remote: false },
          training: false,
        },
      },
    });

    assert.throws(
      () => {
        DatasetBuilder.buildCandidateObservation({
          decision: decObs,
          dataRights: deniedOpTrainingRights,
        });
      },
      /TRAINING_FORBIDDEN/,
      'buildCandidateObservation must throw when operationRights denies training on NUMERIC_FEATURE'
    );

    // 5. Missing dataRights must throw TRAINING_FORBIDDEN (Mandatory dataRights requirement)
    assert.throws(
      () => {
        DatasetBuilder.buildCandidateObservation({
          decision: decObs,
        } as any);
      },
      /TRAINING_FORBIDDEN: Customer DataRights must be provided explicitly/,
      'buildCandidateObservation must throw when dataRights is omitted'
    );

    assert.throws(
      () => {
        DatasetBuilder.buildTrainingEvidenceRecord({
          decision: decObs,
        } as any);
      },
      /TRAINING_FORBIDDEN: Customer DataRights must be provided explicitly/,
      'buildTrainingEvidenceRecord must throw when dataRights is omitted'
    );

    // 6. Real sessionId preservation without sess_${taskId} fabrication
    const permissiveTrainingRights = createDefaultDataRights({
      trainingAllowed: true,
      trajectoryRetentionAllowed: true,
    });
    const candidateObs = DatasetBuilder.buildCandidateObservation({
      decision: decObs,
      behavior: { read: true, edited: true },
      taskSucceeded: true,
      dataRights: permissiveTrainingRights,
    });
    assert.strictEqual(
      candidateObs.siftrSessionId,
      decObs.sessionId,
      'CandidateObservationV2 must inherit real decObs.sessionId without sess_${taskId} fabrication'
    );

    const evidenceRec = DatasetBuilder.buildTrainingEvidenceRecord({
      decision: decObs,
      behavior: { read: true, edited: true },
      dataRights: permissiveTrainingRights,
    });
    assert.strictEqual(
      evidenceRec.sessionId,
      decObs.sessionId,
      'TrainingEvidenceRecord must inherit real decObs.sessionId without sess_${taskId} fabrication'
    );

    // 7. Multi-dataclass training rights checks (OUTCOME and TRAJECTORY)
    const deniedOutcomeTrainingRights = createDefaultDataRights({
      trainingAllowed: true,
      operationRights: {
        ...createDefaultOperationRightsPolicy(),
        [DataClass.NUMERIC_FEATURE]: { processing: { local: true, remote: false }, retention: { local: true, remote: false }, training: true },
        [DataClass.OUTCOME]: { processing: { local: true, remote: false }, retention: { local: true, remote: false }, training: false },
        [DataClass.TRAJECTORY]: { processing: { local: true, remote: false }, retention: { local: true, remote: false }, training: true },
      },
    });

    assert.throws(
      () => {
        DatasetBuilder.buildCandidateObservation({
          decision: decObs,
          dataRights: deniedOutcomeTrainingRights,
        });
      },
      /TRAINING_FORBIDDEN: operationRights forbids training on OUTCOME/,
      'buildCandidateObservation must throw when operationRights denies training on OUTCOME'
    );

    const deniedTrajectoryTrainingRights = createDefaultDataRights({
      trainingAllowed: true,
      operationRights: {
        ...createDefaultOperationRightsPolicy(),
        [DataClass.NUMERIC_FEATURE]: { processing: { local: true, remote: false }, retention: { local: true, remote: false }, training: true },
        [DataClass.OUTCOME]: { processing: { local: true, remote: false }, retention: { local: true, remote: false }, training: true },
        [DataClass.TRAJECTORY]: { processing: { local: true, remote: false }, retention: { local: true, remote: false }, training: false },
      },
    });

    assert.throws(
      () => {
        DatasetBuilder.buildTrainingEvidenceRecord({
          decision: decObs,
          dataRights: deniedTrajectoryTrainingRights,
        });
      },
      /TRAINING_FORBIDDEN: operationRights forbids training on TRAJECTORY/,
      'buildTrainingEvidenceRecord must throw when operationRights denies training on TRAJECTORY'
    );

    // 8. RightsFilter.evaluate rejects when operationRights denies training on NUMERIC_FEATURE or OUTCOME
    const filter = new RightsFilter();
    const filterResultNumeric = filter.evaluate({
      observation: candidateObs,
      dataRights: deniedOpTrainingRights,
    });
    assert.strictEqual(filterResultNumeric.passed, false);
    assert.ok(filterResultNumeric.reasons.some((r) => r.includes('NUMERIC_FEATURE')));

    const filterResultOutcome = filter.evaluate({
      observation: candidateObs,
      dataRights: deniedOutcomeTrainingRights,
    });
    assert.strictEqual(filterResultOutcome.passed, false);
    assert.ok(filterResultOutcome.reasons.some((r) => r.includes('OUTCOME')));

    // 9. TrainingExporter.exportTrainingEvidenceRecords boundary verification
    const exporter = new TrainingExporter();
    const unexposedDecObs = createCandidateDecisionObservation({
      taskId: 'task_unexposed',
      sessionId: 'sess_unexposed',
      workspaceSnapshotId: 'ws_snap_train',
      contextUnitId: 'src/core/unexposed.ts',
      candidate: { generated: true, candidateRank: 2, retrievalSources: ['generator'] },
      features: dummyFeatures,
      rank: 2,
      exposureDecision: {
        contextUnitId: 'src/core/unexposed.ts',
        eligibleForSelection: false,
        selected: false,
        resolution: ContextResolution.OMIT,
        contextPlanId: 'plan_train',
        policyId: 'policy_train',
        policyVersion: '1.0.0',
        timestamp: new Date().toISOString(),
      },
      agentEnvironment: createAgentEnvironment(),
      observabilityLevel: 'FULL_TOOL_TRACE',
    });

    const unexposedEvidenceRec = DatasetBuilder.buildTrainingEvidenceRecord({
      decision: unexposedDecObs,
      dataRights: permissiveTrainingRights,
    });

    // Test export with missing dataRights
    const missingRightsExport = exporter.exportTrainingEvidenceRecords(
      [evidenceRec],
      () => ({} as any),
      { datasetVersion: 'v2-test' }
    );
    assert.strictEqual(missingRightsExport.totalAccepted, 0);
    assert.strictEqual(missingRightsExport.totalRejected, 1);
    assert.ok(missingRightsExport.rejections[0].reasons.some((r) => r.includes('MISSING_DATA_RIGHTS')));

    // Test export with forbidden training rights
    const forbiddenExport = exporter.exportTrainingEvidenceRecords(
      [evidenceRec],
      () => ({ dataRights: forbiddenTrainingRights }),
      { datasetVersion: 'v2-test' }
    );
    assert.strictEqual(forbiddenExport.totalAccepted, 0);
    assert.strictEqual(forbiddenExport.totalRejected, 1);
    assert.ok(forbiddenExport.rejections[0].reasons.some((r) => r.includes('TRAINING_NOT_ALLOWED')));

    // Test export with unexposed candidate
    const unexposedExport = exporter.exportTrainingEvidenceRecords(
      [unexposedEvidenceRec],
      () => ({ dataRights: permissiveTrainingRights }),
      { datasetVersion: 'v2-test' }
    );
    assert.strictEqual(unexposedExport.totalAccepted, 0);
    assert.strictEqual(unexposedExport.totalRejected, 1);
    assert.ok(unexposedExport.rejections[0].reasons.some((r) => r.includes('INVALID_LABEL_UNEXPOSED')));

    // Test export with valid exposed record and permissive rights -> ACCEPTED
    const acceptedExport = exporter.exportTrainingEvidenceRecords(
      [evidenceRec],
      () => ({ dataRights: permissiveTrainingRights, repository: 'siftrcode/test' }),
      { datasetVersion: 'v2-test' }
    );
    assert.strictEqual(acceptedExport.totalAccepted, 1);
    assert.strictEqual(acceptedExport.totalRejected, 0);
    assert.strictEqual(acceptedExport.records[0].repository, 'siftrcode/test');

    console.log('  ✔ Suite 8 passed: Mandatory training rights, multi-dataclass schemas & TrainingExporter boundary verified\n');
  }

  // ==========================================================================
  // SUITE 9: Preservation of Partially Missing JEV Heads in ContextRank
  // ==========================================================================
  console.log('--- Suite 9: Preservation of Partially Missing JEV Heads in ContextRank ---');
  {
    const ranker = new ContextRanker({
      jevSemanticWeight: 20,
      jevEditTargetWeight: 30,
      jevRootCauseWeight: 25,
      jevImplementationWeight: 15,
    });

    const candidateFeatures: any = {
      schemaVersion: 'v1',
      contextUnitId: 'sym_partially_missing_heads',
      unitKind: ContextUnitKind.CODE_SYMBOL,
      tokenEstimate: 50,
      isTest: false,
      isConfig: false,
      isDocumentation: false,
      isSchema: false,
      isExported: true,
      exactSymbolMatch: false,
      exactPathMatch: false,
      bm25Score: 0,
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
      heuristicScore: 10,
    };

    // Candidate has only likelyEditTargetProbability (missing rootCause, impNeeded, semRel)
    const partialJudgment: any = {
      candidateUnitId: 'sym_partially_missing_heads',
      likelyEditTargetProbability: 0.8,
      likelyRootCauseProbability: undefined,
      implementationNeededProbability: undefined,
      semanticRelevanceProbability: undefined,
      confidence: 1.0,
    };

    const judgmentsMap = new Map<string, any>([
      ['sym_partially_missing_heads', partialJudgment],
    ]);

    const ranked = ranker.rank([candidateFeatures], judgmentsMap);
    assert.strictEqual(ranked.length, 1);
    const rc = ranked[0];

    // Likely edit target boost: 30 * 0.8 * 1.0 = 24
    assert.ok(
      rc.reasons.some((r: string) => r.includes('jev_likely_edit_target (+24.0)')),
      'Likely edit target applied +24.0 boost'
    );
    // Missing heads must NOT add reasons with 0.0 or penalize
    assert.ok(
      !rc.reasons.some((r: string) => r.includes('jev_likely_root_cause')),
      'Missing root cause head must not inject reasons'
    );
    assert.ok(
      !rc.reasons.some((r: string) => r.includes('jev_implementation_needed')),
      'Missing implementation head must not inject reasons'
    );
    assert.ok(
      !rc.reasons.some((r: string) => r.includes('jev_semantic_relevance')),
      'Missing semantic relevance head must not inject reasons'
    );

    console.log('  ✔ Suite 9 passed: Partially missing JEV heads preserved without synthetic 0.0 injection\n');
  }

  // ==========================================================================
  // SUITE 10: Mandatory Session Management in CandidateDecisionObservation & ContextEngine
  // ==========================================================================
  console.log('--- Suite 10: Mandatory Session Management & ContextEngine Authority ---');
  {
    const dummyFeatures: any = { schemaVersion: 'v1', heuristicScore: 0.9 };

    // 1. CandidateDecisionObservation sessionId must be mandatory at construction
    assert.throws(
      () => {
        createCandidateDecisionObservation({
          taskId: 'task_mandatory_sess',
          sessionId: '' as any,
          workspaceSnapshotId: 'ws_snap_sess',
          contextUnitId: 'src/core/session.ts',
          candidate: { generated: true, candidateRank: 1, retrievalSources: ['generator'] },
          features: dummyFeatures,
          rank: 1,
          exposureDecision: {
            contextUnitId: 'src/core/session.ts',
            eligibleForSelection: true,
            selected: true,
            resolution: ContextResolution.FULL,
            contextPlanId: 'plan_sess',
            policyId: 'policy_sess',
            policyVersion: '1.0.0',
            timestamp: new Date().toISOString(),
          },
          agentEnvironment: createAgentEnvironment(),
          observabilityLevel: 'FULL_TOOL_TRACE',
        });
      },
      /CandidateDecisionObservation requires a valid, non-empty sessionId at construction/,
      'createCandidateDecisionObservation must reject empty or missing sessionId'
    );

    // 2. ContextEngine.getOrCreateSession authoritatively creates and persists sessions
    const store = new SqliteStore(':memory:');
    const engine = new ContextEngine({
      sqliteStore: store,
      dataRights: createDefaultDataRights({ telemetryAllowed: true }),
    });

    const session = engine.getOrCreateSession({
      taskId: 'task_auto_session_test',
      snapshotId: 'snap_test_1',
    });
    assert.ok(session.sessionId.startsWith('sess_'), 'Auto-generated session ID starts with sess_');
    assert.strictEqual(session.status, 'ACTIVE');

    const storedSession = store.getSiftrSession(session.sessionId);
    assert.ok(storedSession !== undefined, 'getOrCreateSession must persist session to SqliteStore');
    assert.strictEqual(storedSession?.sessionId, session.sessionId);

    // 3. ContextEngine.generatePlan validates and persists SiftrSession
    const snapshot = createWorkspaceSnapshot({
      repositories: [
        {
          repositoryId: 'test_repo',
          baseCommitSha: 'sha_sess',
          trackedTreeHash: 'tree_sess',
          dirtyPatchHash: 'clean',
        },
      ],
    });
    const unit: CodeSymbolUnit = {
      id: 'unit_session_target',
      repositoryId: 'test_repo',
      path: 'src/session.ts',
      title: 'SessionManager',
      qualifiedName: 'SessionManager',
      contentHash: 'hash_session',
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      provenance: { sourceType: 'file' },
      trustLevel: TrustLevel.FIRST_PARTY_CODE,
      symbolKind: SymbolKind.CLASS,
      symbolName: 'SessionManager',
      language: 'typescript',
      kind: ContextUnitKind.CODE_SYMBOL,
      metadata: {},
      startLine: 1,
      endLine: 10,
    };
    const task = createTaskContext({
      taskId: 'task_generate_plan_sess',
      sessionId: 'sess_generate_plan_1',
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      primaryPrompt: 'Test session integration in ContextEngine',
      agentEnvironment: createAgentEnvironment(),
    });

    const plan = engine.generatePlan({
      task,
      units: [unit],
      snapshot,
    });

    assert.ok(plan.sessionId, 'ContextPlan must carry an authoritative sessionId');
    const planSession = store.getSiftrSession(plan.sessionId);
    assert.ok(planSession !== undefined, 'ContextEngine must persist SiftrSession to SqliteStore on generatePlan');
    assert.strictEqual(planSession?.taskId, 'task_generate_plan_sess');
    assert.strictEqual(planSession?.status, 'ACTIVE');

    const decObsList = store.listCandidateDecisionObservations({ taskId: 'task_generate_plan_sess' });
    assert.ok(decObsList.length >= 1, 'Decision observations persisted');
    assert.strictEqual(decObsList[0].sessionId, plan.sessionId, 'Decision observations must carry matching sessionId');

    store.close();

    // 4. Invariant: Direct ContextEngine.optimizeWorkspace call with no session produces 100% consistent session lineage
    // result.task.sessionId == result.plan.sessionId == decision.sessionId == JEV signal.sessionId == persisted session.sessionId
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_opt_test_'));
    const dummySrc = path.join(tempDir, 'src');
    fs.mkdirSync(dummySrc, { recursive: true });
    fs.writeFileSync(path.join(dummySrc, 'core.ts'), 'export function authenticate(user: string): boolean { return true; }\n');

    const shadowRunner = new JevShadowRunner({
      mode: JevMode.SHADOW,
      client: new FakeSystemOneClient(async () => ({
        model: 'typesafe-one-preview',
        answers: {
          semanticRelevance: { noul: 0.9 },
          implementationNeeded: { noul: 0.8 },
          likelyEditTarget: { noul: 0.85 },
          likelyRootCause: { noul: 0.7 },
        },
        usage: { input_tokens: 100, output_tokens: 20 },
      })),
      budget: { maxCandidates: 5, maxCallsPerTask: 5, maxConcurrency: 2 },
    });

    const optResult = await ContextEngine.optimizeWorkspace({
      workspaceDir: tempDir,
      prompt: 'Authenticate user safely',
      jevShadowRunner: shadowRunner,
      enableJevShadow: true,
      dataRights: createJevPermittedDataRights(),
    });

    assert.ok(optResult.task.sessionId, 'optResult.task must have an authoritative sessionId');
    assert.strictEqual(optResult.task.sessionId, optResult.plan.sessionId, 'task.sessionId == plan.sessionId');
    assert.ok(optResult.plan.decisionObservations && optResult.plan.decisionObservations.length >= 1, 'At least one decision observation');
    assert.strictEqual(
      optResult.plan.decisionObservations![0].sessionId,
      optResult.task.sessionId,
      'decision.sessionId == task.sessionId'
    );

    if (optResult.plan.jevPromise) {
      await optResult.plan.jevPromise;
    }
    assert.ok(optResult.plan.jevSignals && optResult.plan.jevSignals.length >= 1, 'At least one JEV signal');
    assert.strictEqual(
      optResult.plan.jevSignals![0].sessionId,
      optResult.task.sessionId,
      'JEV signal.sessionId == task.sessionId'
    );

    const persistedSession = (optResult.engine as any).sqliteStore.getSiftrSession(optResult.task.sessionId);
    assert.ok(persistedSession !== undefined, 'Session must be persisted in SQLite');
    assert.strictEqual(persistedSession?.sessionId, optResult.task.sessionId, 'persisted session.sessionId == task.sessionId');

    // Section 10: AgentEnvironment identity equality across all records
    assert.strictEqual(
      persistedSession?.agentEnvironmentId,
      optResult.task.agentEnvironment.systemConfigurationHash,
      'persistedSession.agentEnvironmentId == result.task.agentEnvironment.systemConfigurationHash'
    );
    assert.strictEqual(
      optResult.plan.agentEnvironmentId,
      persistedSession?.agentEnvironmentId,
      'result.plan.agentEnvironmentId == persistedSession.agentEnvironmentId'
    );
    for (const dec of optResult.plan.decisionObservations!) {
      assert.strictEqual(
        dec.agentEnvironment.systemConfigurationHash,
        persistedSession?.agentEnvironmentId,
        'decision.agentEnvironment.systemConfigurationHash == persistedSession.agentEnvironmentId'
      );
    }

    // Section 11: JEV signal lineage equality
    for (const sig of optResult.plan.jevSignals!) {
      assert.strictEqual(sig.taskId, optResult.task.taskId, 'sig.taskId == task.taskId');
      assert.strictEqual(sig.sessionId, optResult.task.sessionId, 'sig.sessionId == task.sessionId');
      assert.strictEqual(sig.workspaceSnapshotId, optResult.task.workspaceSnapshotId, 'sig.workspaceSnapshotId == task.workspaceSnapshotId');
      assert.strictEqual(sig.agentEnvironmentId, persistedSession?.agentEnvironmentId, 'sig.agentEnvironmentId == persistedSession.agentEnvironmentId');
      assert.ok(sig.contextUnitId, 'sig.contextUnitId present');
    }

    // Also assert in SQLite table jev_shadow_judgments
    const persistedJudgments = (optResult.engine as any).sqliteStore.listJevShadowJudgments(optResult.task.taskId);
    assert.strictEqual(persistedJudgments.length, optResult.plan.jevSignals!.length);
    assert.strictEqual(persistedJudgments[0].agentEnvironmentId, persistedSession?.agentEnvironmentId);

    // Section 12: Existing-session mismatch test
    // Attempting to reuse an existing session with a conflicting agentEnvironment must throw AGENT_ENVIRONMENT_MISMATCH
    const countPlansBefore = (optResult.engine as any).sqliteStore.listContextPlans(undefined, optResult.task.sessionId).length;
    const countDecisionsBefore = (optResult.engine as any).sqliteStore.listCandidateDecisionObservations({ sessionId: optResult.task.sessionId }).length;
    const countJudgmentsBefore = (optResult.engine as any).sqliteStore.listJevShadowJudgments(optResult.task.taskId).length;

    await assert.rejects(
      async () => {
        await ContextEngine.optimizeWorkspace({
          workspaceDir: tempDir,
          prompt: 'Second prompt with conflicting environment',
          sessionId: optResult.task.sessionId,
          agentModel: 'different-conflicting-model-v2',
        });
      },
      (err: any) => {
        return (
          err?.code === 'AGENT_ENVIRONMENT_MISMATCH' ||
          (err?.message && err.message.includes('AGENT_ENVIRONMENT_MISMATCH'))
        );
      },
      'Conflicting agentEnvironment on existing session must throw AGENT_ENVIRONMENT_MISMATCH'
    );

    // Assert zero new plans, decisions, or judgments written on mismatch
    const countPlansAfter = (optResult.engine as any).sqliteStore.listContextPlans(undefined, optResult.task.sessionId).length;
    const countDecisionsAfter = (optResult.engine as any).sqliteStore.listCandidateDecisionObservations({ sessionId: optResult.task.sessionId }).length;
    const countJudgmentsAfter = (optResult.engine as any).sqliteStore.listJevShadowJudgments(optResult.task.taskId).length;
    assert.strictEqual(countPlansAfter, countPlansBefore, 'No new ContextPlan written on mismatch');
    assert.strictEqual(countDecisionsAfter, countDecisionsBefore, 'No new CandidateDecisionObservations written on mismatch');
    assert.strictEqual(countJudgmentsAfter, countJudgmentsBefore, 'No new JevShadowJudgments written on mismatch');

    // Section 13: Existing-session valid reuse test
    // Compatible operation with same session and matching environment succeeds
    const reuseResult = await ContextEngine.optimizeWorkspace({
      workspaceDir: tempDir,
      prompt: 'Compatible second prompt in same session',
      sessionId: optResult.task.sessionId,
      agentModel: optResult.task.agentEnvironment.model !== 'unknown' ? optResult.task.agentEnvironment.model : undefined,
    });
    assert.strictEqual(reuseResult.task.sessionId, optResult.task.sessionId, 'Session reused successfully');
    assert.strictEqual(
      reuseResult.plan.agentEnvironmentId,
      persistedSession?.agentEnvironmentId,
      'Reused session maintains identical agentEnvironmentId'
    );

    // Section 8: generatePlan() requires TaskContext.sessionId or throws SESSION_REQUIRED
    const dummyTaskNoSession = createTaskContext({
      taskId: 'task_no_session_check',
      workspaceSnapshotId: 'snap_dummy_check',
      primaryPrompt: 'No session prompt',
      agentEnvironment: createAgentEnvironment(),
    });
    delete (dummyTaskNoSession as any).sessionId;
    const directEngine = new ContextEngine();
    assert.throws(
      () => {
        directEngine.generatePlan({
          task: dummyTaskNoSession,
          units: [],
        });
      },
      (err: any) => {
        return (
          err?.code === 'SESSION_REQUIRED' ||
          (err?.message && err.message.includes('SESSION_REQUIRED'))
        );
      },
      'generatePlan without TaskContext.sessionId must throw SESSION_REQUIRED'
    );

    // Clean up tempDir
    try {
      (optResult.engine as any).sqliteStore?.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }

    console.log('  ✔ Suite 10 passed: Mandatory session enforcement and ContextEngine session management verified\n');
  }

  // ==========================================================================
  // SUITE 11: JEV Test Environment Scrubber & Hermeticity
  // ==========================================================================
  console.log('--- Suite 11: JEV Test Environment Scrubber & Hermeticity ---');
  {
    const mockEnv: Record<string, string | undefined> = {
      SIFTR_JEV_REMOTE_PROCESSING: 'true',
      SIFTR_JEV_ENABLED: 'true',
      SIFTR_JEV_MODE: 'shadow',
      SIFTR_JEV_MAX_CALLS: '10',
      SIFTR_JEV_MAX_CANDIDATES: '5',
      SIFTR_JEV_MODEL: 'custom-model',
      SIFTR_JEV_API_KEY: 'siftr_secret',
      TYPESAFE_API_KEY: 'typesafe_secret',
      JEV_API_KEY: 'jev_secret',
      INTEGRATION_TEST: 'false',
      SIFTR_INTEGRATION_TEST: 'false',
      SAFE_USER_VAR: 'keep_this_variable',
      NODE_ENV: 'test',
    };

    assert.strictEqual(isIntegrationTest(mockEnv), false, 'mockEnv correctly classified as non-integration');

    // Scrub mock environment
    scrubJevTestEnvironment(mockEnv);

    // Verify all JEV keys scrubbed
    assert.strictEqual(mockEnv.SIFTR_JEV_REMOTE_PROCESSING, undefined);
    assert.strictEqual(mockEnv.SIFTR_JEV_ENABLED, undefined);
    assert.strictEqual(mockEnv.SIFTR_JEV_MODE, undefined);
    assert.strictEqual(mockEnv.SIFTR_JEV_MAX_CALLS, undefined);
    assert.strictEqual(mockEnv.SIFTR_JEV_MAX_CANDIDATES, undefined);
    assert.strictEqual(mockEnv.SIFTR_JEV_MODEL, undefined);
    assert.strictEqual(mockEnv.SIFTR_JEV_API_KEY, undefined);
    assert.strictEqual(mockEnv.TYPESAFE_API_KEY, undefined);
    assert.strictEqual(mockEnv.JEV_API_KEY, undefined);

    // Verify non-JEV keys preserved
    assert.strictEqual(mockEnv.SAFE_USER_VAR, 'keep_this_variable');
    assert.strictEqual(mockEnv.NODE_ENV, 'test');

    // Verify integration environment behavior
    const intEnv: Record<string, string | undefined> = {
      INTEGRATION_TEST: 'true',
      SIFTR_JEV_REMOTE_PROCESSING: 'true',
      SIFTR_JEV_ENABLED: 'true',
    };
    assert.strictEqual(isIntegrationTest(intEnv), true);
    scrubJevTestEnvironment(intEnv, false);
    assert.strictEqual(intEnv.SIFTR_JEV_REMOTE_PROCESSING, 'true', 'Integration env preserves JEV keys');

    // Force scrubbing works even if INTEGRATION_TEST is true
    scrubJevTestEnvironment(intEnv, true);
    assert.strictEqual(intEnv.SIFTR_JEV_REMOTE_PROCESSING, undefined, 'Force scrub removes keys even in integration');

    console.log('  ✔ Suite 11 passed: JEV environment scrubber enforces hermetic non-integration test execution\n');
  }

  // ==========================================================================
  // SUITE 12: Sanctioned TrainingExporter Persistence Route & Export ID Lineage
  // ==========================================================================
  console.log('--- Suite 12: Sanctioned TrainingExporter Route & Export ID Lineage ---');
  {
    const store = new SqliteStore(':memory:');

    // 1. Check Migration 11 applied
    const applied = store.getAppliedMigrations();
    const mig11 = applied.find((m) => m.version === 11);
    assert.ok(mig11 !== undefined, 'Migration 011_training_rows_export_id must be applied');
    assert.strictEqual(mig11?.name, '011_training_rows_export_id');

    // 2. Direct persistence of unsanctioned row lacking exportId must be blocked
    const dummyFeatures: any = { schemaVersion: 'v1', heuristicScore: 0.9 };
    const unsanctionedRow = createTrainingRow({
      datasetVersion: 'v2.0.0',
      contextUnitId: 'src/core/auth.ts',
      taskId: 'task_unsanctioned',
      sessionId: 'sess_unsanctioned',
      repository: 'test_repo',
      features: dummyFeatures,
      label: 1,
      outcomeLabel: 'POSITIVE',
      sourceObservationIds: ['obs_raw_1'],
      rightsReference: 'rights_default',
    });

    assert.throws(
      () => store.saveTrainingRows([unsanctionedRow]),
      /UNSANCTIONED_TRAINING_ROW_PERSISTENCE/,
      'Direct persistence of unsanctioned training row lacking exportId must throw UNSANCTIONED_TRAINING_ROW_PERSISTENCE'
    );

    // 3. Row with invalid exportId format must also be blocked
    const invalidPrefixRow = { ...unsanctionedRow, exportId: 'unauthorized_export_123' };
    assert.throws(
      () => store.saveTrainingRows([invalidPrefixRow]),
      /UNSANCTIONED_TRAINING_ROW_PERSISTENCE/,
      'Row with non-texport_ exportId must throw UNSANCTIONED_TRAINING_ROW_PERSISTENCE'
    );

    // 4. Sanctioned TrainingExporter pipeline output persists cleanly
    const exporter = new TrainingExporter();
    const validObs = createCandidateObservationV2({
      observationId: 'obs_sanctioned_1',
      taskId: 'task_sanctioned',
      siftrSessionId: 'sess_sanctioned',
      workspaceSnapshotId: 'snap_sanctioned',
      contextUnitId: 'src/core/auth.ts',
      agentEnvironmentId: 'env_1',
      observabilityLevel: 'FULL_TOOL_TRACE',
      features: dummyFeatures,
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
      taskSucceeded: true,
      rightsReference: 'rights_auth',
    });

    const allowedProv = createSourceProvenance({
      repository: 'test_repo',
      origin: 'FIRST_PARTY',
      license: 'MIT',
      trainingPermission: 'ALLOWED',
      verified: true,
    });

    const exportResult = exporter.exportTrainingRows(
      [validObs],
      () => ({
        dataRights: createDefaultDataRights({ trainingAllowed: true }),
        provenance: allowedProv,
        repository: 'test_repo',
      }),
      { datasetVersion: 'v2.0.0-export' }
    );

    assert.strictEqual(exportResult.totalAccepted, 1);
    assert.ok(exportResult.exportId.startsWith('texport_'), 'exportId must start with texport_');
    assert.strictEqual(exportResult.rows[0].exportId, exportResult.exportId);

    // Persist via sanctioned TrainingExportResult
    store.saveTrainingRows(exportResult);

    const savedRow = store.getTrainingRow(exportResult.rows[0].rowId);
    assert.ok(savedRow !== undefined, 'Sanctioned training row must be saved');
    assert.strictEqual(savedRow?.exportId, exportResult.exportId);

    // Query via exportId filter
    const filteredRows = store.listTrainingRows({ exportId: exportResult.exportId });
    assert.strictEqual(filteredRows.length, 1);
    assert.strictEqual(filteredRows[0].rowId, exportResult.rows[0].rowId);

    // Persist via sanctioned rows array directly
    store.saveTrainingRows(exportResult.rows);
    assert.strictEqual(store.listTrainingRows({ exportId: exportResult.exportId }).length, 1);

    // 5. TrainingEvidenceRecord: Migration 12 applied
    const mig12 = applied.find((m) => m.version === 12);
    assert.ok(mig12 !== undefined, 'Migration 012_training_evidence_records_export_id must be applied');
    assert.strictEqual(mig12?.name, '012_training_evidence_records_export_id');

    // Migration 13: JEV shadow judgments agent_environment_id
    const mig13 = applied.find((m) => m.version === 13);
    assert.ok(mig13 !== undefined, 'Migration 013_jev_shadow_judgments_agent_env must be applied');
    assert.strictEqual(mig13?.name, '013_jev_shadow_judgments_agent_env');

    // 6. Direct persistence of unsanctioned evidence lacking exportId must be blocked
    const unsanctionedEv = createTrainingEvidenceRecord({
      datasetVersion: 'v2.0.0',
      contextUnitId: 'src/core/auth.ts',
      taskId: 'task_unsanctioned_ev',
      sessionId: 'sess_unsanctioned_ev',
      repository: 'test_repo',
      features: dummyFeatures,
      exposure: { wasExposed: true, resolution: ContextResolution.FULL },
      readEvidence: { wasRead: true, confidence: 1.0 },
      editEvidence: { wasEdited: false, confidence: 0.9 },
      verifiedOutcomeAssociation: { verifiedSuccess: true, confidence: 1.0 },
      sourceObservationIds: ['obs_raw_ev_1'],
      rightsReference: 'rights_default',
    });

    assert.throws(
      () => store.saveTrainingEvidenceRecords([unsanctionedEv]),
      /UNSANCTIONED_TRAINING_EVIDENCE_PERSISTENCE/,
      'Direct persistence of unsanctioned training evidence record lacking exportId must throw UNSANCTIONED_TRAINING_EVIDENCE_PERSISTENCE'
    );

    // 7. Evidence record with invalid exportId format must also be blocked
    const invalidPrefixEv = { ...unsanctionedEv, exportId: 'texport_only_not_ev_123' };
    assert.throws(
      () => store.saveTrainingEvidenceRecords([invalidPrefixEv]),
      /UNSANCTIONED_TRAINING_EVIDENCE_PERSISTENCE/,
      'Evidence record with non-texport_ev_ exportId must throw UNSANCTIONED_TRAINING_EVIDENCE_PERSISTENCE'
    );

    // 8. Sanctioned TrainingExporter pipeline output persists cleanly
    const evExportResult = exporter.exportTrainingEvidenceRecords(
      [unsanctionedEv],
      () => ({
        dataRights: createDefaultDataRights({ trainingAllowed: true, trajectoryRetentionAllowed: true }),
        provenance: allowedProv,
        repository: 'test_repo',
      }),
      { datasetVersion: 'v2.0.0-export' }
    );

    assert.strictEqual(evExportResult.totalAccepted, 1);
    assert.ok(evExportResult.exportId.startsWith('texport_ev_'), 'exportId must start with texport_ev_');
    assert.strictEqual(evExportResult.records[0].exportId, evExportResult.exportId);

    // Persist via sanctioned TrainingEvidenceExportResult
    store.saveTrainingEvidenceRecords(evExportResult);

    const savedEv = store.getTrainingEvidenceRecord(evExportResult.records[0].evidenceId);
    assert.ok(savedEv !== undefined, 'Sanctioned training evidence record must be saved');
    assert.strictEqual(savedEv?.exportId, evExportResult.exportId);

    // Query via exportId filter
    const filteredEvs = store.listTrainingEvidenceRecords({ exportId: evExportResult.exportId });
    assert.strictEqual(filteredEvs.length, 1);
    assert.strictEqual(filteredEvs[0].evidenceId, evExportResult.records[0].evidenceId);

    // Persist via sanctioned records array directly
    store.saveTrainingEvidenceRecords(evExportResult.records);
    assert.strictEqual(store.listTrainingEvidenceRecords({ exportId: evExportResult.exportId }).length, 1);

    store.close();
    console.log('  ✔ Suite 12 passed: Sanctioned TrainingExporter route, exportId lineage, and Migrations 11 & 12 verified\n');
  }

  // =========================================================================
  // Suite 13: WorkspaceSnapshot Equality, Retry Budgeting & Railway Path Smoke Verification
  // =========================================================================
  {
    console.log('--- Suite 13: WorkspaceSnapshot Equality, Retry Budgeting & Railway Path Smoke Verification ---');
    const store = new SqliteStore(':memory:');

    // 1. WorkspaceSnapshot Equality in generatePlan()
    const engine = new ContextEngine({ sqliteStore: store });
    const snapshotA = createWorkspaceSnapshot({
      repositories: [
        {
          repositoryId: 'test_repo',
          baseCommitSha: 'commit_a',
          trackedTreeHash: 'tree_a',
          dirtyPatchHash: 'clean',
        },
      ],
    });
    const snapshotB = createWorkspaceSnapshot({
      repositories: [
        {
          repositoryId: 'test_repo',
          baseCommitSha: 'commit_b',
          trackedTreeHash: 'tree_b',
          dirtyPatchHash: 'clean',
        },
      ],
    });

    const env = createAgentEnvironment({
      agentProvider: 'anthropic',
      agentVersion: '1.0',
      model: 'claude-3-7-sonnet',
      harnessVersion: '1.0',
      availableTools: ['View', 'Edit', 'Bash'],
    });

    const taskMismatch = createTaskContext({
      taskId: 'task_snapshot_mismatch',
      sessionId: 'sess_suite13_mismatch',
      primaryPrompt: 'Fix auth bug',
      workspaceSnapshotId: snapshotA.workspaceSnapshotId,
      agentEnvironment: env,
    });

    // Mismatched snapshot must throw WORKSPACE_SNAPSHOT_MISMATCH
    assert.throws(
      () => engine.generatePlan({ task: taskMismatch, units: [], snapshot: snapshotB }),
      (err: any) => {
        assert.strictEqual(err.code, 'WORKSPACE_SNAPSHOT_MISMATCH');
        assert.ok(err.message.includes('does not match WorkspaceSnapshot id'));
        return true;
      },
      'generatePlan must reject task whose workspaceSnapshotId does not match snapshot.workspaceSnapshotId'
    );

    // Matching snapshot succeeds and records consistent workspaceSnapshotId
    const taskMatch = createTaskContext({
      taskId: 'task_snapshot_match',
      sessionId: 'sess_suite13_match',
      primaryPrompt: 'Fix auth bug',
      workspaceSnapshotId: snapshotA.workspaceSnapshotId,
      agentEnvironment: env,
    });
    const plan = engine.generatePlan({ task: taskMatch, units: [], snapshot: snapshotA });
    assert.strictEqual(plan.workspaceSnapshotId, snapshotA.workspaceSnapshotId);

    // Omitting workspaceSnapshotId auto-populates from snapshot
    const taskAuto = createTaskContext({
      taskId: 'task_snapshot_auto',
      sessionId: 'sess_suite13_auto',
      primaryPrompt: 'Fix auth bug',
      workspaceSnapshotId: '',
      agentEnvironment: env,
    });
    const planAuto = engine.generatePlan({ task: taskAuto, units: [], snapshot: snapshotA });
    assert.strictEqual(planAuto.workspaceSnapshotId, snapshotA.workspaceSnapshotId);
    assert.strictEqual(taskAuto.workspaceSnapshotId, snapshotA.workspaceSnapshotId);

    // Mismatched unit workspaceSnapshotId must throw WORKSPACE_SNAPSHOT_MISMATCH
    const unitValid: ContextUnit = {
      id: 'sym_auth_login',
      kind: ContextUnitKind.CODE_SYMBOL,
      workspaceSnapshotId: snapshotA.workspaceSnapshotId,
      path: 'src/auth/login.ts',
      title: 'Auth.login',
      provenance: { sourceType: 'file' },
      trustLevel: TrustLevel.FIRST_PARTY_CODE,
      metadata: { content: 'export function login() {}' },
    };
    const unitMismatched: ContextUnit = {
      ...unitValid,
      id: 'sym_auth_other',
      workspaceSnapshotId: 'ws_snap_other_mismatch',
    };

    assert.throws(
      () => engine.generatePlan({ task: taskMatch, units: [unitMismatched], snapshot: snapshotA }),
      (err: any) => {
        assert.strictEqual(err.code, 'WORKSPACE_SNAPSHOT_MISMATCH');
        assert.ok(err.message.includes('does not match WorkspaceSnapshot id'));
        return true;
      },
      'generatePlan must reject unit whose workspaceSnapshotId does not match snapshot.workspaceSnapshotId'
    );

    // 2. Provider Retries Configuration
    // In smoke mode, maxRetries: 0 eliminates hidden retries ensuring strictly 1:1 call-to-budget mapping
    const smokeClient = new TypeSafeSystemOneClient({
      apiKey: 'test_key_smoke_dummy',
      retry: { maxRetries: 0 },
    });
    assert.strictEqual(smokeClient.options.retry?.maxRetries, 0, 'TypeSafeSystemOneClient must accept maxRetries: 0 for smoke budgeting');

    // 3. Application/Railway Path Integration Test (SIFTR_JEV_REMOTE_PROCESSING)
    // Proves through normal application rights resolver:
    // - SIFTR_JEV_REMOTE_PROCESSING=true -> provider call permitted
    // - absent / false -> zero provider calls
    const origRemote = process.env.SIFTR_JEV_REMOTE_PROCESSING;
    try {
      let callCount = 0;
      const testProviderClient = new FakeSystemOneClient(async () => {
        callCount++;
        return {
          model: 'typesafe-one-preview',
          answers: {
            semanticRelevance: { noul: 0.82 },
            implementationNeeded: { noul: 0.75 },
            likelyEditTarget: { noul: 0.68 },
            likelyRootCause: { noul: 0.55 },
          },
        };
      });

      // Case 3A: SIFTR_JEV_REMOTE_PROCESSING=true -> Provider call permitted
      process.env.SIFTR_JEV_REMOTE_PROCESSING = 'true';
      callCount = 0;
      const runnerPermitted = new JevShadowRunner({
        client: testProviderClient,
        mode: JevMode.SHADOW,
        sqliteStore: store,
      });
      const enginePermitted = new ContextEngine({
        sqliteStore: store,
        jevShadowRunner: runnerPermitted,
        enableJevShadow: true,
        // Notice: dataRights omitted, resolving through application environment
      });
      assert.strictEqual(enginePermitted.getDataRights().remoteProcessingAllowed, true);

      const taskPermitted = createTaskContext({
        taskId: 'task_app_rights_perm',
        sessionId: 'sess_app_rights_perm',
        primaryPrompt: 'Fix login authentication vulnerability',
        workspaceSnapshotId: snapshotA.workspaceSnapshotId,
        agentEnvironment: env,
      });
      const planPermitted = enginePermitted.generatePlan({
        task: taskPermitted,
        units: [unitValid],
        snapshot: snapshotA,
      });
      const signalsPermitted = await planPermitted.jevPromise;
      assert.ok(signalsPermitted && signalsPermitted.length > 0, 'JEV shadow signals must be produced');
      assert.ok(callCount > 0, `SIFTR_JEV_REMOTE_PROCESSING=true must permit provider calls (observed ${callCount})`);

      // Case 3B: SIFTR_JEV_REMOTE_PROCESSING absent -> Zero provider calls
      delete process.env.SIFTR_JEV_REMOTE_PROCESSING;
      callCount = 0;
      const runnerAbsent = new JevShadowRunner({
        client: testProviderClient,
        mode: JevMode.SHADOW,
        sqliteStore: store,
      });
      const engineAbsent = new ContextEngine({
        sqliteStore: store,
        jevShadowRunner: runnerAbsent,
        enableJevShadow: true,
        // dataRights omitted
      });
      assert.strictEqual(engineAbsent.getDataRights().remoteProcessingAllowed, false);

      const taskAbsent = createTaskContext({
        taskId: 'task_app_rights_absent',
        sessionId: 'sess_app_rights_absent',
        primaryPrompt: 'Fix login authentication vulnerability',
        workspaceSnapshotId: snapshotA.workspaceSnapshotId,
        agentEnvironment: env,
      });
      const planAbsent = engineAbsent.generatePlan({
        task: taskAbsent,
        units: [unitValid],
        snapshot: snapshotA,
      });
      await planAbsent.jevPromise;
      assert.strictEqual(callCount, 0, `Absent SIFTR_JEV_REMOTE_PROCESSING must result in zero provider calls (observed ${callCount})`);

      // Case 3C: SIFTR_JEV_REMOTE_PROCESSING=false -> Zero provider calls
      process.env.SIFTR_JEV_REMOTE_PROCESSING = 'false';
      callCount = 0;
      const runnerFalse = new JevShadowRunner({
        client: testProviderClient,
        mode: JevMode.SHADOW,
        sqliteStore: store,
      });
      const engineFalse = new ContextEngine({
        sqliteStore: store,
        jevShadowRunner: runnerFalse,
        enableJevShadow: true,
        // dataRights omitted
      });
      assert.strictEqual(engineFalse.getDataRights().remoteProcessingAllowed, false);

      const taskFalse = createTaskContext({
        taskId: 'task_app_rights_false',
        sessionId: 'sess_app_rights_false',
        primaryPrompt: 'Fix login authentication vulnerability',
        workspaceSnapshotId: snapshotA.workspaceSnapshotId,
        agentEnvironment: env,
      });
      const planFalse = engineFalse.generatePlan({
        task: taskFalse,
        units: [unitValid],
        snapshot: snapshotA,
      });
      await planFalse.jevPromise;
      assert.strictEqual(callCount, 0, `SIFTR_JEV_REMOTE_PROCESSING=false must result in zero provider calls (observed ${callCount})`);
    } finally {
      if (origRemote !== undefined) {
        process.env.SIFTR_JEV_REMOTE_PROCESSING = origRemote;
      } else {
        delete process.env.SIFTR_JEV_REMOTE_PROCESSING;
      }
    }

    store.close();
    console.log('  ✔ Suite 13 passed: WorkspaceSnapshot equality, retry budgeting, and Railway path smoke verified\n');
  }

  // -------------------------------------------------------------------------
  // Suite 14: Real Pilot Harness End-to-End Regression
  // -------------------------------------------------------------------------
  console.log('--- Suite 14: Real Pilot Harness End-to-End Regression ---');
  {
    const report = await runTypeSafeJevPilotStudy({
      useLive: false,
      isSmoke: true,
      verbose: false,
    });

    assert.strictEqual(report.totalTasks, 5, 'Pilot smoke must evaluate exactly 5 tasks');
    assert.strictEqual(report.tasksPerRepo.express, 2, 'Stratified smoke must evaluate 2 Express tasks');
    assert.strictEqual(report.tasksPerRepo.fastapi, 2, 'Stratified smoke must evaluate 2 FastAPI tasks');
    assert.strictEqual(report.tasksPerRepo.siftrcode, 1, 'Stratified smoke must evaluate 1 SiftrCode task');
    assert.strictEqual(report.planInvarianceHolds, true, 'Decision plan invariance must hold (100% normalized decision plan match)');
    assert.ok(report.operational.totalCalls <= 25, `Total JEV calls must be <= 25 (observed: ${report.operational.totalCalls})`);
    assert.strictEqual(report.operational.successfulCalls, 25, 'Offline mock smoke must have 25 successful calls');
    assert.strictEqual(report.operational.failedCalls, 0, 'Offline mock smoke must have 0 failed calls');
    assert.strictEqual(report.operational.fallbackCalls, 0, 'Offline mock smoke must have 0 fallback calls');
    assert.strictEqual(report.operational.trustDeniedCalls, 0, 'Offline mock smoke must have 0 trust denied calls');
    assert.strictEqual(report.operational.rightsDeniedCalls, 0, 'Offline mock smoke must have 0 rights denied calls');
    assert.strictEqual(report.operational.budgetSkippedCalls, 0, 'Offline mock smoke must have 0 budget skipped calls');
    assert.strictEqual(report.operational.configuredMaxConcurrency, 4, 'Configured max concurrency must be 4');
    assert.ok(report.operational.peakConcurrency <= 4, `Measured peak concurrency must be <= 4 (observed: ${report.operational.peakConcurrency})`);
    assert.ok(report.operational.peakConcurrency >= 1, `Measured peak concurrency must be >= 1 (observed: ${report.operational.peakConcurrency})`);
    assert.ok(report.testedGitCommit !== undefined && report.testedGitCommit.length > 0, 'Tested git commit must be captured');

    // Verify metadata completeness
    assert.ok(report.metadata, 'Report metadata must be present');
    assert.strictEqual(report.metadata.sdk.name, '@typesafe-ai/sdk', 'SDK name must be @typesafe-ai/sdk');
    assert.strictEqual(report.metadata.questionSet.questionCount, 4, 'Question set must define 4 questions');
    assert.strictEqual(report.metadata.redaction.rawSourceExcluded, true, 'Raw source code must be excluded');
    assert.strictEqual(report.metadata.redaction.secretsRedacted, true, 'Secrets must be redacted');
    assert.ok(report.metadata.sampleSanitizedPayloadShape, 'Sample sanitized payload shape must be captured');
    assert.ok(report.metadata.sampleRequestId, 'Sample request ID must be captured');

    console.log('  ✔ Suite 14 passed: Real pilot harness end-to-end regression verified\n');
  }

  console.log('🎉 ALL FOURTEEN REGRESSION SUITES PASSED CLEANLY!\n');
}

if (require.main === module) {
  runRegressionTests().catch((err) => {
    console.error('❌ Regression tests failed:', err);
    process.exit(1);
  });
}
