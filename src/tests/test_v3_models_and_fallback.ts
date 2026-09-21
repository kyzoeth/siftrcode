/**
 * SiftrCode V3 - Test Suite: Model Artifacts, Safe Fallback & Shadow Mode
 *
 * Verifies:
 * 1. ModelArtifactV3 checksum verification and anti-tampering.
 * 2. Deterministic scoring and tie-breaking (finalScore DESC, contextUnitId ASC).
 * 3. Safe Fallback: Exception in learned ranker seamlessly falls back to V2 deterministic ranker.
 * 4. Safe Fallback: Non-finite score (NaN / Infinity) seamlessly falls back to V2.
 * 5. ShadowContextRanker guarantees 100% production plan invariance.
 */

import * as assert from 'assert';
import { TreeRanker } from '../learning/models/context_rank/tree_ranker';
import { LinearPairwiseRanker } from '../learning/models/context_rank/linear_pairwise_ranker';
import { ModelArtifactVerifier } from '../learning/models/context_rank/model_artifact';
import { SafeFallbackRanker, LearnedContextRanker } from '../learning/models/context_rank/learned_context_ranker';
import { ShadowContextRanker } from '../learning/models/context_rank/shadow_ranker';
import { ContextFeaturesV3_1 } from '../learning/features/feature_set_v3_1';

console.log('🧪 [Test Suite V3-Models & Fallback] Starting verification...\n');

// 1. Model Artifact Checksum & Anti-Tampering
console.log('--- 1. Model Artifact Checksum & Anti-Tampering ---');
const dummyTrees = [
  { featureIndex: 0, threshold: 0.5, leftValue: 0.1, rightValue: -0.1 },
];
const ranker = new TreeRanker('gbdt_test', {
  learningRate: 0.1,
  baseScore: 0.0,
  trees: dummyTrees,
  includeJev: true,
  featureIndices: [0],
});

const artifact = ranker.toArtifact({
  gitSha: '1eedac03b0d83025ebf08ed2945e0ab015c46f6a',
  datasetVersion: 'SIFTR_CONTEXT_DATASET_V1',
  trainSplitHash: 'hash_train',
  valSplitHash: 'hash_val',
  metrics: { trainNdcg10: 0.85, valNdcg10: 0.82 },
});

const verifyClean = ModelArtifactVerifier.verifyArtifact(artifact);
assert.strictEqual(verifyClean.valid, true, 'Clean artifact must pass verification');
console.log('  ✔ Clean model artifact passed checksum verification');

// Tamper with payload
const tamperedArtifact = {
  ...artifact,
  modelPayload: { ...artifact.modelPayload, learningRate: 99.9 },
};
const verifyTampered = ModelArtifactVerifier.verifyArtifact(tamperedArtifact as any);
assert.strictEqual(verifyTampered.valid, false, 'Tampered artifact must be rejected');
assert.ok(verifyTampered.errors.some((e) => e.includes('Checksum mismatch')), 'Must flag checksum mismatch');
console.log('  ✔ Tampered artifact strictly rejected by verifier');

// 2. Deterministic Tie-Breaking
console.log('\n--- 2. Deterministic Scoring & Tie-Breaking ---');
const featuresList: ContextFeaturesV3_1[] = [
  {
    schemaVersion: 'CONTEXT_RANK_FEATURES_V3_1',
    contextUnitId: 'cu_zebra',
    temporalCutoff: '2024-01-01T00:00:00.000Z',
    unitKind: 1 as any,
    tokenEstimate: 100,
    isTest: false,
    isConfig: false,
    isDocumentation: false,
    isSchema: false,
    isExported: true,
    exactSymbolMatch: false,
    exactPathMatch: false,
    bm25Score: 0,
    tokenOverlapRatio: 0,
    graphDegree: 0,
    minDistanceToSeed: null,
    minDistanceToErrorFrame: null,
    isDirectDependency: false,
    isDirectDependent: false,
    changeFrequency: 0,
    recentChangeFrequency: 0,
    maxCoChangeWithSeeds: 0,
    inStackTrace: false,
    isFailingTestTarget: false,
    inCompilerError: false,
    inDirtyDiff: false,
    fromExactRetrieval: false,
    fromLexicalRetrieval: false,
    fromGraphRetrieval: false,
    fromGitRetrieval: false,
    fromRuntimeRetrieval: false,
    heuristicScore: 10,
    hasJevSignals: false,
    semanticRelevanceProbability: null,
    implementationNeededProbability: null,
    likelyEditTargetProbability: null,
    likelyRootCauseProbability: null,
  },
  {
    schemaVersion: 'CONTEXT_RANK_FEATURES_V3_1',
    contextUnitId: 'cu_alpha', // Identical score to zebra, must win tie-break via alpha sort
    temporalCutoff: '2024-01-01T00:00:00.000Z',
    unitKind: 1 as any,
    tokenEstimate: 100,
    isTest: false,
    isConfig: false,
    isDocumentation: false,
    isSchema: false,
    isExported: true,
    exactSymbolMatch: false,
    exactPathMatch: false,
    bm25Score: 0,
    tokenOverlapRatio: 0,
    graphDegree: 0,
    minDistanceToSeed: null,
    minDistanceToErrorFrame: null,
    isDirectDependency: false,
    isDirectDependent: false,
    changeFrequency: 0,
    recentChangeFrequency: 0,
    maxCoChangeWithSeeds: 0,
    inStackTrace: false,
    isFailingTestTarget: false,
    inCompilerError: false,
    inDirtyDiff: false,
    fromExactRetrieval: false,
    fromLexicalRetrieval: false,
    fromGraphRetrieval: false,
    fromGitRetrieval: false,
    fromRuntimeRetrieval: false,
    heuristicScore: 10,
    hasJevSignals: false,
    semanticRelevanceProbability: null,
    implementationNeededProbability: null,
    likelyEditTargetProbability: null,
    likelyRootCauseProbability: null,
  },
];

async function runTieBreakTest() {
  const dummyTask: any = { taskId: 't_test', workspaceSnapshotId: 'ws_snap' };
  const ranked = await ranker.score(dummyTask, [], featuresList);

  assert.strictEqual(ranked[0].contextUnitId, 'cu_alpha', 'Ties must break alphabetically by contextUnitId');
  assert.strictEqual(ranked[1].contextUnitId, 'cu_zebra');
  console.log('  ✔ Ties broken deterministically by contextUnitId ASC');
}

// 3. Safe Fallback on Exception
console.log('\n--- 3. Safe Fallback on Exception ---');
class BrokenThrowingRanker implements LearnedContextRanker {
  public modelId = 'broken_throwing';
  public modelType = 'test';
  public featureSetVersion = 'v3';
  async score(): Promise<any> {
    throw new Error('SIMULATED_MODEL_CRASH');
  }
}

async function runFallbackExceptionTest() {
  const dummyTask: any = { taskId: 't_test', workspaceSnapshotId: 'ws_snap' };
  const safe = new SafeFallbackRanker(new BrokenThrowingRanker());
  const fallbackResults = await safe.score(dummyTask, [], featuresList);

  assert.strictEqual(fallbackResults.length, 2);
  assert.ok(fallbackResults[0].fallbackUsed, 'Fallback must be marked as used');
  assert.strictEqual(fallbackResults[0].modelId, 'deterministic_v2_fallback');
  console.log('  ✔ Model exception safely fell back to deterministic V2 ContextRanker');
}

// 4. Safe Fallback on NaN / Non-Finite Score
console.log('\n--- 4. Safe Fallback on NaN Score ---');
class MalformedNaNRanker implements LearnedContextRanker {
  public modelId = 'broken_nan';
  public modelType = 'test';
  public featureSetVersion = 'v3';
  async score(): Promise<any> {
    return [
      { contextUnitId: 'cu_alpha', finalScore: NaN, rank: 1, modelId: 'nan', fallbackUsed: false, reasons: [] },
      { contextUnitId: 'cu_zebra', finalScore: 10, rank: 2, modelId: 'nan', fallbackUsed: false, reasons: [] },
    ];
  }
}

async function runFallbackNaNTest() {
  const dummyTask: any = { taskId: 't_test', workspaceSnapshotId: 'ws_snap' };
  const safe = new SafeFallbackRanker(new MalformedNaNRanker());
  const fallbackResults = await safe.score(dummyTask, [], featuresList);

  assert.strictEqual(fallbackResults.length, 2);
  assert.ok(fallbackResults[0].fallbackUsed, 'Fallback must be marked as used on NaN output');
  assert.strictEqual(fallbackResults[0].modelId, 'deterministic_v2_fallback');
  console.log('  ✔ Non-finite score safely triggered deterministic V2 fallback');
}

// 5. Shadow Mode Plan Invariance
console.log('\n--- 5. Shadow Mode Plan Invariance ---');
async function runShadowModeTest() {
  const dummyTask: any = { taskId: 't_test', workspaceSnapshotId: 'ws_snap' };
  const shadow = new ShadowContextRanker(ranker);
  const result = await shadow.score(dummyTask, [], featuresList);

  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].modelId, 'v2_baseline_shadow_active');
  const records = shadow.getShadowRecords();
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].planInvarianceHolds, true);
  console.log('  ✔ Shadow mode recorded learned predictions while preserving 100% baseline ranking');
}

Promise.all([
  runTieBreakTest(),
  runFallbackExceptionTest(),
  runFallbackNaNTest(),
  runShadowModeTest(),
]).then(() => {
  console.log('\n🎉 ALL V3 MODELS & FALLBACK TESTS PASSED CLEANLY!\n');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
