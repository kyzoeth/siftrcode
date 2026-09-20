import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteStore } from '../storage/sqlite_store';
import { createWorkspaceSnapshot } from '../workspace/workspace_snapshot';
import {
  ContextUnit,
  ContextUnitKind,
  CodeSymbolUnit,
  SymbolKind,
  generateSymbolUnitId,
  generateContextUnitId,
  isCodeSymbolUnit
} from '../context/context_unit';
import { TrustLevel } from '../security/trust';
import { createTaskContext } from '../context/task_context';
import { createAgentEnvironment } from '../agents/agent_environment';
import { TaskEvidenceKind, StackTraceEvidence } from '../context/task_evidence';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

async function runStorageTests() {
  console.log('🧪 Testing SqliteStore & Migration System...\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-test-storage-'));
  const dbFile = path.join(tempDir, 'test_siftr.db');

  try {
    // 1. In-Memory Store & Migration Execution
    console.log('--- 1. In-Memory Store & Migrations ---');
    const memStore = new SqliteStore(':memory:');
    const applied = memStore.getAppliedMigrations();
    assert(applied.length >= 1, 'Initial migration applied');
    assert(applied[0].name === '001_initial_schema', 'Applied migration matches name');

    // Migration idempotency
    memStore.runMigrations();
    const appliedAgain = memStore.getAppliedMigrations();
    assert(appliedAgain.length === applied.length, 'Re-running migrations is idempotent');
    memStore.close();

    // 2. File-based Store: Snapshots Persistence
    console.log('\n--- 2. File-based Store: Snapshots ---');
    const store1 = new SqliteStore(dbFile);

    const snapA = createWorkspaceSnapshot({
      repositories: [
        {
          repositoryId: 'frontend',
          baseCommitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          trackedTreeHash: 'tree_fe_1',
          dirtyPatchHash: 'clean',
        }
      ]
    });

    const snapB = createWorkspaceSnapshot({
      repositories: [
        {
          repositoryId: 'frontend',
          baseCommitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          trackedTreeHash: 'tree_fe_1',
          dirtyPatchHash: 'diff_modified_line',
        }
      ],
      parentSnapshotId: snapA.workspaceSnapshotId,
    });

    store1.saveSnapshot(snapA, 'ws-main');
    store1.saveSnapshot(snapB, 'ws-main');

    const retrievedA = store1.getSnapshot(snapA.workspaceSnapshotId);
    assert(retrievedA !== undefined, 'Snapshot A retrieved');
    assert(retrievedA!.contentRootHash === snapA.contentRootHash, 'Snapshot A content root hash matches');
    assert(retrievedA!.repositories[0].repositoryId === 'frontend', 'Snapshot A repo state matches');

    const retrievedB = store1.getSnapshot(snapB.workspaceSnapshotId);
    assert(retrievedB !== undefined, 'Snapshot B retrieved');
    assert(retrievedB!.parentSnapshotId === snapA.workspaceSnapshotId, 'Snapshot B parent link matches');

    const allSnaps = store1.listSnapshots('ws-main');
    assert(allSnaps.length === 2, `Listed 2 snapshots for workspace ws-main (got ${allSnaps.length})`);

    // 3. ContextUnit Persistence & Query Filtering
    console.log('\n--- 3. ContextUnit Persistence & Query Filtering ---');
    const symId1 = generateSymbolUnitId('frontend', 'src/auth.ts', 'login', SymbolKind.FUNCTION);
    const sym1: CodeSymbolUnit = {
      id: symId1,
      kind: ContextUnitKind.CODE_SYMBOL,
      workspaceSnapshotId: snapA.workspaceSnapshotId,
      repositoryId: 'frontend',
      path: 'src/auth.ts',
      title: 'login function',
      provenance: { sourceType: 'file', sourceUri: 'src/auth.ts' },
      trustLevel: TrustLevel.FIRST_PARTY_CODE,
      metadata: { exported: true },
      symbolKind: SymbolKind.FUNCTION,
      symbolName: 'login',
      qualifiedName: 'login',
      language: 'typescript',
      startLine: 10,
      endLine: 35,
      signature: 'login(credentials: Credentials): Promise<Session>',
      contentHash: 'hash_body_login',
    };

    const cfgId = generateContextUnitId(ContextUnitKind.CONFIG, 'frontend', 'package.json');
    const cfgUnit: ContextUnit = {
      id: cfgId,
      kind: ContextUnitKind.CONFIG,
      workspaceSnapshotId: snapA.workspaceSnapshotId,
      repositoryId: 'frontend',
      path: 'package.json',
      title: 'package.json',
      provenance: { sourceType: 'file' },
      trustLevel: TrustLevel.FIRST_PARTY_CONFIGURATION,
      metadata: {},
    };

    store1.saveContextUnits([sym1, cfgUnit]);

    const retrievedSym = store1.getContextUnit(symId1);
    assert(retrievedSym !== undefined, 'Retrieved code symbol unit');
    assert(isCodeSymbolUnit(retrievedSym!), 'Retrieved unit recognized as CodeSymbolUnit');
    assert((retrievedSym as CodeSymbolUnit).signature === sym1.signature, 'Signature preserved');

    const unitsForSnapA = store1.listContextUnits(snapA.workspaceSnapshotId);
    assert(unitsForSnapA.length === 2, 'Listed all units for snapshot A');

    const symbolsOnly = store1.listContextUnits(snapA.workspaceSnapshotId, { kind: ContextUnitKind.CODE_SYMBOL });
    assert(symbolsOnly.length === 1, 'Filtered symbols only count is 1');
    assert(symbolsOnly[0].id === symId1, 'Filtered symbol ID matches');

    const pathFiltered = store1.listContextUnits(snapA.workspaceSnapshotId, { path: 'package.json' });
    assert(pathFiltered.length === 1 && pathFiltered[0].id === cfgId, 'Filtered by path correctly');

    // 4. Graph Edges Persistence & Adjacency Queries
    console.log('\n--- 4. Graph Edges Persistence ---');
    const symId2 = generateSymbolUnitId('frontend', 'src/db.ts', 'query', SymbolKind.FUNCTION);
    store1.saveGraphEdges([
      {
        fromUnitId: symId1,
        toUnitId: symId2,
        kind: 'CALLS',
        confidence: 0.95,
        source: 'tree-sitter',
        weight: 1.0,
        snapshotId: snapA.workspaceSnapshotId,
      }
    ]);

    const outgoing = store1.getOutgoingEdges(symId1, snapA.workspaceSnapshotId);
    assert(outgoing.length === 1, 'Found 1 outgoing edge for sym1');
    assert(outgoing[0].kind === 'CALLS' && outgoing[0].toUnitId === symId2, 'Outgoing edge matches target and kind');

    const incoming = store1.getIncomingEdges(symId2, snapA.workspaceSnapshotId);
    assert(incoming.length === 1, 'Found 1 incoming edge for sym2');
    assert(incoming[0].fromUnitId === symId1, 'Incoming edge matches source');

    // 5. TaskContext & Session Persistence
    console.log('\n--- 5. TaskContext & Session Persistence ---');
    const agentEnv = createAgentEnvironment({
      agentProvider: 'claude-code',
      agentVersion: '1.0.0',
      model: 'claude-3-5-sonnet',
      harnessVersion: '0.1.0',
      availableTools: ['bash', 'read_file'],
    });

    const stackEv: StackTraceEvidence = {
      evidenceId: 'ev_stack_1',
      kind: TaskEvidenceKind.STACK_TRACE,
      timestamp: new Date().toISOString(),
      rawTrace: 'Error at login (src/auth.ts:15)',
      frames: [{ file: 'src/auth.ts', line: 15 }],
    };

    const taskCtx = createTaskContext({
      taskId: 'task_auth_fix_001',
      primaryPrompt: 'Fix login error handling',
      evidence: [stackEv],
      workspaceSnapshotId: snapA.workspaceSnapshotId,
      agentEnvironment: agentEnv,
    });

    store1.saveTaskContext(taskCtx);
    const retrievedTask = store1.getTaskContext('task_auth_fix_001');
    assert(retrievedTask !== undefined, 'TaskContext retrieved');
    assert(retrievedTask!.evidence.length === 2, 'Task evidence count preserved (prompt + stack trace)');

    store1.saveSession({
      sessionId: 'sess_123',
      taskId: 'task_auth_fix_001',
      snapshotId: snapA.workspaceSnapshotId,
      state: 'ACTIVE',
      metadata: { turns: 3 },
    });

    const retrievedSess = store1.getSession('sess_123');
    assert(retrievedSess !== undefined, 'Session retrieved');
    assert(retrievedSess!.state === 'ACTIVE', 'Session state matches');

    // 6. Process Restart Simulation
    console.log('\n--- 6. Process Restart Simulation ---');
    store1.close();

    // Reopen database from disk in a fresh store instance
    const store2 = new SqliteStore(dbFile);

    const restartedSnapA = store2.getSnapshot(snapA.workspaceSnapshotId);
    assert(restartedSnapA !== undefined, 'Restart: Snapshot retrieved after database reopen');
    assert(restartedSnapA!.contentRootHash === snapA.contentRootHash, 'Restart: Snapshot content hash intact');

    const restartedSym = store2.getContextUnit(symId1);
    assert(restartedSym !== undefined, 'Restart: ContextUnit retrieved after reopen');
    assert(isCodeSymbolUnit(restartedSym!), 'Restart: CodeSymbolUnit typing intact');

    const restartedTask = store2.getTaskContext('task_auth_fix_001');
    assert(restartedTask !== undefined, 'Restart: TaskContext retrieved after reopen');

    const restartedEdge = store2.getOutgoingEdges(symId1, snapA.workspaceSnapshotId);
    assert(restartedEdge.length === 1 && restartedEdge[0].kind === 'CALLS', 'Restart: Graph edge intact');

    store2.close();
    console.log('\n🎉 All SqliteStore & Migration tests passed successfully!');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

runStorageTests().catch((err) => {
  console.error('❌ Storage tests failed:', err);
  process.exit(1);
});
