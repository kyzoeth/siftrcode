import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

import { ContextResolution } from '../context/context_resolution';
import { ContextUnitKind, SymbolKind } from '../context/context_unit';
import { ContextEngine } from '../engine/context_engine';
import { WorkspaceManager } from '../workspace/workspace_manager';
import { RepositoryIndexer } from '../indexing/repository_index';
import { GraphBuilder } from '../graph/graph_builder';
import { DefaultContextUnitMaterializer } from '../materialization/context_unit_materializer';
import { DefaultWorkspaceSourceReader } from '../workspace/workspace_source_reader';

console.log('🧪 Testing Real-Pipeline Integration with On-Disk Fixture Repository (Remediation PR 3)...\n');

async function runTests(): Promise<void> {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_fixture_repo_'));

  try {
    // 1. Initialize Git Repository
    execSync('git init -b main', { cwd: fixtureDir, stdio: 'ignore' });
    execSync('git config user.name "Test Author"', { cwd: fixtureDir, stdio: 'ignore' });
    execSync('git config user.email "test@siftrcode.com"', { cwd: fixtureDir, stdio: 'ignore' });

    // 2. Create Real Files on Disk (Section 15: real fixture repository)
    const srcDir = path.join(fixtureDir, 'src');
    const testsDir = path.join(fixtureDir, 'tests');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(testsDir, { recursive: true });

    // package.json
    fs.writeFileSync(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify(
        {
          name: 'fixture-project',
          version: '1.0.0',
          dependencies: { redis: '^4.0.0' },
        },
        null,
        2
      )
    );

    // src/redis_lock.ts
    const redisLockContent = `// RedisLockManager Distributed Lock
export class RedisLockManager {
  private redisUrl: string;

  constructor(redisUrl: string = 'redis://localhost:6379') {
    this.redisUrl = redisUrl;
  }

  public async acquire(lockKey: string, ttlMs: number): Promise<boolean> {
    // Acquire distributed lock with atomic NX expiration
    if (!lockKey || ttlMs <= 0) {
      return false;
    }
    return true;
  }

  public async release(lockKey: string): Promise<void> {
    // Release distributed lock
  }

  public async renew(lockKey: string, ttlMs: number): Promise<boolean> {
    // Extend lease
    return true;
  }
}
`;
    fs.writeFileSync(path.join(srcDir, 'redis_lock.ts'), redisLockContent, 'utf-8');

    // src/deduplicator.ts
    const dedupeContent = `import { RedisLockManager } from './redis_lock';

export class Deduplicator {
  private lock: RedisLockManager;

  constructor() {
    this.lock = new RedisLockManager();
  }

  public async isDuplicate(eventId: string): Promise<boolean> {
    const locked = await this.lock.acquire(eventId, 5000);
    return !locked;
  }
}
`;
    fs.writeFileSync(path.join(srcDir, 'deduplicator.ts'), dedupeContent, 'utf-8');

    // src/webhook.ts
    const webhookContent = `import { Deduplicator } from './deduplicator';

export class WebhookHandler {
  private dedupe: Deduplicator;

  constructor() {
    this.dedupe = new Deduplicator();
  }

  public async handleWebhook(event: { id: string; payload: unknown }): Promise<void> {
    const dup = await this.dedupe.isDuplicate(event.id);
    if (dup) {
      return;
    }
    // Process business event
  }
}
`;
    fs.writeFileSync(path.join(srcDir, 'webhook.ts'), webhookContent, 'utf-8');

    // src/unrelated.ts
    const unrelatedContent = `export class UnrelatedUtility {
  public static calculateHash(input: string): string {
    return 'unrelated_' + input;
  }

  public static formatTimestamp(ts: number): string {
    return new Date(ts).toISOString();
  }
}
`;
    fs.writeFileSync(path.join(srcDir, 'unrelated.ts'), unrelatedContent, 'utf-8');

    // tests/webhook.test.ts
    const testContent = `import { WebhookHandler } from '../src/webhook';

describe('WebhookHandler', () => {
  it('handles events idempotently', async () => {
    const handler = new WebhookHandler();
    await handler.handleWebhook({ id: 'evt_1', payload: {} });
  });
});
`;
    fs.writeFileSync(path.join(testsDir, 'webhook.test.ts'), testContent, 'utf-8');

    // Commit baseline clean tree
    execSync('git add .', { cwd: fixtureDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit of fixture codebase"', { cwd: fixtureDir, stdio: 'ignore' });

    console.log('--- 1. Real Fixture Repository Initialized & Clean Commit Recorded ---');
    console.log(`  ✔ Fixture created at: ${fixtureDir}`);

    // Create uncommitted dirty change in src/webhook.ts (Section 16: Dirty workspace verification)
    fs.appendFileSync(
      path.join(srcDir, 'webhook.ts'),
      '\n// Uncommitted modification: fix race condition in webhook processing\n'
    );
    console.log('  ✔ Dirty uncommitted change added to src/webhook.ts');

    // =========================================================================
    // 2. Full Live Pipeline Execution from Disk (No Mocked Content/Tokens!)
    // =========================================================================
    console.log('\n--- 2. End-to-End Live Pipeline (Disk -> Index -> Graph -> Plan -> Gate) ---');

    const optimizeResult = await ContextEngine.optimizeWorkspace({
      workspaceDir: fixtureDir,
      prompt: 'Fix distributed lock timeout in RedisLockManager when called by WebhookHandler',
      agentModel: 'claude-3-5-sonnet-20241022',
      tokenBudget: 500, // Section 16: maxTokens = 500
    });

    const plan = optimizeResult.plan;
    console.log(`  ✔ Generated ContextPlan: ${plan.planId}`);
    console.log(`  ✔ Actual Rendered Tokens: ${plan.actualRenderedTokens}`);

    // Section 16 Assertion: Budget <= 500 tokens
    assert.ok(
      plan.actualRenderedTokens <= 500,
      `Actual tokens (${plan.actualRenderedTokens}) must not exceed budget limit (500)`
    );
    console.log('  ✔ Section 16 Budget Invariant verified: actualRenderedTokens <= 500');

    // Section 16 Assertion: Dirty workspace correctly identified
    const dirtyUnit = plan.units.find((u) => u.path?.includes('webhook.ts'));
    assert.ok(dirtyUnit !== undefined, 'Dirty file src/webhook.ts must be selected');
    assert.ok(
      dirtyUnit!.resolution === ContextResolution.FULL || dirtyUnit!.resolution === ContextResolution.BODY,
      'Dirty edit target must be protected with FULL or BODY resolution'
    );
    console.log(`  ✔ Dirty file WebhookHandler selected and preserved at resolution: ${dirtyUnit!.resolution}`);

    // =========================================================================
    // 3. Symbol Materialization Scoping (BODY, SIGNATURE, SKELETON)
    // =========================================================================
    console.log('\n--- 3. Real On-Disk Symbol Scoping Assertions ---');

    const workspaceManager = new WorkspaceManager({ rootDir: fixtureDir });
    const snapshot = await workspaceManager.captureSnapshot();
    const sourceReader = new DefaultWorkspaceSourceReader(fixtureDir);
    const materializer = new DefaultContextUnitMaterializer(sourceReader);

    // Index the live workspace
    const indexer = new RepositoryIndexer();
    const indexResult = await indexer.indexRepository(fixtureDir, {
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
    });

    // Find the acquire method symbol
    const acquireUnit = indexResult.units.find(
      (u) => u.kind === ContextUnitKind.CODE_SYMBOL && u.title.includes('acquire')
    );
    assert.ok(acquireUnit !== undefined, 'Indexer must extract acquire method symbol from src/redis_lock.ts');

    // 3.1 BODY Assertion (Section 16: contains acquire, does NOT contain release/renew)
    const bodyMat = materializer.materializeSync(acquireUnit!, ContextResolution.BODY, snapshot);
    assert.ok(bodyMat.content.includes('public async acquire'), 'BODY must contain acquire declaration');
    assert.ok(bodyMat.content.includes('return true;'), 'BODY must contain acquire implementation');
    assert.ok(
      !bodyMat.content.includes('public async release'),
      'Section 16 Invariant: BODY must NOT contain unrelated method "release"!'
    );
    assert.ok(
      !bodyMat.content.includes('public async renew'),
      'Section 16 Invariant: BODY must NOT contain unrelated method "renew"!'
    );
    console.log('  ✔ Symbol BODY: strictly isolated acquire implementation, release/renew excluded');

    // 3.2 SIGNATURE Assertion (Section 16: exact indexed signature, not 3-line file approximation)
    const sigMat = materializer.materializeSync(acquireUnit!, ContextResolution.SIGNATURE, snapshot);
    assert.ok(
      sigMat.content.includes('acquire(lockKey: string, ttlMs: number): Promise<boolean>'),
      'SIGNATURE must contain exact method signature'
    );
    assert.ok(
      !sigMat.content.includes('// RedisLockManager Distributed Lock'),
      'SIGNATURE must not return first three lines of file'
    );
    console.log('  ✔ Symbol SIGNATURE: exact indexed signature returned, zero file-head approximation');

    // 3.3 SKELETON Assertion (Section 16: correct symbol/class scope)
    const lockClassUnit = indexResult.units.find(
      (u) => u.kind === ContextUnitKind.CODE_SYMBOL && u.title === 'RedisLockManager'
    );
    assert.ok(lockClassUnit !== undefined, 'Indexer must extract RedisLockManager class symbol');
    const skelMat = materializer.materializeSync(lockClassUnit!, ContextResolution.SKELETON, snapshot);
    assert.ok(skelMat.content.includes('class RedisLockManager'));
    assert.ok(skelMat.content.includes('acquire(lockKey: string, ttlMs: number)'));
    assert.ok(!skelMat.content.includes('UnrelatedUtility'), 'SKELETON must exclude unrelated classes');
    console.log('  ✔ Symbol SKELETON: strictly scoped to RedisLockManager class structure');

    // =========================================================================
    // 4. Workspace Mutation & Snapshot Validation
    // =========================================================================
    console.log('\n--- 4. Workspace Mutation (WORKSPACE_CHANGED) Assertion ---');

    // Record expected hash for redis_lock.ts for the captured snapshot
    const lockReadBefore = sourceReader.readFileSync(snapshot, 'root', 'src/redis_lock.ts');
    sourceReader.recordExpectedHash(snapshot.workspaceSnapshotId, 'src/redis_lock.ts', lockReadBefore.contentHash);

    // Now mutate redis_lock.ts on disk AFTER snapshot was established
    fs.appendFileSync(path.join(srcDir, 'redis_lock.ts'), '\n// POST-SNAPSHOT MUTATION BY RUNTIME AGENT\n');

    // Attempt to read with the old snapshot: must return WORKSPACE_CHANGED
    const mutatedRead = sourceReader.readFileSync(snapshot, 'root', 'src/redis_lock.ts');
    assert.equal(
      mutatedRead.status,
      'WORKSPACE_CHANGED',
      'Section 16 Invariant: Post-snapshot disk mutation must return status WORKSPACE_CHANGED'
    );
    console.log('  ✔ Post-snapshot disk mutation detected: returned WORKSPACE_CHANGED');

    // Materializer must reflect workspace mutation rather than silently rendering stale content
    const mutatedMat = materializer.materializeSync(acquireUnit!, ContextResolution.FULL, snapshot);
    assert.ok(
      mutatedMat.content.includes('WORKSPACE_CHANGED'),
      'Materialized output must reflect WORKSPACE_CHANGED state'
    );
    console.log('  ✔ Materializer safely flagged WORKSPACE_CHANGED preventing stale context poisoning');

    console.log('\n🎉 All Real-Pipeline Integration tests passed successfully!');
  } finally {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // Cleanup
    }
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
