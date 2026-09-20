/**
 * SiftrCode V2 - BudgetSolver Tests (Phase 15)
 */

import { strict as assert } from 'assert';
import { BudgetSolver, calculateCostUSD, BUDGET_PROFILES } from '../context/budget_solver';
import { ContextResolution } from '../context/context_resolution';
import { ContextUnit, ContextUnitKind } from '../context/context_unit';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { TrustLevel } from '../security/trust';

console.log('🧪 Testing BudgetSolver Token & Economic Optimization (Phase 15)...\n');

// 1. Setup Units & Features
const units = new Map<string, ContextUnit>();
const features = new Map<string, ContextFeaturesV1>();

// Unit 1: Edit Target (WebhookHandler) - 1,000 raw tokens
const unitWebhook: ContextUnit = {
  id: 'unit_webhook',
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: 'snap_w0',
  path: 'src/webhook.ts',
  title: 'WebhookHandler',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: { tokenEstimate: 1000 },
};
units.set(unitWebhook.id, unitWebhook);

features.set(unitWebhook.id, {
  schemaVersion: 'v1',
  contextUnitId: 'unit_webhook',
  unitKind: ContextUnitKind.CODE_SYMBOL,
  tokenEstimate: 1000,
  isTest: false,
  isConfig: false,
  isDocumentation: false,
  isSchema: false,
  isExported: true,
  exactSymbolMatch: true,
  exactPathMatch: true,
  bm25Score: 10,
  tokenOverlapRatio: 1.0,
  graphDegree: 4,
  minDistanceToSeed: 0,
  minDistanceToErrorFrame: 0,
  isDirectDependency: false,
  isDirectDependent: false,
  changeFrequency: 10,
  recentChangeFrequency: 5,
  maxCoChangeWithSeeds: 1.0,
  inStackTrace: true,
  isFailingTestTarget: false,
  inCompilerError: false,
  inDirtyDiff: true,
  heuristicScore: 150,
});

// Unit 2: Direct Dependency (RedisLock) - 2,000 raw tokens
const unitLock: ContextUnit = {
  id: 'unit_lock',
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: 'snap_w0',
  path: 'src/lock.ts',
  title: 'RedisLock',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: { tokenEstimate: 2000 },
};
units.set(unitLock.id, unitLock);

features.set(unitLock.id, {
  schemaVersion: 'v1',
  contextUnitId: 'unit_lock',
  unitKind: ContextUnitKind.CODE_SYMBOL,
  tokenEstimate: 2000,
  isTest: false,
  isConfig: false,
  isDocumentation: false,
  isSchema: false,
  isExported: true,
  exactSymbolMatch: false,
  exactPathMatch: false,
  bm25Score: 3,
  tokenOverlapRatio: 0.4,
  graphDegree: 2,
  minDistanceToSeed: 1,
  minDistanceToErrorFrame: 1,
  isDirectDependency: true,
  isDirectDependent: false,
  changeFrequency: 5,
  recentChangeFrequency: 2,
  maxCoChangeWithSeeds: 0.8,
  inStackTrace: false,
  isFailingTestTarget: false,
  inCompilerError: false,
  inDirtyDiff: false,
  heuristicScore: 60,
});

// Unit 3: Distant Helper (Util) - 3,000 raw tokens
const unitUtil: ContextUnit = {
  id: 'unit_util',
  kind: ContextUnitKind.CODE_SYMBOL,
  workspaceSnapshotId: 'snap_w0',
  path: 'src/util.ts',
  title: 'Util',
  provenance: { sourceType: 'file' },
  trustLevel: TrustLevel.FIRST_PARTY_CODE,
  metadata: { tokenEstimate: 3000 },
};
units.set(unitUtil.id, unitUtil);

features.set(unitUtil.id, {
  schemaVersion: 'v1',
  contextUnitId: 'unit_util',
  unitKind: ContextUnitKind.CODE_SYMBOL,
  tokenEstimate: 3000,
  isTest: false,
  isConfig: false,
  isDocumentation: false,
  isSchema: false,
  isExported: true,
  exactSymbolMatch: false,
  exactPathMatch: false,
  bm25Score: 1,
  tokenOverlapRatio: 0.2,
  graphDegree: 1,
  minDistanceToSeed: 2,
  minDistanceToErrorFrame: 2,
  isDirectDependency: false,
  isDirectDependent: false,
  changeFrequency: 2,
  recentChangeFrequency: 1,
  maxCoChangeWithSeeds: 0.2,
  inStackTrace: false,
  isFailingTestTarget: false,
  inCompilerError: false,
  inDirtyDiff: false,
  heuristicScore: 25,
});

const solver = new BudgetSolver();
const selectedUnitIds = ['unit_webhook', 'unit_lock', 'unit_util'];

// --- Test 1: Pricing Calculation ---
console.log('--- 1. Pricing Model Calculations ---');
const cost1M_Sonnet = calculateCostUSD(1_000_000, 'claude-3-7-sonnet');
assert.equal(cost1M_Sonnet, 3.0);
const cost1M_Gpt4o = calculateCostUSD(1_000_000, 'gpt-4o');
assert.equal(cost1M_Gpt4o, 2.5);
console.log('  ✔ Accurate per-model token pricing for Claude and GPT-4o');

// --- Test 2: Unconstrained vs Constrained Budget ---
console.log('\n--- 2. Unconstrained Allocation (THOROUGH) ---');
const unconstrainedPlan = solver.solve({
  selectedUnitIds,
  units,
  features,
  limits: { maxTokens: 10000, modelName: 'claude-3-7-sonnet' },
  profileName: 'THOROUGH',
});

assert.equal(unconstrainedPlan.rawTotalTokens, 6000);
assert.ok(unconstrainedPlan.totalTokens <= 10000);
console.log(`  ✔ Raw tokens: ${unconstrainedPlan.rawTotalTokens}, allocated: ${unconstrainedPlan.totalTokens}`);

// --- Test 3: Tight Token Budget Enforcement (MINIMAL profile: 2,000 tokens) ---
console.log('\n--- 3. Tight Token Budget Enforcement (2,000 tokens) ---');
const tightPlan = solver.solve({
  selectedUnitIds,
  units,
  features,
  limits: { maxTokens: 2000, modelName: 'claude-3-7-sonnet' },
  profileName: 'MINIMAL',
});

assert.ok(tightPlan.totalTokens <= 2000, `Expected <= 2000, got ${tightPlan.totalTokens}`);
assert.ok(tightPlan.savingsPercentage > 60);

// Invariant: Edit target WebhookHandler is NOT degraded to OMIT or SIGNATURE
const webhookAlloc = tightPlan.allocations.find((a) => a.contextUnitId === 'unit_webhook');
assert.ok(webhookAlloc !== undefined);
assert.ok(
  webhookAlloc!.resolution === ContextResolution.FULL ||
  webhookAlloc!.resolution === ContextResolution.BODY
);
console.log(`  ✔ Strict budget limit enforced (${tightPlan.totalTokens} <= 2000) with ${tightPlan.savingsPercentage}% savings`);
console.log('  ✔ Edit target WebhookHandler strictly protected at FULL/BODY');

// --- Test 4: Economic Cost Ceiling Optimization ---
console.log('\n--- 4. Economic Cost Ceiling Constraint ---');
// Set cost ceiling to $0.005
const costCappedPlan = solver.solve({
  selectedUnitIds,
  units,
  features,
  limits: { maxTokens: 10000, maxCostUSD: 0.005, modelName: 'claude-3-7-sonnet' },
  profileName: 'CUSTOM',
});

assert.ok(costCappedPlan.estimatedCostUSD <= 0.005, `Expected <= 0.005, got ${costCappedPlan.estimatedCostUSD}`);
assert.ok(costCappedPlan.costSavedUSD > 0);
console.log(`  ✔ Cost ceiling strictly enforced: $${costCappedPlan.estimatedCostUSD} <= $0.005 (saved $${costCappedPlan.costSavedUSD})`);

console.log('\n🎉 All BudgetSolver tests passed successfully!');
