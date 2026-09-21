import * as http from 'http';
import { AddressInfo } from 'net';
import { ContextUnit, ContextUnitKind } from '../context/context_unit';
import { createTaskContext, TaskContext } from '../context/task_context';
import { createAgentEnvironment } from '../agents/agent_environment';
import { TaskEvidenceKind, StackTraceEvidence } from '../context/task_evidence';
import { JevJudgmentProvider } from '../jev/jev_judgment_provider';
import { JudgmentResult } from '../jev/judgment_provider';
import { ContextRanker } from '../ranking/context_rank';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { EnforcedEgressGateway } from '../security/egress_policy';
import { createDefaultDataRights } from '../rights/data_rights';
import { TrustLevel } from '../security/trust';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

async function runJevV2ProviderTests() {
  console.log('\n=== Running V2 JEV Provider & Resilience Tests (Remediation PR 10) ===\n');

  const agentEnv = createAgentEnvironment({
    agentProvider: 'anthropic',
    agentVersion: '1.0.0',
    model: 'claude-3-5-sonnet',
    harnessVersion: '2.1.0',
    availableTools: ['bash'],
  });

  const task: TaskContext = createTaskContext({
    taskId: 'task_jev_test_1',
    workspaceSnapshotId: 'snap_jev_1',
    primaryPrompt: 'Fix null pointer exception when refreshing user token in AuthService',
    evidence: [
      {
        evidenceId: 'ev_stack_1',
        kind: TaskEvidenceKind.STACK_TRACE,
        timestamp: new Date().toISOString(),
        rawTrace: 'TypeError: Cannot read properties of null at AuthService.refreshToken (src/auth_service.ts:42:15)',
        frames: [{ file: 'src/auth_service.ts', line: 42, functionName: 'refreshToken' }],
      } as StackTraceEvidence,
    ],
    agentEnvironment: agentEnv,
  });

  const authUnit: ContextUnit = {
    id: 'unit_auth_service',
    kind: ContextUnitKind.SOURCE_FILE,
    workspaceSnapshotId: 'snap_jev_1',
    path: 'src/auth_service.ts',
    title: 'AuthService',
    provenance: { sourceType: 'file', sourceUri: 'src/auth_service.ts', extractedBy: 'indexer' },
    trustLevel: TrustLevel.FIRST_PARTY_CODE,
    metadata: {},
  };

  const utilsUnit: ContextUnit = {
    id: 'unit_utils',
    kind: ContextUnitKind.SOURCE_FILE,
    workspaceSnapshotId: 'snap_jev_1',
    path: 'src/utils/formatting.ts',
    title: 'FormattingUtils',
    provenance: { sourceType: 'file', sourceUri: 'src/utils/formatting.ts', extractedBy: 'indexer' },
    trustLevel: TrustLevel.FIRST_PARTY_CODE,
    metadata: {},
  };

  // =========================================================================
  // TEST 1: Independent Signals (Section 46) & ContextRank Consumption
  // =========================================================================
  console.log('--- 1. Independent Signals (Section 46) & ContextRank Consumption ---');

  const localProvider = new JevJudgmentProvider({ apiKey: null });
  const localAuthJudgment = await localProvider.judge(task, authUnit, { graphDistance: 0 });

  assert(typeof localAuthJudgment.semanticRelevance === 'number', 'Emits numeric semanticRelevance');
  assert(typeof localAuthJudgment.implementationNeeded === 'boolean', 'Emits boolean implementationNeeded');
  assert(typeof localAuthJudgment.likelyEditTarget === 'boolean', 'Emits boolean likelyEditTarget');
  assert(typeof localAuthJudgment.likelyRootCause === 'boolean', 'Emits boolean likelyRootCause');
  assert(typeof localAuthJudgment.confidence === 'number', 'Emits numeric confidence');
  assert(localAuthJudgment.likelyEditTarget === true, 'AuthService identified as likely edit target from evidence');
  assert(localAuthJudgment.likelyRootCause === true, 'AuthService identified as likely root cause from stack trace');

  // Verify that ContextRank consumes these signals without JEV dictating the resolution
  const ranker = new ContextRanker();
  const featuresAuth: ContextFeaturesV1 = {
    schemaVersion: 'v1',
    contextUnitId: authUnit.id,
    unitKind: ContextUnitKind.SOURCE_FILE,
    tokenEstimate: 200,
    isTest: false,
    isConfig: false,
    isDocumentation: false,
    isSchema: false,
    isExported: true,
    exactSymbolMatch: true,
    exactPathMatch: true,
    bm25Score: 8.5,
    tokenOverlapRatio: 0.6,
    graphDegree: 4,
    minDistanceToSeed: 0,
    minDistanceToErrorFrame: 0,
    isDirectDependency: false,
    isDirectDependent: false,
    changeFrequency: 10,
    recentChangeFrequency: 3,
    maxCoChangeWithSeeds: 0.5,
    inStackTrace: true,
    isFailingTestTarget: false,
    inCompilerError: false,
    inDirtyDiff: false,
    heuristicScore: 50,
  };

  const featuresUtils: ContextFeaturesV1 = {
    ...featuresAuth,
    contextUnitId: utilsUnit.id,
    exactSymbolMatch: false,
    exactPathMatch: false,
    bm25Score: 0.5,
    tokenOverlapRatio: 0.05,
    inStackTrace: false,
    minDistanceToSeed: 4,
    minDistanceToErrorFrame: 4,
  };

  const judgments = new Map<string, JudgmentResult>([
    [authUnit.id, localAuthJudgment],
  ]);

  const ranked = ranker.rank([featuresUtils, featuresAuth], judgments);
  assert(ranked[0].contextUnitId === authUnit.id, 'ContextRank places AuthService at rank 1');
  assert(ranked[0].judgment !== undefined, 'RankedCandidate attaches JudgmentResult');
  assert((ranked[0].scoreBreakdown.judgmentBoost ?? 0) > 0, 'ScoreBreakdown reflects positive judgmentBoost');
  assert(ranked[0].reasons.some((r) => r.includes('jev_likely_edit_target')), 'Reasons include jev_likely_edit_target');

  // =========================================================================
  // TEST 2: Resilience - No API Key (Section 47)
  // =========================================================================
  console.log('\n--- 2. Resilience Gate: No API Key (Section 47) ---');

  const noKeyProvider = new JevJudgmentProvider({ apiKey: null });
  const noKeyResult = await noKeyProvider.judge(task, authUnit);

  assert(noKeyResult.provider === 'local-heuristic', 'No API key falls back to local-heuristic provider');
  assert(noKeyResult.fallbackReason === 'no_api_key', 'Fallback reason recorded as no_api_key');
  assert(noKeyResult.confidence > 0.5, 'Local heuristic maintains high confidence');

  // =========================================================================
  // TEST 3: Resilience - Budget Exhausted (Section 47)
  // =========================================================================
  console.log('\n--- 3. Resilience Gate: Budget Exhausted (Section 47) ---');

  const budgetExhaustedProvider = new JevJudgmentProvider({
    apiKey: 'mock-key',
    budgetExhausted: true,
  });
  const budgetResult = await budgetExhaustedProvider.judge(task, authUnit);

  assert(budgetResult.provider === 'local-heuristic', 'Budget exhausted falls back cleanly to local heuristic');
  assert(budgetResult.fallbackReason === 'budget_exhausted', 'Fallback reason recorded as budget_exhausted');

  // Also verify maxCalls cap
  const maxCallsProvider = new JevJudgmentProvider({
    apiKey: 'mock-key',
    maxCalls: 1,
    endpoint: 'http://127.0.0.1:9999/dummy', // Will fail if called
  });
  // Force second call to exceed cap
  (maxCallsProvider as any).callCount = 1;
  const maxCallsResult = await maxCallsProvider.judge(task, authUnit);
  assert(maxCallsResult.fallbackReason === 'budget_exhausted', 'Exceeding maxCalls cleanly triggers budget_exhausted fallback');

  // =========================================================================
  // Setup Mock HTTP Server for Network Scenarios (Timeout, Errors, Malformed, Partial)
  // =========================================================================
  let serverResponseMode: 'success' | 'timeout' | 'http_error_500' | 'http_error_429' | 'malformed' | 'partial' = 'success';

  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (serverResponseMode === 'timeout') {
        // Intentionally don't respond to trigger client timeout
        return;
      }

      if (serverResponseMode === 'http_error_500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
        return;
      }

      if (serverResponseMode === 'http_error_429') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }

      if (serverResponseMode === 'malformed') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"broken_json": [');
        return;
      }

      if (serverResponseMode === 'partial') {
        // Only return semanticRelevance; omit likelyEditTarget, likelyRootCause, confidence
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ semanticRelevance: 0.88 }));
        return;
      }

      // Default: full success response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          semanticRelevance: 0.92,
          implementationNeeded: true,
          likelyEditTarget: true,
          likelyRootCause: true,
          confidence: 0.96,
          rationale: 'High relevance from JEV mock server',
        })
      );
    });
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (mockServer.address() as AddressInfo).port;
  const mockEndpoint = `http://127.0.0.1:${port}/judge`;

  try {
    // =========================================================================
    // TEST 4: Successful Remote API Call
    // =========================================================================
    console.log('\n--- 4. Successful Remote JEV Call ---');
    serverResponseMode = 'success';
    const remoteProvider = new JevJudgmentProvider({
      apiKey: 'valid-test-key',
      endpoint: mockEndpoint,
      timeoutMs: 1000,
    });
    const successResult = await remoteProvider.judge(task, authUnit);

    assert(successResult.provider === 'typesafe-jev', 'Successful response marks provider as typesafe-jev');
    assert(successResult.semanticRelevance === 0.92, 'Parses semanticRelevance correctly (0.92)');
    assert(successResult.likelyEditTarget === true, 'Parses likelyEditTarget correctly');
    assert(successResult.likelyRootCause === true, 'Parses likelyRootCause correctly');
    assert(successResult.confidence === 0.96, 'Parses confidence correctly');

    // =========================================================================
    // TEST 5: Resilience - Timeout (Section 47)
    // =========================================================================
    console.log('\n--- 5. Resilience Gate: Timeout Handling (Section 47) ---');
    serverResponseMode = 'timeout';
    const timeoutProvider = new JevJudgmentProvider({
      apiKey: 'valid-test-key',
      endpoint: mockEndpoint,
      timeoutMs: 100, // Short timeout for test speed
    });
    const timeoutResult = await timeoutProvider.judge(task, authUnit);

    assert(timeoutResult.provider === 'local-heuristic', 'Timeout cleanly falls back to local-heuristic');
    assert(timeoutResult.fallbackReason === 'timeout', 'Fallback reason recorded as timeout');
    assert(timeoutResult.semanticRelevance > 0, 'Emits valid local heuristic signals despite timeout');

    // =========================================================================
    // TEST 6: Resilience - HTTP 500 & HTTP 429 Errors (Section 47)
    // =========================================================================
    console.log('\n--- 6. Resilience Gate: HTTP Errors (500 & 429) (Section 47) ---');
    serverResponseMode = 'http_error_500';
    const errorProvider = new JevJudgmentProvider({
      apiKey: 'valid-test-key',
      endpoint: mockEndpoint,
      timeoutMs: 1000,
    });
    const error500Result = await errorProvider.judge(task, authUnit);
    assert(error500Result.provider === 'local-heuristic', 'HTTP 500 cleanly falls back to local-heuristic');
    assert(error500Result.fallbackReason === 'http_error_500', 'Fallback reason indicates http_error_500');

    serverResponseMode = 'http_error_429';
    const error429Result = await errorProvider.judge(task, authUnit);
    assert(error429Result.provider === 'local-heuristic', 'HTTP 429 rate limit cleanly falls back to local-heuristic');
    assert(error429Result.fallbackReason === 'http_error_429', 'Fallback reason indicates http_error_429');

    // =========================================================================
    // TEST 7: Resilience - Malformed Response (Section 47)
    // =========================================================================
    console.log('\n--- 7. Resilience Gate: Malformed JSON Response (Section 47) ---');
    serverResponseMode = 'malformed';
    const malformedResult = await errorProvider.judge(task, authUnit);

    assert(malformedResult.provider === 'local-heuristic', 'Malformed JSON cleanly falls back to local-heuristic');
    assert(
      malformedResult.fallbackReason?.includes('malformed_response') === true,
      'Fallback reason indicates malformed_response'
    );

    // =========================================================================
    // TEST 8: Resilience - Partial Response (Section 47)
    // =========================================================================
    console.log('\n--- 8. Resilience Gate: Partial Response Sanitization (Section 47) ---');
    serverResponseMode = 'partial';
    const partialResult = await errorProvider.judge(task, authUnit);

    assert(partialResult.provider === 'typesafe-jev', 'Partial response gracefully preserved with provider typesafe-jev');
    assert(partialResult.semanticRelevance === 0.88, 'Preserves present field semanticRelevance (0.88)');
    assert(typeof partialResult.likelyEditTarget === 'boolean', 'Sanitizes missing likelyEditTarget with default');
    assert(typeof partialResult.likelyRootCause === 'boolean', 'Sanitizes missing likelyRootCause with default');
    assert(typeof partialResult.confidence === 'number', 'Sanitizes missing confidence with default');

    // =========================================================================
    // TEST 9: Resilience - Enforced Egress Policy Block (Section 47)
    // =========================================================================
    console.log('\n--- 9. Resilience Gate: Enforced Egress Policy (DataRights & Secrets) ---');
    const egressGateway = new EnforcedEgressGateway();
    const restrictedRights = createDefaultDataRights({ remoteProcessingAllowed: false });

    const egressBlockedProvider = new JevJudgmentProvider({
      apiKey: 'valid-test-key',
      endpoint: mockEndpoint,
      egressGateway,
      dataRights: restrictedRights,
      trustLevel: TrustLevel.FIRST_PARTY_CODE,
    });

    const egressBlockedResult = await egressBlockedProvider.judge(task, authUnit);
    assert(egressBlockedResult.provider === 'local-heuristic', 'Egress blocked call falls back cleanly to local-heuristic');
    assert(
      egressBlockedResult.fallbackReason?.includes('egress_blocked') === true,
      'Fallback reason indicates egress_blocked'
    );

    console.log('\n🎉 All JEV V2 Provider & Resilience tests passed successfully!');
  } finally {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  }
}

runJevV2ProviderTests().catch((err) => {
  console.error('❌ JEV V2 Provider test failed:', err);
  process.exit(1);
});
