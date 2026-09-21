import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import { ContextResolution } from '../context/context_resolution';
import {
  ContextUnitKind,
  CodeSymbolUnit,
  SymbolKind,
  ContextUnit,
} from '../context/context_unit';
import { TrustLevel } from '../security/trust';
import { createWorkspaceSnapshot } from '../workspace/workspace_snapshot';
import {
  DefaultWorkspaceSourceReader,
  WorkspaceSourceReader,
} from '../workspace/workspace_source_reader';
import {
  DefaultContextUnitMaterializer,
  ContextUnitMaterializer,
} from '../materialization/context_unit_materializer';
import { ContextEngine } from '../engine/context_engine';
import { createTaskContext } from '../context/task_context';
import { createAgentEnvironment } from '../agents/agent_environment';

console.log('🧪 Testing ContextUnit Materialization Foundation & WorkspaceSourceReader (Remediation PR 1)...\n');

async function runTests(): Promise<void> {
  // Setup Temporary Test Workspace
  const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_mat_test_'));
  const tempOutsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_outside_test_'));

  try {
    const infraDir = path.join(tempWorkspaceDir, 'src', 'infrastructure');
    fs.mkdirSync(infraDir, { recursive: true });

    const sampleFileContent = `// File: src/infrastructure/RedisLockManager.ts
import { RedisClient } from './redis';

export class UnrelatedHelper {
  public ping(): string {
    return 'pong';
  }
}

export class RedisLockManager {
  private client: RedisClient;

  constructor() {
    this.client = new RedisClient();
  }

  public async acquire(key: string, ttlMs: number): Promise<boolean> {
    const raw = await this.client.set(key, 'locked', 'PX', ttlMs, 'NX');
    if (!raw) {
      return false;
    }
    return true;
  }

  public async release(key: string): Promise<void> {
    await this.client.del(key);
  }
}
`;
    const sampleFilePath = path.join(infraDir, 'RedisLockManager.ts');
    fs.writeFileSync(sampleFilePath, sampleFileContent, 'utf-8');

    // Outside secret file
    const secretFilePath = path.join(tempOutsideDir, 'secret.env');
    fs.writeFileSync(secretFilePath, 'SECRET_API_KEY=top_secret_123', 'utf-8');

    // Symlink pointing outside workspace
    const symlinkPath = path.join(tempWorkspaceDir, 'symlink_outside.env');
    try {
      fs.symlinkSync(secretFilePath, symlinkPath);
    } catch {
      // Symlinks may not be allowed on some environments
    }

    const snapshot = createWorkspaceSnapshot({
      repositories: [
        {
          repositoryId: 'root',
          baseCommitSha: 'commit_abc123',
          trackedTreeHash: 'tree_hash_456',
          dirtyPatchHash: 'clean',
        },
      ],
    });

    // =========================================================================
    // 1. WorkspaceSourceReader Security & Integrity Tests
    // =========================================================================
    console.log('--- 1. WorkspaceSourceReader Path Containment & Symlink Defense ---');
    const reader = new DefaultWorkspaceSourceReader(tempWorkspaceDir);

    // Normal read
    const validRead = reader.readFileSync(snapshot, 'root', 'src/infrastructure/RedisLockManager.ts');
    assert.equal(validRead.status, 'OK', 'Valid in-tree file should return status OK');
    assert.equal(validRead.content, sampleFileContent, 'Content must match disk content');
    assert.ok(validRead.contentHash.length === 64, 'Must compute sha256 contentHash');
    assert.equal(validRead.byteLength, Buffer.byteLength(sampleFileContent), 'byteLength must match');
    console.log('  ✔ In-tree file read securely with valid status OK and SHA-256 hash');

    // Traversal attack with relative path escape
    const traversalRead = reader.readFileSync(snapshot, 'root', '../../outside.txt');
    assert.equal(traversalRead.status, 'OUTSIDE_WORKSPACE', 'Relative traversal must be rejected');
    assert.equal(traversalRead.content, '', 'Outside content must not be read');
    assert.ok(traversalRead.errorMessage?.includes('escapes workspace boundary'));
    console.log('  ✔ Path traversal escape (../../) strictly blocked with OUTSIDE_WORKSPACE');

    // Symlink escape defense
    if (fs.existsSync(symlinkPath)) {
      const symlinkRead = reader.readFileSync(snapshot, 'root', 'symlink_outside.env');
      assert.equal(symlinkRead.status, 'OUTSIDE_WORKSPACE', 'Symlink pointing outside workspace must be rejected');
      console.log('  ✔ Symlink pointing outside workspace boundary blocked with OUTSIDE_WORKSPACE');
    } else {
      console.log('  ✔ Symlink test skipped (platform filesystem limitation)');
    }

    // Non-existent file
    const missingRead = reader.readFileSync(snapshot, 'root', 'src/infrastructure/NonExistent.ts');
    assert.equal(missingRead.status, 'FILE_NOT_FOUND', 'Missing file must return FILE_NOT_FOUND');
    console.log('  ✔ Non-existent file returned FILE_NOT_FOUND');

    // Snapshot hash mismatch (WORKSPACE_CHANGED)
    reader.recordExpectedHash(snapshot.workspaceSnapshotId, 'src/infrastructure/RedisLockManager.ts', 'stale_hash_value');
    const staleRead = reader.readFileSync(snapshot, 'root', 'src/infrastructure/RedisLockManager.ts');
    assert.equal(staleRead.status, 'WORKSPACE_CHANGED', 'Hash mismatch must return WORKSPACE_CHANGED');
    assert.ok(staleRead.errorMessage?.includes('does not match snapshot hash'));
    console.log('  ✔ Stale snapshot modification flagged with WORKSPACE_CHANGED');

    // Reset expected hash to correct hash
    reader.recordExpectedHash(snapshot.workspaceSnapshotId, 'src/infrastructure/RedisLockManager.ts', validRead.contentHash);

    // Async variant equivalence
    const asyncRead = await reader.readFile(snapshot, 'root', 'src/infrastructure/RedisLockManager.ts');
    assert.equal(asyncRead.status, 'OK');
    assert.equal(asyncRead.contentHash, validRead.contentHash);
    console.log('  ✔ Async readFile produces identical results to synchronous readFileSync');

    // =========================================================================
    // 2. Capability Matrix (supports) Tests
    // =========================================================================
    console.log('\n--- 2. Materializer Capability Publishing (supports) ---');
    const materializer: ContextUnitMaterializer = new DefaultContextUnitMaterializer(reader);

    // Code symbols support all resolutions
    assert.strictEqual(materializer.supports(ContextUnitKind.CODE_SYMBOL, ContextResolution.OMIT), true);
    assert.strictEqual(materializer.supports(ContextUnitKind.CODE_SYMBOL, ContextResolution.NAME), true);
    assert.strictEqual(materializer.supports(ContextUnitKind.CODE_SYMBOL, ContextResolution.SIGNATURE), true);
    assert.strictEqual(materializer.supports(ContextUnitKind.CODE_SYMBOL, ContextResolution.SKELETON), true);
    assert.strictEqual(materializer.supports(ContextUnitKind.CODE_SYMBOL, ContextResolution.BODY), true);
    assert.strictEqual(materializer.supports(ContextUnitKind.CODE_SYMBOL, ContextResolution.FULL), true);
    console.log('  ✔ CODE_SYMBOL publishes support for all resolutions (OMIT, NAME, SIGNATURE, SKELETON, BODY, FULL)');

    // Source files support skeletons and signatures
    assert.strictEqual(materializer.supports(ContextUnitKind.SOURCE_FILE, ContextResolution.SKELETON), true);
    assert.strictEqual(materializer.supports(ContextUnitKind.SOURCE_FILE, ContextResolution.SIGNATURE), true);

    // Non-code configs and lockfiles CANNOT be skeletonized (Section 6 & 38 invariant!)
    assert.strictEqual(materializer.supports(ContextUnitKind.CONFIG, ContextResolution.SKELETON), false);
    assert.strictEqual(materializer.supports(ContextUnitKind.LOCKFILE, ContextResolution.SKELETON), false);
    assert.strictEqual(materializer.supports(ContextUnitKind.CONFIG, ContextResolution.NAME), true);
    assert.strictEqual(materializer.supports(ContextUnitKind.CONFIG, ContextResolution.FULL), true);
    console.log('  ✔ CONFIG and LOCKFILE strictly reject SKELETON capability');

    // =========================================================================
    // 3. Strict Symbol-Scoped Materialization Semantics
    // =========================================================================
    console.log('\n--- 3. Strict Symbol-Scoped Materialization Semantics ---');

    const acquireMethodUnit: CodeSymbolUnit = {
      id: 'unit_redis_acquire',
      kind: ContextUnitKind.CODE_SYMBOL,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'src/infrastructure/RedisLockManager.ts',
      title: 'RedisLockManager.acquire',
      provenance: { sourceType: 'file' },
      trustLevel: TrustLevel.FIRST_PARTY_CODE,
      symbolName: 'acquire',
      symbolKind: SymbolKind.METHOD,
      qualifiedName: 'RedisLockManager.acquire',
      language: 'typescript',
      contentHash: 'hash_acquire',
      metadata: {},
      startLine: 17,
      endLine: 23,
      signature: 'public async acquire(key: string, ttlMs: number): Promise<boolean>',
      sourceRange: {
        startLine: 17,
        endLine: 23,
        startByte: 240,
        endByte: 450,
      },
    };

    const classUnit: CodeSymbolUnit = {
      id: 'unit_redis_class',
      kind: ContextUnitKind.CODE_SYMBOL,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'src/infrastructure/RedisLockManager.ts',
      title: 'RedisLockManager',
      provenance: { sourceType: 'file' },
      trustLevel: TrustLevel.FIRST_PARTY_CODE,
      symbolName: 'RedisLockManager',
      symbolKind: SymbolKind.CLASS,
      qualifiedName: 'RedisLockManager',
      language: 'typescript',
      contentHash: 'hash_class',
      metadata: {},
      startLine: 10,
      endLine: 27,
      signature: 'export class RedisLockManager',
      sourceRange: {
        startLine: 10,
        endLine: 27,
      },
    };

    // 3.1 NAME Resolution
    const matName = materializer.materializeSync(acquireMethodUnit, ContextResolution.NAME, snapshot);
    assert.equal(matName.resolution, ContextResolution.NAME);
    assert.equal(matName.content, 'METHOD RedisLockManager.acquire src/infrastructure/RedisLockManager.ts');
    assert.ok(matName.actualTokenCount > 0);
    assert.ok(matName.contentHash.length === 64);
    console.log(`  ✔ NAME: "${matName.content}"`);

    // 3.2 SIGNATURE Resolution: Real indexed signature, NEVER 3-line file approximation!
    const matSig = materializer.materializeSync(acquireMethodUnit, ContextResolution.SIGNATURE, snapshot);
    assert.equal(matSig.resolution, ContextResolution.SIGNATURE);
    assert.ok(matSig.content.includes('public async acquire(key: string, ttlMs: number): Promise<boolean>'));
    assert.ok(!matSig.content.includes('// File: src/infrastructure/RedisLockManager.ts'), 'Must NOT return top 3 lines of file!');
    assert.ok(!matSig.content.includes('UnrelatedHelper'), 'Must NOT contain unrelated symbols!');
    console.log('  ✔ SIGNATURE: Returned exact indexed signature, zero file-head approximation');

    // 3.3 SKELETON Resolution: Scoped to symbol/class
    // For class unit: skeletonize ONLY RedisLockManager, UnrelatedHelper must NOT appear!
    const matClassSkel = materializer.materializeSync(classUnit, ContextResolution.SKELETON, snapshot);
    assert.equal(matClassSkel.resolution, ContextResolution.SKELETON);
    assert.ok(matClassSkel.content.includes('class RedisLockManager'));
    assert.ok(!matClassSkel.content.includes('UnrelatedHelper'), 'Class skeleton must exclude unrelated classes in same file!');
    console.log('  ✔ SKELETON (Class): Scoped precisely to target class block, excluding UnrelatedHelper');

    // For method unit: skeleton is declaration signature
    const matMethodSkel = materializer.materializeSync(acquireMethodUnit, ContextResolution.SKELETON, snapshot);
    assert.equal(matMethodSkel.resolution, ContextResolution.SKELETON);
    assert.ok(matMethodSkel.content.includes('acquire(key: string, ttlMs: number): Promise<boolean>;'));
    console.log('  ✔ SKELETON (Method): Returned declaration signature statement');

    // 3.4 BODY Resolution: Exact line slice, NEVER whole file!
    const matBody = materializer.materializeSync(acquireMethodUnit, ContextResolution.BODY, snapshot);
    assert.equal(matBody.resolution, ContextResolution.BODY);
    assert.ok(matBody.content.includes('const raw = await this.client.set'));
    assert.ok(matBody.content.includes('return true;'));
    assert.ok(!matBody.content.includes('UnrelatedHelper'), 'BODY must NOT contain whole file or unrelated symbols!');
    assert.ok(!matBody.content.includes('release(key: string)'), 'BODY must NOT contain other methods in class!');
    assert.equal(matBody.sourceRange?.startLine, 17);
    assert.equal(matBody.sourceRange?.endLine, 23);
    console.log('  ✔ BODY: Returned exact indexed line slice (L17-L23), strictly isolating method implementation');

    // 3.5 FULL Resolution: Entire file
    const matFull = materializer.materializeSync(acquireMethodUnit, ContextResolution.FULL, snapshot);
    assert.equal(matFull.resolution, ContextResolution.FULL);
    assert.ok(matFull.content.includes('UnrelatedHelper'), 'FULL includes complete source file');
    assert.ok(matFull.content.includes('release(key: string)'));
    console.log('  ✔ FULL: Returned complete source file');

    // 3.6 OMIT Resolution: Empty content
    const matOmit = materializer.materializeSync(acquireMethodUnit, ContextResolution.OMIT, snapshot);
    assert.equal(matOmit.resolution, ContextResolution.OMIT);
    assert.equal(matOmit.content, '');
    assert.equal(matOmit.actualTokenCount, 0);
    console.log('  ✔ OMIT: Returns empty string with zero tokens');

    // =========================================================================
    // 4. Non-Code Unit Degradation Safety
    // =========================================================================
    console.log('\n--- 4. Non-Code Unit Degradation Safety ---');
    const configUnit: ContextUnit = {
      id: 'unit_tsconfig',
      kind: ContextUnitKind.CONFIG,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'tsconfig.json',
      title: 'tsconfig.json',
      provenance: { sourceType: 'file' },
      trustLevel: TrustLevel.FIRST_PARTY_CONFIGURATION,
      metadata: {
        content: '{\n  "compilerOptions": { "target": "ES2022" }\n}',
      },
    };

    // Requesting SKELETON on non-code unit must safely degrade to NAME
    const degradedMat = materializer.materializeSync(configUnit, ContextResolution.SKELETON, snapshot);
    assert.equal(degradedMat.resolution, ContextResolution.NAME, 'CONFIG requesting SKELETON must degrade to NAME');
    assert.ok(degradedMat.content.includes('tsconfig.json'));
    console.log('  ✔ CONFIG requesting SKELETON degrades safely to NAME without AST parser error');

    // =========================================================================
    // 5. ContextEngine Dependency Injection & Materializer Wiring
    // =========================================================================
    console.log('\n--- 5. ContextEngine Materializer Injection & Orchestration ---');
    let injectedMaterializerCalled = false;

    const trackingMaterializer: ContextUnitMaterializer = {
      supports: (kind, res) => materializer.supports(kind, res),
      materialize: async (u, r, w, e) => {
        injectedMaterializerCalled = true;
        return materializer.materialize(u, r, w, e);
      },
      materializeSync: (u, r, w, e) => {
        injectedMaterializerCalled = true;
        return materializer.materializeSync(u, r, w, e);
      },
    };

    const engine = new ContextEngine({
      repoRootDir: tempWorkspaceDir,
      materializer: trackingMaterializer,
      budgetProfile: 'BALANCED',
    });

    const task = createTaskContext({
      taskId: 'task_mat_test',
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      primaryPrompt: 'Fix RedisLockManager acquire timeout handling',
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
      units: [acquireMethodUnit, classUnit],
      snapshot,
    });

    assert.ok(plan.planId.startsWith('cplan_'));
    assert.ok(plan.units.length > 0);
    assert.strictEqual(injectedMaterializerCalled, true, 'ContextEngine must delegate materialization to injected ContextUnitMaterializer');
    console.log('  ✔ ContextEngine successfully delegated all unit content rendering to injected ContextUnitMaterializer');

    console.log('\n🎉 All ContextUnit Materialization & WorkspaceSourceReader tests passed successfully!');
  } finally {
    // Cleanup temp directories
    try {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
      fs.rmSync(tempOutsideDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
