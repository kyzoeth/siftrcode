/**
 * SiftrCode V2 - JEV Shadow Integration & Final Learning-Loop Closure Tests (PR J6)
 *
 * Covers all 11 required acceptance tests from Part XIX and Part XX of the Directive:
 * 1. SDK Mapping Test (continuous probabilities preserved, no boolean thresholding)
 * 2. Sanitization Test (secret redaction, verification that closure cannot leak raw secrets)
 * 3. Rights Test (remote processing allowed + retention denied; remote processing denied -> RIGHTS_DENIED fallback)
 * 4. Trust Test (CLONED_EXTERNAL trust policy preserved and respected)
 * 5. Budget Test (attemptedCalls <= 20 bounded strictly by maxCallsPerTask)
 * 6. Concurrency Test (peak concurrency <= 4 verified with FakeSystemOneClient)
 * 7. Failure Tests (NO_API_KEY, TIMEOUT, RATE_LIMITED, PROVIDER_ERROR, MALFORMED_RESPONSE fallbacks recorded)
 * 8. Shadow Invariance Test (bit-for-bit identity check: plan_without_JEV == plan_with_JEV_shadow_enabled)
 * 9. MCP BODY Expansion Test (asserts MCP response contains target method and excludes sibling methods)
 * 10. Missing-Session Test (siftr_session(end/status, nonexistent) -> ERROR_SESSION_NOT_FOUND)
 * 11. Sessionless Context Test (siftr_context auto-creates session, joins outcome)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp/server';
import { SqliteStore } from '../storage/sqlite_store';
import { ContextEngine } from '../engine/context_engine';
import { JevShadowRunner } from '../providers/judgment/typesafe/jev_shadow_runner';
import { FakeSystemOneClient } from '../providers/judgment/typesafe/typesafe_client';
import { JevMode, JevFallbackReason, JevSignalV1 } from '../providers/judgment/typesafe/jev_signal';
import { JEV_QUESTION_SET_VERSION_V1 } from '../providers/judgment/typesafe/jev_questions';
import { ContextUnit, ContextUnitKind, CodeSymbolUnit, SymbolKind } from '../context/context_unit';
import { ContextResolution } from '../context/context_resolution';
import { createTaskContext } from '../context/task_context';
import { createWorkspaceSnapshot } from '../workspace/workspace_snapshot';
import { createDefaultDataRights, createJevPermittedDataRights, createDefaultOperationRightsPolicy, DataClass, DataRights } from '../rights/data_rights';
import { StructuredEgressGateway, EgressField } from '../security/structured_egress';
import { RepositoryOrigin, TrustLevel, RepositoryTrustPolicy, createDefaultRepositoryTrustPolicy } from '../security/trust';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { RankedCandidate } from '../ranking/context_rank';
import { createAgentEnvironment } from '../agents/agent_environment';
import { ContextGraph } from '../graph/context_graph';

function createMockCodeSymbolUnit(params: {
  id: string;
  title: string;
  path: string;
  symbolName: string;
  scope?: string;
  startLine: number;
  endLine: number;
  signature?: string;
}): CodeSymbolUnit {
  return {
    id: params.id,
    kind: ContextUnitKind.CODE_SYMBOL,
    symbolKind: SymbolKind.FUNCTION,
    symbolName: params.symbolName,
    qualifiedName: params.scope ? `${params.scope}.${params.symbolName}` : params.symbolName,
    language: 'typescript',
    startLine: params.startLine,
    endLine: params.endLine,
    signature: params.signature,
    contentHash: 'hash_' + params.id,
    workspaceSnapshotId: 'snap_test',
    path: params.path,
    title: params.title,
    provenance: { sourceType: 'file' },
    trustLevel: TrustLevel.FIRST_PARTY_CODE,
    metadata: {},
  };
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertStrictEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    console.error(`❌ Assertion failed: ${message}\n  Expected: ${expected}\n  Actual:   ${actual}`);
    throw new Error(`Assertion failed: ${message} (expected ${expected}, got ${actual})`);
  }
}

function createMockRankedCandidate(
  contextUnitId: string,
  rank: number,
  score: number,
  features?: Partial<ContextFeaturesV1>
): RankedCandidate {
  const feat: ContextFeaturesV1 = {
    schemaVersion: 'v1',
    contextUnitId,
    unitKind: ContextUnitKind.CODE_SYMBOL,
    tokenEstimate: 50,
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
    ...features,
  };

  return {
    contextUnitId,
    finalScore: score,
    rank,
    scoreBreakdown: {
      runtimeEvidence: 0,
      exactMatch: 0,
      lexicalRelevance: score,
      graphProximity: 0,
      gitCoChange: 0,
      penalties: 0,
    },
    reasons: ['test_ranking'],
    features: feat,
  };
}

export async function runJevShadowClosureTests() {
  console.log('\n=== Running SiftrCode V2 JEV Shadow Closure Tests (PR J6) ===\n');

  const origCwd = process.cwd();
  const tempWorkspaceDir = path.join(
    __dirname,
    '..',
    '..',
    'temp_jev_closure_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8)
  );
  fs.mkdirSync(tempWorkspaceDir, { recursive: true });
  fs.mkdirSync(path.join(tempWorkspaceDir, 'src'), { recursive: true });

  const siftrDir = path.join(tempWorkspaceDir, '.siftr');
  fs.mkdirSync(siftrDir, { recursive: true });
  const dbPath = path.join(siftrDir, 'observations.sqlite');
  const store = new SqliteStore(dbPath);

  // Initialize git repository in temporary workspace
  execSync('git init -b main', { cwd: tempWorkspaceDir, stdio: 'ignore' });
  execSync('git config user.email "test@siftrcode.com"', { cwd: tempWorkspaceDir, stdio: 'ignore' });
  execSync('git config user.name "Siftr Test"', { cwd: tempWorkspaceDir, stdio: 'ignore' });

  // Create sample code files with class and multiple methods for BODY isolation
  const mathServiceContent = `export class MathService {
  constructor(private prefix: string) {}

  public calculateSum(a: number, b: number): number {
    const result = a + b;
    return result;
  }

  public calculateProduct(a: number, b: number): number {
    const intermediate = a * b;
    return intermediate;
  }

  public calculateDifference(a: number, b: number): number {
    return a - b;
  }
}
`;
  fs.writeFileSync(path.join(tempWorkspaceDir, 'src', 'math_service.ts'), mathServiceContent);

  const authContent = `export function authenticateUser(token: string): boolean {
  if (token.startsWith('valid_')) {
    return true;
  }
  return false;
}
`;
  fs.writeFileSync(path.join(tempWorkspaceDir, 'src', 'auth.ts'), authContent);

  execSync('git add .', { cwd: tempWorkspaceDir, stdio: 'ignore' });
  execSync('git commit -m "Initial commit"', { cwd: tempWorkspaceDir, stdio: 'ignore' });

  try {
    // ------------------------------------------------------------------------
    // TEST 1: SDK Mapping Test (continuous probabilities preserved, no thresholding)
    // ------------------------------------------------------------------------
    console.log('--- Test 1: SDK Mapping (Continuous Probabilities Preserved) ---');
    {
      const mockClient = new FakeSystemOneClient(async () => ({
        model: 'typesafe-one-preview',
        answers: {
          semanticRelevance: { noul: 0.82 },
          implementationNeeded: { noul: 0.61 },
          likelyEditTarget: { noul: 0.27 },
          likelyRootCause: { noul: 0.74 },
        },
        providerReportedConfidence: { confidence: 0.95 },
        inputTokens: 120,
      }));

      const runner = new JevShadowRunner({
        client: mockClient,
        mode: JevMode.SHADOW,
        sqliteStore: store,
        model: 'typesafe-one-preview',
      });

      const unit = createMockCodeSymbolUnit({
        id: 'sym_math_sum',
        title: 'MathService.calculateSum',
        path: 'src/math_service.ts',
        symbolName: 'calculateSum',
        scope: 'MathService',
        startLine: 4,
        endLine: 7,
        signature: 'public calculateSum(a: number, b: number): number',
      });

      const snapshot = createWorkspaceSnapshot({
        repositories: [{ repositoryId: 'root', baseCommitSha: 'HEAD', trackedTreeHash: 't1', dirtyPatchHash: 'clean' }],
      });

      const task = createTaskContext({
        taskId: 'task_map_1',
        primaryPrompt: 'Fix calculateSum return value',
        workspaceSnapshotId: snapshot.workspaceSnapshotId,
        agentEnvironment: createAgentEnvironment({ agentProvider: 'cursor', agentVersion: '1.0', model: 'claude-3-sonnet', harnessVersion: '1.0' }),
      });

      const features: ContextFeaturesV1 = {
        schemaVersion: 'v1',
        contextUnitId: unit.id,
        unitKind: ContextUnitKind.CODE_SYMBOL,
        tokenEstimate: 40,
        isTest: false,
        isConfig: false,
        isDocumentation: false,
        isSchema: false,
        isExported: true,
        exactSymbolMatch: true,
        exactPathMatch: false,
        bm25Score: 0.85,
        tokenOverlapRatio: 0.5,
        graphDegree: 2,
        minDistanceToSeed: 1,
        minDistanceToErrorFrame: null,
        isDirectDependency: false,
        isDirectDependent: false,
        changeFrequency: 0.1,
        recentChangeFrequency: 0.2,
        maxCoChangeWithSeeds: 0.4,
        inStackTrace: false,
        isFailingTestTarget: false,
        inCompilerError: false,
        inDirtyDiff: false,
        heuristicScore: 0.8,
      };

      const ranked = createMockRankedCandidate(unit.id, 1, 0.8, features);

      const signals = await runner.evaluate({
        task,
        workspaceSnapshot: snapshot,
        rankedCandidates: [ranked],
        units: [unit],
        featuresMap: new Map([[unit.id, features]]),
        dataRights: createJevPermittedDataRights(),
        contextPlanId: 'cplan_map_1',
      });

      assert(signals.length === 1, 'Expected 1 JEV signal');
      const sig = signals[0];
      assertStrictEqual(sig.semanticRelevanceProbability, 0.82, 'semanticRelevanceProbability strictly preserved');
      assertStrictEqual(sig.implementationNeededProbability, 0.61, 'implementationNeededProbability strictly preserved');
      assertStrictEqual(sig.likelyEditTargetProbability, 0.27, 'likelyEditTargetProbability strictly preserved');
      assertStrictEqual(sig.likelyRootCauseProbability, 0.74, 'likelyRootCauseProbability strictly preserved');
      assertStrictEqual(sig.questionSetVersion, JEV_QUESTION_SET_VERSION_V1, 'questionSetVersion matches');
      assertStrictEqual(sig.provider, 'typesafe-jev', 'provider is typesafe-jev');
      assertStrictEqual(sig.model, 'typesafe-one-preview', 'model is preserved');
      assert(sig.latencyMs >= 0, 'latencyMs is recorded');

      // Verify persistence in sqlite
      const storedSignals = store.listJevShadowJudgments(snapshot.workspaceSnapshotId);
      assert(storedSignals.length >= 1, 'JEV signals persisted to SQLite store');
      assertStrictEqual(storedSignals[0].semanticRelevanceProbability, 0.82, 'SQLite preserved 0.82 probability');
      console.log('  ✔ Continuous probabilities preserved without boolean thresholding');
    }

    // ------------------------------------------------------------------------
    // TEST 2: Sanitization & Redaction Test
    // ------------------------------------------------------------------------
    console.log('--- Test 2: Sanitization & Secret Redaction Test ---');
    {
      let capturedState: any = null;
      const mockClient = new FakeSystemOneClient(async (req) => {
        capturedState = req.state;
        return {
          model: 'typesafe-one-preview',
          answers: {
            semanticRelevance: { noul: 0.5 },
            implementationNeeded: { noul: 0.5 },
            likelyEditTarget: { noul: 0.5 },
            likelyRootCause: { noul: 0.5 },
          },
        };
      });

      const runner = new JevShadowRunner({
        client: mockClient,
        mode: JevMode.SHADOW,
        sqliteStore: store,
      });

      const secretApiKey = 'sk-proj-supersecretkey1234567890abcdef1234567890';
      const secretBearer = 'ghp_secrettokenvalue12345678901234567890';

      const unitWithSecrets = createMockCodeSymbolUnit({
        id: 'sym_auth_secret',
        title: `authHandler with ${secretApiKey}`,
        path: 'src/auth.ts',
        symbolName: 'authHandler',
        scope: '',
        startLine: 1,
        endLine: 5,
        signature: `function authHandler(bearer = "${secretBearer}"): boolean`,
      });

      const snapshot = createWorkspaceSnapshot({
        repositories: [{ repositoryId: 'root', baseCommitSha: 'HEAD', trackedTreeHash: 't2', dirtyPatchHash: 'clean' }],
      });

      const task = createTaskContext({
        taskId: 'task_sanitization_2',
        primaryPrompt: `Test with prompt containing secret ${secretApiKey}`,
        workspaceSnapshotId: snapshot.workspaceSnapshotId,
        agentEnvironment: createAgentEnvironment({ agentProvider: 'cursor', agentVersion: '1.0', model: 'claude-3-sonnet', harnessVersion: '1.0' }),
      });

      const ranked = createMockRankedCandidate(unitWithSecrets.id, 1, 0.9);

      const signals = await runner.evaluate({
        task,
        workspaceSnapshot: snapshot,
        rankedCandidates: [ranked],
        units: [unitWithSecrets],
        featuresMap: new Map(),
        dataRights: createJevPermittedDataRights(),
      });

      assert(capturedState !== null, 'Client evaluate was invoked');
      assert(!JSON.stringify(capturedState).includes(secretApiKey), 'Raw API key was REDACTED from egress payload');
      assert(!JSON.stringify(capturedState).includes(secretBearer), 'Raw bearer token was REDACTED from egress payload');
      assert(signals[0].redactionApplied === true, 'redactionApplied flag marked as true');
      console.log('  ✔ Structured egress gateway safely redacted secrets prior to client dispatch');
    }

    // ------------------------------------------------------------------------
    // TEST 3: Rights Enforcement Test
    // ------------------------------------------------------------------------
    console.log('--- Test 3: Rights Enforcement Test ---');
    {
      const mockClient = new FakeSystemOneClient();
      const runner = new JevShadowRunner({
        client: mockClient,
        mode: JevMode.SHADOW,
        sqliteStore: store,
      });

      const deniedRights: DataRights = {
        ...createJevPermittedDataRights(),
        operationRights: {
          ...createDefaultOperationRightsPolicy(),
          [DataClass.TASK_PROMPT]: { processing: { local: true, remote: true }, retention: { local: false, remote: false }, training: false },
          [DataClass.SYMBOL_NAME]: { processing: { local: true, remote: true }, retention: { local: false, remote: false }, training: false },
          [DataClass.PATH]: { processing: { local: true, remote: true }, retention: { local: false, remote: false }, training: false },
          [DataClass.SYMBOL_METADATA]: {
            processing: { local: true, remote: false },
            retention: { local: true, remote: false },
            training: false,
          },
        },
      };

      const unit = createMockCodeSymbolUnit({
        id: 'sym_rights_test',
        title: 'MathService.calculateProduct',
        path: 'src/math_service.ts',
        symbolName: 'calculateProduct',
        scope: 'MathService',
        startLine: 8,
        endLine: 11,
        signature: 'public calculateProduct(a: number, b: number): number',
      });

      const snapshot = createWorkspaceSnapshot({
        repositories: [{ repositoryId: 'root', baseCommitSha: 'HEAD', trackedTreeHash: 't3', dirtyPatchHash: 'clean' }],
      });

      const task = createTaskContext({
        taskId: 'task_rights_3',
        primaryPrompt: 'Check rights',
        workspaceSnapshotId: snapshot.workspaceSnapshotId,
        agentEnvironment: createAgentEnvironment({ agentProvider: 'cursor', agentVersion: '1.0', model: 'claude-3-sonnet', harnessVersion: '1.0' }),
      });

      const ranked = createMockRankedCandidate(unit.id, 1, 0.7);

      const signals = await runner.evaluate({
        task,
        workspaceSnapshot: snapshot,
        rankedCandidates: [ranked],
        units: [unit],
        featuresMap: new Map(),
        dataRights: deniedRights,
      });

      assertStrictEqual(mockClient.callCount, 0, 'Zero remote calls made when remote processing is denied');
      assertStrictEqual(signals[0].fallbackReason, JevFallbackReason.RIGHTS_DENIED, 'Fallback reason is RIGHTS_DENIED');
      assertStrictEqual(signals[0].semanticRelevanceProbability, null, 'Probability is null on fallback');

      // Case B: Remote processing allowed + remote retention denied -> Evaluation proceeds
      const noRetentionRights: DataRights = createJevPermittedDataRights({
        symbolMetadataAllowed: false,
        rawSourceRetentionAllowed: false,
      });

      const signalsAllowed = await runner.evaluate({
        task,
        workspaceSnapshot: snapshot,
        rankedCandidates: [ranked],
        units: [unit],
        featuresMap: new Map(),
        dataRights: noRetentionRights,
      });

      assert(signalsAllowed.length === 1, 'Evaluation proceeded when remote processing is allowed');
      assert(signalsAllowed[0].fallbackReason === undefined, 'No fallback when rights allowed');
      console.log('  ✔ Rights enforcement verified: remote processing gated, retention policy respected');
    }

    // ------------------------------------------------------------------------
    // TEST 4: Trust Test (CLONED_EXTERNAL Trust Policy)
    // ------------------------------------------------------------------------
    console.log('--- Test 4: Repository Trust Policy Test ---');
    {
      const trustPolicy = createDefaultRepositoryTrustPolicy({
        repositoryId: 'root',
        origin: RepositoryOrigin.CLONED_EXTERNAL,
      });

      assertStrictEqual(trustPolicy.origin, RepositoryOrigin.CLONED_EXTERNAL, 'CLONED_EXTERNAL origin verified');
      assertStrictEqual(trustPolicy.defaultTrustLevel, TrustLevel.EXTERNAL_SOURCE, 'TrustLevel EXTERNAL_SOURCE verified');
      console.log('  ✔ Repository trust policy verified for external cloned repositories');
    }

    // ------------------------------------------------------------------------
    // TEST 5: Budget Test (attemptedCalls <= 20 bounded)
    // ------------------------------------------------------------------------
    console.log('--- Test 5: Decision Budget Bounded Calls Test ---');
    {
      const mockClient = new FakeSystemOneClient();
      const runner = new JevShadowRunner({
        client: mockClient,
        mode: JevMode.SHADOW,
        budget: { maxCandidates: 20, maxCallsPerTask: 20 },
      });

      const units: ContextUnit[] = [];
      const ranked: RankedCandidate[] = [];
      for (let i = 0; i < 40; i++) {
        const u = createMockCodeSymbolUnit({
          id: `sym_budget_${i}`,
          title: `Unit ${i}`,
          path: `src/unit_${i}.ts`,
          symbolName: `unit${i}`,
          scope: '',
          startLine: 1,
          endLine: 5,
        });
        units.push(u);
        ranked.push(createMockRankedCandidate(u.id, i + 1, 1 - i * 0.02));
      }

      const snapshot = createWorkspaceSnapshot({
        repositories: [{ repositoryId: 'root', baseCommitSha: 'HEAD', trackedTreeHash: 't5', dirtyPatchHash: 'clean' }],
      });

      const task = createTaskContext({
        taskId: 'task_budget_5',
        primaryPrompt: 'Evaluate budget',
        workspaceSnapshotId: snapshot.workspaceSnapshotId,
        agentEnvironment: createAgentEnvironment({ agentProvider: 'cursor', agentVersion: '1.0', model: 'claude-3-sonnet', harnessVersion: '1.0' }),
      });

      await runner.evaluate({
        task,
        workspaceSnapshot: snapshot,
        rankedCandidates: ranked,
        units,
        featuresMap: new Map(),
        dataRights: createJevPermittedDataRights(),
      });

      assert(mockClient.callCount <= 20, `Calls strictly <= 20 (actual: ${mockClient.callCount})`);
      assertStrictEqual(mockClient.callCount, 20, 'Exactly 20 calls attempted per budget limit');
      console.log('  ✔ Decision budget strictly caps attempted calls to maxCallsPerTask (20)');
    }

    // ------------------------------------------------------------------------
    // TEST 6: Bounded Concurrency Test (peak <= 4)
    // ------------------------------------------------------------------------
    console.log('--- Test 6: Bounded Concurrency Test (Peak <= 4) ---');
    {
      const mockClient = new FakeSystemOneClient(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return {
          model: 'typesafe-one-preview',
          answers: {
            semanticRelevance: { noul: 0.5 },
            implementationNeeded: { noul: 0.5 },
            likelyEditTarget: { noul: 0.5 },
            likelyRootCause: { noul: 0.5 },
          },
        };
      });

      const runner = new JevShadowRunner({
        client: mockClient,
        mode: JevMode.SHADOW,
        budget: { maxCandidates: 12, maxCallsPerTask: 12, maxConcurrency: 4 },
      });

      const units: ContextUnit[] = [];
      const ranked: RankedCandidate[] = [];
      for (let i = 0; i < 12; i++) {
        const u = createMockCodeSymbolUnit({
          id: `sym_conc_${i}`,
          title: `ConcurrentUnit ${i}`,
          path: `src/conc_${i}.ts`,
          symbolName: `conc${i}`,
          scope: '',
          startLine: 1,
          endLine: 5,
        });
        units.push(u);
        ranked.push(createMockRankedCandidate(u.id, i + 1, 1 - i * 0.05));
      }

      const snapshot = createWorkspaceSnapshot({
        repositories: [{ repositoryId: 'root', baseCommitSha: 'HEAD', trackedTreeHash: 't6', dirtyPatchHash: 'clean' }],
      });

      const task = createTaskContext({
        taskId: 'task_conc_6',
        primaryPrompt: 'Test concurrency',
        workspaceSnapshotId: snapshot.workspaceSnapshotId,
        agentEnvironment: createAgentEnvironment({ agentProvider: 'cursor', agentVersion: '1.0', model: 'claude-3-sonnet', harnessVersion: '1.0' }),
      });

      await runner.evaluate({
        task,
        workspaceSnapshot: snapshot,
        rankedCandidates: ranked,
        units,
        featuresMap: new Map(),
        dataRights: createJevPermittedDataRights(),
      });

      const peakConc = mockClient.peakConcurrency;
      assert(peakConc <= 4, `Peak concurrency must be <= 4 (observed: ${peakConc})`);
      assert(peakConc > 1, `Concurrency was actually parallel (observed: ${peakConc})`);
      console.log(`  ✔ Bounded worker pool verified: peak concurrency was ${peakConc} <= 4`);
    }

    // ------------------------------------------------------------------------
    // TEST 7: Failure & Resilience Fallbacks
    // ------------------------------------------------------------------------
    console.log('--- Test 7: Failure & Fallback Resilience Tests ---');
    {
      const unit = createMockCodeSymbolUnit({
        id: 'sym_fail_test',
        title: 'FailTest',
        path: 'src/fail.ts',
        symbolName: 'fail',
        scope: '',
        startLine: 1,
        endLine: 5,
      });

      const snapshot = createWorkspaceSnapshot({
        repositories: [{ repositoryId: 'root', baseCommitSha: 'HEAD', trackedTreeHash: 't7', dirtyPatchHash: 'clean' }],
      });

      const task = createTaskContext({
        taskId: 'task_fail_7',
        primaryPrompt: 'Fail resilience',
        workspaceSnapshotId: snapshot.workspaceSnapshotId,
        agentEnvironment: createAgentEnvironment({ agentProvider: 'cursor', agentVersion: '1.0', model: 'claude-3-sonnet', harnessVersion: '1.0' }),
      });

      const ranked = createMockRankedCandidate(unit.id, 1, 0.5);

      // 7a. NO_API_KEY
      const runnerNoKey = new JevShadowRunner({ client: undefined, mode: JevMode.SHADOW, sqliteStore: store });
      const sigNoKey = await runnerNoKey.evaluate({
        task,
        workspaceSnapshot: snapshot,
        rankedCandidates: [ranked],
        units: [unit],
        featuresMap: new Map(),
        dataRights: createJevPermittedDataRights(),
      });
      assertStrictEqual(sigNoKey[0].fallbackReason, JevFallbackReason.NO_API_KEY, 'NO_API_KEY fallback reason');

      // 7b. TIMEOUT
      const runnerTimeout = new JevShadowRunner({
        client: new FakeSystemOneClient(async () => {
          const err: any = new Error('Request timed out after 2000ms');
          err.name = 'TimeoutError';
          throw err;
        }),
        mode: JevMode.SHADOW,
        sqliteStore: store,
      });
      const sigTimeout = await runnerTimeout.evaluate({
        task,
        workspaceSnapshot: snapshot,
        rankedCandidates: [ranked],
        units: [unit],
        featuresMap: new Map(),
        dataRights: createJevPermittedDataRights(),
      });
      assertStrictEqual(sigTimeout[0].fallbackReason, JevFallbackReason.TIMEOUT, 'TIMEOUT fallback reason');

      // 7c. RATE_LIMITED
      const runnerRateLimit = new JevShadowRunner({
        client: new FakeSystemOneClient(async () => {
          const err: any = new Error('HTTP 429 Too Many Requests');
          err.status = 429;
          throw err;
        }),
        mode: JevMode.SHADOW,
        sqliteStore: store,
      });
      const sigRateLimit = await runnerRateLimit.evaluate({
        task,
        workspaceSnapshot: snapshot,
        rankedCandidates: [ranked],
        units: [unit],
        featuresMap: new Map(),
        dataRights: createJevPermittedDataRights(),
      });
      assertStrictEqual(sigRateLimit[0].fallbackReason, JevFallbackReason.RATE_LIMITED, 'RATE_LIMITED fallback reason');

      // 7d. PROVIDER_ERROR
      const runnerProvErr = new JevShadowRunner({
        client: new FakeSystemOneClient(async () => {
          const err: any = new Error('HTTP 500 Internal Server Error');
          err.status = 500;
          throw err;
        }),
        mode: JevMode.SHADOW,
        sqliteStore: store,
      });
      const sigProvErr = await runnerProvErr.evaluate({
        task,
        workspaceSnapshot: snapshot,
        rankedCandidates: [ranked],
        units: [unit],
        featuresMap: new Map(),
        dataRights: createJevPermittedDataRights(),
      });
      assertStrictEqual(sigProvErr[0].fallbackReason, JevFallbackReason.PROVIDER_ERROR, 'PROVIDER_ERROR fallback reason');

      // 7e. MALFORMED_RESPONSE
      const runnerMalformed = new JevShadowRunner({
        client: new FakeSystemOneClient(async () => {
          return { answers: null } as any;
        }),
        mode: JevMode.SHADOW,
        sqliteStore: store,
      });
      const sigMalformed = await runnerMalformed.evaluate({
        task,
        workspaceSnapshot: snapshot,
        rankedCandidates: [ranked],
        units: [unit],
        featuresMap: new Map(),
        dataRights: createJevPermittedDataRights(),
      });
      assertStrictEqual(sigMalformed[0].fallbackReason, JevFallbackReason.MALFORMED_RESPONSE, 'MALFORMED_RESPONSE fallback reason');

      console.log('  ✔ All failure modes handled cleanly and recorded with proper fallbackReason');
    }

    // ------------------------------------------------------------------------
    // TEST 8: Shadow Invariance Test (Plan_without_JEV == Plan_with_JEV_shadow)
    // ------------------------------------------------------------------------
    console.log('--- Test 8: Shadow Invariance Test (Bit-for-Bit Identity) ---');
    {
      const permittedRights = createJevPermittedDataRights();
      const optResultNoJev = await ContextEngine.optimizeWorkspace({
        workspaceDir: tempWorkspaceDir,
        prompt: 'Implement calculateProduct integration',
        enableJevShadow: false,
        dataRights: permittedRights,
      });

      const fakeClient = new FakeSystemOneClient(async () => ({
        model: 'typesafe-one-preview',
        answers: {
          semanticRelevance: { noul: 0.99 }, // Extreme probabilities to ensure ranking is unaffected
          implementationNeeded: { noul: 0.99 },
          likelyEditTarget: { noul: 0.99 },
          likelyRootCause: { noul: 0.99 },
        },
      }));

      const customRunner = new JevShadowRunner({
        client: fakeClient,
        mode: JevMode.SHADOW,
        sqliteStore: store,
      });

      const optResultWithShadow = await ContextEngine.optimizeWorkspace({
        workspaceDir: tempWorkspaceDir,
        prompt: 'Implement calculateProduct integration',
        enableJevShadow: true,
        jevShadowRunner: customRunner,
        dataRights: permittedRights,
      });

      const planA = optResultNoJev.plan;
      const planB = optResultWithShadow.plan;

      // Assert bit-for-bit equivalence in bundle composition and resolutions
      assertStrictEqual(planA.units.length, planB.units.length, 'Same number of units in bundle');
      for (let i = 0; i < planA.units.length; i++) {
        assertStrictEqual(planA.units[i].contextUnitId, planB.units[i].contextUnitId, `Unit ${i} ID matches`);
        assertStrictEqual(planA.units[i].resolution, planB.units[i].resolution, `Unit ${i} resolution matches`);
        assertStrictEqual(planA.units[i].tokenEstimate, planB.units[i].tokenEstimate, `Unit ${i} token estimate matches`);
      }

      assertStrictEqual(planA.formattedContext.promptText, planB.formattedContext.promptText, 'Formatted context promptText is identical');
      assertStrictEqual(planA.exposureDecisions.length, planB.exposureDecisions.length, 'Exposure decisions count matches');
      for (let i = 0; i < planA.exposureDecisions.length; i++) {
        assertStrictEqual(planA.exposureDecisions[i].contextUnitId, planB.exposureDecisions[i].contextUnitId, `Decision ${i} unit ID matches`);
        assertStrictEqual(planA.exposureDecisions[i].exposureResolution, planB.exposureDecisions[i].exposureResolution, `Decision ${i} resolution matches`);
        assertStrictEqual(planA.exposureDecisions[i].exposureRank, planB.exposureDecisions[i].exposureRank, `Decision ${i} rank matches`);
      }

      // Assert JEV signals were generated in shadow mode
      assert(planB.jevSignals !== undefined && planB.jevSignals.length > 0, 'JEV shadow signals were generated');
      assertStrictEqual(fakeClient.callCount > 0, true, 'Fake JEV client was invoked in shadow mode');
      console.log('  ✔ Invariant verified: Plan_without_JEV is bit-for-bit identical to Plan_with_JEV_shadow_enabled');
    }

    // ------------------------------------------------------------------------
    // Switch working directory for MCP server tests
    // ------------------------------------------------------------------------
    process.chdir(tempWorkspaceDir);

    // ------------------------------------------------------------------------
    // TEST 9: MCP BODY Expansion Test (Target Method Isolated, Siblings Excluded)
    // ------------------------------------------------------------------------
    console.log('--- Test 9: MCP BODY Expansion Method Isolation Test ---');
    {
      const server = createMcpServer();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const mcpClient = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await mcpClient.connect(clientTransport);

      // 1. siftr_context to populate store and find units
      const contextRes = (await mcpClient.callTool({
        name: 'siftr_context',
        arguments: { prompt: 'calculateSum in MathService' },
      })) as any;
      const contextData = JSON.parse(contextRes.content[0].text);
      const sessionId = contextData.sessionId;
      assert(sessionId !== undefined, 'Auto-created sessionId returned by siftr_context');

      // Find the calculateSum method unit in SQLite
      const units = store.getContextUnitsBySnapshot(contextData.workspaceSnapshotId);
      const sumUnit = units.find((u) => u.title.includes('calculateSum'));
      assert(sumUnit !== undefined, 'Found calculateSum ContextUnit in store');

      // 2. Expand calculateSum at BODY resolution
      const expandRes = (await mcpClient.callTool({
        name: 'siftr_expand',
        arguments: {
          sessionId,
          contextUnitId: sumUnit!.id,
          targetResolution: 'BODY',
        },
      })) as any;

      assert(!expandRes.isError, `siftr_expand returned error: ${expandRes.content?.[0]?.text}`);
      const expandData = JSON.parse(expandRes.content[0].text);
      assertStrictEqual(expandData.success, true, 'siftr_expand succeeded');
      assertStrictEqual(expandData.actualResolution, 'BODY', 'Expanded resolution is BODY');

      const expandedContent = expandData.content;
      assert(expandedContent.includes('calculateSum'), 'Contains target method calculateSum');
      assert(expandedContent.includes('const result = a + b;'), 'Contains target method implementation body');
      assert(!expandedContent.includes('calculateProduct'), 'Sibling method calculateProduct is EXCLUDED');
      assert(!expandedContent.includes('calculateDifference'), 'Sibling method calculateDifference is EXCLUDED');
      console.log('  ✔ siftr_expand at BODY resolution strictly isolates target method and excludes siblings');
    }

    // ------------------------------------------------------------------------
    // TEST 10: Missing-Session Rejection Test
    // ------------------------------------------------------------------------
    console.log('--- Test 10: Missing-Session Rejection Test ---');
    {
      const server = createMcpServer();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const mcpClient = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await mcpClient.connect(clientTransport);

      const nonExistentSessionId = 'nonexistent-session-' + Date.now();

      // Test 'end' action on non-existent session
      const endRes = (await mcpClient.callTool({
        name: 'siftr_session',
        arguments: { action: 'end', sessionId: nonExistentSessionId },
      })) as any;
      assertStrictEqual(endRes.isError, true, 'siftr_session end returned error for non-existent session');
      assert(endRes.content[0].text.includes('ERROR_SESSION_NOT_FOUND'), 'Returned ERROR_SESSION_NOT_FOUND error code');

      // Test 'status' action on non-existent session
      const statusRes = (await mcpClient.callTool({
        name: 'siftr_session',
        arguments: { action: 'status', sessionId: nonExistentSessionId },
      })) as any;
      assertStrictEqual(statusRes.isError, true, 'siftr_session status returned error for non-existent session');
      assert(statusRes.content[0].text.includes('ERROR_SESSION_NOT_FOUND'), 'Returned ERROR_SESSION_NOT_FOUND error code');

      console.log('  ✔ Missing-session rejected with strict ERROR_SESSION_NOT_FOUND error');
    }

    // ------------------------------------------------------------------------
    // TEST 11: Sessionless Context Auto-Creation & Outcome Join Test
    // ------------------------------------------------------------------------
    console.log('--- Test 11: Sessionless Context Auto-Creation & Outcome Join Test ---');
    {
      const server = createMcpServer();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const mcpClient = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await mcpClient.connect(clientTransport);

      // 1. siftr_context without sessionId
      const ctxRes = (await mcpClient.callTool({
        name: 'siftr_context',
        arguments: { prompt: 'Auto session test' },
      })) as any;
      const ctxData = JSON.parse(ctxRes.content[0].text);
      const autoSessionId = ctxData.sessionId;
      const planId = ctxData.planId;
      assert(autoSessionId !== undefined && autoSessionId.startsWith('sess_'), 'Auto-generated sessionId created');

      // Verify session exists in DB with status ACTIVE
      const sessionInDb = store.getSession(autoSessionId);
      assert(sessionInDb !== undefined, 'Session persisted in SQLite store');
      assertStrictEqual(sessionInDb!.status, 'ACTIVE', 'Session is ACTIVE');

      // 2. siftr_outcome with this autoSessionId and planId
      const outcomeRes = (await mcpClient.callTool({
        name: 'siftr_outcome',
        arguments: {
          sessionId: autoSessionId,
          planId: planId,
          finalStatus: 'SUCCESS',
          testsPassed: true,
          userAccepted: true,
          editsCount: 1,
        },
      })) as any;

      const outcomeData = JSON.parse(outcomeRes.content[0].text);
      assertStrictEqual(outcomeData.success, true, 'siftr_outcome succeeded');

      // Verify outcome joined in DB
      const outcomes = store.listTaskOutcomes(100);
      const matchedOutcome = outcomes.find((o: any) => o.sessionId === autoSessionId && o.contextPlanId === planId);
      assert(matchedOutcome !== undefined, 'Outcome successfully joined to auto-created session and plan');
      assertStrictEqual(matchedOutcome!.verifiedSuccess, true, 'Outcome verifiedSuccess matches');

      console.log('  ✔ Sessionless context auto-creates active session and joins outcome correctly');
    }

    console.log('\n🎉 ALL 11 JEV SHADOW CLOSURE TESTS PASSED SUCCESSFULLY! (PR J6 Gate Passed)\n');
  } finally {
    // Restore original cwd and cleanup
    process.chdir(origCwd);
    try {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

// Direct execution
if (require.main === module) {
  runJevShadowClosureTests().catch((err) => {
    console.error('Test run failed:', err);
    process.exit(1);
  });
}
