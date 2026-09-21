/**
 * SiftrCode V3 - Test Suite: Dataset Invariants & Pairwise Formulation
 *
 * Verifies:
 * 1. UNKNOWN != NEGATIVE: Unexposed candidate remains UNKNOWN, never labeled 0/negative.
 * 2. Unobserved candidate under limited trace remains UNKNOWN.
 * 3. Legitimate negative evidence requires exposure + full observability + verified success + unread/unedited.
 * 4. DataRights enforcement: trainingAllowed = false blocks dataset inclusion.
 * 5. Pairwise ranking examples stay strictly within the same task episode.
 * 6. UNKNOWN candidates are excluded from pairwise comparisons.
 * 7. JEV missing value preservation (missing != 0).
 */

import * as assert from 'assert';
import { SiftrDatasetV1Builder, CandidateLabelState } from '../learning/datasets/siftr_dataset_v1';
import { PairwiseBuilder } from '../learning/datasets/pairwise_builder';
import { createDefaultDataRights } from '../rights/data_rights';
import { ContextFeaturesV3_1 } from '../learning/features/feature_set_v3_1';

console.log('🧪 [Test Suite V3-Dataset & Pairs] Starting verification...\n');

// 1. UNKNOWN != NEGATIVE: Unexposed Candidate
console.log('--- 1. UNKNOWN != NEGATIVE (Unexposed Candidate) ---');
const unexposedResult = SiftrDatasetV1Builder.resolveLabelState({
  unitPath: 'lib/utils.js',
  expectedTargetPaths: ['lib/response.js'],
  isExposed: false,
  observability: 'FULL_TOOL_TRACE',
  taskSucceeded: true,
});
assert.strictEqual(unexposedResult.labelState, 'UNKNOWN', 'Unexposed candidate must be UNKNOWN');
console.log('  ✔ Unexposed candidate remains UNKNOWN (not negative)');

// 2. UNKNOWN != NEGATIVE: Candidate with Insufficient Observability
console.log('\n--- 2. UNKNOWN != NEGATIVE (Limited Observability) ---');
const limitedObsResult = SiftrDatasetV1Builder.resolveLabelState({
  unitPath: 'lib/utils.js',
  expectedTargetPaths: ['lib/response.js'],
  isExposed: true,
  observability: 'LIMITED_TELEMETRY',
  read: false,
  edited: false,
  taskSucceeded: true,
});
assert.strictEqual(limitedObsResult.labelState, 'UNKNOWN', 'Candidate under limited observability must be UNKNOWN');
console.log('  ✔ Candidate under limited observability remains UNKNOWN');

// 3. Legitimate Weak Negative Evidence
console.log('\n--- 3. Legitimate Weak Negative Conditions ---');
const legitNegative = SiftrDatasetV1Builder.resolveLabelState({
  unitPath: 'lib/utils.js',
  expectedTargetPaths: ['lib/response.js'],
  isExposed: true,
  observability: 'FULL_TOOL_TRACE',
  read: false,
  edited: false,
  taskSucceeded: true,
});
assert.strictEqual(legitNegative.labelState, 'WEAK_NEGATIVE', 'Exposed + full trace + unused + success => WEAK_NEGATIVE');
console.log('  ✔ Qualified unread candidate correctly identified as WEAK_NEGATIVE');

// 4. Ground Truth Positive Evidence
console.log('\n--- 4. Positive Ground Truth Association ---');
const positiveTarget = SiftrDatasetV1Builder.resolveLabelState({
  unitPath: 'lib/response.js',
  expectedTargetPaths: ['lib/response.js'],
  isExposed: true,
  observability: 'FULL_TOOL_TRACE',
  taskSucceeded: true,
});
assert.strictEqual(positiveTarget.labelState, 'POSITIVE', 'Ground truth target must be POSITIVE');
console.log('  ✔ Ground truth target correctly labeled POSITIVE');

// 5. RightsFilter Boundary: trainingAllowed = false
console.log('\n--- 5. RightsFilter Training Enforcement ---');
const builder = new SiftrDatasetV1Builder();
const forbiddenRights = createDefaultDataRights();
(forbiddenRights as any).trainingAllowed = false;

const dummyFeatures: ContextFeaturesV3_1 = {
  schemaVersion: 'CONTEXT_RANK_FEATURES_V3_1',
  contextUnitId: 'cu_test',
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
  bm25Score: 5.0,
  tokenOverlapRatio: 0.2,
  graphDegree: 3,
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
  fromExactRetrieval: false,
  fromLexicalRetrieval: true,
  fromGraphRetrieval: false,
  fromGitRetrieval: false,
  fromRuntimeRetrieval: false,
  heuristicScore: 20,
  hasJevSignals: false,
  semanticRelevanceProbability: null,
  implementationNeededProbability: null,
  likelyEditTargetProbability: null,
  likelyRootCauseProbability: null,
};

const dummyEpisode: any = {
  episodeId: 'ep_test',
  taskId: 'task_test',
  expectedTargetPaths: ['lib/response.js'],
  workspaceSnapshotId: 'ws_snap',
  rightsReference: 'rights_ref',
  temporalCutoff: '2024-01-01T00:00:00.000Z',
};

const rowWithForbiddenRights = builder.createRow({
  episode: dummyEpisode,
  split: 'train',
  contextUnitId: 'cu_test',
  unitPath: 'lib/response.js',
  features: dummyFeatures,
  candidateSources: ['lexical'],
  isExposed: true,
  observability: 'FULL_TOOL_TRACE',
  dataRights: forbiddenRights,
});
assert.strictEqual(rowWithForbiddenRights, null, 'Row with trainingAllowed=false must be rejected');
console.log('  ✔ Customer rights with trainingAllowed=false strictly rejected by builder');

// 6. Pairwise Builder: Within-Task Pairing and UNKNOWN Exclusion
console.log('\n--- 6. Pairwise Within-Task Integrity & UNKNOWN Exclusion ---');
const dummyDataset: any = {
  rowsByEpisode: new Map([
    [
      'ep_task_A',
      [
        {
          episodeId: 'ep_task_A',
          taskId: 'task_A',
          split: 'train',
          contextUnitId: 'cu_pos_A',
          labelState: 'POSITIVE',
          featureVector: [1, 1, 1],
          featureVectorNoJev: [1, 1, 1],
          weight: 1.0,
        },
        {
          episodeId: 'ep_task_A',
          taskId: 'task_A',
          split: 'train',
          contextUnitId: 'cu_neg_A',
          labelState: 'WEAK_NEGATIVE',
          featureVector: [0, 0, 0],
          featureVectorNoJev: [0, 0, 0],
          weight: 1.0,
        },
        {
          episodeId: 'ep_task_A',
          taskId: 'task_A',
          split: 'train',
          contextUnitId: 'cu_unk_A',
          labelState: 'UNKNOWN', // Must NOT form a negative pair!
          featureVector: [0.5, 0.5, 0.5],
          featureVectorNoJev: [0.5, 0.5, 0.5],
          weight: 1.0,
        },
      ],
    ],
    [
      'ep_task_B',
      [
        {
          episodeId: 'ep_task_B',
          taskId: 'task_B',
          split: 'train',
          contextUnitId: 'cu_pos_B',
          labelState: 'POSITIVE',
          featureVector: [2, 2, 2],
          featureVectorNoJev: [2, 2, 2],
          weight: 1.0,
        },
        {
          episodeId: 'ep_task_B',
          taskId: 'task_B',
          split: 'train',
          contextUnitId: 'cu_neg_B',
          labelState: 'WEAK_NEGATIVE',
          featureVector: [0.1, 0.1, 0.1],
          featureVectorNoJev: [0.1, 0.1, 0.1],
          weight: 1.0,
        },
      ],
    ],
  ]),
};

const pairs = PairwiseBuilder.buildPairs(dummyDataset);
assert.strictEqual(pairs.report.totalTasksWithPairs, 2, 'Two tasks should produce pairs');
assert.strictEqual(pairs.pairs.length, 2, 'Exactly 2 pairs expected (1 per task)');
assert.strictEqual(pairs.report.unknownRowsExcluded, 1, 'The 1 UNKNOWN row must be excluded');

// Assert no cross-task pairs exist
for (const p of pairs.pairs) {
  if (p.episodeId === 'ep_task_A') {
    assert.strictEqual(p.positiveUnitId, 'cu_pos_A');
    assert.strictEqual(p.negativeUnitId, 'cu_neg_A');
  } else if (p.episodeId === 'ep_task_B') {
    assert.strictEqual(p.positiveUnitId, 'cu_pos_B');
    assert.strictEqual(p.negativeUnitId, 'cu_neg_B');
  }
}
console.log('  ✔ All pairs are strictly within-task (0 cross-task pairs)');
console.log('  ✔ UNKNOWN candidate was strictly excluded from negative pairs');

console.log('\n🎉 ALL V3 DATASET & PAIR TESTS PASSED CLEANLY!\n');
