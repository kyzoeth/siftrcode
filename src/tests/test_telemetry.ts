/**
 * SiftrCode V2 - Exposure-Aware Telemetry & Data Rights Tests (Phase 11)
 */

import { strict as assert } from 'assert';
import { ContextResolution } from '../context/context_resolution';
import {
  createExposureDecision,
  isExposed,
} from '../telemetry/exposure_decision';
import {
  createCandidateObservation,
  computeObservationLabel,
  exportTrainingExamples,
} from '../telemetry/candidate_observation';
import { TrajectoryLogger } from '../telemetry/trajectory_event';
import { createDefaultDataRights } from '../rights/data_rights';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { ContextUnitKind } from '../context/context_unit';

console.log('🧪 Testing Exposure-Aware Telemetry & Data Rights (Phase 11)...\n');

// Mock features for testing
const mockFeatures: ContextFeaturesV1 = {
  schemaVersion: 'v1',
  contextUnitId: 'unit_webhook_1',
  unitKind: ContextUnitKind.CODE_SYMBOL,
  tokenEstimate: 25,
  isTest: false,
  isConfig: false,
  isDocumentation: false,
  isSchema: false,
  isExported: true,
  exactSymbolMatch: true,
  exactPathMatch: true,
  bm25Score: 8.5,
  tokenOverlapRatio: 0.8,
  graphDegree: 3,
  minDistanceToSeed: 0,
  minDistanceToErrorFrame: 0,
  isDirectDependency: false,
  isDirectDependent: false,
  changeFrequency: 4,
  recentChangeFrequency: 2,
  maxCoChangeWithSeeds: 1.0,
  inStackTrace: true,
  isFailingTestTarget: false,
  inCompilerError: false,
  inDirtyDiff: true,
  heuristicScore: 110,
};

// --- 1. Exposure Decision Verification ---
console.log('--- 1. Exposure Decision Verification ---');
const omitDecision = createExposureDecision({
  contextUnitId: 'u1',
  exposureResolution: ContextResolution.OMIT,
  exposureRank: 10,
});
assert.equal(isExposed(omitDecision), false);
console.log('  ✔ OMIT resolution is not exposed');

const bodyDecision = createExposureDecision({
  contextUnitId: 'u2',
  exposureResolution: ContextResolution.BODY,
  exposureRank: 1,
});
assert.equal(isExposed(bodyDecision), true);
console.log('  ✔ BODY resolution is exposed');

// --- 2. Exposure-Aware Labeling (The Negative Invariant) ---
console.log('\n--- 2. Exposure-Aware Outcome Labeling ---');

// Case 1: Exposed and touched/inspected -> POSITIVE
const label1 = computeObservationLabel(true, true, false, false);
assert.equal(label1, 'POSITIVE');
console.log('  ✔ Exposed & inspected labeled POSITIVE');

// Case 2: Exposed and edited -> POSITIVE
const label2 = computeObservationLabel(true, false, true, false);
assert.equal(label2, 'POSITIVE');
console.log('  ✔ Exposed & edited labeled POSITIVE');

// Case 3: Exposed and NOT used -> NEGATIVE
const label3 = computeObservationLabel(true, false, false, false);
assert.equal(label3, 'NEGATIVE');
console.log('  ✔ Exposed & unused labeled NEGATIVE');

// Case 4: UNEXPOSED and unused -> UNEXPOSED_UNKNOWN (CRITICAL: NOT NEGATIVE)
const label4 = computeObservationLabel(false, false, false, false);
assert.equal(label4, 'UNEXPOSED_UNKNOWN');
assert.notEqual(label4, 'NEGATIVE');
console.log('  ✔ CRITICAL INVARIANT: Unexposed unused candidate is UNEXPOSED_UNKNOWN, NEVER NEGATIVE');

// Case 5: Unexposed but agent touched it anyway -> POSITIVE
const label5 = computeObservationLabel(false, true, false, false);
assert.equal(label5, 'POSITIVE');
console.log('  ✔ Unexposed candidate discovered independently labeled POSITIVE');

// --- 3. Training Set Export & Data Rights Enforcement ---
console.log('\n--- 3. Training Set Export & Data Rights Enforcement ---');

// Customer with training allowed
const permissiveRights = createDefaultDataRights({ trainingAllowed: true });

// Customer with strict privacy (default)
const strictRights = createDefaultDataRights({ trainingAllowed: false });

const obsPositive = createCandidateObservation({
  taskId: 'task_1',
  contextUnitId: 'u_pos',
  wasExposed: true,
  exposureResolution: ContextResolution.BODY,
  wasInspectedByAgent: true,
  wasEditedByAgent: false,
  wasInFailureTrace: false,
  features: mockFeatures,
  dataRights: permissiveRights,
});

const obsNegative = createCandidateObservation({
  taskId: 'task_1',
  contextUnitId: 'u_neg',
  wasExposed: true,
  exposureResolution: ContextResolution.BODY,
  wasInspectedByAgent: false,
  wasEditedByAgent: false,
  wasInFailureTrace: false,
  features: mockFeatures,
  dataRights: permissiveRights,
});

const obsUnexposed = createCandidateObservation({
  taskId: 'task_1',
  contextUnitId: 'u_unexposed',
  wasExposed: false,
  exposureResolution: ContextResolution.OMIT,
  wasInspectedByAgent: false,
  wasEditedByAgent: false,
  wasInFailureTrace: false,
  features: mockFeatures,
  dataRights: permissiveRights,
});

const obsStrict = createCandidateObservation({
  taskId: 'task_2',
  contextUnitId: 'u_strict',
  wasExposed: true,
  exposureResolution: ContextResolution.BODY,
  wasInspectedByAgent: true,
  wasEditedByAgent: false,
  wasInFailureTrace: false,
  features: mockFeatures,
  dataRights: strictRights,
});

// Export permissive set
const trainingData = exportTrainingExamples([obsPositive, obsNegative, obsUnexposed]);
assert.equal(trainingData.length, 2);
assert.equal(trainingData[0].label, 1);
assert.equal(trainingData[1].label, 0);
console.log('  ✔ Permissive observations export 1 positive and 1 negative');
assert.ok(!trainingData.some((ex) => ex.contextUnitId === 'u_unexposed'));
console.log('  ✔ UNEXPOSED_UNKNOWN candidate strictly excluded from training export');

// Export strict privacy set
const strictTrainingData = exportTrainingExamples([obsStrict]);
assert.equal(strictTrainingData.length, 0);
console.log('  ✔ Customer with trainingAllowed: false produces 0 training examples');

// --- 4. Trajectory Logging & Retention Rights ---
console.log('\n--- 4. Trajectory Logging & Retention Rights ---');

// Logger with trajectoryRetentionAllowed: false
const privateLogger = new TrajectoryLogger('task_p', createDefaultDataRights({ trajectoryRetentionAllowed: false }));
const privateEvent = privateLogger.logEvent('TOOL_CALL', { tool: 'View', file: 'secret.ts' });
assert.equal(privateEvent, null);
assert.equal(privateLogger.getEvents().length, 0);
console.log('  ✔ Trajectory logging blocked when trajectoryRetentionAllowed is false');

// Logger with trajectoryRetentionAllowed: true
const activeLogger = new TrajectoryLogger('task_a', createDefaultDataRights({ trajectoryRetentionAllowed: true }));
const activeEvent = activeLogger.logEvent('TOOL_CALL', { tool: 'View', file: 'public.ts' });
assert.ok(activeEvent !== null);
assert.equal(activeLogger.getEvents().length, 1);
assert.equal(activeEvent.payload.tool, 'View');
console.log('  ✔ Trajectory event logged when trajectoryRetentionAllowed is true');

console.log('\n🎉 All Exposure-Aware Telemetry & Data Rights tests passed successfully!');
