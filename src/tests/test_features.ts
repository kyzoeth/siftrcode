/**
 * SiftrCode V2 - Versioned Features (ContextFeaturesV1) Tests (Phase 10)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { strict as assert } from 'assert';
import { FeatureBuilderV1 } from '../ranking/feature_builder';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { ContextUnit, ContextUnitKind, SymbolKind, generateSymbolUnitId } from '../context/context_unit';
import { Candidate } from '../retrieval/candidate';
import { createTaskContext } from '../context/task_context';
import { TaskEvidenceKind, StackTraceEvidence } from '../context/task_evidence';
import { createAgentEnvironment } from '../agents/agent_environment';
import { ContextGraph, EdgeKind } from '../graph/context_graph';
import { GitGraphIntelligence } from '../graph/git_graph';
import { createFeatureCutoff } from '../learning/point_in_time_features';
import { TrustLevel } from '../security/trust';

function makeCommitWithDate(repoDir: string, dateIso: string, msg: string): void {
  execSync(`git commit --allow-empty -m "${msg}"`, {
    cwd: repoDir,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: dateIso,
      GIT_COMMITTER_DATE: dateIso,
    },
  });
}

async function runFeatureTests() {
  console.log('🧪 Testing Versioned Features & FeatureBuilderV1 (Phase 10)...\n');

  // Setup temporary git repo for git intelligence testing
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-test-features-'));
  execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
  execSync('git config user.name "Test Dev"', { cwd: tempDir, stdio: 'ignore' });
  execSync('git config user.email "dev@test.com"', { cwd: tempDir, stdio: 'ignore' });

  const d1 = '2026-01-01T12:00:00Z';
  const d2 = '2026-01-02T12:00:00Z';
  const dCutoff = '2026-01-05T12:00:00Z';
  const dFuture = '2026-01-10T12:00:00Z';

  fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'src/webhook.ts'), 'export class WebhookHandler {}\n');
  fs.writeFileSync(path.join(tempDir, 'src/lock.ts'), 'export class RedisLock {}\n');
  execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
  makeCommitWithDate(tempDir, d1, 'init webhook and lock');

  fs.appendFileSync(path.join(tempDir, 'src/webhook.ts'), '// update 2\n');
  fs.appendFileSync(path.join(tempDir, 'src/lock.ts'), '// update 2\n');
  execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
  makeCommitWithDate(tempDir, d2, 'co-change 2');

  // Future commit after cutoff
  fs.writeFileSync(path.join(tempDir, 'README.md'), '# Documentation\n');
  fs.appendFileSync(path.join(tempDir, 'src/webhook.ts'), '// update 3\n');
  execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
  makeCommitWithDate(tempDir, dFuture, 'future commit');

  const gitIntelligence = new GitGraphIntelligence({ repoDir: tempDir });

  // 1. Setup Test Units
  const repoId = 'repo_test';
  const snapshotId = 'snap_w0';

  const unitWebhook: ContextUnit = {
    id: generateSymbolUnitId(repoId, 'src/webhook.ts', 'WebhookHandler', SymbolKind.CLASS),
    repositoryId: repoId,
    kind: ContextUnitKind.CODE_SYMBOL,
    workspaceSnapshotId: snapshotId,
    path: 'src/webhook.ts',
    title: 'WebhookHandler',
    provenance: { sourceType: 'file' },
    trustLevel: TrustLevel.FIRST_PARTY_CODE,
    metadata: {
      name: 'WebhookHandler',
      isExported: true,
      content: 'export class WebhookHandler { async process() {} }',
      path: 'src/webhook.ts',
    },
  };

  const unitLock: ContextUnit = {
    id: generateSymbolUnitId(repoId, 'src/lock.ts', 'RedisLock', SymbolKind.CLASS),
    repositoryId: repoId,
    kind: ContextUnitKind.CODE_SYMBOL,
    workspaceSnapshotId: snapshotId,
    path: 'src/lock.ts',
    title: 'RedisLock',
    provenance: { sourceType: 'file' },
    trustLevel: TrustLevel.FIRST_PARTY_CODE,
    metadata: {
      name: 'RedisLock',
      isExported: true,
      content: 'export class RedisLock { acquire() {} }',
      path: 'src/lock.ts',
    },
  };

  const unitDoc: ContextUnit = {
    id: 'unit_readme',
    repositoryId: repoId,
    kind: ContextUnitKind.DOCUMENTATION,
    workspaceSnapshotId: snapshotId,
    path: 'README.md',
    title: 'README.md',
    provenance: { sourceType: 'file' },
    trustLevel: TrustLevel.FIRST_PARTY_DOCUMENTATION,
    metadata: {
      content: '# Documentation\nUnrelated guide.',
      path: 'README.md',
    },
  };

  // 2. Setup Graph with dependencies
  const graph = new ContextGraph();
  graph.addNode({ contextUnitId: unitWebhook.id, kind: unitWebhook.kind, workspaceSnapshotId: snapshotId, metadata: { path: 'src/webhook.ts' } });
  graph.addNode({ contextUnitId: unitLock.id, kind: unitLock.kind, workspaceSnapshotId: snapshotId, metadata: { path: 'src/lock.ts' } });
  graph.addNode({ contextUnitId: unitDoc.id, kind: unitDoc.kind, workspaceSnapshotId: snapshotId, metadata: { path: 'README.md' } });

  graph.addEdge({
    from: unitWebhook.id,
    to: unitLock.id,
    kind: EdgeKind.IMPORTS,
    confidence: 1.0,
    source: 'compiler',
  });

  // 3. Setup Task Context with Stack Trace Evidence
  const env = createAgentEnvironment({
    agentProvider: 'anthropic',
    agentVersion: '1.0',
    model: 'claude-3-7-sonnet',
    harnessVersion: '1.0',
    availableTools: ['edit', 'bash'],
  });

  const stackEvidence: StackTraceEvidence = {
    evidenceId: 'ev_stack_01',
    kind: TaskEvidenceKind.STACK_TRACE,
    timestamp: '2026-01-05T00:00:00Z',
    rawTrace: 'Error at WebhookHandler.process (src/webhook.ts:12)',
    frames: [{ file: 'src/webhook.ts', line: 12, functionName: 'WebhookHandler.process' }],
  };

  const task = createTaskContext({
    primaryPrompt: 'Fix race condition in WebhookHandler',
    evidence: [stackEvidence],
    workspaceSnapshotId: snapshotId,
    agentEnvironment: env,
  });

  const cutoff = createFeatureCutoff({
    timestamp: dCutoff,
    workspaceSnapshotId: snapshotId,
  });

  // --- Test 1: Feature Schema & Extraction for Error Target ---
  console.log('--- 1. Feature Schema & Runtime Evidence Extraction ---');
  const candWebhook: Candidate = {
    contextUnitId: unitWebhook.id,
    exactMatch: true,
    testRelationship: false,
    runtimeEvidenceMatch: true,
    retrievalSources: ['exact', 'stack_trace'],
    lexicalScore: 10.0,
  };

  const featuresWebhook = FeatureBuilderV1.buildFeatures({
    candidate: candWebhook,
    unit: unitWebhook,
    task,
    graph,
    gitIntelligence,
    featureCutoff: cutoff,
    seedUnitIds: [unitWebhook.id],
    dirtyPaths: ['src/webhook.ts'],
  });

  assert.equal(featuresWebhook.schemaVersion, 'v1');
  assert.equal(featuresWebhook.contextUnitId, unitWebhook.id);
  assert.equal(featuresWebhook.inStackTrace, true);
  assert.equal(featuresWebhook.inDirtyDiff, true);
  assert.equal(featuresWebhook.exactSymbolMatch, true);
  assert.ok(featuresWebhook.heuristicScore > 50, `Expected high heuristic score, got ${featuresWebhook.heuristicScore}`);
  console.log(`  ✔ Webhook features extract runtime evidence and high priority (${featuresWebhook.heuristicScore})`);

  // --- Test 2: Graph Proximity & Git Co-Change on Dependent Unit ---
  console.log('\n--- 2. Graph Proximity & Point-in-Time Git Co-Change ---');
  const candLock: Candidate = {
    contextUnitId: unitLock.id,
    exactMatch: false,
    testRelationship: false,
    runtimeEvidenceMatch: false,
    retrievalSources: ['graph'],
    lexicalScore: 5.0,
  };

  const featuresLock = FeatureBuilderV1.buildFeatures({
    candidate: candLock,
    unit: unitLock,
    task,
    graph,
    gitIntelligence,
    featureCutoff: cutoff,
    seedUnitIds: [unitWebhook.id],
  });

  assert.equal(featuresLock.minDistanceToSeed, 1);
  assert.equal(featuresLock.minDistanceToErrorFrame, 1);
  // Co-change between webhook and lock at cutoff is 1.0 (both c1 and c2 touched both)
  assert.equal(featuresLock.maxCoChangeWithSeeds, 1.0);
  console.log('  ✔ Dependent RedisLock extracted 1-hop distance and 1.0 git co-change');

  // --- Test 3: Point-in-Time Cutoff Enforcement ---
  console.log('\n--- 3. Point-in-Time Cutoff Enforcement ---');
  const candDoc: Candidate = {
    contextUnitId: unitDoc.id,
    exactMatch: false,
    testRelationship: false,
    runtimeEvidenceMatch: false,
    retrievalSources: ['lexical'],
    lexicalScore: 1.0,
  };

  // With cutoff before future commit, README.md has 0 changes
  const featuresDocWithCutoff = FeatureBuilderV1.buildFeatures({
    candidate: candDoc,
    unit: unitDoc,
    task,
    graph,
    gitIntelligence,
    featureCutoff: cutoff,
    seedUnitIds: [unitWebhook.id],
  });

  assert.equal(featuresDocWithCutoff.changeFrequency, 0);
  assert.equal(featuresDocWithCutoff.maxCoChangeWithSeeds, 0);

  // Future cutoff allows future commit
  const futureCutoff = createFeatureCutoff({
    timestamp: '2026-01-20T00:00:00Z',
    workspaceSnapshotId: snapshotId,
  });
  const featuresDocFuture = FeatureBuilderV1.buildFeatures({
    candidate: candDoc,
    unit: unitDoc,
    task,
    graph,
    gitIntelligence,
    featureCutoff: futureCutoff,
    seedUnitIds: [unitWebhook.id],
  });

  assert.equal(featuresDocFuture.changeFrequency, 1);
  assert.ok(featuresDocFuture.maxCoChangeWithSeeds > 0);
  console.log('  ✔ Feature cutoff strictly prevents future git history from leaking into features');

  // --- Test 4: Determinism ---
  console.log('\n--- 4. Feature Extraction Determinism ---');
  const run1 = FeatureBuilderV1.buildFeatures({
    candidate: candWebhook,
    unit: unitWebhook,
    task,
    graph,
    gitIntelligence,
    featureCutoff: cutoff,
    seedUnitIds: [unitWebhook.id],
  });

  const run2 = FeatureBuilderV1.buildFeatures({
    candidate: candWebhook,
    unit: unitWebhook,
    task,
    graph,
    gitIntelligence,
    featureCutoff: cutoff,
    seedUnitIds: [unitWebhook.id],
  });

  assert.deepEqual(run1, run2);
  console.log('  ✔ Multiple runs yield bitwise identical feature representations');

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('\n🎉 All Versioned Features & FeatureBuilderV1 tests passed successfully!');
}

runFeatureTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
