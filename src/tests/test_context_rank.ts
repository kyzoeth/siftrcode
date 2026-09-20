/**
 * SiftrCode V2 - ContextRank Tests (Phase 12)
 */

import { strict as assert } from 'assert';
import { ContextRanker } from '../ranking/context_rank';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { ContextUnitKind } from '../context/context_unit';

console.log('🧪 Testing ContextRank Candidate Ranker (Phase 12)...\n');

// 1. Setup Feature Scenarios
const featureStackTraceTarget: ContextFeaturesV1 = {
  schemaVersion: 'v1',
  contextUnitId: 'unit_webhook_handler',
  unitKind: ContextUnitKind.CODE_SYMBOL,
  tokenEstimate: 50,
  isTest: false,
  isConfig: false,
  isDocumentation: false,
  isSchema: false,
  isExported: true,
  exactSymbolMatch: true,
  exactPathMatch: true,
  bm25Score: 8.0,
  tokenOverlapRatio: 0.9,
  graphDegree: 4,
  minDistanceToSeed: 0,
  minDistanceToErrorFrame: 0,
  isDirectDependency: false,
  isDirectDependent: false,
  changeFrequency: 5,
  recentChangeFrequency: 3,
  maxCoChangeWithSeeds: 1.0,
  inStackTrace: true,
  isFailingTestTarget: true,
  inCompilerError: false,
  inDirtyDiff: true,
  heuristicScore: 120,
};

const featureCoChangeNeighbor: ContextFeaturesV1 = {
  schemaVersion: 'v1',
  contextUnitId: 'unit_redis_lock',
  unitKind: ContextUnitKind.CODE_SYMBOL,
  tokenEstimate: 30,
  isTest: false,
  isConfig: false,
  isDocumentation: false,
  isSchema: false,
  isExported: true,
  exactSymbolMatch: false,
  exactPathMatch: false,
  bm25Score: 2.0,
  tokenOverlapRatio: 0.3,
  graphDegree: 2,
  minDistanceToSeed: 1,
  minDistanceToErrorFrame: 1,
  isDirectDependency: true,
  isDirectDependent: false,
  changeFrequency: 4,
  recentChangeFrequency: 2,
  maxCoChangeWithSeeds: 0.85,
  inStackTrace: false,
  isFailingTestTarget: false,
  inCompilerError: false,
  inDirtyDiff: false,
  heuristicScore: 50,
};

const featureUnrelatedLockfile: ContextFeaturesV1 = {
  schemaVersion: 'v1',
  contextUnitId: 'unit_package_lock',
  unitKind: ContextUnitKind.LOCKFILE,
  tokenEstimate: 500,
  isTest: false,
  isConfig: false,
  isDocumentation: false,
  isSchema: false,
  isExported: false,
  exactSymbolMatch: false,
  exactPathMatch: false,
  bm25Score: 0.1,
  tokenOverlapRatio: 0.05,
  graphDegree: 0,
  minDistanceToSeed: null,
  minDistanceToErrorFrame: null,
  isDirectDependency: false,
  isDirectDependent: false,
  changeFrequency: 10,
  recentChangeFrequency: 1,
  maxCoChangeWithSeeds: 0.0,
  inStackTrace: false,
  isFailingTestTarget: false,
  inCompilerError: false,
  inDirtyDiff: false,
  heuristicScore: -10,
};

const featureUnrelatedTest: ContextFeaturesV1 = {
  schemaVersion: 'v1',
  contextUnitId: 'unit_user_test',
  unitKind: ContextUnitKind.TEST,
  tokenEstimate: 40,
  isTest: true,
  isConfig: false,
  isDocumentation: false,
  isSchema: false,
  isExported: false,
  exactSymbolMatch: false,
  exactPathMatch: false,
  bm25Score: 0.5,
  tokenOverlapRatio: 0.1,
  graphDegree: 1,
  minDistanceToSeed: null,
  minDistanceToErrorFrame: null,
  isDirectDependency: false,
  isDirectDependent: false,
  changeFrequency: 1,
  recentChangeFrequency: 0,
  maxCoChangeWithSeeds: 0.0,
  inStackTrace: false,
  isFailingTestTarget: false,
  inCompilerError: false,
  inDirtyDiff: false,
  heuristicScore: 0,
};

// --- Test 1: Transparent Ranking & Explainable Reasons ---
console.log('--- 1. Transparent Ranking & Explainable Reasons ---');
const ranker = new ContextRanker();
const ranked = ranker.rank([
  featureUnrelatedLockfile,
  featureCoChangeNeighbor,
  featureStackTraceTarget,
  featureUnrelatedTest,
]);

assert.equal(ranked.length, 4);
assert.equal(ranked[0].contextUnitId, 'unit_webhook_handler');
assert.equal(ranked[0].rank, 1);
assert.ok(ranked[0].finalScore > 100);
assert.ok(ranked[0].reasons.some((r) => r.includes('present_in_runtime_stack_trace')));
assert.ok(ranked[0].reasons.some((r) => r.includes('exact_symbol_name_match')));
console.log(`  ✔ Rank 1 is WebhookHandler (score: ${ranked[0].finalScore}) with full reason breakdown`);

assert.equal(ranked[1].contextUnitId, 'unit_redis_lock');
assert.equal(ranked[1].rank, 2);
assert.ok(ranked[1].reasons.some((r) => r.includes('graph_direct_neighbor')));
assert.ok(ranked[1].reasons.some((r) => r.includes('historical_git_co_change')));
console.log(`  ✔ Rank 2 is RedisLock (score: ${ranked[1].finalScore}) with graph proximity & co-change`);

// --- Test 2: Penalties for Generated Artifacts ---
console.log('\n--- 2. Penalty Application on Lockfile & Unrelated Test ---');
assert.equal(ranked[3].contextUnitId, 'unit_package_lock');
assert.ok(ranked[3].scoreBreakdown.penalties < 0);
assert.ok(ranked[3].reasons.some((r) => r.includes('lockfile_penalty')));
console.log(`  ✔ Lockfile received penalty of ${ranked[3].scoreBreakdown.penalties} and demoted to last place`);

assert.ok(ranked[2].reasons.some((r) => r.includes('unrelated_test_penalty')));
console.log('  ✔ Unrelated test file penalized and demoted');

// --- Test 3: Score Breakdown Structure ---
console.log('\n--- 3. Score Breakdown Invariants ---');
const topBreakdown = ranked[0].scoreBreakdown;
assert.ok(topBreakdown.runtimeEvidence > 0);
assert.ok(topBreakdown.exactMatch > 0);
assert.ok(topBreakdown.lexicalRelevance > 0);
assert.equal(topBreakdown.penalties, 0);
console.log('  ✔ Score breakdown attributes scores cleanly to component channels');

// --- Test 4: Determinism ---
console.log('\n--- 4. Deterministic Ranking & Tie Breaking ---');
const r1 = ranker.rank([featureCoChangeNeighbor, featureStackTraceTarget]);
const r2 = ranker.rank([featureStackTraceTarget, featureCoChangeNeighbor]);
assert.deepEqual(r1, r2);
console.log('  ✔ Ranking output is strictly independent of input candidate order');

console.log('\n🎉 All ContextRank Candidate Ranker tests passed successfully!');
