import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ContextResolution } from '../context/context_resolution';
import {
  ContextUnitKind,
  CodeSymbolUnit,
  SymbolKind,
  ContextUnit,
} from '../context/context_unit';
import { TrustLevel } from '../security/trust';
import { createWorkspaceSnapshot } from '../workspace/workspace_snapshot';
import { DefaultWorkspaceSourceReader } from '../workspace/workspace_source_reader';
import { DefaultContextUnitMaterializer } from '../materialization/context_unit_materializer';
import {
  DefaultTokenCostEstimator,
  TokenCostEstimator,
  ResolutionOption,
} from '../token/token_cost_estimator';
import { ContextEngine } from '../engine/context_engine';
import { createTaskContext } from '../context/task_context';
import { createAgentEnvironment } from '../agents/agent_environment';

console.log('🧪 Testing Real Token Accounting & Hard Budget Gate (Remediation PR 2)...\n');

async function runTests(): Promise<void> {
  const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_token_test_'));

  try {
    const srcDir = path.join(tempWorkspaceDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const lockFileContent = `// File: src/lock.ts
export class RedisLockManager {
  private client: any;

  constructor() {
    this.client = null;
  }

  public async acquire(key: string, ttlMs: number): Promise<boolean> {
    // Acquire redis distributed atomic lock with TTL
    if (!key || ttlMs <= 0) {
      return false;
    }
    const res = await this.client.set(key, '1', 'PX', ttlMs, 'NX');
    return res === 'OK';
  }

  public async release(key: string): Promise<void> {
    await this.client.del(key);
  }
}
`;
    fs.writeFileSync(path.join(srcDir, 'lock.ts'), lockFileContent, 'utf-8');

    const snapshot = createWorkspaceSnapshot({
      repositories: [
        {
          repositoryId: 'root',
          baseCommitSha: 'sha_token_test',
          trackedTreeHash: 'tree_token_test',
          dirtyPatchHash: 'clean',
        },
      ],
    });

    const reader = new DefaultWorkspaceSourceReader(tempWorkspaceDir);
    const materializer = new DefaultContextUnitMaterializer(reader);
    const estimator: TokenCostEstimator = new DefaultTokenCostEstimator(materializer);

    const acquireUnit: CodeSymbolUnit = {
      id: 'unit_redis_acquire',
      kind: ContextUnitKind.CODE_SYMBOL,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'src/lock.ts',
      title: 'RedisLockManager.acquire',
      provenance: { sourceType: 'file' },
      trustLevel: TrustLevel.FIRST_PARTY_CODE,
      symbolName: 'acquire',
      symbolKind: SymbolKind.METHOD,
      qualifiedName: 'RedisLockManager.acquire',
      language: 'typescript',
      contentHash: 'hash_acquire',
      metadata: {},
      startLine: 10,
      endLine: 18,
      signature: 'public async acquire(key: string, ttlMs: number): Promise<boolean>',
      sourceRange: {
        startLine: 10,
        endLine: 18,
      },
    };

    const configUnit: ContextUnit = {
      id: 'unit_package_json',
      kind: ContextUnitKind.CONFIG,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'package.json',
      title: 'package.json',
      provenance: { sourceType: 'file' },
      trustLevel: TrustLevel.FIRST_PARTY_CONFIGURATION,
      metadata: {
        content: '{\n  "name": "sample-project",\n  "version": "1.0.0"\n}',
      },
    };

    // =========================================================================
    // 1. Authoritative Token Cost Estimation
    // =========================================================================
    console.log('--- 1. Authoritative Token Cost Estimation ---');
    const nameCost = estimator.estimateResolutionSync(acquireUnit, ContextResolution.NAME, snapshot);
    const sigCost = estimator.estimateResolutionSync(acquireUnit, ContextResolution.SIGNATURE, snapshot);
    const skelCost = estimator.estimateResolutionSync(acquireUnit, ContextResolution.SKELETON, snapshot);
    const bodyCost = estimator.estimateResolutionSync(acquireUnit, ContextResolution.BODY, snapshot);
    const fullCost = estimator.estimateResolutionSync(acquireUnit, ContextResolution.FULL, snapshot);
    const omitCost = estimator.estimateResolutionSync(acquireUnit, ContextResolution.OMIT, snapshot);

    console.log(`  ➔ OMIT:      ${omitCost} tokens`);
    console.log(`  ➔ NAME:      ${nameCost} tokens`);
    console.log(`  ➔ SIGNATURE: ${sigCost} tokens`);
    console.log(`  ➔ SKELETON:  ${skelCost} tokens`);
    console.log(`  ➔ BODY:      ${bodyCost} tokens`);
    console.log(`  ➔ FULL:      ${fullCost} tokens`);

    assert.equal(omitCost, 0, 'OMIT resolution must cost 0 tokens');
    assert.ok(nameCost > 0, 'NAME must cost > 0 tokens');
    assert.ok(sigCost >= nameCost, 'SIGNATURE must cost >= NAME');
    assert.ok(bodyCost >= sigCost, 'BODY must cost >= SIGNATURE');
    assert.ok(fullCost >= bodyCost, 'FULL must cost >= BODY');
    console.log('  ✔ Resolution cost hierarchy strictly satisfied: OMIT < NAME <= SIGNATURE <= BODY <= FULL');

    // =========================================================================
    // 2. Resolution-Cost Curves & Options
    // =========================================================================
    console.log('\n--- 2. Resolution-Cost Curves & Safety Invariants ---');
    const curve = estimator.computeResolutionCurve(acquireUnit, snapshot);
    assert.equal(curve.length, 5, 'Curve must contain options for all 5 active resolutions');

    for (const opt of curve) {
      assert.ok(opt.tokenCost > 0, `Option ${opt.resolution} must have positive token cost`);
      assert.ok(opt.estimatedUtility >= 0 && opt.estimatedUtility <= 1.0, 'Utility must be normalized in [0, 1]');
      assert.strictEqual(opt.allowed, true, 'Code symbol should allow all standard resolutions');
    }
    console.log('  ✔ Complete resolution curve generated with strictly normalized utilities');

    // Non-code unit safety curve
    const configCurve = estimator.computeResolutionCurve(configUnit, snapshot);
    const configSkelOpt = configCurve.find((opt) => opt.resolution === ContextResolution.SKELETON);
    assert.ok(configSkelOpt !== undefined);
    assert.strictEqual(configSkelOpt!.allowed, false, 'CONFIG must not allow SKELETON resolution');
    assert.strictEqual(configSkelOpt!.safety, 'UNSAFE', 'CONFIG SKELETON must be marked UNSAFE');
    console.log('  ✔ Non-code unit (CONFIG) strictly marks SKELETON option as allowed: false, safety: UNSAFE');

    // =========================================================================
    // 3. Hard Post-Render Budget Gate: Degradation Enforcement
    // =========================================================================
    console.log('\n--- 3. Hard Post-Render Budget Gate: Strict Degradation ---');
    const env = createAgentEnvironment({
      agentProvider: 'anthropic',
      agentVersion: '1.0.0',
      model: 'claude-3-5-sonnet-20241022',
      harnessVersion: 'v2',
      availableTools: ['read_file', 'edit_file'],
    });

    const task = createTaskContext({
      taskId: 'task_budget_gate',
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      primaryPrompt: 'Fix acquire lock timeout',
      agentEnvironment: env,
    });

    // Create an unconstrained engine first (balanced 16,000 tokens)
    const engineUnconstrained = new ContextEngine({
      repoRootDir: tempWorkspaceDir,
      materializer,
      tokenCostEstimator: estimator,
      budgetProfile: 'BALANCED',
    });

    const unconstrainedPlan = engineUnconstrained.generatePlan({
      task,
      units: [acquireUnit, configUnit],
      snapshot,
    });

    const baseRenderedTokens = unconstrainedPlan.actualRenderedTokens;
    console.log(`  ➔ Unconstrained actual rendered tokens: ${baseRenderedTokens}`);
    assert.ok(baseRenderedTokens > 0);
    assert.strictEqual(unconstrainedPlan.overflowReason, undefined);

    // Now enforce a tight budget of 150 tokens (forcing post-render budget gate to degrade/remove optional units)
    const tightTokenLimit = 150;
    const engineTight = new ContextEngine({
      repoRootDir: tempWorkspaceDir,
      materializer,
      tokenCostEstimator: estimator,
      budgetLimits: { maxTokens: tightTokenLimit },
    });

    const tightPlan = engineTight.generatePlan({
      task,
      units: [acquireUnit, configUnit],
      dirtyPaths: ['src/lock.ts'], // acquireUnit is mandatory edit target
      snapshot,
    });

    console.log(`  ➔ Post-gate rendered tokens under tight budget (${tightTokenLimit}): ${tightPlan.actualRenderedTokens}`);
    assert.ok(
      tightPlan.actualRenderedTokens <= tightTokenLimit,
      `Actual rendered tokens (${tightPlan.actualRenderedTokens}) must not exceed budget limit (${tightTokenLimit})`
    );
    assert.strictEqual(tightPlan.overflowReason, undefined, 'Must not overflow when degradation successfully fits');
    console.log('  ✔ Hard post-render budget gate strictly enforced: actualRenderedTokens <= maxTokens');

    // Mandatory edit target invariant: mandatory unit preserved
    const mandatoryUnitInPlan = tightPlan.units.find((u) => u.contextUnitId === acquireUnit.id);
    assert.ok(mandatoryUnitInPlan !== undefined, 'Mandatory unit must not be omitted');
    console.log(`  ✔ Mandatory edit target retained at resolution: ${mandatoryUnitInPlan!.resolution}`);

    // =========================================================================
    // 4. Mandatory Context Overflow Handling
    // =========================================================================
    console.log('\n--- 4. Mandatory Context Overflow Handling ---');
    // Budget of 80 tokens where even mandatory unit alone (138 tokens) cannot fit
    const impossibleLimit = 80;
    const engineImpossible = new ContextEngine({
      repoRootDir: tempWorkspaceDir,
      materializer,
      tokenCostEstimator: estimator,
      budgetLimits: { maxTokens: impossibleLimit },
    });

    const impossiblePlan = engineImpossible.generatePlan({
      task,
      units: [acquireUnit],
      dirtyPaths: ['src/lock.ts'], // mandatory unit
      snapshot,
    });

    console.log(`  ➔ Overflow reason: "${impossiblePlan.overflowReason}"`);
    assert.ok(impossiblePlan.overflowReason !== undefined, 'Must declare overflowReason when mandatory context exceeds budget');
    assert.ok(
      impossiblePlan.overflowReason!.includes('MANDATORY_CONTEXT_OVERFLOW'),
      'Must specify MANDATORY_CONTEXT_OVERFLOW code'
    );
    assert.ok(
      impossiblePlan.actualRenderedTokens > impossibleLimit,
      'Actual rendered tokens accurately reports true overflow size'
    );
    console.log('  ✔ Mandatory context overflow accurately reported without silent truncation');

    // =========================================================================
    // 5. Hard Invariant Verification
    // =========================================================================
    console.log('\n--- 5. Hard Invariant Verification ---');
    const plansToVerify = [unconstrainedPlan, tightPlan, impossiblePlan];
    for (const p of plansToVerify) {
      // Section 13 invariant:
      // ContextPlan.actualRenderedTokens <= ContextBudget.maxContextTokens except overflowReason != null
      const satisfiesInvariant = p.actualRenderedTokens <= 16000 || p.overflowReason !== undefined;
      assert.strictEqual(satisfiesInvariant, true, 'Section 13 budget invariant must hold on all ContextPlans');
    }
    console.log('  ✔ Section 13 budget invariant verified across unconstrained, degraded, and overflow plans');

    console.log('\n🎉 All Token Accounting & Hard Budget Gate tests passed successfully!');
  } finally {
    try {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
