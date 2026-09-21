/**
 * SiftrCode V3 - Test Suite: Leakage-Safe Splits & Point-in-Time Safety
 *
 * Verifies:
 * 1. Disjointness between Train, Validation, and Test splits.
 * 2. Zero splitGroupId cross-partition overlap (anti-join).
 * 3. Strict temporal cutoff enforcement (Git history <= C0).
 * 4. Future Git commit leakage prevention.
 * 5. Feature matrix strictly prohibits post-outcome properties.
 */

import * as assert from 'assert';
import { BenchmarkBuilder } from '../benchmark/siftrbench/benchmark_builder';
import { SplitManager } from '../benchmark/siftrbench/split_manager';
import { isTimestampBeforeCutoff, createFeatureCutoff } from '../learning/point_in_time_features';
import { FeatureBuilderV3_1 } from '../learning/features/feature_builder_v3_1';
import { PROHIBITED_FEATURE_FIELDS } from '../learning/features/feature_set_v3_1';

console.log('🧪 [Test Suite V3-Leakage & Splits] Starting verification...\n');

// 1. Partition Benchmark into Splits
console.log('--- 1. Partition Disjointness & Anti-Join Verification ---');
const episodes = BenchmarkBuilder.buildBenchmarkEpisodes();
const splitResult = SplitManager.partition(episodes, {
  trainRatio: 0.70,
  valRatio: 0.15,
  testRatio: 0.15,
  seed: 42,
});

assert.ok(splitResult.train.length > 0, 'Train split must not be empty');
assert.ok(splitResult.validation.length > 0, 'Validation split must not be empty');
assert.ok(splitResult.test.length > 0, 'Test split must not be empty');
assert.strictEqual(
  splitResult.train.length + splitResult.validation.length + splitResult.test.length,
  episodes.length,
  'All episodes must be accounted for'
);

const trainIds = new Set(splitResult.train.map((e) => e.episodeId));
const valIds = new Set(splitResult.validation.map((e) => e.episodeId));
const testIds = new Set(splitResult.test.map((e) => e.episodeId));

// Anti-joins for episode IDs
for (const id of valIds) {
  assert.ok(!trainIds.has(id), `Leakage detected: Episode ${id} in both train and validation`);
}
for (const id of testIds) {
  assert.ok(!trainIds.has(id), `Leakage detected: Episode ${id} in both train and test`);
  assert.ok(!valIds.has(id), `Leakage detected: Episode ${id} in both validation and test`);
}
console.log('  ✔ Zero episode ID overlap across Train, Validation, and Test splits');

// 2. Anti-joins for splitGroupId
console.log('\n--- 2. splitGroupId Leakage Prevention ---');
const trainGroups = new Set(splitResult.train.map((e) => e.splitGroupId));
const valGroups = new Set(splitResult.validation.map((e) => e.splitGroupId));
const testGroups = new Set(splitResult.test.map((e) => e.splitGroupId));

for (const g of valGroups) {
  assert.ok(!trainGroups.has(g), `Group leakage: ${g} in both train and validation`);
}
for (const g of testGroups) {
  assert.ok(!trainGroups.has(g), `Group leakage: ${g} in both train and test`);
  assert.ok(!valGroups.has(g), `Group leakage: ${g} in both validation and test`);
}
console.log('  ✔ Zero splitGroupId overlap between splits (anti-join verified)');

// 3. Point-in-Time Git Safety (<= C0)
console.log('\n--- 3. Point-in-Time Git Safety & Cutoff Logic ---');
const cutoffTimestamp = '2024-01-01T00:00:00.000Z';
const cutoff = createFeatureCutoff({
  timestamp: cutoffTimestamp,
  workspaceSnapshotId: 'ws_snap_c0',
});

const priorCommitTime = '2023-12-31T23:59:59.000Z';
const exactCommitTime = '2024-01-01T00:00:00.000Z';
const futureCommitTime = '2024-01-01T00:00:01.000Z';

assert.strictEqual(isTimestampBeforeCutoff(priorCommitTime, cutoff), true, 'Prior commit must pass cutoff');
assert.strictEqual(isTimestampBeforeCutoff(exactCommitTime, cutoff), true, 'Exact commit must pass cutoff');
assert.strictEqual(isTimestampBeforeCutoff(futureCommitTime, cutoff), false, 'Future commit MUST be rejected');
console.log('  ✔ Point-in-time timestamp cutoff strictly filters commits > C0');

// 4. Feature Matrix Prohibited Fields Assertion
console.log('\n--- 4. Absence of Outcome Fields in Model Input Matrix ---');
const cleanFeatures = {
  schemaVersion: 'CONTEXT_RANK_FEATURES_V3_1',
  contextUnitId: 'cu_test',
  bm25Score: 12.5,
  heuristicScore: 55,
};

// Clean features pass
FeatureBuilderV3_1.assertNoLeakage(cleanFeatures);

// Leaked outcome field triggers hard error
for (const prohibited of PROHIBITED_FEATURE_FIELDS) {
  const dirtyFeatures = { ...cleanFeatures, [prohibited]: true };
  assert.throws(
    () => FeatureBuilderV3_1.assertNoLeakage(dirtyFeatures),
    /FEATURE_LEAKAGE_DETECTED/,
    `Feature builder must throw when prohibited field ${prohibited} is present`
  );
}
console.log(`  ✔ All ${PROHIBITED_FEATURE_FIELDS.length} prohibited post-outcome fields verified guarded`);

console.log('\n🎉 ALL V3 LEAKAGE & SPLIT TESTS PASSED CLEANLY!\n');
