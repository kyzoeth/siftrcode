import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CandidateGenerator } from '../retrieval/candidate_generator';
import { ExactRetriever } from '../retrieval/exact_retriever';
import { LexicalRetriever } from '../retrieval/lexical_retriever';
import { StackTraceRetriever } from '../retrieval/stack_trace_retriever';
import { RepositoryIndexer } from '../indexing/repository_index';
import { GraphBuilder } from '../graph/graph_builder';
import { createTaskContext } from '../context/task_context';
import { createAgentEnvironment } from '../agents/agent_environment';
import { TaskEvidenceKind, StackTraceEvidence } from '../context/task_evidence';
import { ContextUnitKind } from '../context/context_unit';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

async function runCandidateDiscoveryTests() {
  console.log('🧪 Testing Candidate Discovery & Recall Benchmark (Phase 8)...\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-test-candidates-'));
  const srcDir = path.join(tempDir, 'src');
  const testDir = path.join(tempDir, 'tests');

  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });

  // 1. Setup simulated multi-file repository
  fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name": "payment-service"}\n');

  // webhook.ts
  fs.writeFileSync(
    path.join(srcDir, 'webhook.ts'),
    `
import { EventDeduplicator } from './deduplicator';
import { PaymentService } from './payment';

export class WebhookHandler {
  constructor(private deduplicator: EventDeduplicator, private payment: PaymentService) {}

  public async handleStripeWebhook(eventId: string, payload: any): Promise<boolean> {
    const isNew = await this.deduplicator.reserve(eventId);
    if (!isNew) return false;
    return await this.payment.charge(payload.amount);
  }
}
`
  );

  // deduplicator.ts
  fs.writeFileSync(
    path.join(srcDir, 'deduplicator.ts'),
    `
import { RedisLockManager } from './redis_lock';

export class EventDeduplicator {
  constructor(private lockManager: RedisLockManager) {}

  public async reserve(key: string): Promise<boolean> {
    return await this.lockManager.acquire(key, 5000);
  }
}
`
  );

  // redis_lock.ts
  fs.writeFileSync(
    path.join(srcDir, 'redis_lock.ts'),
    `
export class RedisLockManager {
  public async acquire(key: string, ttlMs: number): Promise<boolean> {
    return true;
  }

  public async release(key: string): Promise<void> {}
}
`
  );

  // payment.ts
  fs.writeFileSync(
    path.join(srcDir, 'payment.ts'),
    `
export class PaymentService {
  public async charge(amount: number): Promise<boolean> {
    return true;
  }
}
`
  );

  // webhook.test.ts
  fs.writeFileSync(
    path.join(testDir, 'webhook.test.ts'),
    `
import { WebhookHandler } from '../src/webhook';

describe("WebhookHandler", () => {
  it("rejects duplicate events", async () => {});
});
`
  );

  try {
    const indexer = new RepositoryIndexer();
    const indexResult = await indexer.indexRepository(tempDir, {
      repositoryId: 'payment-repo',
      workspaceSnapshotId: 'ws_snap_pay',
    });

    const graphBuilder = new GraphBuilder();
    const graph = graphBuilder.buildGraph(indexResult.units, { repoDir: tempDir });

    const agentEnv = createAgentEnvironment({
      agentProvider: 'claude-code',
      agentVersion: '1.0.0',
      model: 'claude-3-5-sonnet',
      harnessVersion: '0.1.0',
      availableTools: ['read_file'],
    });

    // Failing stack trace evidence from a test run
    const stackEvidence: StackTraceEvidence = {
      evidenceId: 'ev_stack_stripe',
      kind: TaskEvidenceKind.STACK_TRACE,
      timestamp: new Date().toISOString(),
      rawTrace: 'Error: Duplicate webhook lock collision\n    at EventDeduplicator.reserve (src/deduplicator.ts:8:11)',
      frames: [
        { file: 'src/deduplicator.ts', line: 8, functionName: 'reserve' }
      ]
    };

    const task = createTaskContext({
      taskId: 'task_stripe_duplicate',
      primaryPrompt: 'Fix duplicate Stripe webhook processing race condition in WebhookHandler',
      evidence: [stackEvidence],
      workspaceSnapshotId: 'ws_snap_pay',
      agentEnvironment: agentEnv,
    });

    // 1. Exact Retriever Direct Test
    console.log('--- 1. Exact Retriever ---');
    const exactRetriever = new ExactRetriever();
    const exactMatches = exactRetriever.retrieve(task, indexResult.units);
    assert(exactMatches.length > 0, `Found ${exactMatches.length} exact matches`);
    const foundWebhook = exactMatches.some(m => m.matchedToken === 'WebhookHandler');
    assert(foundWebhook, 'Exact match found "WebhookHandler"');

    // 2. Lexical Retriever Direct Test
    console.log('\n--- 2. Lexical Retriever ---');
    const lexicalRetriever = new LexicalRetriever();
    const lexicalMatches = lexicalRetriever.search(task, indexResult.units);
    assert(lexicalMatches.length > 0, `Found ${lexicalMatches.length} lexical matches`);
    assert(lexicalMatches[0].score > 0, 'Top lexical score is positive');

    // 3. Stack Trace Retriever Direct Test
    console.log('\n--- 3. Stack Trace Retriever ---');
    const stackRetriever = new StackTraceRetriever();
    const stackMatches = stackRetriever.retrieve(task, indexResult.units);
    assert(stackMatches.length > 0, `Found ${stackMatches.length} stack trace matches`);
    const matchedDeduplicator = stackMatches.some(m => m.matchedFrame.includes('deduplicator.ts'));
    assert(matchedDeduplicator, 'Stack trace retriever identified deduplicator.ts');

    // 4. CandidateGenerator Multi-Channel Fusion
    console.log('\n--- 4. Multi-Channel Candidate Generation ---');
    const generator = new CandidateGenerator();
    const candidates = generator.generateCandidates(task, indexResult.units, graph);

    assert(candidates.length > 0, `Generated ${candidates.length} candidates`);
    const sourcesAggregated = new Set(candidates.flatMap(c => c.retrievalSources));
    assert(sourcesAggregated.has('exact'), 'Candidates contain "exact" retrieval source');
    assert(sourcesAggregated.has('lexical'), 'Candidates contain "lexical" retrieval source');
    assert(sourcesAggregated.has('stack_trace'), 'Candidates contain "stack_trace" retrieval source');
    assert(sourcesAggregated.has('graph'), 'Candidates contain "graph" retrieval source');

    // 5. Candidate Recall Fixture Benchmark (Section 40)
    console.log('\n--- 5. Candidate Recall Fixture Benchmark ---');
    // Ground truth units that must be surfaced to solve this task:
    // 1. WebhookHandler class
    // 2. WebhookHandler.handleStripeWebhook method
    // 3. EventDeduplicator.reserve method
    // 4. RedisLockManager.acquire method (discovered via graph traversal from deduplicator!)
    // 5. webhook.test.ts
    const webhookClassUnit = indexResult.units.find(u => u.title === 'WebhookHandler')!;
    const handleMethodUnit = indexResult.units.find(u => u.title === 'WebhookHandler.handleStripeWebhook')!;
    const reserveMethodUnit = indexResult.units.find(u => u.title === 'EventDeduplicator.reserve')!;
    const acquireMethodUnit = indexResult.units.find(u => u.title === 'RedisLockManager.acquire')!;
    const testUnit = indexResult.units.find(u => u.kind === ContextUnitKind.TEST)!;

    const groundTruthIds = [
      webhookClassUnit.id,
      handleMethodUnit.id,
      reserveMethodUnit.id,
      acquireMethodUnit.id,
      testUnit.id,
    ];

    const recallMetrics = generator.evaluateRecall(candidates, groundTruthIds);

    console.log(`  ➔ Recall@20:  ${(recallMetrics.recallAt20 * 100).toFixed(1)}%`);
    console.log(`  ➔ Recall@50:  ${(recallMetrics.recallAt50 * 100).toFixed(1)}%`);
    console.log(`  ➔ Recall@100: ${(recallMetrics.recallAt100 * 100).toFixed(1)}%`);
    console.log(`  ➔ Recall@200: ${(recallMetrics.recallAt200 * 100).toFixed(1)}%`);

    assert(recallMetrics.recallAt20 >= 0.80, `Recall@20 is >= 80% (got ${recallMetrics.recallAt20})`);
    assert(recallMetrics.recallAt50 === 1.0, `Recall@50 is 100% (got ${recallMetrics.recallAt50})`);

    // Verify RedisLockManager.acquire was retrieved via graph traversal
    const acquireCandidate = candidates.find(c => c.contextUnitId === acquireMethodUnit.id);
    assert(acquireCandidate !== undefined, 'RedisLockManager.acquire candidate was retrieved');
    assert(acquireCandidate!.retrievalSources.includes('graph'), 'RedisLockManager.acquire was discovered via graph channel');

    console.log('\n🎉 All Candidate Discovery & Recall Benchmark tests passed successfully!');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

runCandidateDiscoveryTests().catch((err) => {
  console.error('❌ Candidate discovery test failed:', err);
  process.exit(1);
});
