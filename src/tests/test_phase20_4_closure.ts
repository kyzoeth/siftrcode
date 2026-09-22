/**
 * SiftrCode V2 - Phase 20.4 Data Flywheel Integrity Closure Regression Suite
 *
 * Exhaustively validates all 24 required integrity invariants:
 *  1. buildPassed = false alone yields verifiedSuccess: null
 *  2. publicTestsPassed = false alone yields verifiedSuccess: null
 *  3. agentReportedSuccess = false/true alone yields verifiedSuccess: null
 *  4. behavioralOraclePassed = true AND regressionTestsPassed !== false yields true
 *  5. hiddenTestsPassed = true AND regressionTestsPassed !== false yields true
 *  6. behavioralOraclePassed = false yields false
 *  7. hiddenTestsPassed = false yields false
 *  8. humanReview = PASS yields true, FAIL yields false
 *  9. HTTP /api/outcome preserves tri-state SQLite NULL
 * 10. HTTP outcome reports finalizationErrorCode on finalization failure
 * 11. MCP siftr_outcome preserves tri-state SQLite NULL and reports finalizationErrorCode
 * 12. Absent rightsProvenance.permissionSource remains UNKNOWN (never fabricated USER_CONSENT)
 * 13. UNKNOWN rights provenance strictly blocked from dataset export
 * 14. Exposure attribution independence between sibling symbols in the same file
 * 15. Missing exposuresProvider in exportContextDatasetV2 fails closed
 * 16. verifiedTargetEvidence deprecated in favor of verifiedTargetEdit
 * 17. Pre-outcome snapshot tampering in SQLite rejected by resolveOutcomeLineage
 * 18. agentEnvironmentId mismatch between caller and stored plan fails closed
 * 19. Lineage fails closed when sessionId is missing (no synthetic fallback)
 * 20. Non-PRODUCTION or custom unidentified ranker blocked from training export
 * 21. Readiness Gate 6 enforces 100% distinct active eligible snapshots with passing audits
 * 22. Readiness Gate 7 counts strictly is_synthetic = 0 AND environment = 'PRODUCTION'
 * 23. TaskEpisodeV1 payload tampering rejected by loadVerifiedTaskEpisode
 * 24. Primary real E2E production path: full run through /api/outcome with verified lineage and export
 * 25. Rejects Dataset V2 export if any candidate lacks an authoritative exposure record
 * 26. Canonical isEpisodeTrainingEligible() predicate enforces all integrity requirements
 * 27. Outcome endpoints stop reporting trainingEligible = verifiedSuccess (evaluates finalized episode)
 * 28. Canonical episode assembly fails closed on missing sessionId (no sess_default)
 * 29. Gate 7 rationale deleted unmeasured <= 25ms claim
 * 30. 1,000 apparently good but rights-ineligible episodes leave readiness false (non-vacuous Gate 4)
 * 31. Gate 4 canonical eligibility enforcement on Dataset V2 training pool (UNKNOWN rights, orphan rows, foreign exposures)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as crypto from 'crypto';
import { DefaultOutcomePolicyV1 } from '../telemetry/outcome_evidence';
import { SqliteStore } from '../storage/sqlite_store';
import { server as webAppServer, setSharedStore } from '../server/web';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp/server';
import { createDefaultDataRights } from '../rights/data_rights';
import { EpisodeAssembler } from '../learning/episodes/episode_assembler';
import { TrainingExporter } from '../learning/training_exporter';
import { resolveOutcomeLineage } from '../learning/episodes/lineage_resolver';
import { createPreOutcomeEpisodeSnapshot } from '../learning/episodes/pre_outcome_snapshot';
import {
  createTaskEpisodeV1,
  loadVerifiedTaskEpisode,
  TaskEpisodeV1,
} from '../learning/episodes/task_episode';
import { ContextEngine } from '../engine/context_engine';
import { ContextExposureState, ContextUnitExposureRecord } from '../learning/episodes/context_exposure';
import { isEpisodeTrainingEligible, evaluateEpisodeTrainingEligibility } from '../learning/episodes/training_eligibility';
import { evaluateCanonicalReadinessGates } from '../learning/analytics/readiness_gates';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`  ✔ ${msg}`);
}

function assertStrictEqual(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    console.error(`❌ Assertion failed: ${msg} (expected ${expected}, got ${actual})`);
    throw new Error(`Assertion failed: ${msg} (expected ${expected}, got ${actual})`);
  }
  console.log(`  ✔ ${msg}`);
}

function makeHttpRequest(
  server: http.Server,
  options: http.RequestOptions,
  postData?: string
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

export async function runPhase204ClosureTests() {
  console.log('\n=== Running Phase 20.4 Data Flywheel Integrity Closure Regression Suite ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-phase20-4-closure-'));
  const dbPath = path.join(tempDir, 'closure_test.db');
  const store = new SqliteStore(dbPath);
  setSharedStore(store);

  const policy = new DefaultOutcomePolicyV1();

  // Start real HTTP server on ephemeral port for tests
  const httpServer = http.createServer(webAppServer.listeners('request')[0] as http.RequestListener);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const httpPort = (httpServer.address() as any).port;

  try {
    // =========================================================================
    // Case 1: buildPassed = false alone yields verifiedSuccess: null
    // =========================================================================
    console.log('--- 1. buildPassed = false alone yields verifiedSuccess: null ---');
    const out1 = policy.evaluateOutcome({
      taskId: 't1',
      sessionId: 's1',
      agentEnvironmentId: 'env1',
      workspaceSnapshotBefore: 'snap1',
      buildPassed: false,
    });
    assertStrictEqual(out1.verifiedSuccess, null, 'buildPassed = false alone yields verifiedSuccess: null');

    // =========================================================================
    // Case 2: publicTestsPassed = false alone yields verifiedSuccess: null
    // =========================================================================
    console.log('\n--- 2. publicTestsPassed = false alone yields verifiedSuccess: null ---');
    const out2 = policy.evaluateOutcome({
      taskId: 't2',
      sessionId: 's2',
      agentEnvironmentId: 'env2',
      workspaceSnapshotBefore: 'snap2',
      publicTestsPassed: false,
    });
    assertStrictEqual(out2.verifiedSuccess, null, 'publicTestsPassed = false alone yields verifiedSuccess: null');

    // =========================================================================
    // Case 3: agentReportedSuccess = false/true alone yields verifiedSuccess: null
    // =========================================================================
    console.log('\n--- 3. agentReportedSuccess = false/true alone yields verifiedSuccess: null ---');
    const out3True = policy.evaluateOutcome({
      taskId: 't3',
      sessionId: 's3',
      agentEnvironmentId: 'env3',
      workspaceSnapshotBefore: 'snap3',
      agentReportedSuccess: true,
    });
    assertStrictEqual(out3True.verifiedSuccess, null, 'agentReportedSuccess = true yields verifiedSuccess: null');

    const out3False = policy.evaluateOutcome({
      taskId: 't3',
      sessionId: 's3',
      agentEnvironmentId: 'env3',
      workspaceSnapshotBefore: 'snap3',
      agentReportedSuccess: false,
    });
    assertStrictEqual(out3False.verifiedSuccess, null, 'agentReportedSuccess = false yields verifiedSuccess: null');

    // =========================================================================
    // Case 4: behavioralOraclePassed = true AND regressionTestsPassed !== false yields true
    // =========================================================================
    console.log('\n--- 4. behavioralOraclePassed = true AND regressionTestsPassed !== false yields true ---');
    const out4 = policy.evaluateOutcome({
      taskId: 't4',
      sessionId: 's4',
      agentEnvironmentId: 'env4',
      workspaceSnapshotBefore: 'snap4',
      behavioralOraclePassed: true,
      regressionTestsPassed: true,
      securityChecksPassed: true,
    });
    assertStrictEqual(out4.verifiedSuccess, true, 'behavioralOraclePassed = true yields verifiedSuccess: true');

    // Also verify when regressionTestsPassed === false, it does NOT yield true
    const out4RegFail = policy.evaluateOutcome({
      taskId: 't4',
      sessionId: 's4',
      agentEnvironmentId: 'env4',
      workspaceSnapshotBefore: 'snap4',
      behavioralOraclePassed: true,
      regressionTestsPassed: false,
    });
    assertStrictEqual(out4RegFail.verifiedSuccess, null, 'behavioralOracle with regressionTestsPassed = false yields verifiedSuccess: null');

    // =========================================================================
    // Case 5: hiddenTestsPassed = true AND regressionTestsPassed !== false yields true
    // =========================================================================
    console.log('\n--- 5. hiddenTestsPassed = true AND regressionTestsPassed !== false yields true ---');
    const out5 = policy.evaluateOutcome({
      taskId: 't5',
      sessionId: 's5',
      agentEnvironmentId: 'env5',
      workspaceSnapshotBefore: 'snap5',
      hiddenTestsPassed: true,
    });
    assertStrictEqual(out5.verifiedSuccess, true, 'hiddenTestsPassed = true yields verifiedSuccess: true');

    // =========================================================================
    // Case 6: behavioralOraclePassed = false yields false
    // =========================================================================
    console.log('\n--- 6. behavioralOraclePassed = false yields false ---');
    const out6 = policy.evaluateOutcome({
      taskId: 't6',
      sessionId: 's6',
      agentEnvironmentId: 'env6',
      workspaceSnapshotBefore: 'snap6',
      behavioralOraclePassed: false,
    });
    assertStrictEqual(out6.verifiedSuccess, false, 'behavioralOraclePassed = false yields verifiedSuccess: false');

    // =========================================================================
    // Case 7: hiddenTestsPassed = false yields false
    // =========================================================================
    console.log('\n--- 7. hiddenTestsPassed = false yields false ---');
    const out7 = policy.evaluateOutcome({
      taskId: 't7',
      sessionId: 's7',
      agentEnvironmentId: 'env7',
      workspaceSnapshotBefore: 'snap7',
      hiddenTestsPassed: false,
    });
    assertStrictEqual(out7.verifiedSuccess, false, 'hiddenTestsPassed = false yields verifiedSuccess: false');

    // =========================================================================
    // Case 8: humanReview = PASS yields true, FAIL yields false
    // =========================================================================
    console.log('\n--- 8. humanReview = PASS yields true, FAIL yields false ---');
    const out8Pass = policy.evaluateOutcome({
      taskId: 't8',
      sessionId: 's8',
      agentEnvironmentId: 'env8',
      workspaceSnapshotBefore: 'snap8',
      humanReview: 'PASS',
    });
    assertStrictEqual(out8Pass.verifiedSuccess, true, 'humanReview = PASS yields verifiedSuccess: true');

    const out8Fail = policy.evaluateOutcome({
      taskId: 't8',
      sessionId: 's8',
      agentEnvironmentId: 'env8',
      workspaceSnapshotBefore: 'snap8',
      humanReview: 'FAIL',
    });
    assertStrictEqual(out8Fail.verifiedSuccess, false, 'humanReview = FAIL yields verifiedSuccess: false');

    // =========================================================================
    // Setup Context & Snapshot for Cases 9, 10, 11
    // =========================================================================
    const snapshot9 = createPreOutcomeEpisodeSnapshot({
      episodeId: 'ep_http_test',
      taskId: 'task_http_test',
      prompt: 'Refactor test service',
      promptSha256: 'sha256_p9',
      repositoryId: 'kyzoeth/siftrcode',
      baseCommit: '9'.repeat(40),
      featureCutoffCommit: '9'.repeat(40),
      workspaceSnapshotId: 'snap_http_9',
      candidateUniverse: [],
      selectedUnits: [],
      tokenBudget: 4000,
      actualRenderedTokens: 100,
      bundleSha256: 'bundle_sha_9',
      contextPolicyId: 'siftr-default-v2',
      rankerId: 'deterministic-v2',
      contextPolicyIdentity: {
        contextPolicyId: 'siftr-default-v2',
        rankerId: 'deterministic-v2',
        rankerVersion: 'v2.0.0',
        featureSetVersion: 'CONTEXT_FEATURES_V1',
        candidateGeneratorVersion: 'v1.0.0',
        budgetPolicyVersion: 'v1.0.0',
        materializerVersion: 'v1.0.0',
      },
      capturedAt: new Date().toISOString(),
    });
    store.savePreOutcomeSnapshot(snapshot9);

    // Save session and plan bound to snapshot9
    store.saveSession({
      sessionId: 'sess_http_9',
      taskId: 'task_http_test',
      agentEnvironmentId: 'env_http_9',
      initialWorkspaceSnapshotId: 'snap_http_9',
      latestWorkspaceSnapshotId: 'snap_http_9',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.saveContextPlan({
      planId: 'plan_http_9',
      taskId: 'task_http_test',
      sessionId: 'sess_http_9',
      workspaceSnapshotId: 'snap_http_9',
      agentEnvironmentId: 'env_http_9',
      budgetPlan: {
        totalAllocatedTokens: 100,
        units: [],
        budgetLimits: { maxTokens: 4000 },
        candidateCount: 0,
      } as any,
      units: [],
      formattedContext: { files: [] } as any,
      exposureDecisions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    // =========================================================================
    // Case 9: HTTP /api/outcome preserves tri-state SQLite NULL
    // =========================================================================
    console.log('\n--- 9. HTTP /api/outcome preserves tri-state SQLite NULL ---');
    const httpRes9 = await makeHttpRequest(
      httpServer,
      {
        host: '127.0.0.1',
        port: httpPort,
        path: '/api/outcome',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({
        taskId: 'task_http_test',
        sessionId: 'sess_http_9',
        planId: 'plan_http_9',
        agentClaimedSuccess: true, // Weak signal -> tri-state null
      })
    );

    assertStrictEqual(httpRes9.statusCode, 200, 'HTTP /api/outcome returned status 200');
    const resBody9 = JSON.parse(httpRes9.body);
    assertStrictEqual(resBody9.verifiedSuccess, null, 'HTTP response verifiedSuccess is null');

    // Verify directly in SQLite: value and verified_success are true NULLs
    const rows9 = store.listOutcomeEvidence('task_http_test', 'sess_http_9');
    const row9 = rows9.find((r) => r.evidenceId === resBody9.outcomeId);
    if (!row9) {
      console.error('DEBUG resBody9:', resBody9);
      console.error('DEBUG all outcome evidence:', store.listOutcomeEvidence());
    }
    assert(row9 !== undefined, 'Outcome evidence recorded in SQLite');
    assertStrictEqual(row9!.value, null, 'SQLite outcome_evidence value column is NULL');
    assertStrictEqual(row9!.verifiedSuccess, null, 'SQLite outcome_evidence verified_success column is NULL');

    // =========================================================================
    // Case 10: HTTP outcome reports finalizationErrorCode on finalization failure
    // =========================================================================
    console.log('\n--- 10. HTTP outcome reports finalizationErrorCode on finalization failure ---');
    // Create a plan without pre-outcome snapshot
    store.saveSession({
      sessionId: 'sess_broken_10',
      taskId: 'task_broken_10',
      agentEnvironmentId: 'env_10',
      initialWorkspaceSnapshotId: 'snap_missing_10',
      latestWorkspaceSnapshotId: 'snap_missing_10',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.saveContextPlan({
      planId: 'plan_broken_10',
      taskId: 'task_broken_10',
      sessionId: 'sess_broken_10',
      workspaceSnapshotId: 'snap_missing_10',
      agentEnvironmentId: 'env_10',
      budgetPlan: {
        totalAllocatedTokens: 100,
        units: [],
        budgetLimits: { maxTokens: 4000 },
        candidateCount: 0,
      } as any,
      units: [],
      formattedContext: { files: [] } as any,
      exposureDecisions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    const httpRes10 = await makeHttpRequest(
      httpServer,
      {
        host: '127.0.0.1',
        port: httpPort,
        path: '/api/outcome',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({
        taskId: 'task_broken_10',
        sessionId: 'sess_broken_10',
        planId: 'plan_broken_10',
        behavioralOraclePassed: true,
      })
    );

    assertStrictEqual(httpRes10.statusCode, 400, 'HTTP /api/outcome returned status 400 on unresolvable lineage');
    const resBody10 = JSON.parse(httpRes10.body);
    assertStrictEqual(resBody10.episodeFinalized, false, 'episodeFinalized is false');
    assert(
      resBody10.finalizationErrorCode !== undefined && resBody10.finalizationErrorCode.length > 0,
      `finalizationErrorCode reported on failure: ${resBody10.finalizationErrorCode}`
    );

    // =========================================================================
    // Case 11: MCP siftr_outcome preserves tri-state SQLite NULL and reports finalizationErrorCode
    // =========================================================================
    console.log('\n--- 11. MCP siftr_outcome preserves tri-state SQLite NULL and reports finalizationErrorCode ---');
    const mcpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-mcp-closure-'));
    fs.mkdirSync(path.join(mcpWorkspace, '.siftr'), { recursive: true });
    // Copy the test db so mcp server uses the same store
    fs.copyFileSync(dbPath, path.join(mcpWorkspace, '.siftr', 'observations.sqlite'));

    const mcpServer = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const mcpClient = new Client({ name: 'mcp-closure-client', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(clientTransport);

    const mcpOutcomeRes = (await mcpClient.callTool({
      name: 'siftr_outcome',
      arguments: {
        directory: mcpWorkspace,
        taskId: 'task_http_test',
        sessionId: 'sess_http_9',
        planId: 'plan_http_9',
        agentClaimedSuccess: true,
      },
    })) as any;

    assert(!mcpOutcomeRes.isError, 'MCP siftr_outcome call succeeded');
    const mcpOutcomePayload = JSON.parse(mcpOutcomeRes.content[0].text);
    assertStrictEqual(mcpOutcomePayload.verifiedSuccess, null, 'MCP outcome verifiedSuccess is null');

    // Test finalization failure in MCP
    const mcpBrokenRes = (await mcpClient.callTool({
      name: 'siftr_outcome',
      arguments: {
        directory: mcpWorkspace,
        taskId: 'task_broken_10',
        sessionId: 'sess_broken_10',
        planId: 'plan_broken_10',
        behavioralOraclePassed: true,
      },
    })) as any;

    const mcpBrokenPayload = JSON.parse(mcpBrokenRes.content[0].text);
    assertStrictEqual(mcpBrokenPayload.episodeFinalized, false, 'MCP reported episodeFinalized = false');
    assert(
      mcpBrokenPayload.finalizationErrorCode !== undefined,
      `MCP reported finalizationErrorCode: ${mcpBrokenPayload.finalizationErrorCode}`
    );

    // =========================================================================
    // Case 12: Absent rightsProvenance.permissionSource remains UNKNOWN (never fabricated USER_CONSENT)
    // =========================================================================
    console.log('\n--- 12. Absent rightsProvenance.permissionSource remains UNKNOWN ---');
    const rightsWithoutProvenance = createDefaultDataRights({ trainingAllowed: true });
    assertStrictEqual(
      rightsWithoutProvenance.rightsProvenance?.permissionSource,
      undefined,
      'createDefaultDataRights leaves rightsProvenance undefined'
    );

    // Test that assembler defaults permissionSource to UNKNOWN, not fabricated USER_CONSENT
    const intermediateEp = EpisodeAssembler.assembleEpisode({
      preOutcomeSnapshot: snapshot9,
      plan: {
        planId: 'plan_http_9',
        taskId: 'task_http_test',
        sessionId: 'sess_http_9',
        workspaceSnapshotId: 'snap_http_9',
      } as any,
      task: {
        taskId: 'task_http_test',
        sessionId: 'sess_http_9',
      } as any,
      snapshot: {
        workspaceSnapshotId: 'snap_http_9',
      } as any,
      outcome: {
        episodeId: 'ep_http_test',
        verifiedSuccess: true,
        verificationConfidence: 'HIGH',
        verificationSources: ['ORACLE'],
        evaluationRationale: 'Test',
      },
      dataRights: rightsWithoutProvenance,
    });
    assertStrictEqual(
      intermediateEp.rights.permissionSource,
      'UNKNOWN',
      'Assembler preserves UNKNOWN permissionSource, never fabricates USER_CONSENT'
    );

    // =========================================================================
    // Case 13: UNKNOWN rights provenance strictly blocked from dataset export
    // =========================================================================
    console.log('\n--- 13. UNKNOWN rights provenance strictly blocked from dataset export ---');
    const exporter = new TrainingExporter();
    const exportRes13 = exporter.exportContextDatasetV2([intermediateEp], {
      isRevoked: () => false,
      exposuresProvider: () => [],
    });
    assertStrictEqual(exportRes13.totalEpisodesAccepted, 0, 'Zero episodes accepted with UNKNOWN permissionSource');
    assertStrictEqual(exportRes13.rejections.length, 1, 'Episode rejected for UNKNOWN rights provenance');
    assert(
      exportRes13.rejections[0].reasons[0].includes('RIGHTS_BLOCKED: permissionSource is UNKNOWN'),
      `Rejection reason contains RIGHTS_BLOCKED: ${exportRes13.rejections[0].reasons[0]}`
    );

    // =========================================================================
    // Case 14: Exposure attribution independence between sibling symbols in the same file
    // =========================================================================
    console.log('\n--- 14. Exposure attribution independence between sibling symbols in same file ---');
    const ep14 = createTaskEpisodeV1({
      repositoryId: 'kyzoeth/siftrcode',
      sessionId: 'sess_sibling_14',
      taskId: 'task_sibling_14',
      workspace: {
        repositoryIdentity: 'kyzoeth/siftrcode',
        baseCommit: 'c14',
        dirtyAtStart: false,
        workspaceSnapshotId: 'snap_14',
      },
      task: { prompt: 'Fix charge logic' },
      environment: {
        contextPolicyId: 'siftr-default-v2',
        rankerId: 'deterministic-v2',
        rankerStatus: 'PRODUCTION',
      },
      rights: {
        trainingAllowed: true,
        permissionSource: 'USER_CONSENT',
      },
      contextDecision: {
        candidateCount: 2,
        candidates: [
          {
            contextUnitId: 'sym_executeCharge',
            path: 'src/payment.ts',
            unitKind: 'FUNCTION',
            retrievalSources: ['lexical'],
            finalRank: 1,
            finalScore: 0.9,
            featureSetVersion: 'v1',
            estimatedTokens: 100,
            selected: true,
            selectedResolution: 'FULL',
          },
          {
            contextUnitId: 'sym_refundCharge',
            path: 'src/payment.ts',
            unitKind: 'FUNCTION',
            retrievalSources: ['lexical'],
            finalRank: 2,
            finalScore: 0.8,
            featureSetVersion: 'v1',
            estimatedTokens: 100,
            selected: true,
            selectedResolution: 'FULL',
          },
        ],
        selectedUnits: [
          {
            contextUnitId: 'sym_executeCharge',
            path: 'src/payment.ts',
            unitKind: 'FUNCTION',
            resolution: 'FULL',
            rank: 1,
            allocatedTokens: 100,
          },
          {
            contextUnitId: 'sym_refundCharge',
            path: 'src/payment.ts',
            unitKind: 'FUNCTION',
            resolution: 'FULL',
            rank: 2,
            allocatedTokens: 100,
          },
        ],
        bundleSha256: 'bundle_14',
        actualRenderedTokens: 200,
        tokenBudget: 4000,
      },
      outcome: {
        episodeId: 'ep_sibling_14',
        verifiedSuccess: true,
        verificationConfidence: 'HIGH',
        verificationSources: ['ORACLE'],
      },
    });

    // Sibling exposure: ONLY sym_executeCharge was edited! sym_refundCharge was only shown.
    const exposures14: ContextUnitExposureRecord[] = [
      {
        episodeId: ep14.episodeId,
        contextUnitId: 'sym_executeCharge',
        path: 'src/payment.ts',
        unitKind: 'FUNCTION',
        state: ContextExposureState.EDITED,
        attributionType: 'EXACT_UNIT',
        readAttribution: 'EXACT_UNIT',
        editAttribution: 'EXACT_UNIT',
        candidateAt: new Date().toISOString(),
        editedAt: new Date().toISOString(),
      },
      {
        episodeId: ep14.episodeId,
        contextUnitId: 'sym_refundCharge',
        path: 'src/payment.ts',
        unitKind: 'FUNCTION',
        state: ContextExposureState.SHOWN,
        attributionType: 'NONE',
        readAttribution: 'NONE',
        editAttribution: 'NONE',
        candidateAt: new Date().toISOString(),
      },
    ];

    const exportRes14 = exporter.exportContextDatasetV2([ep14], {
      isRevoked: () => false,
      exposuresProvider: () => exposures14,
    });

    assertStrictEqual(exportRes14.totalEpisodesAccepted, 1, 'Accepted episode with authoritative rights');
    const executeRow = exportRes14.rows.find((r) => r.contextUnitId === 'sym_executeCharge');
    const refundRow = exportRes14.rows.find((r) => r.contextUnitId === 'sym_refundCharge');
    assert(executeRow !== undefined, 'Found row for sym_executeCharge');
    assert(refundRow !== undefined, 'Found row for sym_refundCharge');
    assertStrictEqual(executeRow!.wasEdited, true, 'sym_executeCharge wasEdited = true');
    assertStrictEqual(executeRow!.verifiedTargetEdit, true, 'sym_executeCharge verifiedTargetEdit = true');
    assertStrictEqual(refundRow!.wasEdited, false, 'sym_refundCharge wasEdited = false');
    assertStrictEqual(refundRow!.verifiedTargetEdit, false, 'sym_refundCharge verifiedTargetEdit = false');

    // =========================================================================
    // Case 15: Missing exposuresProvider in exportContextDatasetV2 fails closed
    // =========================================================================
    console.log('\n--- 15. Missing exposuresProvider in exportContextDatasetV2 fails closed ---');
    let thrown15 = false;
    try {
      (exporter as any).exportContextDatasetV2([ep14], {
        isRevoked: () => false,
      });
    } catch (err: any) {
      thrown15 = true;
      assert(
        err.message.includes('Mandatory exposuresProvider must be provided'),
        `Error contains mandatory exposuresProvider message: ${err.message}`
      );
    }
    assert(thrown15, 'exportContextDatasetV2 threw on missing exposuresProvider');

    // =========================================================================
    // Case 16: verifiedTargetEvidence completely removed in favor of verifiedTargetEdit
    // =========================================================================
    console.log('\n--- 16. verifiedTargetEvidence completely removed in favor of verifiedTargetEdit ---');
    assertStrictEqual(
      (executeRow as any).verifiedTargetEvidence,
      undefined,
      'verifiedTargetEvidence property has been completely removed from SiftrContextDatasetV2Row'
    );
    assertStrictEqual(
      executeRow!.verifiedTargetEdit,
      true,
      'verifiedTargetEdit is populated accurately'
    );

    // =========================================================================
    // Case 17: Pre-outcome snapshot tampering in SQLite rejected by resolveOutcomeLineage
    // =========================================================================
    console.log('\n--- 17. Pre-outcome snapshot tampering rejected by resolveOutcomeLineage ---');
    (store as any).db.prepare('UPDATE pre_outcome_snapshots SET raw_json = ? WHERE episode_id = ?').run(
      JSON.stringify({
        ...snapshot9,
        bundleSha256: 'tampered_bundle_sha_after_the_fact',
      }),
      snapshot9.episodeId
    );

    const lineageTampered = resolveOutcomeLineage(
      {
        contextPlanId: 'plan_http_9',
        sessionId: 'sess_http_9',
        taskId: 'task_http_test',
      },
      store
    );
    assertStrictEqual(lineageTampered.valid, false, 'Lineage resolution rejected tampered snapshot');
    if (!lineageTampered.valid) {
      assert(
        lineageTampered.error.includes('SNAPSHOT_HASH_MISMATCH'),
        `Error indicates SNAPSHOT_HASH_MISMATCH: ${lineageTampered.error}`
      );
    }

    // Restore clean snapshot9
    store.savePreOutcomeSnapshot(snapshot9);

    // =========================================================================
    // Case 18: agentEnvironmentId mismatch between caller and stored plan fails closed
    // =========================================================================
    console.log('\n--- 18. agentEnvironmentId mismatch between caller and stored plan fails closed ---');
    const lineageEnvMismatch = resolveOutcomeLineage(
      {
        contextPlanId: 'plan_http_9',
        sessionId: 'sess_http_9',
        taskId: 'task_http_test',
        agentEnvironmentId: 'env_fraudulent_spoofed',
      },
      store
    );
    assertStrictEqual(lineageEnvMismatch.valid, false, 'Lineage resolution rejected env mismatch');
    if (!lineageEnvMismatch.valid) {
      assertStrictEqual(lineageEnvMismatch.code, 'FAIL_CLOSED_LINEAGE_MISMATCH', 'Code is FAIL_CLOSED_LINEAGE_MISMATCH');
    }

    // =========================================================================
    // Case 19: Lineage fails closed when sessionId is missing (no synthetic fallback)
    // =========================================================================
    console.log('\n--- 19. Lineage fails closed when sessionId is missing ---');
    store.saveContextPlan({
      planId: 'plan_no_sess_19',
      taskId: 'task_http_test',
      workspaceSnapshotId: 'snap_http_9',
      agentEnvironmentId: 'env_http_9',
      budgetPlan: {
        totalAllocatedTokens: 100,
        units: [],
        budgetLimits: { maxTokens: 4000 },
        candidateCount: 0,
      } as any,
      units: [],
      formattedContext: { files: [] } as any,
      exposureDecisions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    const lineageMissingSession = resolveOutcomeLineage(
      {
        contextPlanId: 'plan_no_sess_19',
        taskId: 'task_http_test',
        sessionId: undefined,
      },
      store
    );
    assertStrictEqual(lineageMissingSession.valid, false, 'Lineage resolution fails closed without session');
    if (!lineageMissingSession.valid) {
      assert(
        lineageMissingSession.error.includes('synthetic session generation is forbidden'),
        `Error mentions synthetic session forbidden: ${lineageMissingSession.error}`
      );
    }

    // =========================================================================
    // Case 20: Non-PRODUCTION or custom unidentified ranker blocked from training export
    // =========================================================================
    console.log('\n--- 20. Non-PRODUCTION or custom unidentified ranker blocked from training export ---');
    const ep20Shadow = createTaskEpisodeV1({
      repositoryId: 'kyzoeth/siftrcode',
      sessionId: 'sess_20',
      taskId: 'task_20',
      workspace: {
        repositoryIdentity: 'kyzoeth/siftrcode',
        baseCommit: 'c20',
        dirtyAtStart: false,
        workspaceSnapshotId: 'snap_20',
      },
      task: { prompt: 'Test shadow export' },
      environment: {
        contextPolicyId: 'siftr-default-v2',
        rankerId: 'deterministic-v2',
        rankerStatus: 'SHADOW', // NOT PRODUCTION!
      },
      rights: {
        trainingAllowed: true,
        permissionSource: 'USER_CONSENT',
      },
      contextDecision: {
        candidateCount: 1,
        candidates: [],
        selectedUnits: [],
        bundleSha256: 'b20',
        actualRenderedTokens: 100,
        tokenBudget: 4000,
      },
      outcome: {
        episodeId: 'ep_20',
        verifiedSuccess: true,
        verificationConfidence: 'HIGH',
        verificationSources: ['ORACLE'],
      },
    });

    const exportRes20 = exporter.exportContextDatasetV2([ep20Shadow], {
      isRevoked: () => false,
      exposuresProvider: () => [],
    });
    assertStrictEqual(exportRes20.totalEpisodesAccepted, 0, 'Zero accepted for SHADOW rankerStatus');
    assert(
      exportRes20.rejections[0].reasons[0].includes('POLICY_INELIGIBLE: Ranker status is SHADOW'),
      `Rejection reason contains POLICY_INELIGIBLE: ${exportRes20.rejections[0].reasons[0]}`
    );

    // Also test custom unidentified ranker
    const ep20Custom = createTaskEpisodeV1({
      ...ep20Shadow,
      episodeId: 'ep_20_custom',
      environment: {
        contextPolicyId: 'siftr-default-v2',
        rankerId: 'custom_unidentified',
        rankerStatus: 'PRODUCTION',
      },
    });
    const exportRes20Custom = exporter.exportContextDatasetV2([ep20Custom], {
      isRevoked: () => false,
      exposuresProvider: () => [],
    });
    assertStrictEqual(exportRes20Custom.totalEpisodesAccepted, 0, 'Zero accepted for custom unidentified ranker');
    assert(
      exportRes20Custom.rejections[0].reasons[0].includes('custom_unidentified'),
      `Rejection reason contains custom_unidentified: ${exportRes20Custom.rejections[0].reasons[0]}`
    );

    // =========================================================================
    // Case 21: Readiness Gate 6 enforces 100% distinct active eligible snapshots with passing audits
    // =========================================================================
    console.log('\n--- 21. Readiness Gate 6 enforces 100% distinct active eligible snapshots with passing audits ---');
    const snap21a = createPreOutcomeEpisodeSnapshot({
      episodeId: 'ep_21a',
      taskId: 'task_21a',
      prompt: 'Prompt 21a',
      promptSha256: 'sha21a',
      repositoryId: 'kyzoeth/siftrcode',
      baseCommit: 'a'.repeat(40),
      featureCutoffCommit: 'a'.repeat(40),
      workspaceSnapshotId: 'snap_21a',
      candidateUniverse: [],
      selectedUnits: [],
      tokenBudget: 4000,
      actualRenderedTokens: 100,
      bundleSha256: 'bundle_21a',
      contextPolicyId: 'siftr-default-v2',
      rankerId: 'deterministic-v2',
      contextPolicyIdentity: {
        contextPolicyId: 'siftr-default-v2',
        rankerId: 'deterministic-v2',
        rankerVersion: 'v2.0.0',
        featureSetVersion: 'CONTEXT_FEATURES_V1',
        candidateGeneratorVersion: 'v1.0.0',
        budgetPolicyVersion: 'v1.0.0',
        materializerVersion: 'v1.0.0',
      },
      capturedAt: new Date().toISOString(),
    });
    store.savePreOutcomeSnapshot(snap21a);
    const ep21a = createTaskEpisodeV1({
      episodeId: 'ep_21a',
      repositoryId: 'kyzoeth/siftrcode',
      sessionId: 'sess_21a',
      taskId: 'task_21a',
      workspace: {
        repositoryIdentity: 'kyzoeth/siftrcode',
        baseCommit: 'a'.repeat(40),
        dirtyAtStart: false,
        workspaceSnapshotId: 'snap_21a',
      },
      task: { prompt: 'Prompt 21a' },
      environment: {
        contextPolicyId: 'siftr-default-v2',
        rankerId: 'deterministic-v2',
        rankerStatus: 'PRODUCTION',
      },
      rights: {
        trainingAllowed: true,
        permissionSource: 'USER_CONSENT',
      },
      contextDecision: {
        candidateCount: 0,
        bundleSha256: 'bundle_21a',
        actualRenderedTokens: 100,
        tokenBudget: 4000,
        candidates: [],
        selectedUnits: [],
      },
      outcome: {
        episodeId: 'ep_21a',
        verifiedSuccess: true,
        verificationConfidence: 'HIGH',
        verificationSources: ['BEHAVIORAL_ORACLE'],
      },
    });
    store.saveTaskEpisode(ep21a);

    // Audit snap21a with passing audit
    store.auditPreOutcomeSnapshot(JSON.stringify(snap21a));

    // Now insert a second active snapshot snap21b WITHOUT an audit yet
    const snap21b = createPreOutcomeEpisodeSnapshot({
      episodeId: 'ep_21b',
      taskId: 'task_21b',
      prompt: 'Prompt 21b',
      promptSha256: 'sha21b',
      repositoryId: 'kyzoeth/siftrcode',
      baseCommit: 'b'.repeat(40),
      featureCutoffCommit: 'b'.repeat(40),
      workspaceSnapshotId: 'snap_21b',
      candidateUniverse: [],
      selectedUnits: [],
      tokenBudget: 4000,
      actualRenderedTokens: 100,
      bundleSha256: 'bundle_21b',
      contextPolicyId: 'siftr-default-v2',
      rankerId: 'deterministic-v2',
      contextPolicyIdentity: {
        contextPolicyId: 'siftr-default-v2',
        rankerId: 'deterministic-v2',
        rankerVersion: 'v2.0.0',
        featureSetVersion: 'CONTEXT_FEATURES_V1',
        candidateGeneratorVersion: 'v1.0.0',
        budgetPolicyVersion: 'v1.0.0',
        materializerVersion: 'v1.0.0',
      },
      capturedAt: new Date().toISOString(),
    });
    store.savePreOutcomeSnapshot(snap21b);
    const ep21b = createTaskEpisodeV1({
      episodeId: 'ep_21b',
      repositoryId: 'kyzoeth/siftrcode',
      sessionId: 'sess_21b',
      taskId: 'task_21b',
      workspace: {
        repositoryIdentity: 'kyzoeth/siftrcode',
        baseCommit: 'b'.repeat(40),
        dirtyAtStart: false,
        workspaceSnapshotId: 'snap_21b',
      },
      task: { prompt: 'Prompt 21b' },
      environment: {
        contextPolicyId: 'siftr-default-v2',
        rankerId: 'deterministic-v2',
        rankerStatus: 'PRODUCTION',
      },
      rights: {
        trainingAllowed: true,
        permissionSource: 'USER_CONSENT',
      },
      contextDecision: {
        candidateCount: 0,
        bundleSha256: 'bundle_21b',
        actualRenderedTokens: 100,
        tokenBudget: 4000,
        candidates: [],
        selectedUnits: [],
      },
      outcome: {
        episodeId: 'ep_21b',
        verifiedSuccess: true,
        verificationConfidence: 'HIGH',
        verificationSources: ['BEHAVIORAL_ORACLE'],
      },
    });
    store.saveTaskEpisode(ep21b);

    // Manually record a failed audit for snap21b
    store.savePreOutcomeIntegrityAudit({
      auditId: 'audit_fail_21b',
      episodeId: snap21b.episodeId,
      snapshotSha256: snap21b.snapshotSha256,
      recomputedSha256: 'mismatched_sha',
      passed: false,
      hasLeakage: true,
      hasHashMismatch: true,
      hasProvenanceError: false,
      auditedAt: new Date().toISOString(),
      details: { leakageFieldsFound: ['futurePatch'] },
    });

    const readinessReportFail = store.getV32DataReadinessReport();
    const gate6Fail = readinessReportFail.canonicalEvaluation!.gates.find((g: any) => g.name.includes('Zero-Leakage Audit'));
    assert(gate6Fail !== undefined, 'Found Gate 6 in readiness report');
    assertStrictEqual(gate6Fail!.passed, false, 'Gate 6 strictly fails when active snapshot audit fails');

    // Fix the audit for snap21b
    (store as any).db.prepare('DELETE FROM pre_outcome_integrity_audits WHERE episode_id = ?').run(snap21b.episodeId);
    store.auditPreOutcomeSnapshot(JSON.stringify(snap21b));

    // Audit all other active snapshots to satisfy 100%
    const allActive = (store as any).db.prepare('SELECT raw_json FROM pre_outcome_snapshots WHERE episode_id NOT IN (SELECT episode_id FROM episode_revocations)').all() as any[];
    for (const r of allActive) {
      store.auditPreOutcomeSnapshot(r.raw_json);
    }

    const readinessReportPass = store.getV32DataReadinessReport();
    const gate6Pass = readinessReportPass.canonicalEvaluation!.gates.find((g: any) => g.name.includes('Zero-Leakage Audit'));
    assertStrictEqual(gate6Pass!.passed, true, 'Gate 6 passes when 100% active snapshots have passing audits');

    // =========================================================================
    // Case 22: Readiness Gate 7 counts strictly is_synthetic = 0 AND environment = 'PRODUCTION'
    // =========================================================================
    console.log('\n--- 22. Readiness Gate 7 counts strictly is_synthetic = 0 AND environment = "PRODUCTION" ---');
    // Save synthetic or non-production evaluations
    store.saveShadowPolicyEvaluation(
      {
        taskId: 't_synth',
        productionPolicyId: 'prod',
        shadowPolicyId: 'shadow',
        candidateCount: 5,
        topK: 5,
        rankOverlapJaccard: 0.9,
        topKDifferences: { inProductionOnly: [], inShadowOnly: [], sharedTopKCount: 5 },
        inclusionDifferences: { inProductionOnly: [], inShadowOnly: [], sharedInclusionCount: 5 },
        resolutionDifferences: [],
        tokenDifference: 0,
        productionTokens: 500,
        shadowTokens: 500,
        shadowLatencyMs: 10,
        evaluatedAt: new Date().toISOString(),
      },
      false,
      undefined,
      'STAGING',
      true // synthetic
    );

    const reportBefore = store.getV32DataReadinessReport();
    const gate7Before = reportBefore.canonicalEvaluation!.gates.find((g: any) => g.name.includes('Shadow Policy Stability') || g.name.includes('Shadow Policy Parity'));
    assert(gate7Before !== undefined, 'Found Gate 7');
    assertStrictEqual(gate7Before!.currentValue, '0 runs, 0 crashes', 'Gate 7 ignores synthetic / non-production runs');

    // Now save a genuine PRODUCTION, non-synthetic evaluation
    store.saveShadowPolicyEvaluation(
      {
        taskId: 't_real_prod',
        productionPolicyId: 'prod',
        shadowPolicyId: 'shadow',
        candidateCount: 5,
        topK: 5,
        rankOverlapJaccard: 0.9,
        topKDifferences: { inProductionOnly: [], inShadowOnly: [], sharedTopKCount: 5 },
        inclusionDifferences: { inProductionOnly: [], inShadowOnly: [], sharedInclusionCount: 5 },
        resolutionDifferences: [],
        tokenDifference: 0,
        productionTokens: 500,
        shadowTokens: 500,
        shadowLatencyMs: 10,
        evaluatedAt: new Date().toISOString(),
      },
      false,
      undefined,
      'PRODUCTION',
      false // NOT synthetic
    );

    const reportAfter = store.getV32DataReadinessReport();
    const gate7After = reportAfter.canonicalEvaluation!.gates.find((g: any) => g.name.includes('Shadow Policy Stability') || g.name.includes('Shadow Policy Parity'));
    assertStrictEqual(
      gate7After!.currentValue,
      '1 runs, 0 crashes',
      'Gate 7 shadowEvaluationRuns incremented strictly for real PRODUCTION shadow runs'
    );

    // =========================================================================
    // Case 23: TaskEpisodeV1 payload tampering rejected by loadVerifiedTaskEpisode
    // =========================================================================
    console.log('\n--- 23. TaskEpisodeV1 payload tampering rejected by loadVerifiedTaskEpisode ---');
    const validEp = createTaskEpisodeV1({
      repositoryId: 'kyzoeth/siftrcode',
      sessionId: 'sess_tamper_23',
      taskId: 'task_tamper_23',
      workspace: {
        repositoryIdentity: 'kyzoeth/siftrcode',
        baseCommit: 'c23',
        dirtyAtStart: false,
        workspaceSnapshotId: 'snap_23',
      },
      task: { prompt: 'Test tamper detection' },
      environment: {
        contextPolicyId: 'siftr-default-v2',
        rankerId: 'deterministic-v2',
        rankerStatus: 'PRODUCTION',
      },
      rights: {
        trainingAllowed: true,
        permissionSource: 'USER_CONSENT',
      },
      contextDecision: {
        candidateCount: 1,
        candidates: [],
        selectedUnits: [],
        bundleSha256: 'b23',
        actualRenderedTokens: 100,
        tokenBudget: 4000,
      },
      outcome: {
        episodeId: 'ep_tamper_23',
        verifiedSuccess: true,
        verificationConfidence: 'HIGH',
        verificationSources: ['ORACLE'],
      },
    });

    // Verify valid load succeeds
    const verifiedEp = loadVerifiedTaskEpisode(validEp);
    assert(verifiedEp !== undefined, 'Valid episode loaded and verified successfully');

    // Now tamper with nested field contextDecision.tokenBudget
    const tamperedEp = JSON.parse(JSON.stringify(validEp));
    tamperedEp.contextDecision.tokenBudget = 999999;

    let thrownTamper = false;
    try {
      loadVerifiedTaskEpisode(tamperedEp);
    } catch (err: any) {
      thrownTamper = true;
      assert(
        err.message.includes('FAIL_CLOSED_EPISODE_HASH_MISMATCH'),
        `Tamper threw FAIL_CLOSED_EPISODE_HASH_MISMATCH: ${err.message}`
      );
    }
    assert(thrownTamper, 'loadVerifiedTaskEpisode rejected tampered payload');

    // =========================================================================
    // Case 24: Primary real E2E production path: full run through /api/outcome or siftr_outcome
    // =========================================================================
    console.log('\n--- 24. Primary real E2E production path: full run with verified lineage and export ---');
    // Setup real engine run
    const e2eWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-e2e-real-path-'));
    fs.mkdirSync(path.join(e2eWorkspaceDir, 'src'), { recursive: true });
    const paymentFile = path.join(e2eWorkspaceDir, 'src', 'payment_service.ts');
    fs.writeFileSync(
      paymentFile,
      `export class PaymentService {
  executePayment(amount: number): boolean {
    return amount > 0;
  }
}`
    );

    const execSync = require('child_process').execSync;
    execSync('git init && git config user.name "Test" && git config user.email "test@example.com"', {
      cwd: e2eWorkspaceDir,
      stdio: 'pipe',
    });
    execSync('git add -A && git commit -m "initial commit"', {
      cwd: e2eWorkspaceDir,
      stdio: 'pipe',
    });

    const engineStore = new SqliteStore(path.join(e2eWorkspaceDir, '.siftr', 'observations.sqlite'));
    setSharedStore(engineStore);

    const rights24 = createDefaultDataRights({
      trainingAllowed: true,
    });
    rights24.rightsProvenance = {
      serviceProcessingAllowed: true,
      trainingAllowed: true,
      redistributionAllowed: true,
      permissionSource: 'USER_CONSENT',
      decisionTimestamp: new Date().toISOString(),
    };

    const optimizeResult = await ContextEngine.optimizeWorkspace({
      workspaceDir: e2eWorkspaceDir,
      prompt: 'Fix payment verification in src/payment_service.ts and executePayment in PaymentService',
      sessionId: 'sess_real_e2e_24',
      taskId: 'task_real_e2e_24',
      sqliteStore: engineStore,
      tokenBudget: 4000,
      dataRights: rights24,
    });

    const plan = optimizeResult.plan;
    assert(plan.planId !== undefined, 'Generated real ContextPlan');
    assert(plan.units.length > 0, 'ContextPlan contains indexed contextUnits');
    const targetUnit = plan.units[0];

    // Simulate real agent reading & editing the file
    fs.appendFileSync(paymentFile, '\n// Fix applied\n');

    // Record exposure event in store via trajectory
    engineStore.saveEpisodeTrajectoryEvents([
      {
        eventId: 'evt_edit_24',
        episodeId: plan.preOutcomeSnapshot!.episodeId,
        timestamp: new Date().toISOString(),
        sequence: 1,
        type: 'FILE_EDIT',
        path: 'src/payment_service.ts',
        contextUnitId: targetUnit.contextUnitId,
      },
    ]);

    // Call real HTTP /api/outcome with strong verification oracle
    const httpE2ERes = await makeHttpRequest(
      httpServer,
      {
        host: '127.0.0.1',
        port: httpPort,
        path: '/api/outcome',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({
        taskId: plan.taskId,
        sessionId: plan.sessionId,
        planId: plan.planId,
        agentEnvironmentId: plan.agentEnvironmentId,
        workspaceSnapshotBefore: plan.workspaceSnapshotId,
        behavioralOraclePassed: true,
        regressionTestsPassed: true,
        securityChecksPassed: true,
        costUSD: 0.005,
      })
    );

    assertStrictEqual(httpE2ERes.statusCode, 200, 'HTTP /api/outcome returned status 200');
    const e2ePayload = JSON.parse(httpE2ERes.body);
    assertStrictEqual(e2ePayload.verifiedSuccess, true, 'Real HTTP run evaluated verifiedSuccess = true');
    assertStrictEqual(e2ePayload.episodeFinalized, true, 'Real HTTP run automatically finalized TaskEpisode');

    // Verify finalized episode in SQLite
    const finalizedEpisodes = engineStore.listTaskEpisodes({ taskId: plan.taskId });
    assertStrictEqual(finalizedEpisodes.length, 1, 'Finalized TaskEpisode persisted in SQLite');
    const episode24 = finalizedEpisodes[0];
    assertStrictEqual(episode24.outcome.verifiedSuccess, true, 'Persisted episode has verifiedSuccess = true');

    // Export dataset V2 directly from genuine production episode
    const exportRes24 = exporter.exportContextDatasetV2([episode24], {
      isRevoked: () => false,
      exposuresProvider: (epId) => engineStore.getContextExposures(epId),
    });

    assertStrictEqual(exportRes24.totalEpisodesAccepted, 1, 'Export accepted finalized production episode');
    assert(exportRes24.rows.length > 0, 'Export produced SiftrContextDatasetV2Row records');
    const exportedUnitRow = exportRes24.rows.find((r) => r.contextUnitId === targetUnit.contextUnitId);
    assert(exportedUnitRow !== undefined, 'Found exported row for targetUnit');
    assertStrictEqual(exportedUnitRow!.verifiedTargetEdit, true, 'Exported row has verifiedTargetEdit = true');
    assertStrictEqual(exportedUnitRow!.wasInSuccessfulTask, true, 'Exported row has wasInSuccessfulTask = true');

    assertStrictEqual(e2ePayload.trainingEligible, true, 'Real HTTP run evaluated trainingEligible = true on fully eligible episode');

    // =========================================================================
    // Case 25: Dataset V2 export strictly rejects episode if any candidate lacks an authoritative exposure record
    // =========================================================================
    console.log('\n--- 25. Rejects Dataset V2 export if any candidate lacks exposure record ---');
    const exportMissingCandidateExp = exporter.exportContextDatasetV2([episode24], {
      isRevoked: () => false,
      exposuresProvider: () => [], // Empty exposures: candidates lack authoritative exposure records
    });
    assertStrictEqual(exportMissingCandidateExp.totalEpisodesAccepted, 0, 'Zero episodes accepted when candidates lack exposure');
    assertStrictEqual(exportMissingCandidateExp.totalEpisodesRejected, 1, 'Episode rejected when candidates lack exposure');
    assert(
      exportMissingCandidateExp.rejections[0].reasons.some((r) => r.includes('MISSING_EXPOSURE_RECORD')),
      `Rejection reason contains MISSING_EXPOSURE_RECORD: ${exportMissingCandidateExp.rejections[0].reasons.join(', ')}`
    );

    // =========================================================================
    // Case 26: Canonical isEpisodeTrainingEligible() predicate enforces all integrity requirements
    // =========================================================================
    console.log('\n--- 26. Canonical isEpisodeTrainingEligible() evaluation ---');
    // Valid episode is eligible
    assert(
      isEpisodeTrainingEligible(episode24, {
        isRevoked: () => false,
        exposuresProvider: (id) => engineStore.getContextExposures(id),
      }),
      'episode24 is training eligible'
    );
    // Blocked if isRevoked is missing (mandatory fail closed)
    const missingRevRes = evaluateEpisodeTrainingEligibility(episode24, {
      exposuresProvider: (id: string) => engineStore.getContextExposures(id),
    } as any);
    assertStrictEqual(missingRevRes.eligible, false, 'Missing isRevoked fails closed');
    assert(
      missingRevRes.reasons.some((r) => r.includes('Mandatory isRevoked authority is required')),
      'Reason cites missing mandatory isRevoked authority'
    );
    // Blocked if exposuresProvider is missing (mandatory fail closed)
    const missingExpRes = evaluateEpisodeTrainingEligibility(episode24, {
      isRevoked: () => false,
    } as any);
    assertStrictEqual(missingExpRes.eligible, false, 'Missing exposuresProvider fails closed');
    assert(
      missingExpRes.reasons.some((r) => r.includes('Mandatory exposuresProvider is required')),
      'Reason cites missing mandatory exposuresProvider'
    );
    // Blocked if exposure record is not bound to this episode
    const foreignExpRes = evaluateEpisodeTrainingEligibility(episode24, {
      isRevoked: () => false,
      exposuresProvider: (id) => [
        {
          episodeId: 'foreign_episode_id',
          contextUnitId: episode24.contextDecision.candidates[0].contextUnitId,
          unitKind: 'SOURCE_FILE',
          state: ContextExposureState.SHOWN,
          candidateAt: new Date().toISOString(),
        },
      ],
    });
    assertStrictEqual(foreignExpRes.eligible, false, 'Unbound exposure record fails closed');
    assert(
      foreignExpRes.reasons.some((r) => r.includes('UNBOUND_EXPOSURE_RECORD')),
      'Reason cites UNBOUND_EXPOSURE_RECORD'
    );
    // Blocked if trainingAllowed is false
    const rightsBlockedEp: TaskEpisodeV1 = { ...episode24, rights: { ...episode24.rights, trainingAllowed: false } };
    assertStrictEqual(
      isEpisodeTrainingEligible(rightsBlockedEp, {
        isRevoked: () => false,
        exposuresProvider: (id) => engineStore.getContextExposures(id),
      }),
      false,
      'Episode with trainingAllowed = false is not training eligible'
    );
    // Blocked if permissionSource is UNKNOWN
    const unknownSourceEp: TaskEpisodeV1 = { ...episode24, rights: { ...episode24.rights, permissionSource: 'UNKNOWN' } };
    assertStrictEqual(
      isEpisodeTrainingEligible(unknownSourceEp, {
        isRevoked: () => false,
        exposuresProvider: (id) => engineStore.getContextExposures(id),
      }),
      false,
      'Episode with permissionSource = UNKNOWN is not training eligible'
    );
    // Blocked if rankerStatus is not PRODUCTION
    const nonProdRankerEp: TaskEpisodeV1 = { ...episode24, environment: { ...episode24.environment, rankerStatus: 'SHADOW' } };
    assertStrictEqual(
      isEpisodeTrainingEligible(nonProdRankerEp, {
        isRevoked: () => false,
        exposuresProvider: (id) => engineStore.getContextExposures(id),
      }),
      false,
      'Episode with rankerStatus = SHADOW is not training eligible'
    );
    // Blocked if rankerId is custom_unidentified
    const customRankerEp: TaskEpisodeV1 = { ...episode24, environment: { ...episode24.environment, rankerId: 'custom_unidentified' } };
    assertStrictEqual(
      isEpisodeTrainingEligible(customRankerEp, {
        isRevoked: () => false,
        exposuresProvider: (id) => engineStore.getContextExposures(id),
      }),
      false,
      'Episode with rankerId = custom_unidentified is not training eligible'
    );
    // Blocked if revoked
    assertStrictEqual(
      isEpisodeTrainingEligible(episode24, {
        isRevoked: () => true,
        exposuresProvider: (id) => engineStore.getContextExposures(id),
      }),
      false,
      'Revoked episode is not training eligible'
    );

    // =========================================================================
    // Case 27: Outcome endpoints stop reporting trainingEligible = verifiedSuccess
    // =========================================================================
    console.log('\n--- 27. Stop reporting trainingEligible = verifiedSuccess ---');
    const optimizeResult27 = await ContextEngine.optimizeWorkspace({
      workspaceDir: e2eWorkspaceDir,
      prompt: 'Fix payment verification in src/payment_service.ts',
      sessionId: 'sess_rights_blocked_27',
      taskId: 'task_rights_blocked_27',
      sqliteStore: engineStore,
      tokenBudget: 4000,
      dataRights: createDefaultDataRights({ trainingAllowed: false }),
    });
    const plan27 = optimizeResult27.plan;

    const blockedOutcomeRes = await makeHttpRequest(
      httpServer,
      {
        host: '127.0.0.1',
        port: httpPort,
        path: '/api/outcome',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({
        taskId: plan27.taskId,
        sessionId: plan27.sessionId,
        planId: plan27.planId,
        agentEnvironmentId: plan27.agentEnvironmentId,
        workspaceSnapshotBefore: plan27.workspaceSnapshotId,
        behavioralOraclePassed: true,
        regressionTestsPassed: true,
      })
    );

    assertStrictEqual(blockedOutcomeRes.statusCode, 200, 'HTTP /api/outcome returned status 200');
    const blockedPayload = JSON.parse(blockedOutcomeRes.body);
    assertStrictEqual(blockedPayload.verifiedSuccess, true, 'verifiedSuccess is true based on oracle');
    assertStrictEqual(blockedPayload.episodeFinalized, true, 'episodeFinalized is true');
    assertStrictEqual(
      blockedPayload.trainingEligible,
      false,
      'trainingEligible is strictly false when trainingAllowed = false, despite verifiedSuccess = true'
    );

    // =========================================================================
    // Case 28: Canonical episode assembly fails closed when sessionId is missing
    // =========================================================================
    console.log('\n--- 28. Canonical episode assembly fails closed on missing sessionId ---');
    let missingSessionThrew = false;
    try {
      EpisodeAssembler.assembleEpisode({
        episodeId: 'ep_test_missing_sess',
        preOutcomeSnapshot: plan.preOutcomeSnapshot!,
        plan: { ...plan, sessionId: undefined as any },
        task: { taskId: 'task_missing_sess', primaryPrompt: 'Fix bug', evidence: [] } as any,
        snapshot: {
          workspaceSnapshotId: plan.workspaceSnapshotId!,
          contentRootHash: 'hash',
          createdAt: new Date().toISOString(),
          repositories: [],
        },
        outcome: { verifiedSuccess: true, verificationConfidence: 'HIGH' } as any,
        trajectoryEvents: [],
        dataRights: plan.dataRights,
      });
    } catch (err: any) {
      missingSessionThrew = true;
      assertStrictEqual(err.code, 'FAIL_CLOSED_LINEAGE_MISMATCH', 'Error code is FAIL_CLOSED_LINEAGE_MISMATCH');
      assert(err.message.includes('Missing sessionId in canonical episode assembly'), 'Error mentions missing sessionId');
    }
    assert(missingSessionThrew, 'EpisodeAssembler.assembleEpisode threw on missing sessionId (no sess_default)');

    // =========================================================================
    // Case 29: Gate 7 rationale deleted unmeasured <= 25ms claim
    // =========================================================================
    console.log('\n--- 29. Gate 7 rationale deleted unmeasured latency claim ---');
    const dummyReadiness = evaluateCanonicalReadinessGates({
      totalEpisodes: 1000,
      verifiedSuccesses: 200,
      verifiedFailures: 100,
      unknownOutcomes: 50,
      episodesWithCandidatesLogged: 900,
      unpermittedEpisodesInPool: 0,
      revokedEpisodesInPool: 0,
      verifiedEpisodesWithMissingProof: 0,
      preOutcomeSnapshotsAudited: 100,
      leakageViolationsDetected: 0,
      shadowEvaluationRuns: 100,
      shadowEvaluationCrashes: 0,
    });
    const gate7 = dummyReadiness.gates.find((g) => g.gateId === 'GATE_7_SHADOW_POLICY_PARITY');
    assert(gate7 !== undefined, 'Found Gate 7');
    assert(
      !gate7!.rationale.includes('25ms'),
      `Gate 7 rationale does not contain "25ms": "${gate7!.rationale}"`
    );
    assert(
      gate7!.rationale.includes('operational stability'),
      `Gate 7 rationale includes "operational stability": "${gate7!.rationale}"`
    );

    // =========================================================================
    // Case 30: 1,000 apparently good but rights-ineligible episodes leave readiness false (non-vacuous Gate 4)
    // =========================================================================
    console.log('\n--- 30. 1,000 rights-ineligible episodes leave readiness false ---');
    const case30Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_case30_'));
    try {
      const case30Store = new SqliteStore(path.join(case30Dir, 'test.db'));
      const db = (case30Store as any).db;

      // Seed 1,000 episodes using authentic createTaskEpisodeV1() records:
      // - 700 verified successes, 300 verified failures
      // - Full candidate universes logged in episode_candidates
      // - Context unit exposures logged in context_exposures
      // - Valid pre-outcome snapshots with passing integrity audits
      // - 100 production shadow policy runs with 0 crashes
      // - BUT trainingAllowed = false (rights ineligible)
      db.exec('BEGIN IMMEDIATE');
      for (let i = 0; i < 1000; i++) {
        const epId = `ep_rights_ineligible_${i}`;
        const isSuccess = i < 700;
        const candidateUnitId = `unit_${i}`;
        const candidatePath = `src/file_${i}.ts`;

        const authenticEp = createTaskEpisodeV1({
          episodeId: epId,
          tenantId: 'tenant_default',
          repositoryId: 'repo_ineligible',
          sessionId: `sess_${i}`,
          taskId: `task_${i}`,
          workspace: {
            repositoryIdentity: 'repo_ineligible',
            baseCommit: 'base_commit_123',
            dirtyAtStart: false,
            workspaceSnapshotId: `ws_${i}`,
          },
          task: {
            prompt: 'Fix payment bug',
            taskType: 'BUG_FIX',
            evidence: [],
          },
          environment: {
            contextPolicyId: 'default_v1',
            rankerId: 'heuristic_v1',
            rankerStatus: 'PRODUCTION',
          },
          rights: {
            trainingAllowed: false, // Explicitly rights ineligible!
            serviceProcessingAllowed: true,
            redistributionAllowed: false,
            permissionSource: 'USER_CONSENT',
          },
          contextDecision: {
            candidateCount: 1,
            bundleSha256: 'bundle_sha',
            actualRenderedTokens: 100,
            tokenBudget: 2000,
            candidates: [
              {
                contextUnitId: candidateUnitId,
                path: candidatePath,
                unitKind: 'SOURCE_FILE',
                retrievalSources: ['lexical'],
                finalRank: 1,
                finalScore: 0.95,
                featureSetVersion: 'v1',
                featureSnapshot: {},
                estimatedTokens: 100,
                selected: true,
              },
            ],
            selectedUnits: [
              {
                contextUnitId: candidateUnitId,
                path: candidatePath,
                unitKind: 'SOURCE_FILE',
                resolution: 'FULL',
                rank: 1,
                allocatedTokens: 100,
              },
            ],
          },
          outcome: {
            episodeId: epId,
            verifiedSuccess: isSuccess,
            verificationConfidence: 'HIGH',
            verificationSources: ['BEHAVIORAL_ORACLE'],
          },
        });

        case30Store.saveTaskEpisode(authenticEp);

        case30Store.saveContextExposures(
          [
            {
              episodeId: epId,
              contextUnitId: candidateUnitId,
              path: candidatePath,
              unitKind: 'SOURCE_FILE',
              state: ContextExposureState.SHOWN,
              finalRank: 1,
              candidateAt: '2026-09-22T00:00:00.000Z',
              selectedAt: '2026-09-22T00:00:01.000Z',
              shownAt: '2026-09-22T00:00:02.000Z',
            },
          ],
          epId
        );

        const preSnap = createPreOutcomeEpisodeSnapshot({
          episodeId: epId,
          taskId: `task_${i}`,
          prompt: 'Fix payment bug',
          promptSha256: crypto.createHash('sha256').update('Fix payment bug').digest('hex'),
          repositoryId: 'repo_ineligible',
          baseCommit: 'base_commit_123',
          featureCutoffCommit: 'base_commit_123',
          workspaceSnapshotId: `ws_${i}`,
          candidateUniverse: authenticEp.contextDecision.candidates!,
          selectedUnits: [
            {
              contextUnitId: candidateUnitId,
              path: candidatePath,
              unitKind: 'SOURCE_FILE',
              resolution: 'FULL',
              rank: 1,
              allocatedTokens: 100,
            },
          ],
          tokenBudget: 2000,
          actualRenderedTokens: 100,
          bundleSha256: 'bundle_sha',
          contextPolicyId: 'default_v1',
          rankerId: 'heuristic_v1',
          capturedAt: '2026-09-22T00:00:00.000Z',
        });
        case30Store.savePreOutcomeSnapshot(preSnap);

        case30Store.savePreOutcomeIntegrityAudit({
          auditId: `audit_${i}`,
          episodeId: epId,
          snapshotSha256: preSnap.snapshotSha256,
          recomputedSha256: preSnap.snapshotSha256,
          passed: true,
          hasLeakage: false,
          hasHashMismatch: false,
          hasProvenanceError: false,
          auditedAt: '2026-09-22T00:00:00.000Z',
          details: {},
        });
      }

      // Insert 100 passing production shadow evaluations
      for (let j = 0; j < 100; j++) {
        case30Store.saveShadowPolicyEvaluation(
          {
            taskId: `task_shadow_${j}`,
            productionPolicyId: 'prod_v1',
            shadowPolicyId: 'shadow_v1',
            candidateCount: 10,
            topK: 10,
            rankOverlapJaccard: 0.9,
            topKDifferences: { inProductionOnly: [], inShadowOnly: [], sharedTopKCount: 10 },
            inclusionDifferences: { inProductionOnly: [], inShadowOnly: [], sharedInclusionCount: 10 },
            resolutionDifferences: [],
            tokenDifference: 50,
            productionTokens: 100,
            shadowTokens: 150,
            shadowLatencyMs: 12,
            evaluatedAt: '2026-09-22T00:00:00.000Z',
          },
          false,
          undefined,
          'PRODUCTION',
          false
        );
      }
      db.exec('COMMIT');

      // 1. Prove rights is the SINGLE disqualifying variable on a sample episode
      const sampleEpisode = case30Store.getTaskEpisode('ep_rights_ineligible_0')!;
      assert(sampleEpisode !== null, 'Sample episode loaded');
      const sampleEval = evaluateEpisodeTrainingEligibility(sampleEpisode, {
        isRevoked: (id) => case30Store.isEpisodeRevoked(id),
        exposuresProvider: (id) => case30Store.getContextExposures(id),
      });
      assertStrictEqual(sampleEval.eligible, false, 'Sample episode is ineligible');
      assertStrictEqual(sampleEval.reasons.length, 1, 'Strictly 1 disqualifying reason');
      assert(
        sampleEval.reasons[0].includes('RIGHTS_BLOCKED: trainingAllowed is false'),
        `Disqualifying reason is rights: ${sampleEval.reasons[0]}`
      );

      // Clone sample episode with trainingAllowed = true, keeping all else identical
      const permittedSample = createTaskEpisodeV1({
        episodeId: 'ep_permitted_sample',
        tenantId: sampleEpisode.tenantId,
        repositoryId: sampleEpisode.repositoryId,
        sessionId: sampleEpisode.sessionId,
        taskId: sampleEpisode.taskId,
        workspace: sampleEpisode.workspace,
        task: {
          prompt: sampleEpisode.task.prompt,
          taskType: sampleEpisode.task.taskType,
          evidence: sampleEpisode.task.evidence,
        },
        environment: sampleEpisode.environment,
        rights: {
          ...sampleEpisode.rights,
          trainingAllowed: true,
        },
        contextDecision: sampleEpisode.contextDecision,
        outcome: sampleEpisode.outcome,
      });
      const permittedEval = evaluateEpisodeTrainingEligibility(permittedSample, {
        isRevoked: (id) => case30Store.isEpisodeRevoked(id),
        exposuresProvider: (id) =>
          case30Store
            .getContextExposures('ep_rights_ineligible_0')
            .map((e) => ({ ...e, episodeId: 'ep_permitted_sample' })),
      });
      assertStrictEqual(permittedEval.eligible, true, 'Permitted sample is 100% training eligible');
      assertStrictEqual(permittedEval.reasons.length, 0, 'Zero rejection reasons when trainingAllowed is true');

      // 2. Summary has 1,000 raw episodes
      const summary = case30Store.getLearningFlywheelSummary();
      assertStrictEqual(summary.totalEpisodes, 1000, 'Raw totalEpisodes in summary is 1,000');

      // 3. Readiness report derivation
      const readinessReport = case30Store.getV32DataReadinessReport();

      // Eligible population is strictly 0
      assertStrictEqual(readinessReport.trainingEligibleEpisodes, 0, 'Training-eligible episodes is strictly 0');
      assertStrictEqual(readinessReport.currentVerifiedEpisodes, 0, 'Eligible verified episodes is strictly 0');
      assertStrictEqual(readinessReport.isV32Ready, false, 'isV32Ready is strictly false');
      assert(readinessReport.canonicalEvaluation !== undefined, 'Canonical evaluation is present');
      assertStrictEqual(readinessReport.canonicalEvaluation!.allGatesPassed, false, 'allGatesPassed is strictly false');

      // Assert repository & task-type readiness metrics are derived strictly from eligible population (all 0)
      assertStrictEqual(
        readinessReport.currentIndependentRepositories,
        0,
        'currentIndependentRepositories is 0 (derived from eligiblePopulation)'
      );
      assertStrictEqual(readinessReport.bugFixEpisodes, 0, 'bugFixEpisodes is 0 (derived from eligiblePopulation)');
      assertStrictEqual(
        readinessReport.featureAdditionEpisodes,
        0,
        'featureAdditionEpisodes is 0 (derived from eligiblePopulation)'
      );
      assertStrictEqual(readinessReport.refactorEpisodes, 0, 'refactorEpisodes is 0 (derived from eligiblePopulation)');
      assertStrictEqual(
        readinessReport.testFailureEpisodes,
        0,
        'testFailureEpisodes is 0 (derived from eligiblePopulation)'
      );

      // Gate 1: Total Episodes fails (0 < 1,000)
      const g1 = readinessReport.canonicalEvaluation!.gates.find((g) => g.gateId === 'GATE_1_TOTAL_EPISODES')!;
      assertStrictEqual(g1.passed, false, 'Gate 1 failed');
      assertStrictEqual(g1.currentValue, 0, 'Gate 1 currentValue is 0');

      // Gate 2: Verified Outcomes fails (0 < 500)
      const g2 = readinessReport.canonicalEvaluation!.gates.find((g) => g.gateId === 'GATE_2_VERIFIED_OUTCOMES')!;
      assertStrictEqual(g2.passed, false, 'Gate 2 failed');

      // Gate 3: Candidate Logging Coverage fails (0 eligible episodes)
      const g3 = readinessReport.canonicalEvaluation!.gates.find((g) => g.gateId === 'GATE_3_CANDIDATE_LOGGING_COVERAGE')!;
      assertStrictEqual(g3.passed, false, 'Gate 3 failed');

      // Gate 4: Rights Clearance fails non-vacuously (pool is empty, cannot pass vacuously)
      const g4 = readinessReport.canonicalEvaluation!.gates.find((g) => g.gateId === 'GATE_4_RIGHTS_CLEARANCE')!;
      assertStrictEqual(g4.passed, false, 'Gate 4 failed (cannot pass vacuously when pool is empty)');
      assertStrictEqual(g4.currentValue, 0.0, 'Gate 4 currentValue is 0.0');
      assert(g4.details !== undefined && g4.details.includes('NO_ELIGIBLE_EPISODES'), 'Gate 4 details notes NO_ELIGIBLE_EPISODES');

      // Gate 5: Supervision Diversity fails (0 verified outcomes)
      const g5 = readinessReport.canonicalEvaluation!.gates.find((g) => g.gateId === 'GATE_5_SUPERVISION_DIVERSITY')!;
      assertStrictEqual(g5.passed, false, 'Gate 5 failed');

      // Gate 6: Zero Leakage Audit fails (0 eligible snapshots audited)
      const g6 = readinessReport.canonicalEvaluation!.gates.find((g) => g.gateId === 'GATE_6_ZERO_LEAKAGE_AUDIT')!;
      assertStrictEqual(g6.passed, false, 'Gate 6 failed');

      // Gate 7: Shadow Parity passes (100 real production shadow runs)
      const g7 = readinessReport.canonicalEvaluation!.gates.find((g) => g.gateId === 'GATE_7_SHADOW_POLICY_PARITY')!;
      assertStrictEqual(g7.passed, true, 'Gate 7 passed');
    } finally {
      try {
        fs.rmSync(case30Dir, { recursive: true, force: true });
      } catch {}
    }

    // =========================================================================
    // Case 31: Gate 4 canonical eligibility enforcement on Dataset V2 training pool
    // =========================================================================
    console.log('\n--- 31. Gate 4 canonical eligibility enforcement on Dataset V2 training pool ---');
    const case31Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_case31_'));
    try {
      const case31Store = new SqliteStore(path.join(case31Dir, 'test.db'));
      const db = (case31Store as any).db;

      // Seed 1,000 clean, eligible episodes:
      // - 650 verified successes, 250 verified failures, 100 unknown outcomes (satisfies Gate 5 tri-state)
      // - 25 independent repositories (repo_0 .. repo_24)
      // - 4 task types: BUG_FIX, FEATURE_ADDITION, REFACTOR, TEST_FAILURE
      // - production ranker, USER_CONSENT, valid pre-outcome snapshots with passing audits
      // - 100 real production shadow evaluations with 0 crashes
      db.exec('BEGIN IMMEDIATE');
      const taskTypes = ['BUG_FIX', 'FEATURE_ADDITION', 'REFACTOR', 'TEST_FAILURE'] as const;
      for (let i = 0; i < 1000; i++) {
        const epId = `ep_clean_${i}`;
        const isSuccess = i < 650 ? true : i < 900 ? false : null;
        const candidateUnitId = `unit_clean_${i}`;
        const candidatePath = `src/clean_${i}.ts`;
        const repoId = `repo_${i % 25}`;
        const taskType = taskTypes[i % 4];

        const cleanEp = createTaskEpisodeV1({
          episodeId: epId,
          tenantId: 'tenant_default',
          repositoryId: repoId,
          sessionId: `sess_clean_${i}`,
          taskId: `task_clean_${i}`,
          workspace: {
            repositoryIdentity: repoId,
            baseCommit: 'base_commit_clean',
            dirtyAtStart: false,
            workspaceSnapshotId: `ws_clean_${i}`,
          },
          task: {
            prompt: `Task prompt ${i}`,
            taskType,
            evidence: [],
          },
          environment: {
            contextPolicyId: 'default_v1',
            rankerId: 'heuristic_v1',
            rankerStatus: 'PRODUCTION',
          },
          rights: {
            trainingAllowed: true,
            serviceProcessingAllowed: true,
            redistributionAllowed: true,
            permissionSource: 'USER_CONSENT',
          },
          contextDecision: {
            candidateCount: 1,
            bundleSha256: 'bundle_sha',
            actualRenderedTokens: 100,
            tokenBudget: 2000,
            candidates: [
              {
                contextUnitId: candidateUnitId,
                path: candidatePath,
                unitKind: 'SOURCE_FILE',
                retrievalSources: ['lexical'],
                finalRank: 1,
                finalScore: 0.95,
                featureSetVersion: 'v1',
                featureSnapshot: {},
                estimatedTokens: 100,
                selected: true,
              },
            ],
            selectedUnits: [
              {
                contextUnitId: candidateUnitId,
                path: candidatePath,
                unitKind: 'SOURCE_FILE',
                resolution: 'FULL',
                rank: 1,
                allocatedTokens: 100,
              },
            ],
          },
          outcome: {
            episodeId: epId,
            verifiedSuccess: isSuccess,
            verificationConfidence: isSuccess !== null ? 'HIGH' : 'UNKNOWN',
            verificationSources: isSuccess !== null ? ['BEHAVIORAL_ORACLE'] : [],
          },
        });

        case31Store.saveTaskEpisode(cleanEp);

        case31Store.saveContextExposures(
          [
            {
              episodeId: epId,
              contextUnitId: candidateUnitId,
              path: candidatePath,
              unitKind: 'SOURCE_FILE',
              state: ContextExposureState.SHOWN,
              finalRank: 1,
              candidateAt: '2026-09-22T00:00:00.000Z',
              selectedAt: '2026-09-22T00:00:01.000Z',
              shownAt: '2026-09-22T00:00:02.000Z',
            },
          ],
          epId
        );

        const preSnap = createPreOutcomeEpisodeSnapshot({
          episodeId: epId,
          taskId: `task_clean_${i}`,
          prompt: `Task prompt ${i}`,
          promptSha256: crypto.createHash('sha256').update(`Task prompt ${i}`).digest('hex'),
          repositoryId: repoId,
          baseCommit: 'base_commit_clean',
          featureCutoffCommit: 'base_commit_clean',
          workspaceSnapshotId: `ws_clean_${i}`,
          candidateUniverse: cleanEp.contextDecision.candidates!,
          selectedUnits: [
            {
              contextUnitId: candidateUnitId,
              path: candidatePath,
              unitKind: 'SOURCE_FILE',
              resolution: 'FULL',
              rank: 1,
              allocatedTokens: 100,
            },
          ],
          tokenBudget: 2000,
          actualRenderedTokens: 100,
          bundleSha256: 'bundle_sha',
          contextPolicyId: 'default_v1',
          rankerId: 'heuristic_v1',
          capturedAt: '2026-09-22T00:00:00.000Z',
        });
        case31Store.savePreOutcomeSnapshot(preSnap);

        case31Store.savePreOutcomeIntegrityAudit({
          auditId: `audit_clean_${i}`,
          episodeId: epId,
          snapshotSha256: preSnap.snapshotSha256,
          recomputedSha256: preSnap.snapshotSha256,
          passed: true,
          hasLeakage: false,
          hasHashMismatch: false,
          hasProvenanceError: false,
          auditedAt: '2026-09-22T00:00:00.000Z',
          details: {},
        });
      }

      // Insert 100 passing production shadow evaluations
      for (let j = 0; j < 100; j++) {
        case31Store.saveShadowPolicyEvaluation(
          {
            taskId: `task_shadow_clean_${j}`,
            productionPolicyId: 'prod_v1',
            shadowPolicyId: 'shadow_v1',
            candidateCount: 10,
            topK: 10,
            rankOverlapJaccard: 0.9,
            topKDifferences: { inProductionOnly: [], inShadowOnly: [], sharedTopKCount: 10 },
            inclusionDifferences: { inProductionOnly: [], inShadowOnly: [], sharedInclusionCount: 10 },
            resolutionDifferences: [],
            tokenDifference: 50,
            productionTokens: 100,
            shadowTokens: 150,
            shadowLatencyMs: 12,
            evaluatedAt: '2026-09-22T00:00:00.000Z',
          },
          false,
          undefined,
          'PRODUCTION',
          false
        );
      }
      db.exec('COMMIT');

      // 1. Verify Clean Baseline passes 100% of readiness gates
      const baselineReport = case31Store.getV32DataReadinessReport();
      assertStrictEqual(baselineReport.trainingEligibleEpisodes, 1000, 'Baseline has 1,000 eligible episodes');
      assertStrictEqual(baselineReport.currentVerifiedEpisodes, 900, 'Baseline has 900 verified episodes');
      assertStrictEqual(baselineReport.isV32Ready, true, 'Baseline isV32Ready is strictly true');
      assert(baselineReport.canonicalEvaluation !== undefined, 'Baseline canonical evaluation present');
      assertStrictEqual(baselineReport.canonicalEvaluation!.allGatesPassed, true, 'Baseline allGatesPassed is true');
      const baselineG4 = baselineReport.canonicalEvaluation!.gates.find((g) => g.gateId === 'GATE_4_RIGHTS_CLEARANCE')!;
      assertStrictEqual(baselineG4.passed, true, 'Baseline Gate 4 passed (empty dataset_v2_rows with compliant pool)');

      // 2. Variant 1: One persisted Dataset V2 row whose source episode fails ONLY because permissionSource='UNKNOWN'
      const badRightsEp = createTaskEpisodeV1({
        episodeId: 'ep_bad_rights_source',
        tenantId: 'tenant_default',
        repositoryId: 'repo_0',
        sessionId: 'sess_bad_rights',
        taskId: 'task_bad_rights',
        workspace: {
          repositoryIdentity: 'repo_0',
          baseCommit: 'base_commit_clean',
          dirtyAtStart: false,
          workspaceSnapshotId: 'ws_bad_rights',
        },
        task: {
          prompt: 'Bad rights task',
          taskType: 'BUG_FIX',
          evidence: [],
        },
        environment: {
          contextPolicyId: 'default_v1',
          rankerId: 'heuristic_v1',
          rankerStatus: 'PRODUCTION',
        },
        rights: {
          trainingAllowed: true, // trainingAllowed is true...
          serviceProcessingAllowed: true,
          redistributionAllowed: false,
          permissionSource: 'UNKNOWN', // ...BUT permissionSource is UNKNOWN!
        },
        contextDecision: {
          candidateCount: 1,
          bundleSha256: 'bundle_sha',
          actualRenderedTokens: 100,
          tokenBudget: 2000,
          candidates: [
            {
              contextUnitId: 'unit_bad_rights',
              path: 'src/bad_rights.ts',
              unitKind: 'SOURCE_FILE',
              retrievalSources: ['lexical'],
              finalRank: 1,
              finalScore: 0.95,
              featureSetVersion: 'v1',
              featureSnapshot: {},
              estimatedTokens: 100,
              selected: true,
            },
          ],
          selectedUnits: [
            {
              contextUnitId: 'unit_bad_rights',
              path: 'src/bad_rights.ts',
              unitKind: 'SOURCE_FILE',
              resolution: 'FULL',
              rank: 1,
              allocatedTokens: 100,
            },
          ],
        },
        outcome: {
          episodeId: 'ep_bad_rights_source',
          verifiedSuccess: true,
          verificationConfidence: 'HIGH',
          verificationSources: ['BEHAVIORAL_ORACLE'],
        },
      });
      case31Store.saveTaskEpisode(badRightsEp);
      case31Store.saveContextExposures(
        [
          {
            episodeId: 'ep_bad_rights_source',
            contextUnitId: 'unit_bad_rights',
            path: 'src/bad_rights.ts',
            unitKind: 'SOURCE_FILE',
            state: ContextExposureState.SHOWN,
            finalRank: 1,
            candidateAt: '2026-09-22T00:00:00.000Z',
            selectedAt: '2026-09-22T00:00:01.000Z',
            shownAt: '2026-09-22T00:00:02.000Z',
          },
        ],
        'ep_bad_rights_source'
      );

      // Persist row in dataset_v2_rows referencing ep_bad_rights_source
      case31Store.saveDatasetV2Row({
        rowId: 'row_bad_rights',
        exportId: 'export_v2_test',
        episodeId: 'ep_bad_rights_source',
        contextUnitId: 'unit_bad_rights',
        exposureState: 'SHOWN',
        wasSelected: true,
        wasShown: true,
        wasRead: false,
        wasEdited: false,
        wasInSuccessfulTask: true,
        wasInFailedTask: false,
        verifiedSuccess: true,
        outcomeConfidence: 'HIGH',
      });

      const reportV1 = case31Store.getV32DataReadinessReport();
      const g4_v1 = reportV1.canonicalEvaluation!.gates.find((g) => g.gateId === 'GATE_4_RIGHTS_CLEARANCE')!;
      assertStrictEqual(g4_v1.passed, false, 'Gate 4 strictly fails when dataset row has permissionSource=UNKNOWN');
      assertStrictEqual(reportV1.canonicalEvaluation!.allGatesPassed, false, 'allGatesPassed is false on permissionSource=UNKNOWN');
      assertStrictEqual(reportV1.isV32Ready, false, 'isV32Ready is false on permissionSource=UNKNOWN');
      assert(Boolean(g4_v1.details && g4_v1.details.includes('VIOLATION: 1 unpermitted')), `Gate 4 details notes unpermitted violation: ${g4_v1.details}`);

      // 3. Variant 2: Orphan Dataset V2 row (source episode does not exist in task_episodes)
      db.prepare('DELETE FROM dataset_v2_rows').run();
      case31Store.saveDatasetV2Row({
        rowId: 'row_orphan_row',
        exportId: 'export_v2_test',
        episodeId: 'ep_orphan_nonexistent',
        contextUnitId: 'unit_orphan',
        exposureState: 'SHOWN',
        wasSelected: true,
        wasShown: true,
        wasRead: false,
        wasEdited: false,
        wasInSuccessfulTask: true,
        wasInFailedTask: false,
        verifiedSuccess: true,
        outcomeConfidence: 'HIGH',
      });

      const reportV2 = case31Store.getV32DataReadinessReport();
      const g4_v2 = reportV2.canonicalEvaluation!.gates.find((g) => g.gateId === 'GATE_4_RIGHTS_CLEARANCE')!;
      assertStrictEqual(g4_v2.passed, false, 'Gate 4 strictly fails on orphan Dataset V2 row');
      assertStrictEqual(reportV2.canonicalEvaluation!.allGatesPassed, false, 'allGatesPassed is false on orphan row');
      assertStrictEqual(reportV2.isV32Ready, false, 'isV32Ready is false on orphan row');
      assert(Boolean(g4_v2.details && g4_v2.details.includes('VIOLATION: 1 unpermitted')), `Gate 4 details notes orphan violation: ${g4_v2.details}`);

      // 4. Variant 3: Foreign / missing exposure record
      db.prepare('DELETE FROM dataset_v2_rows').run();
      const foreignExpEp = createTaskEpisodeV1({
        episodeId: 'ep_foreign_exp_source',
        tenantId: 'tenant_default',
        repositoryId: 'repo_0',
        sessionId: 'sess_foreign_exp',
        taskId: 'task_foreign_exp',
        workspace: {
          repositoryIdentity: 'repo_0',
          baseCommit: 'base_commit_clean',
          dirtyAtStart: false,
          workspaceSnapshotId: 'ws_foreign_exp',
        },
        task: {
          prompt: 'Foreign exp task',
          taskType: 'BUG_FIX',
          evidence: [],
        },
        environment: {
          contextPolicyId: 'default_v1',
          rankerId: 'heuristic_v1',
          rankerStatus: 'PRODUCTION',
        },
        rights: {
          trainingAllowed: true,
          serviceProcessingAllowed: true,
          redistributionAllowed: true,
          permissionSource: 'USER_CONSENT',
        },
        contextDecision: {
          candidateCount: 1,
          bundleSha256: 'bundle_sha',
          actualRenderedTokens: 100,
          tokenBudget: 2000,
          candidates: [
            {
              contextUnitId: 'unit_foreign_exp',
              path: 'src/foreign_exp.ts',
              unitKind: 'SOURCE_FILE',
              retrievalSources: ['lexical'],
              finalRank: 1,
              finalScore: 0.95,
              featureSetVersion: 'v1',
              featureSnapshot: {},
              estimatedTokens: 100,
              selected: true,
            },
          ],
          selectedUnits: [
            {
              contextUnitId: 'unit_foreign_exp',
              path: 'src/foreign_exp.ts',
              unitKind: 'SOURCE_FILE',
              resolution: 'FULL',
              rank: 1,
              allocatedTokens: 100,
            },
          ],
        },
        outcome: {
          episodeId: 'ep_foreign_exp_source',
          verifiedSuccess: true,
          verificationConfidence: 'HIGH',
          verificationSources: ['BEHAVIORAL_ORACLE'],
        },
      });
      case31Store.saveTaskEpisode(foreignExpEp);
      // NOTE: Intentionally DO NOT save any exposure record for ep_foreign_exp_source in context_exposures!
      case31Store.saveDatasetV2Row({
        rowId: 'row_foreign_exp',
        exportId: 'export_v2_test',
        episodeId: 'ep_foreign_exp_source',
        contextUnitId: 'unit_foreign_exp',
        exposureState: 'SHOWN',
        wasSelected: true,
        wasShown: true,
        wasRead: false,
        wasEdited: false,
        wasInSuccessfulTask: true,
        wasInFailedTask: false,
        verifiedSuccess: true,
        outcomeConfidence: 'HIGH',
      });

      const reportV3 = case31Store.getV32DataReadinessReport();
      const g4_v3 = reportV3.canonicalEvaluation!.gates.find((g) => g.gateId === 'GATE_4_RIGHTS_CLEARANCE')!;
      assertStrictEqual(g4_v3.passed, false, 'Gate 4 strictly fails on source episode with missing/foreign exposure');
      assertStrictEqual(reportV3.canonicalEvaluation!.allGatesPassed, false, 'allGatesPassed is false on missing/foreign exposure');
      assertStrictEqual(reportV3.isV32Ready, false, 'isV32Ready is false on missing/foreign exposure');
      assert(Boolean(g4_v3.details && g4_v3.details.includes('VIOLATION: 1 unpermitted')), `Gate 4 details notes exposure violation: ${g4_v3.details}`);

      // 5. Clean dataset_v2_rows restores all gates passing
      db.prepare('DELETE FROM dataset_v2_rows').run();
      const restoredReport = case31Store.getV32DataReadinessReport();
      assertStrictEqual(restoredReport.canonicalEvaluation!.allGatesPassed, true, 'Clean training pool restores allGatesPassed=true');
      assertStrictEqual(restoredReport.isV32Ready, true, 'Clean training pool restores isV32Ready=true');
    } finally {
      try {
        fs.rmSync(case31Dir, { recursive: true, force: true });
      } catch {}
    }

    console.log('\n🎉 ALL 31 PHASE 20.4 INTEGRITY CLOSURE INVARIANTS SATISFIED!\n');
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    setSharedStore(null);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

if (require.main === module) {
  runPhase204ClosureTests().catch((err) => {
    console.error('Test run failed:', err);
    process.exit(1);
  });
}
