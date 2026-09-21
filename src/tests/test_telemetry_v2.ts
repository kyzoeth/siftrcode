/**
 * SiftrCode V2 - Telemetry Schema V2 & Outcome-Learning Evidence Tests
 * Verifies Remediation PR 6:
 * 1. Quarantine of binary production training export (Section 17)
 * 2. CandidateObservationV2 schema & linkages (Section 18, 24)
 * 3. ExposureDecisionV2 & mandatory policy identity (Section 19, 20)
 * 4. True selection propensity / probability (Section 21)
 * 5. LabelEvidence vs simplistic 0/1 binary labeling (Section 22)
 * 6. Observability-aware outcome safety (Section 23)
 * 7. ContextEngine integration with V2 telemetry
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ContextResolution } from '../context/context_resolution';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import {
  ExposureDecisionV2,
  createExposureDecisionV2,
  isExposedV2,
} from '../telemetry/exposure_decision';
import {
  CandidateObservationV2,
  createCandidateObservationV2,
  computeLabelEvidence,
  isTrainingExportQuarantined,
  exportTrainingExamples,
  createCandidateObservation,
} from '../telemetry/candidate_observation';
import { ContextEngine } from '../engine/context_engine';
import { createTaskContext } from '../context/task_context';
import { createAgentEnvironment } from '../agents/agent_environment';
import { ContextUnit, CodeSymbolUnit, ContextUnitKind, SymbolKind } from '../context/context_unit';
import { TrustLevel } from '../security/trust';
import { createDefaultDataRights } from '../rights/data_rights';
import { createWorkspaceSnapshot } from '../workspace/workspace_snapshot';
import { DefaultWorkspaceSourceReader } from '../workspace/workspace_source_reader';
import { DefaultContextUnitMaterializer } from '../materialization/context_unit_materializer';
import { DefaultTokenCostEstimator } from '../token/token_cost_estimator';

export async function runTelemetryV2Tests(): Promise<void> {
  console.log('\n=== Running V2 Telemetry Schema & Learning-Plane Tests (Remediation PR 6) ===');

  const mockFeatures: ContextFeaturesV1 = {
    schemaVersion: 'v1',
    contextUnitId: 'unit_redis_lock',
    unitKind: ContextUnitKind.CODE_SYMBOL,
    tokenEstimate: 150,
    isTest: false,
    isConfig: false,
    isDocumentation: false,
    isSchema: false,
    isExported: true,
    exactSymbolMatch: true,
    exactPathMatch: true,
    bm25Score: 0.95,
    tokenOverlapRatio: 0.8,
    graphDegree: 4,
    minDistanceToSeed: 0,
    minDistanceToErrorFrame: 0,
    isDirectDependency: true,
    isDirectDependent: false,
    changeFrequency: 5,
    recentChangeFrequency: 2,
    maxCoChangeWithSeeds: 0.7,
    inStackTrace: true,
    isFailingTestTarget: false,
    inCompilerError: false,
    inDirtyDiff: false,
    heuristicScore: 85.0,
  };

  // ---------------------------------------------------------------------------
  // 1. Quarantined Binary Training Export (Section 17)
  // ---------------------------------------------------------------------------
  console.log('\n--- 1. Quarantined Binary Training Export ---');
  {
    assert.strictEqual(isTrainingExportQuarantined(), true, 'Binary training export must be marked quarantined');

    const v1Obs = createCandidateObservation({
      taskId: 'task_legacy',
      contextUnitId: 'unit_legacy',
      wasExposed: true,
      exposureResolution: ContextResolution.BODY,
      wasInspectedByAgent: true,
      wasEditedByAgent: false,
      wasInFailureTrace: false,
      features: mockFeatures,
      dataRights: createDefaultDataRights({ trainingAllowed: true }),
    });

    // Should warn on call but still function for legacy debug consumption
    const exported = exportTrainingExamples([v1Obs]);
    assert.strictEqual(exported.length, 1);
    assert.strictEqual(exported[0].label, 1);
    console.log('  ✔ Binary training export quarantined from production training pipeline');
  }

  // ---------------------------------------------------------------------------
  // 2. ExposureDecisionV2 & Mandatory Policy Identity (Section 19, 20)
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. ExposureDecisionV2 & Mandatory Policy Identity ---');
  {
    // Deterministic selection
    const decisionDet = createExposureDecisionV2({
      contextUnitId: 'unit_redis_lock',
      eligibleForSelection: true,
      selected: true,
      candidateRank: 1,
      finalBundleRank: 1,
      resolution: ContextResolution.BODY,
      actualTokenCost: 120,
      contextPlanId: 'cplan_001',
      policyId: 'siftr-deterministic',
      policyVersion: '2.1.0',
    });

    assert.strictEqual(decisionDet.policyId, 'siftr-deterministic', 'Policy identity must be recorded');
    assert.strictEqual(decisionDet.policyVersion, '2.1.0', 'Policy version must be recorded');
    assert.strictEqual(decisionDet.selectionProbability, 1.0, 'Deterministic selected item has propensity 1.0');
    assert.strictEqual(isExposedV2(decisionDet), true, 'BODY resolution is exposed');

    // Deterministic unselected / omitted
    const decisionOmit = createExposureDecisionV2({
      contextUnitId: 'unit_unrelated',
      eligibleForSelection: true,
      selected: false,
      candidateRank: 15,
      resolution: ContextResolution.OMIT,
      actualTokenCost: 0,
      contextPlanId: 'cplan_001',
    });
    assert.strictEqual(decisionOmit.selectionProbability, undefined, 'Unselected deterministic candidate has no propensity');
    assert.strictEqual(isExposedV2(decisionOmit), false, 'OMIT resolution is not exposed');

    // Exploration policy with true propensity (Section 21)
    const decisionExplore = createExposureDecisionV2({
      contextUnitId: 'unit_exp_1',
      eligibleForSelection: true,
      selected: true,
      candidateRank: 5,
      resolution: ContextResolution.SKELETON,
      actualTokenCost: 40,
      contextPlanId: 'cplan_exp',
      policyId: 'siftr-eps-greedy',
      policyVersion: '1.0.0',
      selectionProbability: 0.25,
      explorationPolicy: 'uniform_random_sample',
    });
    assert.strictEqual(decisionExplore.selectionProbability, 0.25, 'Exploration propensity strictly preserved');
    assert.strictEqual(decisionExplore.explorationPolicy, 'uniform_random_sample');
    console.log('  ✔ Mandatory policy identity and true propensities strictly recorded');
  }

  // ---------------------------------------------------------------------------
  // 3. LabelEvidence vs Simplistic 0/1 (Section 22)
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. LabelEvidence vs Simplistic Binary Labeling ---');
  {
    const exposure = createExposureDecisionV2({
      contextUnitId: 'unit_auth',
      eligibleForSelection: true,
      selected: true,
      resolution: ContextResolution.FULL,
      contextPlanId: 'cplan_002',
    });

    // Case A: Agent edited unit
    const editResult = computeLabelEvidence({
      exposure,
      observabilityLevel: 'FULL_TOOL_TRACE',
      observedBehavior: { edited: true },
    });
    assert.strictEqual(editResult.outcomeLabel, 'POSITIVE');
    assert.strictEqual(editResult.evidence.length, 1);
    assert.strictEqual(editResult.evidence[0].labelType, 'EDITED');
    assert.strictEqual(editResult.evidence[0].strength, 'STRONG');
    assert.strictEqual(editResult.evidence[0].value, 1.0);
    assert.ok(editResult.evidence[0].confidence >= 0.9);

    // Case B: Agent read unit and appeared in failure trace
    const multiSignal = computeLabelEvidence({
      exposure,
      observabilityLevel: 'FULL_TOOL_TRACE',
      observedBehavior: { read: true, appearedInFailureTrace: true },
    });
    assert.strictEqual(multiSignal.outcomeLabel, 'POSITIVE');
    assert.strictEqual(multiSignal.evidence.length, 2);
    assert.ok(multiSignal.evidence.some((e) => e.labelType === 'READ'));
    assert.ok(multiSignal.evidence.some((e) => e.labelType === 'FAILURE_TRACE'));

    console.log('  ✔ Structured LabelEvidence preserves multiple signals, strengths, and confidences');
  }

  // ---------------------------------------------------------------------------
  // 4. Observability-Aware Safety (Section 23 - Critical Invariant)
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. Observability-Aware Safety & False-Negative Prevention ---');
  {
    const exposedDecision = createExposureDecisionV2({
      contextUnitId: 'unit_db_helper',
      eligibleForSelection: true,
      selected: true,
      resolution: ContextResolution.BODY,
      contextPlanId: 'cplan_003',
    });

    // Invariant 1: SIFTR_CALLS_ONLY with no observed read must be UNKNOWN, NEVER negative
    const mcpResult = computeLabelEvidence({
      exposure: exposedDecision,
      observabilityLevel: 'SIFTR_CALLS_ONLY',
      observedBehavior: { read: false, edited: false },
      taskSucceeded: true,
    });
    assert.strictEqual(
      mcpResult.outcomeLabel,
      'UNKNOWN',
      'SIFTR_CALLS_ONLY with no interaction MUST be UNKNOWN, never NEGATIVE'
    );
    assert.strictEqual(mcpResult.evidence.length, 0, 'No negative evidence inferred under SIFTR_CALLS_ONLY');

    // Invariant 2: PARTIAL_AGENT_TRACE must also be UNKNOWN
    const partialResult = computeLabelEvidence({
      exposure: exposedDecision,
      observabilityLevel: 'PARTIAL_AGENT_TRACE',
      observedBehavior: { read: false, edited: false },
      taskSucceeded: true,
    });
    assert.strictEqual(partialResult.outcomeLabel, 'UNKNOWN');

    // Invariant 3: FULL_TOOL_TRACE + Task Succeeded -> WEAK_NEGATIVE (not hard causal negative)
    const fullSuccessResult = computeLabelEvidence({
      exposure: exposedDecision,
      observabilityLevel: 'FULL_TOOL_TRACE',
      observedBehavior: { read: false, edited: false },
      taskSucceeded: true,
    });
    assert.strictEqual(fullSuccessResult.outcomeLabel, 'WEAK_NEGATIVE');
    assert.strictEqual(fullSuccessResult.evidence.length, 1);
    assert.strictEqual(fullSuccessResult.evidence[0].strength, 'WEAK');
    assert.strictEqual(fullSuccessResult.evidence[0].confidence, 0.5);

    // Invariant 4: FULL_TOOL_TRACE + Task Failed -> UNKNOWN (cannot assume unreferenced unit was bad)
    const fullFailResult = computeLabelEvidence({
      exposure: exposedDecision,
      observabilityLevel: 'FULL_TOOL_TRACE',
      observedBehavior: { read: false, edited: false },
      taskSucceeded: false,
    });
    assert.strictEqual(fullFailResult.outcomeLabel, 'UNKNOWN');

    // Invariant 5: Unexposed unit is ALWAYS UNEXPOSED_UNKNOWN
    const unexposedDecision = createExposureDecisionV2({
      contextUnitId: 'unit_unexposed',
      eligibleForSelection: false,
      selected: false,
      resolution: ContextResolution.OMIT,
      contextPlanId: 'cplan_003',
    });
    const unexpResult = computeLabelEvidence({
      exposure: unexposedDecision,
      observabilityLevel: 'FULL_TOOL_TRACE',
      observedBehavior: { read: false, edited: false },
      taskSucceeded: true,
    });
    assert.strictEqual(
      unexpResult.outcomeLabel,
      'UNEXPOSED_UNKNOWN',
      'Unexposed candidate must strictly be UNEXPOSED_UNKNOWN'
    );

    console.log('  ✔ Section 23 invariants strictly satisfied: unexposed is UNEXPOSED_UNKNOWN, SIFTR_CALLS_ONLY is UNKNOWN');
  }

  // ---------------------------------------------------------------------------
  // 5. CandidateObservationV2 Complete Record Creation (Section 18 & 24)
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. CandidateObservationV2 Complete Record Creation ---');
  {
    const exposure = createExposureDecisionV2({
      contextUnitId: 'unit_user_service',
      eligibleForSelection: true,
      selected: true,
      candidateRank: 2,
      finalBundleRank: 2,
      resolution: ContextResolution.BODY,
      actualTokenCost: 110,
      contextPlanId: 'cplan_004',
      policyId: 'siftr-deterministic',
      policyVersion: '2.1.0',
    });

    const obsV2 = createCandidateObservationV2({
      taskId: 'task_004',
      siftrSessionId: 'sess_004',
      workspaceSnapshotId: 'snap_004',
      contextUnitId: 'unit_user_service',
      agentEnvironmentId: 'env_claude_code_v1',
      observabilityLevel: 'FULL_TOOL_TRACE',
      features: mockFeatures,
      candidate: {
        generated: true,
        candidateRank: 2,
        retrievalSources: ['GRAPH_EXPANSION', 'CO_CHANGE'],
      },
      exposure,
      observedBehavior: { read: true, edited: true },
      rightsReference: 'rights_customer_enterprise',
      taskSucceeded: true,
    });

    assert.strictEqual(obsV2.schemaVersion, '2', 'Schema version must be 2');
    assert.ok(obsV2.observationId.startsWith('cobs_'), 'ObservationId has valid prefix');
    assert.strictEqual(obsV2.agentEnvironmentId, 'env_claude_code_v1');
    assert.strictEqual(obsV2.observabilityLevel, 'FULL_TOOL_TRACE');
    assert.strictEqual(obsV2.featureSchemaVersion, '1.0.0');
    assert.strictEqual(obsV2.outcomeLabel, 'POSITIVE');
    assert.ok(obsV2.evidence.length >= 1);
    assert.strictEqual(obsV2.candidate.retrievalSources.length, 2);
    assert.strictEqual(obsV2.rightsReference, 'rights_customer_enterprise');
    assert.ok(Date.parse(obsV2.recordedAt) > 0, 'recordedAt is valid ISO timestamp');

    console.log('  ✔ CandidateObservationV2 captures complete lineage, environment, and evidence');
  }

  // ---------------------------------------------------------------------------
  // 6. ContextEngine End-to-End V2 Telemetry Generation
  // ---------------------------------------------------------------------------
  console.log('\n--- 6. ContextEngine End-to-End V2 Telemetry Generation ---');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_engine_v2_'));
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'lock.ts'),
      'export class LockManager { acquire() { return true; } }\n'
    );

    const snapshot = createWorkspaceSnapshot({
      repositories: [
        {
          repositoryId: 'root',
          baseCommitSha: 'sha_test',
          trackedTreeHash: 'tree_test',
          dirtyPatchHash: 'clean',
        },
      ],
    });

    const reader = new DefaultWorkspaceSourceReader(tmpDir);
    const materializer = new DefaultContextUnitMaterializer(reader);
    const estimator = new DefaultTokenCostEstimator(materializer);

    const engine = new ContextEngine({
      repoRootDir: tmpDir,
      materializer,
      tokenCostEstimator: estimator,
    });

    const unit: CodeSymbolUnit = {
      id: 'unit_lock',
      kind: ContextUnitKind.CODE_SYMBOL,
      symbolName: 'acquire',
      symbolKind: SymbolKind.METHOD,
      qualifiedName: 'LockManager.acquire',
      language: 'typescript',
      contentHash: 'hash_lock',
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      path: 'src/lock.ts',
      title: 'LockManager.acquire',
      provenance: { sourceType: 'file' },
      trustLevel: TrustLevel.FIRST_PARTY_CODE,
      metadata: {},
      startLine: 1,
      endLine: 1,
    };

    const task = createTaskContext({
      taskId: 'task_v2_telemetry',
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      primaryPrompt: 'Fix lock acquire',
      agentEnvironment: createAgentEnvironment({
        agentProvider: 'anthropic',
        agentVersion: '1.0.0',
        model: 'claude-3-5-sonnet-20241022',
        harnessVersion: 'v2',
        availableTools: ['read_file', 'edit_file'],
      }),
    });

    const plan = engine.generatePlan({
      task,
      units: [unit],
      snapshot,
    });

    assert.ok(plan.exposureDecisionsV2 !== undefined, 'ContextPlan must contain exposureDecisionsV2');
    assert.strictEqual(plan.policyId, 'siftr-deterministic', 'ContextPlan contains policyId');
    assert.strictEqual(plan.policyVersion, '2.1.0', 'ContextPlan contains policyVersion');

    const expV2 = plan.exposureDecisionsV2.find((ed) => ed.contextUnitId === unit.id);
    assert.ok(expV2 !== undefined, 'Unit exposure decision V2 is recorded');
    assert.strictEqual(expV2!.policyId, 'siftr-deterministic');
    assert.strictEqual(expV2!.policyVersion, '2.1.0');
    assert.strictEqual(expV2!.selectionProbability, 1.0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('  ✔ ContextEngine automatically produces V2 exposure decisions with policy identity');
  }

  console.log('\n🎉 All Telemetry Schema V2 & Learning-Plane tests passed successfully!');
}

if (require.main === module) {
  runTelemetryV2Tests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}
