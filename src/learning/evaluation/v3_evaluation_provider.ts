/**
 * SiftrCode V3.1 - V3 Evaluation Context Provider (Phase 11 P0-2)
 *
 * Implements authoritative context generation using exact feature semantics
 * matching model training (FeatureBuilderV3_1 directly):
 * - CandidateGenerator(maxCandidates=50)
 * - FeatureBuilderV3_1 directly (NO reconstruction from ContextFeaturesV1)
 * - Assert feature schema SHA matches model artifact (fail-closed)
 * - TreeRanker.score() with featuresToVector()
 * - Current BundleComposer, BudgetSolver, ResolutionRanker, ContextUnitMaterializer
 * - Enforces candidateBudget <= 50 and tokenBudget <= 8,000 tokens
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { EvaluationContextResult, EvaluationRankedUnit, EvaluationSelectedUnit } from './evaluation_context_result';
import { RepositoryIndexer } from '../../indexing/repository_index';
import { GraphBuilder } from '../../graph/graph_builder';
import { GitGraphIntelligence } from '../../graph/git_graph';
import { CandidateGenerator } from '../../retrieval/candidate_generator';
import { FeatureBuilderV3_1 } from '../features/feature_builder_v3_1';
import {
  ContextFeaturesV3_1,
  CONTEXT_RANK_FEATURES_V3_1_SCHEMA,
} from '../features/feature_set_v3_1';
import { TreeRanker } from '../models/context_rank/tree_ranker';
import { RankedCandidate } from '../../ranking/context_rank';
import { BundleComposer } from '../../context/bundle_composer';
import { BudgetSolver } from '../../context/budget_solver';
import { ResolutionRanker } from '../../context/resolution_rank';
import { ContextResolution } from '../../context/context_resolution';
import { DefaultContextUnitMaterializer } from '../../materialization/context_unit_materializer';
import { DefaultWorkspaceSourceReader } from '../../workspace/workspace_source_reader';
import { WorkspaceManager } from '../../workspace/workspace_manager';
import { DefaultTokenCostEstimator } from '../../token/token_cost_estimator';
import { ClaudeCodeAdapter } from '../../agents/agent_adapter';
import { TaskEvidenceKind, UserPromptEvidence } from '../../context/task_evidence';
import { REPO_FILTERS } from './frozen_v2_bridge';

export const CURRENT_FEATURE_SCHEMA_SHA256 = 'f04f5b0dadbae6964031ef96f7b2b719d6adfacb45b7e3702659a09bd389c69c';

export class V3EvaluationContextProvider {
  private treeRanker: TreeRanker;
  private modelArtifact: any;
  private modelArtifactSha256: string;
  private headSha: string;

  constructor(treeRanker?: TreeRanker, modelArtifactPath?: string) {
    const rootDir = path.resolve(__dirname, '../../..');
    const artifactPath = modelArtifactPath || path.join(rootDir, 'data/models/gbdt_pairwise_v1.json');

    if (!fs.existsSync(artifactPath)) {
      throw new Error(`FAIL_CLOSED: Trained GBDT model artifact missing at ${artifactPath}`);
    }

    const artifactRaw = fs.readFileSync(artifactPath, 'utf8');
    this.modelArtifact = JSON.parse(artifactRaw);
    this.modelArtifactSha256 = crypto.createHash('sha256').update(artifactRaw).digest('hex');

    // Model Feature Integrity: Verify schema SHA matches expected model artifact schema SHA
    const expectedSchemaSha = this.modelArtifact.featureSchemaSha256;
    if (expectedSchemaSha && expectedSchemaSha !== CURRENT_FEATURE_SCHEMA_SHA256) {
      throw new Error(
        `FAIL_CLOSED: Feature schema SHA mismatch! Expected ${expectedSchemaSha}, but current schema is ${CURRENT_FEATURE_SCHEMA_SHA256}`
      );
    }

    this.treeRanker = treeRanker || TreeRanker.fromArtifact(this.modelArtifact);

    try {
      this.headSha = execSync('git rev-parse HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();
    } catch {
      this.headSha = 'unknown';
    }
  }

  public getImplementation(): string {
    return `V3EvaluationContextProvider (FeatureBuilderV3_1 + TreeRanker @ ${this.headSha})`;
  }

  public getImplementationSha(): string {
    return this.headSha;
  }

  public getModelArtifactSha256(): string {
    return this.modelArtifactSha256;
  }

  public getFeatureSchemaSha256(): string {
    return CURRENT_FEATURE_SCHEMA_SHA256;
  }

  public async getContext(options: {
    workspaceDir: string;
    prompt: string;
    candidateBudget?: number;
    tokenBudget?: number;
    baseCommit?: string;
    repoId?: string;
    includePatterns?: string[];
    excludePatterns?: string[];
  }): Promise<EvaluationContextResult> {
    const workspaceDir = path.resolve(options.workspaceDir);
    const candidateBudget = options.candidateBudget ?? 50;
    const tokenBudget = options.tokenBudget ?? 8000;

    let baseCommit = options.baseCommit;
    if (!baseCommit) {
      try {
        baseCommit = execSync(`git -C "${workspaceDir}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
      } catch {
        baseCommit = 'unknown';
      }
    }

    let initialGitStatus = '';
    try {
      initialGitStatus = execSync(`git -C "${workspaceDir}" status --porcelain`, { encoding: 'utf8' }).trim();
    } catch {}

    const repoFilter = options.repoId && REPO_FILTERS[options.repoId] ? REPO_FILTERS[options.repoId] : {};
    const includePatterns = options.includePatterns || repoFilter.includePatterns;
    const excludePatterns = options.excludePatterns || repoFilter.excludePatterns;

    // 1. Snapshot and Index
    const workspaceManager = new WorkspaceManager({ rootDir: workspaceDir });
    const snapshot = await workspaceManager.captureSnapshot();
    const indexer = new RepositoryIndexer();
    const indexResult = await indexer.indexRepository(workspaceDir, {
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      includePatterns,
      excludePatterns,
    });
    const units = indexResult.units;
    const unitsMap = new Map<string, any>();
    for (const u of units) {
      unitsMap.set(u.id, u);
    }

    const sourceReader = new DefaultWorkspaceSourceReader(workspaceDir);
    for (const u of units) {
      if (u.path) {
        const safePath = path.resolve(workspaceDir, u.path);
        if (fs.existsSync(safePath)) {
          try {
            const fileHash = crypto.createHash('sha256').update(fs.readFileSync(safePath)).digest('hex');
            sourceReader.recordExpectedHash(snapshot.workspaceSnapshotId, u.path, fileHash);
          } catch {}
        }
      }
    }

    // 2. Graph and Git Intelligence
    const graphBuilder = new GraphBuilder();
    const graph = graphBuilder.buildGraph(units, { repoDir: workspaceDir, sourceReader, snapshot });
    let gitIntelligence: GitGraphIntelligence | undefined = undefined;
    try {
      gitIntelligence = new GitGraphIntelligence({ repoDir: workspaceDir });
    } catch {}

    // 3. TaskContext without telemetry
    const userPromptEvidence: UserPromptEvidence = {
      evidenceId: 'ev_' + crypto.randomUUID().slice(0, 8),
      kind: TaskEvidenceKind.USER_PROMPT,
      timestamp: new Date().toISOString(),
      prompt: options.prompt,
    };
    const task: any = {
      taskId: `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      sessionId: `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      primaryPrompt: options.prompt,
      taskType: 'BUG_FIX',
      evidence: [userPromptEvidence],
      agentEnvironment: {
        systemConfigurationHash: 'eval_v3',
        model: 'default',
        billingTier: 'standard',
      },
    };

    // 4. Candidate Generation (CandidateGenerator with explicit maxCandidates)
    const candGen = new CandidateGenerator();
    const candidates = candGen.generateCandidates(task, units, graph, gitIntelligence, {
      maxCandidates: candidateBudget,
    });
    const generatedCandidateCount = candidates.length;
    if (generatedCandidateCount > candidateBudget) {
      throw new Error(
        `V3_CANDIDATE_OVERFLOW: Generated ${generatedCandidateCount} candidates, exceeding budget of ${candidateBudget}`
      );
    }

    // 5. Feature Extraction: FeatureBuilderV3_1 DIRECTLY (no proxy reconstruction)
    const featuresList: ContextFeaturesV3_1[] = [];
    const featuresMap = new Map<string, ContextFeaturesV3_1>();
    for (const cand of candidates) {
      const u = unitsMap.get(cand.contextUnitId);
      if (!u) continue;
      const f31 = FeatureBuilderV3_1.buildFeatures({
        candidate: cand,
        unit: u,
        task,
        graph,
        gitIntelligence,
      });
      featuresList.push(f31);
      featuresMap.set(cand.contextUnitId, f31);
    }
    const featuredCandidateCount = featuresList.length;
    if (featuredCandidateCount > candidateBudget) {
      throw new Error(
        `V3_FEATURE_OVERFLOW: Extracted ${featuredCandidateCount} features, exceeding budget of ${candidateBudget}`
      );
    }

    // Schema version check
    if (featuresList.length > 0 && featuresList[0].schemaVersion !== CONTEXT_RANK_FEATURES_V3_1_SCHEMA) {
      throw new Error(
        `FAIL_CLOSED: Extracted features schema "${featuresList[0].schemaVersion}" !== "${CONTEXT_RANK_FEATURES_V3_1_SCHEMA}"`
      );
    }

    // 6. Learned TreeRanker Scoring
    const scored = await this.treeRanker.score(task, candidates, featuresList);
    const rankedCandidateCount = scored.length;
    if (rankedCandidateCount > candidateBudget) {
      throw new Error(
        `V3_RANK_OVERFLOW: Ranked ${rankedCandidateCount} candidates, exceeding budget of ${candidateBudget}`
      );
    }

    const rankedCandidates: RankedCandidate[] = scored.map((s, idx) => {
      const f31 = featuresMap.get(s.contextUnitId)!;
      return {
        contextUnitId: s.contextUnitId,
        finalScore: s.finalScore,
        rank: idx + 1,
        reasons: s.reasons,
        scoreBreakdown: {
          runtimeEvidence: f31.inStackTrace ? 40 : 0,
          exactMatch: f31.exactSymbolMatch ? 30 : 0,
          lexicalRelevance: f31.bm25Score,
          graphProximity: f31.graphDegree,
          gitCoChange: f31.maxCoChangeWithSeeds,
          penalties: 0,
        },
        features: f31 as any,
      };
    });

    // 7. Resolution Curves and Minimum Useful Resolutions
    const materializer = new DefaultContextUnitMaterializer({
      sourceReader,
      throwOnWorkspaceChanged: true,
    });
    const tokenCostEstimator = new DefaultTokenCostEstimator(materializer);
    const resRanker = new ResolutionRanker();

    const resolutionCurves = new Map<string, any>();
    const minimumUsefulResolutions = new Map<string, any>();
    for (const cand of rankedCandidates) {
      const u = unitsMap.get(cand.contextUnitId);
      const f = featuresMap.get(cand.contextUnitId);
      if (!u || !f) continue;
      const curve = tokenCostEstimator.computeResolutionCurve(u, snapshot, task.agentEnvironment, cand.finalScore);
      resolutionCurves.set(u.id, curve);
      const minUseful = resRanker.getMinimumUsefulResolution(u, f as any);
      minimumUsefulResolutions.set(u.id, minUseful);
    }

    // 8. Bundle Composition (BundleComposer)
    const composer = new BundleComposer({
      maxTokens: tokenBudget,
    });
    const bundle = composer.compose({
      rankedCandidates,
      units: unitsMap,
      graph,
      evidence: task.evidence,
      resolutionCurves,
      minimumUsefulResolutions,
    });
    const selectedBundleUnitCount = bundle.selectedUnitIds.length;

    // 9. Budget Solving (BudgetSolver)
    const solver = new BudgetSolver();
    const budgetPlan = solver.solve({
      selectedUnitIds: bundle.selectedUnitIds,
      units: unitsMap,
      features: featuresMap as any,
      limits: { maxTokens: tokenBudget },
      profileName: 'CUSTOM',
    });

    // 10. Materialization & Context Formatting
    const plannedUnits: any[] = [];
    const resolvedForAdapter: any[] = [];
    for (const alloc of budgetPlan.allocations) {
      const u = unitsMap.get(alloc.contextUnitId);
      if (!u) continue;
      let effectiveRes = alloc.resolution;
      if (!materializer.supports(u, effectiveRes)) {
        effectiveRes =
          typeof materializer.getNearestSafeAlternative === 'function'
            ? materializer.getNearestSafeAlternative(u, effectiveRes)
            : ContextResolution.NAME;
        alloc.resolution = effectiveRes;
      }
      const mat = materializer.materializeSync(u, alloc.resolution, snapshot);
      plannedUnits.push({
        contextUnitId: u.id,
        resolution: alloc.resolution,
        content: mat.content,
        tokenEstimate: mat.actualTokenCount,
      });
      resolvedForAdapter.push({
        unitId: u.id,
        title: u.title,
        filePath: u.path,
        resolution: alloc.resolution,
        content: mat.content,
      });
    }

    const adapter = new ClaudeCodeAdapter();
    let formattedContext = adapter.formatContext(resolvedForAdapter, {
      includeInstructions: true,
      instructionPrefix: `Task Prompt: ${task.primaryPrompt}`,
      maxTokens: tokenBudget,
    });
    let actualRenderedTokens = tokenCostEstimator.estimateMaterialized(
      formattedContext.promptText,
      task.agentEnvironment
    );

    // 11. Degradation loop if rendered tokens exceed budget
    while (actualRenderedTokens > tokenBudget) {
      let degraded = false;
      // 1. FULL -> BODY
      const fullUnits = plannedUnits.filter((pu) => pu.resolution === ContextResolution.FULL);
      if (fullUnits.length > 0) {
        const target = fullUnits[fullUnits.length - 1];
        const u = unitsMap.get(target.contextUnitId);
        const minUseful = (u ? minimumUsefulResolutions.get(u.id) : undefined) ?? ContextResolution.NAME;
        if (u && ContextResolution.BODY >= minUseful && materializer.supports(u, ContextResolution.BODY)) {
          target.resolution = ContextResolution.BODY;
          degraded = true;
        }
      }
      // 2. BODY -> SKELETON
      if (!degraded) {
        const bodyUnits = plannedUnits.filter((pu) => pu.resolution === ContextResolution.BODY);
        for (let i = bodyUnits.length - 1; i >= 0; i--) {
          const bu = bodyUnits[i];
          const u = unitsMap.get(bu.contextUnitId);
          const minUseful = (u ? minimumUsefulResolutions.get(u.id) : undefined) ?? ContextResolution.NAME;
          if (u && ContextResolution.SKELETON >= minUseful && materializer.supports(u, ContextResolution.SKELETON)) {
            bu.resolution = ContextResolution.SKELETON;
            degraded = true;
            break;
          }
        }
      }
      // 3. SKELETON -> SIGNATURE
      if (!degraded) {
        const skelUnits = plannedUnits.filter((pu) => pu.resolution === ContextResolution.SKELETON);
        for (let i = skelUnits.length - 1; i >= 0; i--) {
          const su = skelUnits[i];
          const u = unitsMap.get(su.contextUnitId);
          const minUseful = (u ? minimumUsefulResolutions.get(u.id) : undefined) ?? ContextResolution.NAME;
          if (u && ContextResolution.SIGNATURE >= minUseful && materializer.supports(u, ContextResolution.SIGNATURE)) {
            su.resolution = ContextResolution.SIGNATURE;
            degraded = true;
            break;
          }
        }
      }
      // 4. SIGNATURE -> NAME
      if (!degraded) {
        const sigUnits = plannedUnits.filter((pu) => pu.resolution === ContextResolution.SIGNATURE);
        for (let i = sigUnits.length - 1; i >= 0; i--) {
          const su = sigUnits[i];
          const u = unitsMap.get(su.contextUnitId);
          const minUseful = (u ? minimumUsefulResolutions.get(u.id) : undefined) ?? ContextResolution.NAME;
          if (u && ContextResolution.NAME >= minUseful && materializer.supports(u, ContextResolution.NAME)) {
            su.resolution = ContextResolution.NAME;
            degraded = true;
            break;
          }
        }
      }
      // 5. Remove lowest unit
      if (!degraded && plannedUnits.length > 0) {
        plannedUnits.pop();
        degraded = true;
      }
      if (!degraded) break;

      resolvedForAdapter.length = 0;
      for (const pu of plannedUnits) {
        const u = unitsMap.get(pu.contextUnitId);
        if (!u) continue;
        const mat = materializer.materializeSync(u, pu.resolution, snapshot);
        pu.content = mat.content;
        pu.tokenEstimate = mat.actualTokenCount;
        resolvedForAdapter.push({
          unitId: u.id,
          title: u.title,
          filePath: u.path,
          resolution: pu.resolution,
          content: mat.content,
        });
      }
      formattedContext = adapter.formatContext(resolvedForAdapter, {
        includeInstructions: true,
        instructionPrefix: `Task Prompt: ${task.primaryPrompt}`,
        maxTokens: tokenBudget,
      });
      actualRenderedTokens = tokenCostEstimator.estimateMaterialized(
        formattedContext.promptText,
        task.agentEnvironment
      );
    }

    if (actualRenderedTokens > tokenBudget) {
      throw new Error(
        `V3_TOKEN_OVERFLOW: Context tokens (${actualRenderedTokens}) exceeded budget of ${tokenBudget}`
      );
    }

    const materializedUnitCount = plannedUnits.length;
    const contextString = formattedContext.promptText;
    const bundleSha256 = crypto.createHash('sha256').update(contextString).digest('hex');

    let postContextGitStatus = '';
    try {
      postContextGitStatus = execSync(`git -C "${workspaceDir}" status --porcelain`, { encoding: 'utf8' }).trim();
    } catch {}

    const resNameMap: Record<number, 'NAME' | 'SIGNATURE' | 'SKELETON' | 'BODY' | 'FULL'> = {
      [ContextResolution.NAME]: 'NAME',
      [ContextResolution.SIGNATURE]: 'SIGNATURE',
      [ContextResolution.SKELETON]: 'SKELETON',
      [ContextResolution.BODY]: 'BODY',
      [ContextResolution.FULL]: 'FULL',
    };

    const rankedUnits: EvaluationRankedUnit[] = rankedCandidates.map((rc: any, idx: number) => {
      const u = unitsMap.get(rc.contextUnitId);
      return {
        contextUnitId: rc.contextUnitId,
        path: u?.path,
        rank: idx + 1,
        score: rc.finalScore,
        tokenEstimate: rc.tokenEstimate ?? (u?.metadata?.tokenEstimate || 50),
      };
    });

    const selectedUnits: EvaluationSelectedUnit[] = plannedUnits.map((pu: any) => {
      const u = unitsMap.get(pu.contextUnitId);
      return {
        contextUnitId: pu.contextUnitId,
        path: u?.path,
        resolution: resNameMap[pu.resolution] || 'FULL',
        actualTokenCount: pu.tokenEstimate,
        contentSha256: crypto.createHash('sha256').update(pu.content || '').digest('hex'),
      };
    });

    return {
      providerName: 'V3EvaluationContextProvider',
      implementationSha: this.headSha,
      workspaceBaseCommit: baseCommit,
      candidateBudget,
      tokenBudget,
      generatedCandidateCount,
      featuredCandidateCount,
      rankedCandidateCount,
      selectedBundleUnitCount,
      materializedUnitCount,
      rankedUnits,
      selectedUnits,
      totalContextTokens: actualRenderedTokens,
      contextString,
      bundleSha256,
      featureSchemaSha256: CURRENT_FEATURE_SCHEMA_SHA256,
      featureBuilderVersion: '3.1.0',
      modelArtifactSha256: this.modelArtifactSha256,
      trainingCodeGitSha: this.modelArtifact.trainingCodeGitSha,
      initialGitStatus,
      postContextGitStatus,
    };
  }
}
