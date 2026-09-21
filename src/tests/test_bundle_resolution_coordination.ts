/**
 * SiftrCode V2 - Bundle/Resolution Coordination & ResolutionCapabilities Tests
 * Verifies Remediation PR 4:
 * 1. BundleComposer resolution-awareness and budget feasibility
 * 2. Minimum useful resolution enforcement (Section 37)
 * 3. ResolutionCapabilities runtime invariants (Section 38):
 *    - Python decorator case
 *    - Rust macro case
 *    - Module initialization case
 *    - Non-code artifact safety
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { BundleComposer } from '../context/bundle_composer';
import { ContextResolution, ResolutionCapabilities } from '../context/context_resolution';
import { ContextUnit, ContextUnitKind, SymbolKind, generateSymbolUnitId } from '../context/context_unit';
import { RankedCandidate } from '../ranking/context_rank';
import { DefaultContextUnitMaterializer } from '../materialization/context_unit_materializer';
import { DefaultTokenCostEstimator, ResolutionOption } from '../token/token_cost_estimator';
import { ResolutionRanker } from '../context/resolution_rank';
import { BudgetSolver } from '../context/budget_solver';
import { createWorkspaceSnapshot } from '../workspace/workspace_snapshot';
import { ContextFeaturesV1 } from '../ranking/feature_schema';

export async function runBundleResolutionCoordinationTests(): Promise<void> {
  console.log('\n=== Running V2 Bundle/Resolution Coordination & ResolutionCapabilities Tests (Remediation PR 4) ===');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_pr4_test_'));
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const pyFile = path.join(srcDir, 'handler.py');
  fs.writeFileSync(
    pyFile,
    `@retry(times=3)\n@auth_required(role="admin")\ndef process_payment(account_id: str, amount: float) -> bool:\n    print("Processing payment")\n    return True\n`
  );

  const rsFile = path.join(srcDir, 'macros.rs');
  fs.writeFileSync(
    rsFile,
    `macro_rules! define_handler {\n    ($name:ident) => {\n        pub fn $name() { println!("handled"); }\n    };\n}\ndefine_handler!(run_task);\n`
  );

  const initFile = path.join(srcDir, '__init__.py');
  fs.writeFileSync(
    initFile,
    `# Package init\nimport os\nos.environ["APP_MODE"] = "production"\nfrom .handler import process_payment\n`
  );

  const tsFile = path.join(srcDir, 'service.ts');
  fs.writeFileSync(
    tsFile,
    `export class PaymentService {\n  constructor(private apiKey: string) {}\n  public execute(txId: string): boolean {\n    return true;\n  }\n}\n`
  );

  const snapshot = createWorkspaceSnapshot({
    repositories: [
      {
        repositoryId: 'root',
        baseCommitSha: 'commit_pr4_123',
        trackedTreeHash: 'tree_hash_pr4',
        dirtyPatchHash: 'clean',
      },
    ],
  });
  const { DefaultWorkspaceSourceReader } = require('../workspace/workspace_source_reader');
  const sourceReader = new DefaultWorkspaceSourceReader(tmpDir);
  const materializer = new DefaultContextUnitMaterializer(sourceReader);
  const estimator = new DefaultTokenCostEstimator(materializer);
  const ranker = new ResolutionRanker();

  // ---------------------------------------------------------------------------
  // 1. BundleComposer Resolution-Awareness
  // ---------------------------------------------------------------------------
  console.log('\n--- 1. BundleComposer Resolution-Aware Selection ---');
  {
    // Candidate A has a large raw size (500 tokens), but its SIGNATURE is only 25 tokens.
    // If budget limit is 100 tokens, a naive composer would skip Candidate A.
    // Resolution-aware composer recognizes that A's SIGNATURE fits well within budget.
    const unitA: ContextUnit = {
      id: 'unit_a_large',
      kind: ContextUnitKind.SOURCE_FILE,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'src/service.ts',
      title: 'PaymentService',
      provenance: { sourceType: 'file' },
      trustLevel: 'LOCAL_WORKSPACE_COMMITTED' as any,
      metadata: { tokenEstimate: 500 },
    };

    const candA: RankedCandidate = {
      contextUnitId: unitA.id,
      finalScore: 8.5,
      rank: 1,
      scoreBreakdown: {
        runtimeEvidence: 0,
        exactMatch: 0,
        lexicalRelevance: 0,
        graphProximity: 8.5,
        gitCoChange: 0,
        penalties: 0,
      },
      reasons: ['High graph relevance'],
      features: {
        tokenEstimate: 500,
        heuristicScore: 8.0,
      } as any,
    };

    const curveA: ResolutionOption[] = [
      {
        contextUnitId: unitA.id,
        resolution: ContextResolution.NAME,
        tokenCost: 5,
        estimatedUtility: 0.2,
        allowed: true,
        safety: 'SAFE',
      },
      {
        contextUnitId: unitA.id,
        resolution: ContextResolution.SIGNATURE,
        tokenCost: 25,
        estimatedUtility: 0.6,
        allowed: true,
        safety: 'SAFE',
      },
      {
        contextUnitId: unitA.id,
        resolution: ContextResolution.FULL,
        tokenCost: 500,
        estimatedUtility: 1.0,
        allowed: true,
        safety: 'SAFE',
      },
    ];

    const resolutionCurves = new Map<string, ResolutionOption[]>([
      [unitA.id, curveA],
    ]);
    const minimumUsefulResolutions = new Map<string, ContextResolution>([
      [unitA.id, ContextResolution.SIGNATURE],
    ]);

    // Budget is strictly 100 tokens: 500 would not fit, but 25 fits easily!
    const composer = new BundleComposer({ maxTokens: 100 });
    const bundle = composer.compose({
      rankedCandidates: [candA],
      units: new Map([[unitA.id, unitA]]),
      resolutionCurves,
      minimumUsefulResolutions,
    });

    assert.strictEqual(bundle.selectedUnitIds.length, 1, 'Candidate A must be selected based on SIGNATURE feasibility');
    assert.strictEqual(bundle.selectedUnitIds[0], unitA.id);
    console.log('  ✔ BundleComposer selected candidate whose SIGNATURE fits budget despite raw FULL exceeding limit');
  }

  // ---------------------------------------------------------------------------
  // 2. Minimum Useful Resolution Enforcement (Section 37)
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Minimum Useful Resolution Enforcement ---');
  {
    const unitB: ContextUnit = {
      id: 'unit_b_edit_target',
      kind: ContextUnitKind.SOURCE_FILE,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'src/service.ts',
      title: 'PaymentService Target',
      provenance: { sourceType: 'file' },
      trustLevel: 'LOCAL_WORKSPACE_COMMITTED' as any,
      metadata: { tokenEstimate: 300 },
    };

    const candB: RankedCandidate = {
      contextUnitId: unitB.id,
      finalScore: 9.0,
      rank: 1,
      scoreBreakdown: {
        runtimeEvidence: 9.0,
        exactMatch: 0,
        lexicalRelevance: 0,
        graphProximity: 0,
        gitCoChange: 0,
        penalties: 0,
      },
      reasons: ['Edit Target'],
      features: {
        tokenEstimate: 300,
        heuristicScore: 9.0,
      } as any,
    };

    // Candidate B requires at least BODY (cost: 200).
    // Available budget is only 50 tokens.
    // NAME (cost: 5) and SIGNATURE (cost: 25) fit 50 tokens, but are below minimumUsefulResolution (BODY).
    const curveB: ResolutionOption[] = [
      {
        contextUnitId: unitB.id,
        resolution: ContextResolution.NAME,
        tokenCost: 5,
        estimatedUtility: 0.2,
        allowed: true,
        safety: 'SAFE',
      },
      {
        contextUnitId: unitB.id,
        resolution: ContextResolution.SIGNATURE,
        tokenCost: 25,
        estimatedUtility: 0.4,
        allowed: true,
        safety: 'SAFE',
      },
      {
        contextUnitId: unitB.id,
        resolution: ContextResolution.BODY,
        tokenCost: 200,
        estimatedUtility: 0.9,
        allowed: true,
        safety: 'SAFE',
      },
    ];

    const resolutionCurves = new Map<string, ResolutionOption[]>([
      [unitB.id, curveB],
    ]);
    const minimumUsefulResolutions = new Map<string, ContextResolution>([
      [unitB.id, ContextResolution.BODY],
    ]);

    const tightComposer = new BundleComposer({ maxTokens: 50 });
    const bundle = tightComposer.compose({
      rankedCandidates: [candB],
      units: new Map([[unitB.id, unitB]]),
      resolutionCurves,
      minimumUsefulResolutions,
    });

    assert.strictEqual(
      bundle.selectedUnitIds.length,
      0,
      'Candidate B must NOT be selected when feasible representations are below minimum useful resolution'
    );
    console.log('  ✔ Candidate correctly omitted when only representations below minimum useful resolution fit budget');
  }

  // ---------------------------------------------------------------------------
  // 3. ResolutionCapabilities: Python Decorator Case (Section 38)
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. ResolutionCapabilities: Python Decorator Case ---');
  {
    const pyUnit: ContextUnit = {
      id: 'unit_py_decorator',
      kind: ContextUnitKind.CODE_SYMBOL,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'src/handler.py',
      title: 'process_payment',
      provenance: { sourceType: 'file' },
      trustLevel: 'LOCAL_WORKSPACE_COMMITTED' as any,
      metadata: {
        hasDecorators: true,
        decorators: ['@retry', '@auth_required'],
      },
    };

    const caps = materializer.getResolutionCapabilities(pyUnit);
    assert.strictEqual(caps.skeletonSafety, 'UNSAFE', 'Python unit with decorators must have skeletonSafety: UNSAFE');
    assert.strictEqual(caps.supportsSkeleton, false, 'Python unit with decorators must have supportsSkeleton: false');
    assert.strictEqual(materializer.supports(pyUnit, ContextResolution.SKELETON), false, 'supports(unit, SKELETON) must return false');

    // Nearest safe alternative must be SIGNATURE
    const safeAlt = materializer.getNearestSafeAlternative(pyUnit, ContextResolution.SKELETON);
    assert.strictEqual(safeAlt, ContextResolution.SIGNATURE, 'Nearest safe alternative to SKELETON must be SIGNATURE');

    // Materializing with SKELETON must safely degrade to SIGNATURE
    const mat = materializer.materializeSync(pyUnit, ContextResolution.SKELETON, snapshot);
    assert.strictEqual(mat.resolution, ContextResolution.SIGNATURE, 'Materialized resolution must be SIGNATURE, never SKELETON');
    console.log('  ✔ Python decorator unit marks SKELETON as UNSAFE and degrades safely to SIGNATURE');
  }

  // ---------------------------------------------------------------------------
  // 4. ResolutionCapabilities: Rust Macro Case (Section 38)
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. ResolutionCapabilities: Rust Macro Case ---');
  {
    const rsUnit: ContextUnit = {
      id: 'unit_rs_macro',
      kind: ContextUnitKind.SOURCE_FILE,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'src/macros.rs',
      title: 'macros.rs',
      provenance: { sourceType: 'file' },
      trustLevel: 'LOCAL_WORKSPACE_COMMITTED' as any,
      metadata: {
        hasMacros: true,
      },
    };

    const caps = materializer.getResolutionCapabilities(rsUnit);
    assert.strictEqual(caps.skeletonSafety, 'UNSAFE', 'Rust unit with macros must have skeletonSafety: UNSAFE');
    assert.strictEqual(caps.supportsSkeleton, false, 'Rust unit with macros must have supportsSkeleton: false');
    assert.strictEqual(materializer.supports(rsUnit, ContextResolution.SKELETON), false, 'supports(unit, SKELETON) must return false');

    // Resolution curve must mark SKELETON as allowed: false, safety: UNSAFE
    const curve = estimator.computeResolutionCurve(rsUnit, snapshot);
    const skelOpt = curve.find((o) => o.resolution === ContextResolution.SKELETON);
    assert.ok(skelOpt !== undefined, 'SKELETON option must exist in curve');
    assert.strictEqual(skelOpt!.allowed, false, 'SKELETON option must not be allowed');
    assert.strictEqual(skelOpt!.safety, 'UNSAFE', 'SKELETON option must be marked UNSAFE');

    // Materializer must degrade to SIGNATURE
    const mat = materializer.materializeSync(rsUnit, ContextResolution.SKELETON, snapshot);
    assert.strictEqual(mat.resolution, ContextResolution.SIGNATURE, 'Rust macro unit must degrade SKELETON to SIGNATURE');
    console.log('  ✔ Rust macro unit marks SKELETON as UNSAFE and degrades safely to SIGNATURE');
  }

  // ---------------------------------------------------------------------------
  // 5. ResolutionCapabilities: Module Initialization Case (Section 38)
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. ResolutionCapabilities: Module Initialization Case ---');
  {
    const initUnit: ContextUnit = {
      id: 'unit_py_init',
      kind: ContextUnitKind.SOURCE_FILE,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'src/__init__.py',
      title: '__init__.py',
      provenance: { sourceType: 'file' },
      trustLevel: 'LOCAL_WORKSPACE_COMMITTED' as any,
      metadata: {
        isModuleInit: true,
        hasTopLevelCode: true,
      },
    };

    const caps = materializer.getResolutionCapabilities(initUnit);
    assert.strictEqual(caps.skeletonSafety, 'UNSAFE', 'Module init unit must have skeletonSafety: UNSAFE');
    assert.strictEqual(materializer.supports(initUnit, ContextResolution.SKELETON), false, 'supports(unit, SKELETON) must return false');

    const safeAlt = materializer.getNearestSafeAlternative(initUnit, ContextResolution.SKELETON);
    assert.strictEqual(safeAlt, ContextResolution.SIGNATURE, 'Nearest safe alternative must be SIGNATURE');
    console.log('  ✔ Module initialization unit marks SKELETON as UNSAFE and degrades safely to SIGNATURE');
  }

  // ---------------------------------------------------------------------------
  // 6. Non-Code Config Degradation Safety
  // ---------------------------------------------------------------------------
  console.log('\n--- 6. Non-Code Artifact Safety ---');
  {
    const configUnit: ContextUnit = {
      id: 'unit_config',
      kind: ContextUnitKind.CONFIG,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'config.json',
      title: 'config.json',
      provenance: { sourceType: 'file' },
      trustLevel: 'LOCAL_WORKSPACE_COMMITTED' as any,
      metadata: {},
    };

    const caps = materializer.getResolutionCapabilities(configUnit);
    assert.strictEqual(caps.supportsSkeleton, false, 'CONFIG must not support SKELETON');
    assert.strictEqual(caps.supportsSignature, false, 'CONFIG must not support SIGNATURE');
    assert.strictEqual(caps.supportsName, true, 'CONFIG must support NAME');

    const safeAlt = materializer.getNearestSafeAlternative(configUnit, ContextResolution.SKELETON);
    assert.strictEqual(safeAlt, ContextResolution.NAME, 'Non-code CONFIG must degrade to NAME');
    console.log('  ✔ Non-code CONFIG unit degrades safely to NAME, rejecting both SKELETON and SIGNATURE');
  }

  // ---------------------------------------------------------------------------
  // 7. BudgetSolver & ResolutionRanker Invariant Protection
  // ---------------------------------------------------------------------------
  console.log('\n--- 7. BudgetSolver & ResolutionRanker Safety Invariants ---');
  {
    const pyUnit: ContextUnit = {
      id: 'unit_py_decorator_rank',
      kind: ContextUnitKind.SOURCE_FILE,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'src/handler.py',
      title: 'handler.py',
      provenance: { sourceType: 'file' },
      trustLevel: 'LOCAL_WORKSPACE_COMMITTED' as any,
      metadata: {
        hasDecorators: true,
        tokenEstimate: 200,
      },
    };

    const features: ContextFeaturesV1 = {
      contextUnitId: pyUnit.id,
      featureCutoff: { timestamp: new Date().toISOString(), snapshotId: snapshot.workspaceSnapshotId },
      tokenEstimate: 200,
      inStackTrace: false,
      isFailingTestTarget: false,
      inCompilerError: false,
      inDirtyDiff: false,
      isDirectDependency: false,
      isDirectDependent: false,
      minDistanceToSeed: 2, // Would ordinarily trigger SKELETON under moderate pressure
      heuristicScore: 5.0,
      lexicalScore: 0.5,
      graphScore: 0.5,
      gitScore: 0.0,
    } as any;

    // Allocate resolution under budget pressure
    const alloc = ranker.allocateResolution(pyUnit, features, false, 1.3);
    assert.notStrictEqual(alloc.resolution, ContextResolution.SKELETON, 'ResolutionRanker must NEVER allocate SKELETON to an unsafe unit');
    assert.strictEqual(alloc.resolution, ContextResolution.SIGNATURE, 'ResolutionRanker must allocate SIGNATURE instead of SKELETON');
    assert.strictEqual(alloc.safetyLevel, 'UNSAFE');

    // Test BudgetSolver constrained degradation
    const solver = new BudgetSolver(ranker);
    const plan = solver.solve({
      selectedUnitIds: [pyUnit.id],
      units: new Map([[pyUnit.id, pyUnit]]),
      features: new Map([[pyUnit.id, features]]),
      limits: { maxTokens: 50 },
    });

    for (const a of plan.allocations) {
      assert.notStrictEqual(a.resolution, ContextResolution.SKELETON, 'BudgetSolver must NEVER allocate SKELETON to an unsafe unit');
    }
    console.log('  ✔ ResolutionRanker & BudgetSolver strictly prevent SKELETON allocation on UNSAFE units');
  }

  // Cleanup
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup error
  }

  console.log('\n🎉 All Bundle/Resolution Coordination & ResolutionCapabilities tests passed successfully!');
}

if (require.main === module) {
  runBundleResolutionCoordinationTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}
