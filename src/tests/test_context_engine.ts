/**
 * SiftrCode V2 - ContextEngine End-to-End Tests (Phase 16)
 */

import { strict as assert } from 'assert';
import { ContextEngine } from '../engine/context_engine';
import { ContextPlan } from '../engine/context_plan';
import { ContextUnit, ContextUnitKind, SymbolKind, generateSymbolUnitId } from '../context/context_unit';
import { ContextGraph, EdgeKind } from '../graph/context_graph';
import { createTaskContext } from '../context/task_context';
import { TaskEvidenceKind, StackTraceEvidence } from '../context/task_evidence';
import { createAgentEnvironment } from '../agents/agent_environment';
import { createDefaultDataRights } from '../rights/data_rights';
import { ClaudeCodeAdapter } from '../agents/agent_adapter';
import { ContextResolution } from '../context/context_resolution';
import { TrustLevel } from '../security/trust';
import { createWorkspaceSnapshot } from '../workspace/workspace_snapshot';

console.log('🧪 Testing ContextEngine End-to-End Pipeline (Phase 16)...\n');

// 1. Setup Realistic Units
const repoId = 'repo_e2e';
const snapshot = createWorkspaceSnapshot({
  repositories: [
    {
      repositoryId: repoId,
      baseCommitSha: 'commit_e2e',
      trackedTreeHash: 'tree_e2e',
      dirtyPatchHash: 'clean',
    },
  ],
});
const snapshotId = snapshot.workspaceSnapshotId;

const unitWebhook: ContextUnit = {
  id: generateSymbolUnitId(repoId, 'src/webhook.ts', 'WebhookHandler', SymbolKind.CLASS),
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: snapshotId,
  path: 'src/webhook.ts',
  title: 'WebhookHandler',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: {
    name: 'WebhookHandler',
    isExported: true,
    content: `export class WebhookHandler {
  private dedupe: EventDeduplicator;

  constructor() {
    this.dedupe = new EventDeduplicator();
  }

  public async process(event: { id: string; payload: unknown }): Promise<void> {
    const isNew = await this.dedupe.check(event.id);
    if (!isNew) {
      return;
    }
    await this.handleEvent(event);
  }

  private async handleEvent(event: unknown): Promise<void> {
    // Process business logic
  }
}`,
    tokenEstimate: 120,
  },
};

const unitDedupe: ContextUnit = {
  id: generateSymbolUnitId(repoId, 'src/deduplicator.ts', 'EventDeduplicator', SymbolKind.CLASS),
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: snapshotId,
  path: 'src/deduplicator.ts',
  title: 'EventDeduplicator',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: {
    name: 'EventDeduplicator',
    isExported: true,
    content: `import { RedisLockManager } from './lock';

export class EventDeduplicator {
  private lock: RedisLockManager;

  constructor() {
    this.lock = new RedisLockManager();
  }

  public async check(eventId: string): Promise<boolean> {
    const acquired = await this.lock.acquire(eventId);
    if (!acquired) {
      return false;
    }
    return true;
  }
}`,
    tokenEstimate: 90,
  },
};

const unitLock: ContextUnit = {
  id: generateSymbolUnitId(repoId, 'src/lock.ts', 'RedisLockManager', SymbolKind.CLASS),
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: snapshotId,
  path: 'src/lock.ts',
  title: 'RedisLockManager',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: {
    name: 'RedisLockManager',
    isExported: true,
    content: `export class RedisLockManager {
  public async acquire(key: string): Promise<boolean> {
    // Distributed Redis atomic lock acquisition
    return true;
  }

  public async release(key: string): Promise<void> {
    // Release key
  }
}`,
    tokenEstimate: 80,
  },
};

const unitConfig: ContextUnit = {
  id: 'unit_tsconfig',
  kind: ContextUnitKind.CONFIG,
  workspaceSnapshotId: snapshotId,
  path: 'tsconfig.json',
  title: 'tsconfig.json',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CONFIGURATION,
  metadata: {
    content: '{\n  "compilerOptions": {\n    "target": "ES2022"\n  }\n}',
    tokenEstimate: 20,
  },
};

const unitUnrelatedDoc: ContextUnit = {
  id: 'unit_readme',
  kind: ContextUnitKind.DOCUMENTATION,
  workspaceSnapshotId: snapshotId,
  path: 'README.md',
  title: 'README.md',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_DOCUMENTATION,
  metadata: {
    content: '# Project Documentation\nAll about setup and deployments.',
    tokenEstimate: 40,
  },
};

const allUnits = [unitWebhook, unitDedupe, unitLock, unitConfig, unitUnrelatedDoc];

// 2. Setup ContextGraph Relationships
const graph = new ContextGraph();
for (const u of allUnits) {
  graph.addNode({
    contextUnitId: u.id,
    kind: u.kind,
    workspaceSnapshotId: snapshotId,
    metadata: { path: u.path },
  });
}

graph.addEdge({
  from: unitWebhook.id,
  to: unitDedupe.id,
  kind: EdgeKind.CALLS,
  confidence: 1.0,
  source: 'tree-sitter',
});

graph.addEdge({
  from: unitDedupe.id,
  to: unitLock.id,
  kind: EdgeKind.CALLS,
  confidence: 1.0,
  source: 'tree-sitter',
});

// 3. Setup Task Context with Stack Trace
const env = createAgentEnvironment({
  agentProvider: 'anthropic',
  agentVersion: '1.0',
  model: 'claude-3-7-sonnet',
  harnessVersion: '1.0',
  availableTools: ['View', 'Edit', 'Bash'],
});

const stackEvidence: StackTraceEvidence = {
  evidenceId: 'ev_e2e_stack',
  kind: TaskEvidenceKind.STACK_TRACE,
  timestamp: '2026-01-01T00:00:00Z',
  rawTrace: 'Error: Duplicate event processed concurrently at WebhookHandler.process (src/webhook.ts:15)',
  frames: [{ file: 'src/webhook.ts', line: 15, functionName: 'WebhookHandler.process' }],
};

const task = createTaskContext({
  sessionId: 'sess_e2e_test',
  primaryPrompt: 'Fix race condition in WebhookHandler duplicate event processing',
  evidence: [stackEvidence],
  workspaceSnapshotId: snapshotId,
  agentEnvironment: env,
});

// --- Test 1: Full Pipeline Execution ---
console.log('--- 1. End-to-End ContextEngine Execution ---');
const engine = new ContextEngine({
  adapter: new ClaudeCodeAdapter(),
  budgetProfile: 'BALANCED',
  dirtyPaths: ['src/webhook.ts'],
});

const plan: ContextPlan = engine.generatePlan({
  task,
  units: allUnits,
  graph,
  snapshot,
});

assert.ok(plan.planId.startsWith('cplan_'));
assert.equal(plan.taskId, task.taskId);
console.log(`  ✔ Generated ContextPlan: ${plan.planId}`);

// --- Test 2: Invariant Check on Allocated Units ---
console.log('\n--- 2. Allocated Units & Safety Invariants ---');
assert.ok(plan.units.length > 0);

// WebhookHandler must be present at FULL or BODY resolution (edit target invariant!)
const webhookPlanned = plan.units.find((u) => u.contextUnitId === unitWebhook.id);
assert.ok(webhookPlanned !== undefined, 'WebhookHandler must be selected');
assert.ok(
  webhookPlanned!.resolution === ContextResolution.FULL ||
  webhookPlanned!.resolution === ContextResolution.BODY,
  'WebhookHandler must have FULL or BODY resolution'
);
assert.ok(webhookPlanned!.content?.includes('public async process'));
console.log(`  ✔ Critical Edit Target WebhookHandler preserved at resolution: ${webhookPlanned!.resolution}`);

// Deduplicator / RedisLock should be included via graph synergy
const dedupePlanned = plan.units.find((u) => u.contextUnitId === unitDedupe.id);
assert.ok(dedupePlanned !== undefined, 'EventDeduplicator must be included via graph synergy');
console.log(`  ✔ EventDeduplicator included with resolution: ${dedupePlanned!.resolution}`);

// --- Test 3: AST Skeletonization of Dependencies ---
console.log('\n--- 3. Materialized AST Skeletonization ---');
const lockPlanned = plan.units.find((u) => u.contextUnitId === unitLock.id);
if (lockPlanned && lockPlanned.resolution === ContextResolution.SKELETON) {
  assert.ok(lockPlanned.content?.includes('export class RedisLockManager'));
  console.log('  ✔ Distant dependency RedisLockManager materialized as AST skeleton');
}

// --- Test 4: Formatted Context for Claude Code ---
console.log('\n--- 4. Agent Context Formatting ---');
assert.ok(plan.formattedContext.promptText.includes('Fix race condition in WebhookHandler'));
assert.ok(plan.formattedContext.promptText.includes('<context_unit'));
assert.ok(plan.formattedContext.tokenEstimate > 0);
console.log(`  ✔ Agent context formatted with valid XML boundaries (~${plan.formattedContext.tokenEstimate} tokens)`);

// --- Test 5: Exposure Decisions & Data Rights ---
console.log('\n--- 5. Exposure Decisions & Telemetry Invariants ---');
assert.ok(plan.exposureDecisions.length >= allUnits.length);

const webhookDecision = plan.exposureDecisions.find((d) => d.contextUnitId === unitWebhook.id);
assert.ok(webhookDecision !== undefined);
assert.ok(webhookDecision!.exposureResolution > 0);

const readmeDecision = plan.exposureDecisions.find((d) => d.contextUnitId === unitUnrelatedDoc.id);
assert.ok(readmeDecision !== undefined);
// If README was not selected, it must have OMIT (0)
if (!plan.units.some((u) => u.contextUnitId === unitUnrelatedDoc.id)) {
  assert.equal(readmeDecision!.exposureResolution, ContextResolution.OMIT);
  console.log('  ✔ Unselected README marked as OMIT in exposure decisions');
}

assert.equal(plan.dataRights.trainingAllowed, false);
console.log('  ✔ DataRights attached (privacy-by-default trainingAllowed: false)');

// --- Test 6: Token and Economic Cost Savings ---
console.log('\n--- 6. Economic Cost Optimization ---');
assert.ok(plan.budgetPlan.rawTotalTokens > 0);
assert.ok(plan.budgetPlan.totalTokens <= plan.budgetPlan.rawTotalTokens);
console.log(`  ➔ Raw Tokens:      ${plan.budgetPlan.rawTotalTokens}`);
console.log(`  ➔ Allocated Tokens:${plan.budgetPlan.totalTokens}`);
console.log(`  ➔ Savings:         ${plan.budgetPlan.savingsPercentage}%`);
console.log(`  ➔ Estimated Cost:  $${plan.budgetPlan.estimatedCostUSD}`);

console.log('\n🎉 All ContextEngine End-to-End tests passed successfully!');
