import {
  ContextResolution,
  ResolutionCapabilities,
  isResolutionSupported,
  getResolutionName
} from '../context/context_resolution';
import {
  TrustLevel,
  isFirstParty,
  isTrusted
} from '../security/trust';
import {
  DataRights,
  DataClass,
  createDefaultDataRights,
  isDataClassPermitted
} from '../rights/data_rights';
import {
  AgentEnvironment,
  createAgentEnvironment,
  computeEnvironmentHash
} from '../agents/agent_environment';
import {
  RepositoryState,
  computeRepositoryCompositeHash
} from '../workspace/repository_state';
import {
  WorkspaceSnapshot,
  createWorkspaceSnapshot,
  computeWorkspaceContentRootHash
} from '../workspace/workspace_snapshot';
import {
  ContextUnit,
  ContextUnitKind,
  CodeSymbolUnit,
  SymbolKind,
  generateSymbolUnitId,
  generateContextUnitId,
  isCodeSymbolUnit
} from '../context/context_unit';
import {
  TaskEvidenceKind,
  StackTraceEvidence,
  TestFailureEvidence
} from '../context/task_evidence';
import {
  TaskContext,
  createTaskContext
} from '../context/task_context';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

async function runFoundationalContractsTests() {
  console.log('🧪 Testing SiftrCode V2 Foundational Domain Contracts...\n');

  // 1. ContextResolution & Capabilities
  console.log('--- 1. ContextResolution & ResolutionCapabilities ---');
  assert(getResolutionName(ContextResolution.OMIT) === 'OMIT', 'Resolution OMIT name matches');
  assert(getResolutionName(ContextResolution.SKELETON) === 'SKELETON', 'Resolution SKELETON name matches');

  const safeCaps: ResolutionCapabilities = {
    supportsName: true,
    supportsSignature: true,
    supportsSkeleton: true,
    supportsBody: true,
    supportsFull: true,
    skeletonSafety: 'SAFE',
    reasonCodes: [],
  };
  assert(isResolutionSupported(ContextResolution.SKELETON, safeCaps), 'Safe skeleton is supported');

  const unsafeCaps: ResolutionCapabilities = {
    ...safeCaps,
    skeletonSafety: 'UNSAFE',
    reasonCodes: ['MACRO_EXPANSION_REQUIRED'],
  };
  assert(!isResolutionSupported(ContextResolution.SKELETON, unsafeCaps), 'UNSAFE skeleton is NOT supported');
  assert(isResolutionSupported(ContextResolution.FULL, unsafeCaps), 'FULL is supported when skeleton is unsafe');

  // 2. TrustLevel
  console.log('\n--- 2. TrustLevel Contract ---');
  assert(isFirstParty(TrustLevel.FIRST_PARTY_CODE), 'FIRST_PARTY_CODE is first party');
  assert(isFirstParty(TrustLevel.FIRST_PARTY_CONFIGURATION), 'FIRST_PARTY_CONFIGURATION is first party');
  assert(!isFirstParty(TrustLevel.DEPENDENCY), 'DEPENDENCY is not first party');
  assert(!isFirstParty(TrustLevel.UNTRUSTED), 'UNTRUSTED is not first party');
  assert(isTrusted(TrustLevel.FIRST_PARTY_CODE), 'FIRST_PARTY_CODE is trusted');
  assert(!isTrusted(TrustLevel.UNTRUSTED), 'UNTRUSTED is not trusted');

  // 3. DataRights & Privacy Defaults
  console.log('\n--- 3. DataRights & Privacy Defaults ---');
  const defaultRights = createDefaultDataRights();
  assert(defaultRights.trainingAllowed === false, 'Privacy default: trainingAllowed is FALSE');
  assert(defaultRights.rawSourceRetentionAllowed === false, 'Privacy default: rawSourceRetentionAllowed is FALSE');
  assert(defaultRights.remoteProcessingAllowed === false, 'Privacy default: remoteProcessingAllowed is FALSE');
  assert(defaultRights.derivedNumericFeaturesAllowed === true, 'Derived numeric features allowed by default');

  assert(!isDataClassPermitted(defaultRights, DataClass.RAW_SOURCE), 'Raw source retention prohibited by default');
  assert(isDataClassPermitted(defaultRights, DataClass.NUMERIC_FEATURE), 'Numeric feature permitted by default');
  assert(isDataClassPermitted(defaultRights, DataClass.AGGREGATE_STATISTIC), 'Aggregate statistic permitted');

  const explicitTrainingRights = createDefaultDataRights({ trainingAllowed: true, rawSourceRetentionAllowed: true });
  assert(explicitTrainingRights.trainingAllowed === true, 'Explicit training permissions honored');
  assert(isDataClassPermitted(explicitTrainingRights, DataClass.RAW_SOURCE), 'Raw source retention allowed with explicit rights');

  // 4. AgentEnvironment
  console.log('\n--- 4. AgentEnvironment Contract ---');
  const agentEnv = createAgentEnvironment({
    agentProvider: 'claude-code',
    agentVersion: '1.0.0',
    model: 'claude-3-5-sonnet',
    modelVersion: '20241022',
    harnessVersion: '0.1.0',
    reasoningMode: 'standard',
    availableTools: ['bash', 'glob', 'grep', 'read_file', 'edit_file'],
    maxTurns: 30,
  });
  assert(typeof agentEnv.systemConfigurationHash === 'string', 'Generated system configuration hash');
  assert(agentEnv.systemConfigurationHash.length > 8, 'Hash has valid length');

  const jsonEnv = JSON.stringify(agentEnv);
  const parsedEnv: AgentEnvironment = JSON.parse(jsonEnv);
  assert(parsedEnv.systemConfigurationHash === agentEnv.systemConfigurationHash, 'AgentEnvironment roundtrips cleanly');

  // 5. RepositoryState & WorkspaceSnapshot
  console.log('\n--- 5. RepositoryState & WorkspaceSnapshot (Multi-repo) ---');
  const repo1: RepositoryState = {
    repositoryId: 'frontend',
    baseCommitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    trackedTreeHash: 'tree_f1',
    dirtyPatchHash: 'diff_empty',
  };
  const repo2: RepositoryState = {
    repositoryId: 'backend',
    baseCommitSha: 'b1c2d3e4f5a6b1c2d3e4f5a6b1c2d3e4f5a6b1c2',
    trackedTreeHash: 'tree_b1',
    dirtyPatchHash: 'diff_patch_pending',
  };

  const hash1 = computeRepositoryCompositeHash(repo1);
  const hash2 = computeRepositoryCompositeHash(repo2);
  assert(hash1 !== hash2, 'Different repo states produce distinct hashes');

  const ws = createWorkspaceSnapshot({
    repositories: [repo1, repo2],
  });
  assert(ws.repositories.length === 2, 'Snapshot preserves multi-repository configuration');
  assert(ws.workspaceSnapshotId.startsWith('ws_'), 'Snapshot ID has expected prefix');

  // Modifying repo2 dirty diff alters content root hash
  const repo2Dirty: RepositoryState = { ...repo2, dirtyPatchHash: 'diff_patch_mutated' };
  const wsMutated = createWorkspaceSnapshot({
    repositories: [repo1, repo2Dirty],
  });
  assert(ws.contentRootHash !== wsMutated.contentRootHash, 'Dirty modifications alter snapshot content root hash');
  assert(ws.workspaceSnapshotId !== wsMutated.workspaceSnapshotId, 'Dirty modifications alter snapshot identity');

  // Snapshot JSON roundtrip
  const wsJson = JSON.stringify(ws);
  const wsParsed: WorkspaceSnapshot = JSON.parse(wsJson);
  assert(wsParsed.workspaceSnapshotId === ws.workspaceSnapshotId, 'WorkspaceSnapshot roundtrips JSON');
  assert(wsParsed.repositories.length === 2, 'WorkspaceSnapshot repos count intact');

  // 6. ContextUnit & CodeSymbolUnit Stable Identity
  console.log('\n--- 6. ContextUnit & CodeSymbolUnit Stable Identity ---');
  const symIdLine10 = generateSymbolUnitId('repo-main', 'src/auth/token.ts', 'TokenManager.verify', SymbolKind.METHOD);
  const symIdLine99 = generateSymbolUnitId('repo-main', 'src/auth/token.ts', 'TokenManager.verify', SymbolKind.METHOD);
  assert(symIdLine10 === symIdLine99, 'Symbol ID is invariant to line number changes (Section 23)');

  const symIdDiffMethod = generateSymbolUnitId('repo-main', 'src/auth/token.ts', 'TokenManager.revoke', SymbolKind.METHOD);
  assert(symIdLine10 !== symIdDiffMethod, 'Different symbols have distinct identities');

  const symbolUnit: CodeSymbolUnit = {
    id: symIdLine10,
    kind: ContextUnitKind.CODE_SYMBOL,
    workspaceSnapshotId: ws.workspaceSnapshotId,
    repositoryId: 'repo-main',
    path: 'src/auth/token.ts',
    title: 'TokenManager.verify',
    provenance: {
      sourceType: 'file',
      sourceUri: 'src/auth/token.ts',
      extractedBy: 'tree-sitter',
    },
    trustLevel: TrustLevel.FIRST_PARTY_CODE,
    metadata: { exported: true },
    symbolKind: SymbolKind.METHOD,
    symbolName: 'verify',
    qualifiedName: 'TokenManager.verify',
    language: 'typescript',
    startLine: 25,
    endLine: 48,
    signature: 'verify(token: string): Promise<TokenPayload>',
    contentHash: 'hash_verify_body',
  };

  assert(isCodeSymbolUnit(symbolUnit), 'isCodeSymbolUnit recognizes CodeSymbolUnit');
  const genericUnit: ContextUnit = {
    id: generateContextUnitId(ContextUnitKind.CONFIG, 'repo-main', 'package.json'),
    kind: ContextUnitKind.CONFIG,
    workspaceSnapshotId: ws.workspaceSnapshotId,
    repositoryId: 'repo-main',
    path: 'package.json',
    title: 'package.json manifest',
    provenance: { sourceType: 'file' },
    trustLevel: TrustLevel.FIRST_PARTY_CONFIGURATION,
    metadata: {},
  };
  assert(!isCodeSymbolUnit(genericUnit), 'isCodeSymbolUnit returns false for CONFIG unit');

  // ContextUnit JSON roundtrip
  const symJson = JSON.stringify(symbolUnit);
  const symParsed: CodeSymbolUnit = JSON.parse(symJson);
  assert(symParsed.id === symbolUnit.id, 'CodeSymbolUnit ID preserved across serialization');
  assert(symParsed.qualifiedName === 'TokenManager.verify', 'Qualified name preserved');

  // 7. TaskEvidence & TaskContext
  console.log('\n--- 7. TaskEvidence & TaskContext ---');
  const stackEvidence: StackTraceEvidence = {
    evidenceId: 'ev_stack_1',
    kind: TaskEvidenceKind.STACK_TRACE,
    timestamp: new Date().toISOString(),
    rawTrace: 'Error: Token expired\n    at TokenManager.verify (src/auth/token.ts:32:11)',
    frames: [
      { file: 'src/auth/token.ts', line: 32, column: 11, functionName: 'TokenManager.verify' },
    ],
  };

  const testEvidence: TestFailureEvidence = {
    evidenceId: 'ev_test_1',
    kind: TaskEvidenceKind.TEST_FAILURE,
    timestamp: new Date().toISOString(),
    testSuite: 'AuthMiddlewareSuite',
    testName: 'should reject expired tokens',
    failureMessage: 'Expected 401 Unauthorized, got 500 Internal Server Error',
    testFilePath: 'tests/auth_test.ts',
  };

  const taskContext = createTaskContext({
    taskId: 'task_jwt_expiration',
    primaryPrompt: 'Fix JWT expiration handling in auth middleware',
    evidence: [stackEvidence, testEvidence],
    workspaceSnapshotId: ws.workspaceSnapshotId,
    agentEnvironment: agentEnv,
  });

  assert(taskContext.evidence.length === 3, 'Evidence array contains synthesized prompt evidence + 2 provided evidences');
  assert(taskContext.evidence[0].kind === TaskEvidenceKind.USER_PROMPT, 'First evidence item is USER_PROMPT');
  assert(taskContext.workspaceSnapshotId === ws.workspaceSnapshotId, 'Workspace snapshot ID linked correctly');

  // TaskContext serialization roundtrip
  const taskJson = JSON.stringify(taskContext);
  const parsedTask: TaskContext = JSON.parse(taskJson);
  assert(parsedTask.taskId === 'task_jwt_expiration', 'TaskContext taskId preserved');
  assert(parsedTask.evidence.length === 3, 'TaskContext evidence count preserved');
  assert(parsedTask.agentEnvironment.model === 'claude-3-5-sonnet', 'Agent environment model preserved');

  console.log('\n🎉 All Foundational Contracts tests passed successfully!');
}

runFoundationalContractsTests().catch((err) => {
  console.error('❌ Foundational contracts test failed:', err);
  process.exit(1);
});
