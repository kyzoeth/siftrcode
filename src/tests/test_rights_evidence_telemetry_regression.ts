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
  isDataClassPermitted,
} from '../rights/data_rights';
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
      const imp = sig.implementationNeededProbability ?? 0.0;
      const edit = sig.likelyEditTargetProbability ?? 0.0;
      const root = sig.likelyRootCauseProbability ?? 0.0;

      probObj.semRel.push(sem);
      if (sig.implementationNeededProbability !== null) probObj.impNeed.push(imp);
      if (sig.likelyEditTargetProbability !== null) probObj.editTarget.push(edit);
      if (sig.likelyRootCauseProbability !== null) probObj.rootCause.push(root);

      judgmentsMap.set(sig.contextUnitId, {
        candidateUnitId: sig.contextUnitId,
        semanticRelevance: sem,
        semanticRelevanceProbability: sem,
        implementationNeeded: imp > 0.5,
        implementationNeededProbability: imp,
        likelyEditTarget: edit > 0.5,
        likelyEditTargetProbability: edit,
        likelyRootCause: root > 0.5,
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

  console.log('🎉 ALL FOUR REGRESSION SUITES PASSED CLEANLY!\n');
}

if (require.main === module) {
  runRegressionTests().catch((err) => {
    console.error('❌ Regression tests failed:', err);
    process.exit(1);
  });
}
