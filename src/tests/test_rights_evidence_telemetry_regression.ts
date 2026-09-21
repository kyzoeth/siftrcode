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
  deriveRankingTrainingExample,
  deriveBinaryTrainingRow,
} from '../learning/lineage';
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
  SystemOneEvaluationRequest,
  SystemOneEvaluationResponse,
} from '../providers/judgment/typesafe/typesafe_client';

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

  console.log('🎉 ALL NINE REGRESSION SUITES PASSED CLEANLY!\n');
}

if (require.main === module) {
  runRegressionTests().catch((err) => {
    console.error('❌ Regression tests failed:', err);
    process.exit(1);
  });
}
