/**
 * SiftrCode V3 - Test Suite: Foundation & Baseline Immutability
 *
 * Verifies:
 * 1. Frozen V2 baseline SHA immutability (1eedac03b0d83025ebf08ed2945e0ab015c46f6a)
 * 2. v2-final git tag resolution
 * 3. SiftrBench v1 schema validation
 * 4. Episode replay identity and determinism
 * 5. Multi-repository task coverage (Express, FastAPI, SiftrCode)
 */

import * as assert from 'assert';
import * as path from 'path';
import { execSync } from 'child_process';
import { BenchmarkBuilder, REPO_PINNED_COMMITS } from '../benchmark/siftrbench/benchmark_builder';
import { SiftrBenchEpisode } from '../benchmark/siftrbench/episode_schema';

console.log('🧪 [Test Suite V3-Foundation] Starting verification...\n');

const EXPECTED_V2_SHA = '1eedac03b0d83025ebf08ed2945e0ab015c46f6a';

// 1. Verify V2 Baseline SHA Immutability
console.log('--- 1. Frozen V2 Baseline SHA Immutability ---');
const rootDir = path.resolve(__dirname, '../..');
const tagCommit = execSync(`git -C "${rootDir}" rev-parse v2-final^{commit}`, { encoding: 'utf8' }).trim();
assert.strictEqual(tagCommit, EXPECTED_V2_SHA, `v2-final tag must point to ${EXPECTED_V2_SHA}`);
console.log(`  ✔ v2-final tag points to authoritative commit: ${tagCommit}`);

// 2. Build Benchmark Episodes and Verify Schema
console.log('\n--- 2. SiftrBench v1 Schema Validation ---');
const episodes = BenchmarkBuilder.buildBenchmarkEpisodes();
assert.ok(episodes.length >= 100, `Benchmark must have at least 100 episodes (got ${episodes.length})`);
console.log(`  ✔ Assembled ${episodes.length} episodes for SiftrBench v1`);

for (const ep of episodes) {
  assert.strictEqual(ep.schemaVersion, 'siftrbench-v1', `Episode ${ep.episodeId} has invalid schemaVersion`);
  assert.ok(ep.episodeId.length > 0, `Missing episodeId`);
  assert.ok(ep.taskId.length > 0, `Missing taskId`);
  assert.ok(ep.baseCommit.length === 40, `Base commit must be 40 chars`);
  assert.ok(ep.expectedTargetPaths.length > 0, `Must have expectedTargetPaths`);
  assert.ok(ep.verifier && ep.verifier.type, `Must have verifier`);
  assert.ok(ep.splitGroupId.length > 0, `Must have splitGroupId`);
  assert.ok(ep.temporalCutoff.length > 0, `Must have temporalCutoff`);
}
console.log('  ✔ All episodes satisfy SiftrBench v1 schema contract');

// 3. Multi-Repository & Task Diversity Coverage
console.log('\n--- 3. Multi-Repository & Task Diversity ---');
const repoCounts = new Map<string, number>();
const typeCounts = new Map<string, number>();

for (const ep of episodes) {
  repoCounts.set(ep.repositoryId, (repoCounts.get(ep.repositoryId) || 0) + 1);
  typeCounts.set(ep.taskType, (typeCounts.get(ep.taskType) || 0) + 1);
}

assert.ok(repoCounts.get('express')! >= 30, 'Express must have >= 30 tasks');
assert.ok(repoCounts.get('fastapi')! >= 30, 'FastAPI must have >= 30 tasks');
assert.ok(repoCounts.get('siftrcode')! >= 15, 'SiftrCode must have >= 15 tasks');
console.log('  ✔ Repository counts verified:', Object.fromEntries(repoCounts));

assert.ok(typeCounts.has('BUG_FIX'), 'Must include BUG_FIX');
assert.ok(typeCounts.has('FEATURE_ADDITION'), 'Must include FEATURE_ADDITION');
assert.ok(typeCounts.has('REFACTOR'), 'Must include REFACTOR');
assert.ok(typeCounts.has('TEST_FAILURE'), 'Must include TEST_FAILURE');
assert.ok(typeCounts.has('CONFIG_CHANGE') || typeCounts.has('MULTI_FILE_COORDINATION'), 'Must include configuration or multi-file tasks');
console.log('  ✔ Task types verified:', Object.fromEntries(typeCounts));

// 4. Episode Replay Identity
console.log('\n--- 4. Episode Replay Identity ---');
const episodesRun2 = BenchmarkBuilder.buildBenchmarkEpisodes();
assert.strictEqual(episodes.length, episodesRun2.length, 'Replay must produce identical episode count');
for (let i = 0; i < episodes.length; i++) {
  assert.strictEqual(episodes[i].episodeId, episodesRun2[i].episodeId, `Episode mismatch at index ${i}`);
  assert.strictEqual(episodes[i].baseCommit, episodesRun2[i].baseCommit, `Base commit mismatch at index ${i}`);
  assert.strictEqual(episodes[i].splitGroupId, episodesRun2[i].splitGroupId, `Split group mismatch at index ${i}`);
}
console.log('  ✔ Episode replay identity is 100% deterministic');

console.log('\n🎉 ALL V3 FOUNDATION TESTS PASSED CLEANLY!\n');
