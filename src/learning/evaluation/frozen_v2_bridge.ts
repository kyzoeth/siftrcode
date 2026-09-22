/**
 * SiftrCode V3.1 - Frozen V2 Evaluation Bridge (Phase 11 P0-1)
 *
 * Implements an evaluator-side bridge directly invoking native modules from
 * .v2-baseline-worktree/dist verified strictly at commit:
 * 1eedac03b0d83025ebf08ed2945e0ab015c46f6a (v2-final).
 *
 * Enforces true candidate parity:
 * CandidateGenerator.generateCandidates(task, units, graph, gitIntelligence, {
 *   maxCandidates: 50
 * })
 *
 * Tracks internal candidate pipeline counts:
 * - generatedCandidateCount <= 50
 * - featuredCandidateCount <= 50
 * - rankedCandidateCount <= 50
 * - selectedBundleUnitCount
 * - materializedUnitCount
 *
 * Enforces token budget <= 8,000 tokens via native post-render degradation loop.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { EvaluationContextResult, EvaluationRankedUnit, EvaluationSelectedUnit } from './evaluation_context_result';

export const AUTHORITATIVE_V2_SHA = '1eedac03b0d83025ebf08ed2945e0ab015c46f6a';

export const REPO_FILTERS: Record<string, { includePatterns?: string[]; excludePatterns?: string[] }> = {
  express: {},
  fastapi: { includePatterns: ['fastapi/**'], excludePatterns: ['**/tests/**', '**/docs/**'] },
  commander: { includePatterns: ['lib/**'], excludePatterns: ['**/tests/**'] },
  siftrcode: { includePatterns: ['src/**'], excludePatterns: ['**/node_modules/**', '**/dist/**', '**/benchmarks/**'] },
};

export class FrozenV2EvaluationBridge {
  private v2DistPath: string;
  private v2Sha: string;

  // Native V2 modules dynamically loaded from .v2-baseline-worktree/dist
  private RepositoryIndexer: any;
  private GraphBuilder: any;
  private GitGraphIntelligence: any;
  private CandidateGenerator: any;
  private FeatureBuilderV1: any;
  private ContextRanker: any;
  private BundleComposer: any;
  private BudgetSolver: any;
  private ResolutionRanker: any;
  private DefaultContextUnitMaterializer: any;
  private DefaultWorkspaceSourceReader: any;
  private WorkspaceManager: any;
  private DefaultTokenCostEstimator: any;
  private ClaudeCodeAdapter: any;
  private TaskEvidenceKind: any;
  private ContextResolution: any;

  constructor(baselineWorktreePath?: string) {
    const rootDir = path.resolve(__dirname, '../../..');
    const wtPath = baselineWorktreePath || path.join(rootDir, '.v2-baseline-worktree');

    if (!fs.existsSync(wtPath)) {
      throw new Error(`FAIL_CLOSED: Authoritative V2 baseline worktree missing at ${wtPath}`);
    }

    let currentSha = '';
    try {
      currentSha = execSync(`git -C "${wtPath}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
    } catch (err) {
      throw new Error(`FAIL_CLOSED: Failed to read git commit of V2 baseline worktree: ${err}`);
    }

    if (currentSha !== AUTHORITATIVE_V2_SHA) {
      throw new Error(
        `FAIL_CLOSED: V2 baseline worktree commit mismatch! Expected ${AUTHORITATIVE_V2_SHA}, got ${currentSha}`
      );
    }
    this.v2Sha = currentSha;

    this.v2DistPath = path.join(wtPath, 'dist');
    if (!fs.existsSync(this.v2DistPath)) {
      throw new Error(`FAIL_CLOSED: V2 compiled dist directory missing at ${this.v2DistPath}`);
    }

    // Load native frozen V2 modules directly
    this.RepositoryIndexer = require(path.join(this.v2DistPath, 'indexing/repository_index.js')).RepositoryIndexer;
    this.GraphBuilder = require(path.join(this.v2DistPath, 'graph/graph_builder.js')).GraphBuilder;
    this.GitGraphIntelligence = require(path.join(this.v2DistPath, 'graph/git_graph.js')).GitGraphIntelligence;
    this.CandidateGenerator = require(path.join(this.v2DistPath, 'retrieval/candidate_generator.js')).CandidateGenerator;
    this.FeatureBuilderV1 = require(path.join(this.v2DistPath, 'ranking/feature_builder.js')).FeatureBuilderV1;
    this.ContextRanker = require(path.join(this.v2DistPath, 'ranking/context_rank.js')).ContextRanker;
    this.BundleComposer = require(path.join(this.v2DistPath, 'context/bundle_composer.js')).BundleComposer;
    this.BudgetSolver = require(path.join(this.v2DistPath, 'context/budget_solver.js')).BudgetSolver;
    this.ResolutionRanker = require(path.join(this.v2DistPath, 'context/resolution_rank.js')).ResolutionRanker;
    this.DefaultContextUnitMaterializer = require(
      path.join(this.v2DistPath, 'materialization/context_unit_materializer.js')
    ).DefaultContextUnitMaterializer;
    this.DefaultWorkspaceSourceReader = require(
      path.join(this.v2DistPath, 'workspace/workspace_source_reader.js')
    ).DefaultWorkspaceSourceReader;
    this.WorkspaceManager = require(path.join(this.v2DistPath, 'workspace/workspace_manager.js')).WorkspaceManager;
    this.DefaultTokenCostEstimator = require(
      path.join(this.v2DistPath, 'token/token_cost_estimator.js')
    ).DefaultTokenCostEstimator;
    this.ClaudeCodeAdapter = require(path.join(this.v2DistPath, 'agents/agent_adapter.js')).ClaudeCodeAdapter;
    this.TaskEvidenceKind = require(path.join(this.v2DistPath, 'context/task_evidence.js')).TaskEvidenceKind;
    this.ContextResolution = require(path.join(this.v2DistPath, 'context/context_resolution.js')).ContextResolution;
  }

  public getImplementation(): string {
    return `.v2-baseline-worktree/dist @ ${this.v2Sha}`;
  }

  public getImplementationSha(): string {
    return this.v2Sha;
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

    // 1. Snapshot and Index using frozen V2
    const workspaceManager = new this.WorkspaceManager({ rootDir: workspaceDir });
    const snapshot = await workspaceManager.captureSnapshot();
    const indexer = new this.RepositoryIndexer();
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

    const sourceReader = new this.DefaultWorkspaceSourceReader(workspaceDir);
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

    // 2. Graph and Git Intelligence using frozen V2
    const graphBuilder = new this.GraphBuilder();
    const graph = graphBuilder.buildGraph(units, { repoDir: workspaceDir, sourceReader, snapshot });
    let gitIntelligence: any = undefined;
    try {
      gitIntelligence = new this.GitGraphIntelligence({ repoDir: workspaceDir });
    } catch {}

    // 3. TaskContext without telemetry
    const userPromptEvidence = {
      evidenceId: 'ev_' + crypto.randomUUID().slice(0, 8),
      kind: this.TaskEvidenceKind.USER_PROMPT,
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
        systemConfigurationHash: 'eval_bridge',
        model: 'default',
        billingTier: 'standard',
      },
    };

    // 4. Candidate Generation with explicit evaluator-controlled candidateBudget
    const generator = new this.CandidateGenerator();
    const candidates: any[] = generator.generateCandidates(task, units, graph, gitIntelligence, {
      maxCandidates: candidateBudget,
    });
    const generatedCandidateCount = candidates.length;
    if (generatedCandidateCount > candidateBudget) {
      throw new Error(
        `V2_CANDIDATE_OVERFLOW: Generated ${generatedCandidateCount} candidates, exceeding budget of ${candidateBudget}`
      );
    }

    // 5. Feature Extraction (V2 FeatureBuilderV1)
    const featuresMap = new Map<string, any>();
    const featuresList: any[] = [];
    for (const cand of candidates) {
      const u = unitsMap.get(cand.contextUnitId);
      if (!u) continue;
      const f = this.FeatureBuilderV1.buildFeatures({
        candidate: cand,
        unit: u,
        task,
        graph,
        gitIntelligence,
      });
      featuresMap.set(cand.contextUnitId, f);
      featuresList.push(f);
    }
    const featuredCandidateCount = featuresList.length;
    if (featuredCandidateCount > candidateBudget) {
      throw new Error(
        `V2_FEATURE_OVERFLOW: Extracted ${featuredCandidateCount} features, exceeding budget of ${candidateBudget}`
      );
    }

    // 6. Candidate Ranking (V2 ContextRanker)
    const ranker = new this.ContextRanker();
    const rankedCandidates: any[] = ranker.rank(featuresList);
    const rankedCandidateCount = rankedCandidates.length;
    if (rankedCandidateCount > candidateBudget) {
      throw new Error(
        `V2_RANK_OVERFLOW: Ranked ${rankedCandidateCount} candidates, exceeding budget of ${candidateBudget}`
      );
    }

    // 7. Resolution Curves and Minimum Useful Resolutions
    const materializer = new this.DefaultContextUnitMaterializer({
      sourceReader,
      throwOnWorkspaceChanged: true,
    });
    const tokenCostEstimator = new this.DefaultTokenCostEstimator(materializer);
    const resRanker = new this.ResolutionRanker();

    const resolutionCurves = new Map<string, any>();
    const minimumUsefulResolutions = new Map<string, any>();
    for (const cand of rankedCandidates) {
      const u = unitsMap.get(cand.contextUnitId);
      const f = featuresMap.get(cand.contextUnitId);
      if (!u || !f) continue;
      const curve = tokenCostEstimator.computeResolutionCurve(u, snapshot, task.agentEnvironment, cand.finalScore);
      resolutionCurves.set(u.id, curve);
      const minUseful = resRanker.getMinimumUsefulResolution(u, f);
      minimumUsefulResolutions.set(u.id, minUseful);
    }

    // 8. Bundle Composition (V2 BundleComposer)
    const composer = new this.BundleComposer({
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

    // 9. Budget Solving (V2 BudgetSolver)
    const solver = new this.BudgetSolver();
    const budgetPlan = solver.solve({
      selectedUnitIds: bundle.selectedUnitIds,
      units: unitsMap,
      features: featuresMap,
      limits: { maxTokens: tokenBudget },
      profileName: 'CUSTOM',
    });

    // 10. Materialization & Rendering
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
            : this.ContextResolution.NAME;
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

    const adapter = new this.ClaudeCodeAdapter();
    let formattedContext = adapter.formatContext(resolvedForAdapter, {
      includeInstructions: true,
      instructionPrefix: `Task Prompt: ${task.primaryPrompt}`,
      maxTokens: tokenBudget,
    });
    let actualRenderedTokens = tokenCostEstimator.estimateMaterialized(
      formattedContext.promptText,
      task.agentEnvironment
    );

    // 11. Post-render budget degradation loop if rendered tokens exceed budget
    while (actualRenderedTokens > tokenBudget) {
      let degraded = false;
      // 1. FULL -> BODY
      const fullUnits = plannedUnits.filter((pu) => pu.resolution === this.ContextResolution.FULL);
      if (fullUnits.length > 0) {
        const target = fullUnits[fullUnits.length - 1];
        const u = unitsMap.get(target.contextUnitId);
        const minUseful = (u ? minimumUsefulResolutions.get(u.id) : undefined) ?? this.ContextResolution.NAME;
        if (u && this.ContextResolution.BODY >= minUseful && materializer.supports(u, this.ContextResolution.BODY)) {
          target.resolution = this.ContextResolution.BODY;
          degraded = true;
        }
      }
      // 2. BODY -> SKELETON
      if (!degraded) {
        const bodyUnits = plannedUnits.filter((pu) => pu.resolution === this.ContextResolution.BODY);
        for (let i = bodyUnits.length - 1; i >= 0; i--) {
          const bu = bodyUnits[i];
          const u = unitsMap.get(bu.contextUnitId);
          const minUseful = (u ? minimumUsefulResolutions.get(u.id) : undefined) ?? this.ContextResolution.NAME;
          if (
            u &&
            this.ContextResolution.SKELETON >= minUseful &&
            materializer.supports(u, this.ContextResolution.SKELETON)
          ) {
            bu.resolution = this.ContextResolution.SKELETON;
            degraded = true;
            break;
          }
        }
      }
      // 3. SKELETON -> SIGNATURE
      if (!degraded) {
        const skelUnits = plannedUnits.filter((pu) => pu.resolution === this.ContextResolution.SKELETON);
        for (let i = skelUnits.length - 1; i >= 0; i--) {
          const su = skelUnits[i];
          const u = unitsMap.get(su.contextUnitId);
          const minUseful = (u ? minimumUsefulResolutions.get(u.id) : undefined) ?? this.ContextResolution.NAME;
          if (
            u &&
            this.ContextResolution.SIGNATURE >= minUseful &&
            materializer.supports(u, this.ContextResolution.SIGNATURE)
          ) {
            su.resolution = this.ContextResolution.SIGNATURE;
            degraded = true;
            break;
          }
        }
      }
      // 4. SIGNATURE -> NAME
      if (!degraded) {
        const sigUnits = plannedUnits.filter((pu) => pu.resolution === this.ContextResolution.SIGNATURE);
        for (let i = sigUnits.length - 1; i >= 0; i--) {
          const su = sigUnits[i];
          const u = unitsMap.get(su.contextUnitId);
          const minUseful = (u ? minimumUsefulResolutions.get(u.id) : undefined) ?? this.ContextResolution.NAME;
          if (
            u &&
            this.ContextResolution.NAME >= minUseful &&
            materializer.supports(u, this.ContextResolution.NAME)
          ) {
            su.resolution = this.ContextResolution.NAME;
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
        `V2_TOKEN_OVERFLOW: Context tokens (${actualRenderedTokens}) exceeded budget of ${tokenBudget}`
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
      [this.ContextResolution.NAME]: 'NAME',
      [this.ContextResolution.SIGNATURE]: 'SIGNATURE',
      [this.ContextResolution.SKELETON]: 'SKELETON',
      [this.ContextResolution.BODY]: 'BODY',
      [this.ContextResolution.FULL]: 'FULL',
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
      providerName: 'FrozenV2EvaluationBridge',
      implementationSha: this.v2Sha,
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
      initialGitStatus,
      postContextGitStatus,
    };
  }
}
