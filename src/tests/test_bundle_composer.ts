/**
 * SiftrCode V2 - BundleComposer Tests (Phase 13)
 */

import { strict as assert } from 'assert';
import { BundleComposer } from '../context/bundle_composer';
import { RankedCandidate } from '../ranking/context_rank';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { ContextUnit, ContextUnitKind } from '../context/context_unit';
import { ContextGraph, EdgeKind } from '../graph/context_graph';
import { TaskEvidenceKind, StackTraceEvidence } from '../context/task_evidence';
import { TrustLevel } from '../security/trust';

console.log('🧪 Testing BundleComposer Submodular Synergy (Phase 13)...\n');

// 1. Setup Units
const unitsMap = new Map<string, ContextUnit>();

const unitWebhook: ContextUnit = {
  id: 'unit_webhook',
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: 'snap_w0',
  path: 'src/webhook.ts',
  title: 'WebhookHandler',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: { tokenEstimate: 100 },
};
unitsMap.set(unitWebhook.id, unitWebhook);

const unitLock: ContextUnit = {
  id: 'unit_lock',
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: 'snap_w0',
  path: 'src/lock.ts',
  title: 'RedisLock',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: { tokenEstimate: 50 },
};
unitsMap.set(unitLock.id, unitLock);

const unitHelper1: ContextUnit = {
  id: 'unit_h1',
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: 'snap_w0',
  path: 'src/webhook.ts',
  title: 'helper1',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: { tokenEstimate: 20 },
};
unitsMap.set(unitHelper1.id, unitHelper1);

const unitHelper2: ContextUnit = {
  id: 'unit_h2',
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: 'snap_w0',
  path: 'src/webhook.ts',
  title: 'helper2',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: { tokenEstimate: 20 },
};
unitsMap.set(unitHelper2.id, unitHelper2);

const unitHelper3: ContextUnit = {
  id: 'unit_h3',
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: 'snap_w0',
  path: 'src/webhook.ts',
  title: 'helper3',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: { tokenEstimate: 20 },
};
unitsMap.set(unitHelper3.id, unitHelper3);

// 2. Setup ContextGraph
const graph = new ContextGraph();
graph.addNode({ contextUnitId: unitWebhook.id, kind: unitWebhook.kind, workspaceSnapshotId: 'snap_w0', metadata: { path: 'src/webhook.ts' } });
graph.addNode({ contextUnitId: unitLock.id, kind: unitLock.kind, workspaceSnapshotId: 'snap_w0', metadata: { path: 'src/lock.ts' } });
graph.addEdge({
  from: unitWebhook.id,
  to: unitLock.id,
  kind: EdgeKind.CALLS,
  confidence: 1.0,
  source: 'tree-sitter',
});

// 3. Setup Evidence
const stackEvidence: StackTraceEvidence = {
  evidenceId: 'ev_st',
  kind: TaskEvidenceKind.STACK_TRACE,
  timestamp: '2026-01-01T00:00:00Z',
  rawTrace: 'at WebhookHandler in src/webhook.ts',
  frames: [{ file: 'src/webhook.ts', line: 10 }],
};

// 4. Setup Ranked Candidates
function makeMockCandidate(id: string, score: number, tokens: number): RankedCandidate {
  const f: ContextFeaturesV1 = {
    schemaVersion: 'v1',
    contextUnitId: id,
    unitKind: ContextUnitKind.CODE_SYMBOL,
    tokenEstimate: tokens,
    isTest: false,
    isConfig: false,
    isDocumentation: false,
    isSchema: false,
    isExported: true,
    exactSymbolMatch: false,
    exactPathMatch: false,
    bm25Score: 1,
    tokenOverlapRatio: 0.5,
    graphDegree: 1,
    minDistanceToSeed: 1,
    minDistanceToErrorFrame: 1,
    isDirectDependency: false,
    isDirectDependent: false,
    changeFrequency: 1,
    recentChangeFrequency: 1,
    maxCoChangeWithSeeds: 0,
    inStackTrace: id === 'unit_webhook',
    isFailingTestTarget: false,
    inCompilerError: false,
    inDirtyDiff: false,
    heuristicScore: score,
  };
  return {
    contextUnitId: id,
    finalScore: score,
    rank: 1,
    scoreBreakdown: { runtimeEvidence: 0, exactMatch: 0, lexicalRelevance: 0, graphProximity: 0, gitCoChange: 0, penalties: 0 },
    reasons: [],
    features: f,
  };
}

const candWebhook = makeMockCandidate('unit_webhook', 100, 100);
const candLock = makeMockCandidate('unit_lock', 40, 50);
const candH1 = makeMockCandidate('unit_h1', 30, 20);
const candH2 = makeMockCandidate('unit_h2', 25, 20);
const candH3 = makeMockCandidate('unit_h3', 20, 20);

// --- Test 1: Evidence Coverage & Submodular Ordering ---
console.log('--- 1. Evidence Coverage & Submodular Synergy ---');
const composer = new BundleComposer();
const bundle = composer.compose({
  rankedCandidates: [candLock, candWebhook, candH1, candH2, candH3],
  units: unitsMap,
  graph,
  evidence: [stackEvidence],
});

assert.ok(bundle.selectedUnitIds.includes('unit_webhook'));
assert.equal(bundle.selectionOrder[0].contextUnitId, 'unit_webhook');
assert.ok(bundle.selectionOrder[0].reasons.some((r) => r.includes('uncovered_evidence_target')));
console.log('  ✔ Step 1 selected WebhookHandler due to uncovered stack trace evidence target');

assert.ok(bundle.selectedUnitIds.includes('unit_lock'));
assert.equal(bundle.selectionOrder[1].contextUnitId, 'unit_lock');
assert.ok(bundle.selectionOrder[1].reasons.some((r) => r.includes('direct_graph_synergy')));
console.log('  ✔ Step 2 selected RedisLock via direct graph synergy with WebhookHandler');

assert.equal(bundle.evidenceCoverageRatio, 1.0);
console.log('  ✔ Evidence coverage ratio is 100%');

// --- Test 2: Redundancy Suppression ---
console.log('\n--- 2. Redundancy Suppression on Same-File Symbols ---');
const lastSelections = bundle.selectionOrder.slice(2);
const h3Step = lastSelections.find((s) => s.contextUnitId === 'unit_h3');
if (h3Step) {
  assert.ok(h3Step.reasons.some((r) => r.includes('file_saturation_redundancy')));
  console.log('  ✔ 4th symbol from webhook.ts received file_saturation_redundancy penalty');
}

// --- Test 3: Budget Constraint Enforcement ---
console.log('\n--- 3. Budget Limit Enforcement ---');
const constrainedComposer = new BundleComposer({ maxTokens: 120 }); // Can fit webhook (100) but not lock (50)
const budgetBundle = constrainedComposer.compose({
  rankedCandidates: [candWebhook, candLock],
  units: unitsMap,
  graph,
  evidence: [stackEvidence],
});

assert.equal(budgetBundle.selectedUnitIds.length, 1);
assert.equal(budgetBundle.selectedUnitIds[0], 'unit_webhook');
assert.ok(budgetBundle.totalTokens <= 120);
console.log(`  ✔ Budget strictly respected (used ${budgetBundle.totalTokens} tokens <= 120)`);

console.log('\n🎉 All BundleComposer tests passed successfully!');
