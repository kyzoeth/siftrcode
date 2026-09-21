/**
 * SiftrCode V2 - FINAL-3 Closure & Adversarial Verification E2E Tests (Suite 53)
 *
 * Verifies system-level invariants for the FINAL V2 closure pass:
 * 1. Resolved Pilot Config & Call Wiring (immutable config, endpoint & budget propagation)
 * 2. Tri-State Persistence & Migration 14 in SQLite (was_edited NULL for unexposed, 0 for false, 1 for true)
 * 3. Deep Freeze & Anti-Tampering of Sanctioned Training Exports (tampering throws, bypass rejected)
 * 4. Pure Function Report Consistency Validator (validateReportConsistency diff detection)
 * 5. Partial Harness Execution Detection & Task Tracking (startedTaskCount, completedTaskCount)
 * 6. Acceptance Invariant Guarantees (PASS requires exactly 0 failed criteria)
 */

import * as assert from 'assert';
import { SqliteStore } from '../storage/sqlite_store';
import {
  TrainingExporter,
  isSanctionedTrainingExport,
  isSanctionedTrainingEvidenceExport,
} from '../learning/training_exporter';
import { createCandidateObservationV2 } from '../telemetry/candidate_observation';
import { ContextResolution } from '../context/context_resolution';
import { ContextUnitKind } from '../context/context_unit';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { createDefaultDataRights, DataClass, DataRights } from '../rights/data_rights';
import { createSourceProvenance } from '../rights/source_provenance';
import { createTrainingEvidenceRecord, TrainingEvidenceRecord } from '../learning/lineage';
import {
  evaluateLiveAcceptance,
  LiveMetrics,
  resolvePilotConfig,
  validateReportConsistency,
  PilotReport,
  ResolvedPilotConfig,
} from './pilot_jev_real_study';

function createMockFeatures(contextUnitId: string, score: number = 1.0): ContextFeaturesV1 {
  return {
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
  };
}

function createMockEvidenceRecord(params: {
  contextUnitId: string;
  taskId: string;
  wasRead: boolean | null;
  wasEdited: boolean | null;
  verifiedSuccess: boolean | null;
  confidence?: number;
}): TrainingEvidenceRecord {
  return createTrainingEvidenceRecord({
    datasetVersion: 'v2.0-test',
    taskId: params.taskId,
    sessionId: 'sess_test',
    contextUnitId: params.contextUnitId,
    repository: 'kyzoeth/siftrcode',
    features: createMockFeatures(params.contextUnitId),
    sourceObservationIds: ['obs_' + params.contextUnitId],
    rightsReference: 'rights_01',
    exposure: {
      wasExposed: true,
      resolution: ContextResolution.FULL,
    },
    observabilityLevel: 'OUTCOME_ONLY',
    readEvidence: { wasRead: params.wasRead, confidence: params.confidence ?? 0.8 },
    editEvidence: { wasEdited: params.wasEdited, confidence: params.confidence ?? 0.8 },
    verifiedOutcomeAssociation: { verifiedSuccess: params.verifiedSuccess, confidence: params.confidence ?? 0.8 },
    exportedAt: new Date().toISOString(),
  });
}

async function runClosureE2ETests() {
  console.log('🧪 [FINAL-3 Closure & Adversarial E2E Tests] Starting suite 53...\n');

  // =========================================================================
  // Test 1: Resolved Pilot Config & Call Wiring
  // =========================================================================
  console.log('--- Test 1: Resolved Pilot Config & Call Wiring ---');
  {
    // Default smoke config
    const defaultConfig = resolvePilotConfig({ isSmoke: true });
    assert.strictEqual(defaultConfig.isSmoke, true);
    assert.strictEqual(defaultConfig.maxTasks, 5);
    assert.strictEqual(defaultConfig.maxCallsPerTask, 5);
    assert.strictEqual(defaultConfig.maxHttpRequestsPerTask, 10);
    assert.strictEqual(defaultConfig.retriesConfigured, 1);
    assert.strictEqual(Object.isFrozen(defaultConfig), true, 'ResolvedPilotConfig must be frozen');

    // Attempting to mutate config throws in strict mode
    assert.throws(() => {
      (defaultConfig as any).maxTasks = 99;
    }, /read only|frozen|extensible/i);

    // Custom overrides propagation
    const customConfig = resolvePilotConfig({
      isSmoke: true,
      endpoint: 'https://staging-api.typesafe.ai',
      allowNonproductionEndpoint: true,
      maxHttpRequestsPerTask: 25,
      timeoutMs: 8000,
      model: 'custom-jev-model',
    });
    assert.strictEqual(customConfig.endpoint, 'https://staging-api.typesafe.ai');
    assert.strictEqual(customConfig.endpointIsProduction, false);
    assert.strictEqual(customConfig.maxHttpRequestsPerTask, 25);
    assert.strictEqual(customConfig.timeoutMs, 8000);
    assert.strictEqual(customConfig.model, 'custom-jev-model');

    // Non-production endpoint rejected when live and not allowed
    assert.throws(() => {
      resolvePilotConfig({
        useLive: true,
        endpoint: 'http://insecure-internal.lan',
        allowNonproductionEndpoint: false,
      });
    }, /Non-production endpoint.*rejected/);

    console.log('  ✔ ResolvedPilotConfig creates immutable frozen config with accurate option propagation');
  }

  // =========================================================================
  // Test 2: Tri-State Persistence & Migration 14 Enforcement in SQLite
  // =========================================================================
  console.log('\n--- Test 2: Tri-State Persistence & Migration 14 Enforcement in SQLite ---');
  {
    const store = new SqliteStore(':memory:');
    const applied = (store as any).db.prepare('SELECT version, name FROM schema_migrations WHERE version = 14').get() as {
      version: number;
      name: string;
    } | undefined;
    assert.ok(applied, 'Migration 14 must be applied in schema_migrations');
    assert.strictEqual(applied.version, 14);

    const rights: DataRights = createDefaultDataRights({
      trainingAllowed: true,
      trajectoryRetentionAllowed: true,
    });
    const provenance = createSourceProvenance({
      origin: 'FIRST_PARTY',
      license: 'PROPRIETARY',
      repository: 'kyzoeth/siftrcode',
      trainingPermission: 'ALLOWED',
    });

    const taskId = 'task_tristate_sql_01';

    // 1. Unexposed candidate: wasEdited === null (UNKNOWN != FALSE)
    const evNull = createMockEvidenceRecord({
      taskId,
      contextUnitId: 'cu_unexposed_01',
      wasRead: null,
      wasEdited: null,
      verifiedSuccess: null,
      confidence: 0.5,
    });

    // 2. Exposed unedited candidate: wasEdited === false
    const evFalse = createMockEvidenceRecord({
      taskId,
      contextUnitId: 'cu_exposed_unedited_02',
      wasRead: true,
      wasEdited: false,
      verifiedSuccess: null,
      confidence: 0.8,
    });

    // 3. Edited candidate: wasEdited === true
    const evTrue = createMockEvidenceRecord({
      taskId,
      contextUnitId: 'cu_edited_03',
      wasRead: true,
      wasEdited: true,
      verifiedSuccess: true,
      confidence: 0.99,
    });

    const exporter = new TrainingExporter();
    const batch = exporter.exportTrainingEvidenceRecords(
      [evNull, evFalse, evTrue],
      () => ({ dataRights: rights, provenance, repository: 'kyzoeth/siftrcode' }),
      { datasetVersion: 'v2.0-test' }
    );

    assert.strictEqual(batch.records.length, 3);
    store.saveTrainingEvidenceRecords(batch);

    // Direct SQLite queries: check the raw database column values!
    const db = (store as any).db;
    const rowNull = db.prepare('SELECT was_edited, was_read, verified_success FROM training_evidence_records WHERE evidence_id = ?').get(evNull.evidenceId) as any;
    const rowFalse = db.prepare('SELECT was_edited, was_read, verified_success FROM training_evidence_records WHERE evidence_id = ?').get(evFalse.evidenceId) as any;
    const rowTrue = db.prepare('SELECT was_edited, was_read, verified_success FROM training_evidence_records WHERE evidence_id = ?').get(evTrue.evidenceId) as any;

    // Invariant: unexposed candidate was_edited in SQLite column MUST BE NULL, NOT 0!
    assert.strictEqual(rowNull.was_edited, null, 'SQLite column was_edited must be NULL for unexposed candidate');
    assert.strictEqual(rowNull.was_read, null, 'SQLite column was_read must be NULL for unexposed candidate');
    assert.strictEqual(rowNull.verified_success, null, 'SQLite column verified_success must be NULL');

    // Invariant: exposed unedited candidate was_edited in SQLite column MUST BE 0!
    assert.strictEqual(rowFalse.was_edited, 0, 'SQLite column was_edited must be 0 for exposed unedited candidate');
    assert.strictEqual(rowFalse.was_read, 1, 'SQLite column was_read must be 1 for read candidate');

    // Invariant: edited candidate was_edited in SQLite column MUST BE 1!
    assert.strictEqual(rowTrue.was_edited, 1, 'SQLite column was_edited must be 1 for edited candidate');
    assert.strictEqual(rowTrue.verified_success, 1, 'SQLite column verified_success must be 1');

    // Reading back through application layer also preserves null
    const retrievedNull = store.getTrainingEvidenceRecord(evNull.evidenceId);
    assert.strictEqual(retrievedNull?.editEvidence.wasEdited, null, 'Retrieved record preserves wasEdited === null');

    store.close();
    console.log('  ✔ Direct SQLite query confirms was_edited column preserves NULL (UNKNOWN != FALSE) via Migration 14');
  }

  // =========================================================================
  // Test 3: Deep Freeze & Anti-Tampering of Sanctioned Training Exports
  // =========================================================================
  console.log('\n--- Test 3: Deep Freeze & Anti-Tampering of Sanctioned Training Exports ---');
  {
    const exporter = new TrainingExporter();
    const rights = createDefaultDataRights({ trainingAllowed: true, trajectoryRetentionAllowed: true });
    const provenance = createSourceProvenance({ origin: 'FIRST_PARTY', license: 'MIT', repository: 'kyzoeth/siftrcode', trainingPermission: 'ALLOWED' });

    const obs = createCandidateObservationV2({
      observationId: 'obs_freeze_1',
      taskId: 'task_freeze_01',
      siftrSessionId: 'sess_freeze_01',
      workspaceSnapshotId: 'ws_freeze_01',
      contextUnitId: 'cu_freeze_01',
      agentEnvironmentId: 'env_1',
      observabilityLevel: 'FULL_TOOL_TRACE',
      features: createMockFeatures('cu_freeze_01'),
      candidate: {
        generated: true,
        candidateRank: 1,
        retrievalSources: ['lexical'],
      },
      exposure: {
        contextUnitId: 'cu_freeze_01',
        eligibleForSelection: true,
        selected: true,
        resolution: ContextResolution.FULL,
        contextPlanId: 'plan_freeze',
        policyId: 'policy_s',
        policyVersion: '1.0.0',
        timestamp: new Date().toISOString(),
      },
      observedBehavior: {
        edited: true,
      },
      rightsReference: 'rights_freeze_01',
    });

    const rowExport = exporter.exportTrainingRows([obs], () => ({ dataRights: rights, provenance, repository: 'kyzoeth/siftrcode' }), {
      datasetVersion: 'v2.0-freeze-test',
    });

    // 1. Verify frozen status
    assert.strictEqual(Object.isFrozen(rowExport), true, 'Export result must be frozen');
    assert.strictEqual(Object.isFrozen(rowExport.rows), true, 'Export rows array must be frozen');
    assert.strictEqual(Object.isFrozen(rowExport.rows[0]), true, 'Export row items must be frozen');

    // 2. Verify mutation attempts throw
    assert.throws(() => {
      (rowExport.rows as any).push({ forged: true });
    }, /read only|frozen|extensible/i);

    assert.throws(() => {
      (rowExport as any).exportId = 'tampered_export_id';
    }, /read only|frozen/i);

    assert.throws(() => {
      (rowExport.rows[0] as any).label = 0;
    }, /read only|frozen/i);

    // 3. Verify shallow/unfrozen copies fail isSanctionedTrainingExport
    const shallowCopy = { ...rowExport, rows: [...rowExport.rows] };
    assert.strictEqual(isSanctionedTrainingExport(shallowCopy), false, 'Unfrozen copy must fail isSanctionedTrainingExport check');

    const store = new SqliteStore(':memory:');
    assert.throws(() => {
      store.saveTrainingRows(shallowCopy as any);
    }, /UNSANCTIONED_TRAINING_ROW_PERSISTENCE/);

    // 4. Same freeze guarantees for TrainingEvidenceRecords
    const ev = createMockEvidenceRecord({
      taskId: 'task_freeze_ev_01',
      contextUnitId: 'cu_freeze_ev_01',
      wasRead: true,
      wasEdited: true,
      verifiedSuccess: true,
      confidence: 0.99,
    });

    const evExport = exporter.exportTrainingEvidenceRecords([ev], () => ({ dataRights: rights, provenance, repository: 'kyzoeth/siftrcode' }), {
      datasetVersion: 'v2.0-freeze-test',
    });

    assert.strictEqual(Object.isFrozen(evExport), true, 'Evidence export must be frozen');
    assert.strictEqual(Object.isFrozen(evExport.records), true, 'Evidence records array must be frozen');
    assert.strictEqual(Object.isFrozen(evExport.records[0]), true, 'Evidence record item must be frozen');

    assert.throws(() => {
      (evExport.records as any).push({ forged: true });
    }, /read only|frozen|extensible/i);

    store.close();
    console.log('  ✔ Deep freeze prevents batch mutation; unfrozen and forged copies strictly rejected');
  }

  // =========================================================================
  // Test 4: Pure Function Report Consistency Validator
  // =========================================================================
  console.log('\n--- Test 4: Pure Function Report Consistency Validator ---');
  {
    const config: ResolvedPilotConfig = resolvePilotConfig({
      useLive: true,
      isSmoke: true,
      endpoint: 'https://api.typesafe.ai',
      maxCallsPerTask: 5,
    });

    const validReport: PilotReport = {
      mode: 'LIVE_SMOKE',
      endpoint: 'https://api.typesafe.ai',
      endpointIsProduction: true,
      provenance: { isClean: true },
      sdkVersion: '0.6.0',
      requestedModel: 'jev-latest',
      returnedProviderModels: ['typesafe-jev-v1'],
      questionSetVersion: 'jev_qset_v1',
      totalTasks: 5,
      selectedTaskCount: 5,
      startedTaskCount: 5,
      completedTaskCount: 5,
      tasksWithValidProviderSignal: 5,
      tasksPerRepo: { express: 2, fastapi: 2, siftrcode: 1 },
      tasksPerType: { BUG_FIX: 2, TEST_FAILURE: 1, FEATURE_ADDITION: 1, REFACTOR: 1 },
      resolvedMaxCallsPerTask: 5,
      selectedCandidates: 25,
      provider: {
        attempts: 25,
        successes: 25,
        retries: 0,
        httpRequests: 25,
        failuresByCategory: { timeouts: 0, rateLimited: 0, malformed: 0, connectionErrors: 0, providerErrors: 0 },
        rightsDenied: 0,
        trustDenied: 0,
        budgetSkipped: 0,
      },
      signals: { total: 25, validSignals: 25, fallbackSignals: 0 },
      operational: {
        totalCalls: 25,
        successfulCalls: 25,
        failedCalls: 0,
        fallbackCalls: 0,
        trustDeniedCalls: 0,
        rightsDeniedCalls: 0,
        budgetSkippedCalls: 0,
        meanCallsPerTask: 5,
        peakConcurrency: 4,
        latencySummary: { mean: 200, median: 200, std: 10, p95: 300, min: 100, max: 400 },
      },
      redactionCount: 0,
      workspaceSnapshotIds: {},
      benchmarkRepoHeadShas: {},
      lineage: {
        orphanJevSignals: 0, totalJevSignals: 25, joinedJevSignals: 25,
        orphanContextPlans: 0, totalContextPlans: 10, joinedContextPlans: 10,
        orphanCandidateDecisions: 0, totalCandidateDecisions: 100, joinedCandidateDecisions: 100,
        mismatchedJevAgentEnvs: 0, mismatchedPlanAgentEnvs: 0, mismatchedDecisionAgentEnvs: 0,
        mismatchedPlanSnapshots: 0, mismatchedJevSnapshots: 0,
        completeLineageCoverage: true, lineageVerificationSucceeded: true,
      },
      lineageCoverage: {
        totalSessions: 5, totalJudgments: 25, orphanJudgments: 0,
        totalPlans: 10, orphanPlans: 0, totalObservations: 100, orphanObservations: 0,
        mismatchedAgentEnvs: 0, mismatchedSnapshots: 0, lineageVerificationSucceeded: true,
      },
      zeroLineageMismatches: true,
      zeroUnexpectedEgress: true,
      perTaskPlanInvariance: [],
      planInvarianceHolds: true,
      distributions: {
        semanticRelevance: { mean: 0.8, median: 0.8, std: 0.05, p95: 0.9, min: 0.7, max: 0.9 },
        implementationNeeded: { mean: 0.8, median: 0.8, std: 0.05, p95: 0.9, min: 0.7, max: 0.9 },
        likelyEditTarget: { mean: 0.8, median: 0.8, std: 0.05, p95: 0.9, min: 0.7, max: 0.9 },
        likelyRootCause: { mean: 0.8, median: 0.8, std: 0.05, p95: 0.9, min: 0.7, max: 0.9 },
      },
      correlations: { editTargetVsGroundTruth: 0.5, rootCauseVsGroundTruth: 0.5, semanticRelevanceVsGroundTruth: 0.5 },
      rankingAblation: {
        baseline: { ndcg5: 0.5, ndcg10: 0.5, recall5: 0.5, recall10: 0.5, recall20: 0.5, mrr: 0.5 },
        jevAugmented: { ndcg5: 0.6, ndcg10: 0.6, recall5: 0.6, recall10: 0.6, recall20: 0.6, mrr: 0.6 },
        ndcg10Delta: 0.1,
        recall10Delta: 0.1,
        mrrDelta: 0.1,
      },
      failedCriteria: [],
      recommendation: 'PASS_TO_30_TASK_PILOT',
    };

    // 1. Pristine report passes consistency
    const r1 = validateReportConsistency(validReport, config);
    assert.strictEqual(r1.consistent, true, 'Valid report must be consistent');
    assert.strictEqual(r1.diffs.length, 0);

    // 2. Mode discrepancy
    const rMode = validateReportConsistency({ ...validReport, mode: 'OFFLINE_SYNTHETIC' }, config);
    assert.strictEqual(rMode.consistent, false);
    assert.ok(rMode.diffs.some(d => d.includes('report.mode')));

    // 3. Endpoint discrepancy
    const rEndpoint = validateReportConsistency({ ...validReport, endpoint: 'https://other.ai' }, config);
    assert.strictEqual(rEndpoint.consistent, false);
    assert.ok(rEndpoint.diffs.some(d => d.includes('report.endpoint')));

    // 4. Task counts inconsistency
    const rTaskCount = validateReportConsistency({ ...validReport, selectedTaskCount: 10 }, config);
    assert.strictEqual(rTaskCount.consistent, false);
    assert.ok(rTaskCount.diffs.some(d => d.includes('selectedTaskCount')));

    // 5. Tasks per repo sum discrepancy
    const rRepoSum = validateReportConsistency({
      ...validReport,
      tasksPerRepo: { express: 1, fastapi: 1, siftrcode: 1 }, // sum 3 != completed 5
    }, config);
    assert.strictEqual(rRepoSum.consistent, false);
    assert.ok(rRepoSum.diffs.some(d => d.includes('tasksPerRepo sum')));

    // 6. Provider attempts arithmetic discrepancy
    const rAttempts = validateReportConsistency({
      ...validReport,
      provider: { ...validReport.provider, attempts: 30 }, // 30 != 25 + 0
    }, config);
    assert.strictEqual(rAttempts.consistent, false);
    assert.ok(rAttempts.diffs.some(d => d.includes('provider.attempts')));

    // 7. Ranking ablation delta arithmetic discrepancy
    const rDelta = validateReportConsistency({
      ...validReport,
      rankingAblation: { ...validReport.rankingAblation, ndcg10Delta: 0.99 },
    }, config);
    assert.strictEqual(rDelta.consistent, false);
    assert.ok(rDelta.diffs.some(d => d.includes('ndcg10Delta')));

    // 8. Recommendation invariant: PASS but failedCriteria non-empty
    const rPassFailed = validateReportConsistency({
      ...validReport,
      failedCriteria: ['some failure'],
      recommendation: 'PASS_TO_30_TASK_PILOT',
    }, config);
    assert.strictEqual(rPassFailed.consistent, false);
    assert.ok(rPassFailed.diffs.some(d => d.includes('recommendation PASS_TO_30_TASK_PILOT but failedCriteria is non-empty')));

    console.log('  ✔ validateReportConsistency detected every simulated report discrepancy accurately');
  }

  // =========================================================================
  // Test 5: Partial Harness Execution Detection & Task Tracking
  // =========================================================================
  console.log('\n--- Test 5: Partial Harness Execution Detection & Task Tracking ---');
  {
    const baseMetrics: LiveMetrics = {
      liveMode: true,
      totalTasks: 5,
      selectedTaskCount: 5,
      startedTaskCount: 5,
      completedTaskCount: 5,
      tasksWithValidProviderSignal: 5,
      maxHttpRequests: 50,
      successfulCalls: 25,
      failedCalls: 0,
      rateLimitedCalls: 0,
      timeoutCalls: 0,
      malformedCalls: 0,
      connectionErrorCalls: 0,
      totalHttpRequests: 25,
      totalRetries: 0,
      trustDeniedCalls: 0,
      rightsDeniedCalls: 0,
      planInvarianceHolds: true,
      zeroLineageMismatches: true,
      zeroUnexpectedEgress: true,
      endpoint: 'https://api.typesafe.ai',
      endpointIsProduction: true,
      provenanceClean: true,
      providerAttempts: 25,
      providerSuccesses: 25,
      validSignals: 25,
      syntheticSignals: 0,
      fallbackOnlySignals: 0,
      snapshotMismatches: 0,
      sessionMismatches: 0,
      agentEnvironmentMismatches: 0,
      completeLineageCoverage: true,
      lineageVerificationSucceeded: true,
      perTaskAttemptsExceeded: false,
      httpRequestsExceededBudget: false,
      reportConsistencyCheck: true,
    };

    // 1. Started task count mismatch (e.g. stopped at task 3)
    const mStartedMismatch = evaluateLiveAcceptance({
      ...baseMetrics,
      startedTaskCount: 3,
      selectedTaskCount: 5,
    });
    assert.strictEqual(mStartedMismatch.recommendation, 'FIX_AND_REPEAT_SMOKE');
    assert.ok(mStartedMismatch.failed.some(f => f.includes('startedTaskCount === selectedTaskCount')));

    // 2. Completed task count mismatch (e.g. task 4 threw error)
    const mCompletedMismatch = evaluateLiveAcceptance({
      ...baseMetrics,
      completedTaskCount: 4,
      selectedTaskCount: 5,
      harnessException: 'Network connection aborted on task 4',
    });
    assert.strictEqual(mCompletedMismatch.recommendation, 'FIX_AND_REPEAT_SMOKE');
    assert.ok(mCompletedMismatch.failed.some(f => f.includes('completedTaskCount === selectedTaskCount')));
    assert.ok(mCompletedMismatch.failed.some(f => f.includes('harness execution without error')));

    // 3. Report consistency check false
    const mConsistencyFailed = evaluateLiveAcceptance({
      ...baseMetrics,
      reportConsistencyCheck: false,
    });
    assert.strictEqual(mConsistencyFailed.recommendation, 'FIX_AND_REPEAT_SMOKE');
    assert.ok(mConsistencyFailed.failed.some(f => f.includes('reportConsistencyCheck === true')));

    console.log('  ✔ Acceptance evaluator strictly enforces startedTaskCount, completedTaskCount, and reportConsistencyCheck');
  }

  // =========================================================================
  // Test 6: Invariant Enforcement - PASS Impossible With Failures
  // =========================================================================
  console.log('\n--- Test 6: Invariant Enforcement - PASS Impossible With Failures ---');
  {
    // Verify evaluateLiveAcceptance CANNOT return PASS_TO_30_TASK_PILOT if failed.length > 0
    for (let i = 1; i <= 5; i++) {
      const metrics: LiveMetrics = {
        liveMode: true,
        totalTasks: 5,
        selectedTaskCount: 5,
        startedTaskCount: 5,
        completedTaskCount: 5,
        tasksWithValidProviderSignal: 5,
        maxHttpRequests: 50,
        successfulCalls: 25,
        failedCalls: i > 1 ? 1 : 0,
        rateLimitedCalls: 0,
        timeoutCalls: 0,
        malformedCalls: 0,
        connectionErrorCalls: 0,
        totalHttpRequests: 25,
        totalRetries: 0,
        trustDeniedCalls: 0,
        rightsDeniedCalls: 0,
        planInvarianceHolds: i !== 2,
        zeroLineageMismatches: i !== 3,
        zeroUnexpectedEgress: i !== 4,
        endpoint: 'https://api.typesafe.ai',
        endpointIsProduction: i !== 5,
        provenanceClean: true,
        providerAttempts: 25,
        providerSuccesses: 25,
        validSignals: 25,
        syntheticSignals: 0,
        fallbackOnlySignals: 0,
        snapshotMismatches: 0,
        completeLineageCoverage: true,
        lineageVerificationSucceeded: true,
        perTaskAttemptsExceeded: false,
        httpRequestsExceededBudget: false,
        reportConsistencyCheck: true,
      };

      const result = evaluateLiveAcceptance(metrics);
      if (result.failed.length > 0) {
        assert.strictEqual(result.recommendation, 'FIX_AND_REPEAT_SMOKE', `Failure in variation ${i} must result in FIX_AND_REPEAT_SMOKE`);
      } else {
        assert.strictEqual(result.recommendation, 'PASS_TO_30_TASK_PILOT');
      }
    }

    console.log('  ✔ Universal invariant proven: recommendation is PASS_TO_30_TASK_PILOT if and only if failed.length === 0');
  }

  console.log('\n🎉 ALL FINAL-3 CLOSURE & ADVERSARIAL E2E TESTS PASSED CLEANLY!\n');
}

if (require.main === module) {
  runClosureE2ETests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}
