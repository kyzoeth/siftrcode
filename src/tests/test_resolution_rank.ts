/**
 * SiftrCode V2 - ResolutionRank Tests (Phase 14)
 */

import { strict as assert } from 'assert';
import { ResolutionRanker } from '../context/resolution_rank';
import { ContextResolution } from '../context/context_resolution';
import { ContextUnit, ContextUnitKind } from '../context/context_unit';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { TrustLevel } from '../security/trust';

console.log('🧪 Testing ResolutionRank Variable Resolution Degradation (Phase 14)...\n');

const ranker = new ResolutionRanker();

function makeMockFeatures(overrides: Partial<ContextFeaturesV1> = {}): ContextFeaturesV1 {
  return {
    schemaVersion: 'v1',
    contextUnitId: 'u_test',
    unitKind: ContextUnitKind.CODE_SYMBOL,
    tokenEstimate: 200,
    isTest: false,
    isConfig: false,
    isDocumentation: false,
    isSchema: false,
    isExported: true,
    exactSymbolMatch: false,
    exactPathMatch: false,
    bm25Score: 1,
    tokenOverlapRatio: 0.2,
    graphDegree: 2,
    minDistanceToSeed: null,
    minDistanceToErrorFrame: null,
    isDirectDependency: false,
    isDirectDependent: false,
    changeFrequency: 1,
    recentChangeFrequency: 1,
    maxCoChangeWithSeeds: 0,
    inStackTrace: false,
    isFailingTestTarget: false,
    inCompilerError: false,
    inDirtyDiff: false,
    heuristicScore: 30,
    ...overrides,
  };
}

// --- Test 1: Critical Invariant: Edit & Error Target Protection ---
console.log('--- 1. Critical Invariant: Edit & Error Target Protection ---');
const unitTarget: ContextUnit = {
  id: 'unit_webhook',
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: 'snap_w0',
  path: 'src/webhook.ts',
  title: 'WebhookHandler',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: { tokenEstimate: 200 },
};

const featuresErrorTarget = makeMockFeatures({
  contextUnitId: 'unit_webhook',
  inStackTrace: true,
  inDirtyDiff: true,
});

const allocNormal = ranker.allocateResolution(unitTarget, featuresErrorTarget, true, 1.0);
assert.equal(allocNormal.resolution, ContextResolution.FULL);
assert.equal(allocNormal.tokenEstimate, 200);
assert.ok(allocNormal.justification.includes('edit_or_failure_target'));
console.log('  ✔ Edit target gets FULL resolution under standard budget');

const allocUnderPressure = ranker.allocateResolution(unitTarget, featuresErrorTarget, true, 2.0);
// Under extreme budget pressure, edit target receives BODY, never SKELETON
assert.ok(
  allocUnderPressure.resolution === ContextResolution.FULL ||
  allocUnderPressure.resolution === ContextResolution.BODY
);
assert.notEqual(allocUnderPressure.resolution, ContextResolution.SKELETON);
assert.notEqual(allocUnderPressure.resolution, ContextResolution.SIGNATURE);
assert.notEqual(allocUnderPressure.resolution, ContextResolution.NAME);
console.log('  ✔ Edit target is strictly protected from SKELETON degradation under high budget pressure');

// --- Test 2: Non-Skeletonizable Artifact Safety ---
console.log('\n--- 2. Non-Skeletonizable Artifact Safety ---');
const unitConfig: ContextUnit = {
  id: 'unit_tsconfig',
  kind: ContextUnitKind.CONFIG,
  workspaceSnapshotId: 'snap_w0',
  path: 'tsconfig.json',
  title: 'tsconfig.json',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CONFIGURATION,
  metadata: { tokenEstimate: 80 },
};

const allocConfigNormal = ranker.allocateResolution(unitConfig, makeMockFeatures({ unitKind: ContextUnitKind.CONFIG }), false, 1.0);
assert.equal(allocConfigNormal.resolution, ContextResolution.FULL);
console.log('  ✔ Config file retained in FULL under normal budget');

const allocConfigPressure = ranker.allocateResolution(unitConfig, makeMockFeatures({ unitKind: ContextUnitKind.CONFIG }), false, 1.5);
// Under budget pressure, degrades to NAME (never SKELETON)
assert.equal(allocConfigPressure.resolution, ContextResolution.NAME);
assert.notEqual(allocConfigPressure.resolution, ContextResolution.SKELETON);
console.log('  ✔ Config file degrades to NAME, strictly avoiding unsafe skeletonization');

// --- Test 3: Distant Dependencies (>= 2 hops) Degradation ---
console.log('\n--- 3. Distant Dependencies Degradation ---');
const unitDistant: ContextUnit = {
  id: 'unit_distant_util',
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: 'snap_w0',
  path: 'src/util/hash.ts',
  title: 'hashKey',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: { tokenEstimate: 100 },
};

const featuresDistant = makeMockFeatures({
  minDistanceToSeed: 2,
});

const allocDistant = ranker.allocateResolution(unitDistant, featuresDistant, false, 1.0);
assert.equal(allocDistant.resolution, ContextResolution.SKELETON);
assert.equal(allocDistant.tokenEstimate, 25); // ~25% of 100
console.log('  ✔ 2-hop distant dependency safely degraded to SKELETON (75% token reduction)');

const allocDistantHighPressure = ranker.allocateResolution(unitDistant, featuresDistant, false, 1.5);
assert.equal(allocDistantHighPressure.resolution, ContextResolution.SIGNATURE);
assert.equal(allocDistantHighPressure.tokenEstimate, 10); // ~10% of 100
console.log('  ✔ 2-hop distant dependency degraded to SIGNATURE under high budget pressure (90% reduction)');

// --- Test 4: Token Estimation Sanity ---
console.log('\n--- 4. Token Estimation Invariants ---');
assert.equal(ranker.estimateTokensForResolution(1000, ContextResolution.FULL), 1000);
assert.equal(ranker.estimateTokensForResolution(1000, ContextResolution.BODY), 750);
assert.equal(ranker.estimateTokensForResolution(1000, ContextResolution.SKELETON), 250);
assert.equal(ranker.estimateTokensForResolution(1000, ContextResolution.SIGNATURE), 100);
assert.equal(ranker.estimateTokensForResolution(1000, ContextResolution.NAME), 5);
assert.equal(ranker.estimateTokensForResolution(1000, ContextResolution.OMIT), 0);
console.log('  ✔ Token estimates correctly scaled across all resolution levels');

console.log('\n🎉 All ResolutionRank tests passed successfully!');
