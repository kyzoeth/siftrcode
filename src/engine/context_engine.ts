/**
 * SiftrCode V2 - ContextEngine Master Orchestrator
 * Connects candidate discovery, point-in-time features, ranking, bundle synergy,
 * budget solving, skeleton materialization, and agent adaptation into a unified pipeline.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { TaskContext, createTaskContext } from '../context/task_context';
import { ContextUnit, ContextUnitKind } from '../context/context_unit';
import { ContextGraph } from '../graph/context_graph';
import { GitGraphIntelligence } from '../graph/git_graph';
import { FeatureCutoff } from '../learning/point_in_time_features';
import { DataRights, createDefaultDataRights } from '../rights/data_rights';
import { AgentAdapter, ClaudeCodeAdapter, CursorAdapter, GenericMcpAdapter, ContextUnitResolved, FormattedContext } from '../agents/agent_adapter';
import { CandidateGenerator } from '../retrieval/candidate_generator';
import { FeatureBuilderV1 } from '../ranking/feature_builder';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { ContextRanker, RankedCandidate } from '../ranking/context_rank';
import { BundleComposer } from '../context/bundle_composer';
import { BudgetSolver, BudgetLimits, BUDGET_PROFILES, BudgetProfileName } from '../context/budget_solver';
import { ContextResolution } from '../context/context_resolution';
import { createExposureDecision, ExposureDecision } from '../telemetry/exposure_decision';
import { TrajectoryLogger } from '../telemetry/trajectory_event';
import { ContextPlan, PlannedUnit } from './context_plan';
import { WorkspaceManager } from '../workspace/workspace_manager';
import { RepositoryIndexer } from '../indexing/repository_index';
import { GraphBuilder } from '../graph/graph_builder';
import { TaskEvidence, TaskEvidenceKind, UserPromptEvidence, DiffEvidence } from '../context/task_evidence';
import { createAgentEnvironment } from '../agents/agent_environment';
import { ContextUnitMaterializer, DefaultContextUnitMaterializer } from '../materialization/context_unit_materializer';
import { WorkspaceSnapshot, createWorkspaceSnapshot } from '../workspace/workspace_snapshot';
import { DefaultWorkspaceSourceReader } from '../workspace/workspace_source_reader';

export interface ContextEngineOptions {
  repoRootDir?: string;
  adapter?: AgentAdapter;
  dataRights?: DataRights;
  budgetProfile?: BudgetProfileName;
  budgetLimits?: BudgetLimits;
  dirtyPaths?: string[];
  seedUnitIds?: string[];
  materializer?: ContextUnitMaterializer;
}

export interface OptimizeWorkspaceOptions {
  workspaceDir: string;
  prompt: string;
  agentModel?: string;
  agentKind?: 'claude_code' | 'cursor' | 'generic_mcp';
  budgetProfile?: BudgetProfileName;
  budgetLimits?: BudgetLimits;
  tokenBudget?: number;
  maxCostUSD?: number;
  dataRights?: DataRights;
  seedUnitIds?: string[];
  dirtyPaths?: string[];
  excludePatterns?: string[];
  includePatterns?: string[];
}

export interface OptimizeWorkspaceResult {
  plan: ContextPlan;
  engine: ContextEngine;
  units: ContextUnit[];
  graph: ContextGraph;
  task: TaskContext;
  formattedContext: FormattedContext;
  contextString: string;
}


export interface RankWorkspaceOptions {
  workspaceDir: string;
  prompt: string;
  limit?: number;
  excludePatterns?: string[];
  includePatterns?: string[];
}

export interface RankWorkspaceResult {
  task: TaskContext;
  ranked: RankedCandidate[];
  totalCandidates: number;
}


export class ContextEngine {
  private repoRootDir?: string;
  private adapter: AgentAdapter;
  private dataRights: DataRights;
  private budgetProfile: BudgetProfileName;
  private budgetLimits: BudgetLimits;
  private materializer: ContextUnitMaterializer;

  constructor(options: ContextEngineOptions = {}) {
    this.repoRootDir = options.repoRootDir;
    this.adapter = options.adapter || new ClaudeCodeAdapter();
    this.dataRights = options.dataRights || createDefaultDataRights();
    this.budgetProfile = options.budgetProfile || 'BALANCED';
    this.budgetLimits = options.budgetLimits || (
      this.budgetProfile !== 'CUSTOM' ? BUDGET_PROFILES[this.budgetProfile] : { maxTokens: 16000 }
    );
    this.materializer = options.materializer || new DefaultContextUnitMaterializer(
      new DefaultWorkspaceSourceReader(this.repoRootDir || process.cwd())
    );
  }

  /**
   * Generates an end-to-end optimized ContextPlan for a given task.
   */
  public generatePlan(params: {
    task: TaskContext;
    units: ContextUnit[];
    graph?: ContextGraph;
    gitIntelligence?: GitGraphIntelligence;
    featureCutoff?: FeatureCutoff;
    dirtyPaths?: string[];
    seedUnitIds?: string[];
    snapshot?: WorkspaceSnapshot;
  }): ContextPlan {
    const {
      task,
      units,
      graph,
      gitIntelligence,
      featureCutoff,
      dirtyPaths = [],
      seedUnitIds = [],
      snapshot = createWorkspaceSnapshot({
        repositories: [
          {
            repositoryId: 'root',
            baseCommitSha: 'HEAD',
            trackedTreeHash: 'root',
            dirtyPatchHash: 'clean',
          },
        ],
      }),
    } = params;

    const planId = 'cplan_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const createdAt = new Date().toISOString();
    const trajectoryLogger = new TrajectoryLogger(task.taskId, this.dataRights);

    // 1. Index units by id for fast lookups
    const unitsMap = new Map<string, ContextUnit>();
    for (const u of units) {
      unitsMap.set(u.id, u);
    }

    // 2. Candidate Discovery (Multi-channel: exact, lexical, stack_trace, graph, git)
    const generator = new CandidateGenerator();
    const candidates = generator.generateCandidates(task, units, graph, gitIntelligence);

    // 3. Feature Extraction (ContextFeaturesV1 with point-in-time constraints)
    const featuresMap = new Map<string, ContextFeaturesV1>();
    const featuresList: ContextFeaturesV1[] = [];

    for (const cand of candidates) {
      const u = unitsMap.get(cand.contextUnitId);
      if (!u) continue;

      const f = FeatureBuilderV1.buildFeatures({
        candidate: cand,
        unit: u,
        task,
        graph,
        gitIntelligence,
        featureCutoff,
        seedUnitIds,
        dirtyPaths,
      });

      featuresMap.set(cand.contextUnitId, f);
      featuresList.push(f);
    }

    // 4. Candidate Ranking (ContextRanker)
    const ranker = new ContextRanker();
    const rankedCandidates = ranker.rank(featuresList);

    // 5. Submodular Bundle Composition (BundleComposer)
    const composer = new BundleComposer({
      maxTokens: this.budgetLimits.maxTokens,
    });
    const bundle = composer.compose({
      rankedCandidates,
      units: unitsMap,
      graph,
      evidence: task.evidence,
    });

    // 6. Constrained Budget & Resolution Solving (BudgetSolver)
    const solver = new BudgetSolver();
    const budgetPlan = solver.solve({
      selectedUnitIds: bundle.selectedUnitIds,
      units: unitsMap,
      features: featuresMap,
      limits: this.budgetLimits,
      profileName: this.budgetProfile,
    });

    // 7. Materialize Unit Contents according to assigned resolutions
    const plannedUnits: PlannedUnit[] = [];
    const resolvedForAdapter: ContextUnitResolved[] = [];

    for (const alloc of budgetPlan.allocations) {
      const u = unitsMap.get(alloc.contextUnitId);
      if (!u) continue;

      const mat = this.materializer.materializeSync(u, alloc.resolution, snapshot);
      const materializedContent = mat.content;

      plannedUnits.push({
        contextUnitId: u.id,
        title: u.title,
        path: u.path,
        resolution: alloc.resolution,
        content: materializedContent,
        tokenEstimate: mat.actualTokenCount || alloc.tokenCost,
        reason: alloc.justification,
      });

      resolvedForAdapter.push({
        unitId: u.id,
        title: u.title,
        filePath: u.path,
        resolution: alloc.resolution,
        content: materializedContent,
      });
    }

    // 8. Format Context for target Agent Adapter
    const formattedContext = this.adapter.formatContext(resolvedForAdapter, {
      includeInstructions: true,
      instructionPrefix: `Task Prompt: ${task.primaryPrompt}`,
      maxTokens: this.budgetLimits.maxTokens,
    });

    // 9. Telemetry: Record Exposure Decisions & Trajectory Log
    const exposureDecisions: ExposureDecision[] = [];
    const recordedUnitIds = new Set<string>();

    for (let i = 0; i < rankedCandidates.length; i++) {
      const rc = rankedCandidates[i];
      const planned = plannedUnits.find((pu) => pu.contextUnitId === rc.contextUnitId);

      const decision = createExposureDecision({
        contextUnitId: rc.contextUnitId,
        exposureResolution: planned ? planned.resolution : ContextResolution.OMIT,
        exposureRank: i + 1,
        exposureCostTokens: planned ? planned.tokenEstimate : 0,
      });
      exposureDecisions.push(decision);
      recordedUnitIds.add(rc.contextUnitId);
    }

    // For any repository unit not even retrieved as candidate, record OMIT decision
    let nextRank = rankedCandidates.length + 1;
    for (const u of units) {
      if (!recordedUnitIds.has(u.id)) {
        exposureDecisions.push(
          createExposureDecision({
            contextUnitId: u.id,
            exposureResolution: ContextResolution.OMIT,
            exposureRank: nextRank++,
            exposureCostTokens: 0,
          })
        );
        recordedUnitIds.add(u.id);
      }
    }

    trajectoryLogger.logEvent('CONTEXT_ALLOCATED', {
      planId,
      totalUnits: plannedUnits.length,
      allocatedTokens: budgetPlan.totalTokens,
      savingsPercentage: budgetPlan.savingsPercentage,
      costSavedUSD: budgetPlan.costSavedUSD,
    });

    return {
      taskId: task.taskId,
      planId,
      budgetPlan,
      units: plannedUnits,
      formattedContext,
      exposureDecisions,
      dataRights: this.dataRights,
      createdAt,
    };
  }

  /**
   * High-level orchestrator that indexes and optimizes context for a workspace directory.
   */
  public static async optimizeWorkspace(options: OptimizeWorkspaceOptions): Promise<OptimizeWorkspaceResult> {
    const rootDir = path.resolve(options.workspaceDir || process.cwd());
    const workspaceManager = new WorkspaceManager({ rootDir });
    const snapshot = await workspaceManager.captureSnapshot();

    const dirtyPaths: string[] = options.dirtyPaths ? [...options.dirtyPaths] : [];
    try {
      const statusOut = require('child_process').execSync('git status --porcelain', {
        cwd: rootDir,
        stdio: ['pipe', 'pipe', 'ignore'],
        encoding: 'utf-8',
      });
      const lines = statusOut.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 3) {
          const p = trimmed.slice(3).trim();
          if (p) dirtyPaths.push(p);
        }
      }
    } catch {
      // Non-git directory
    }

    const indexer = new RepositoryIndexer();
    const indexResult = await indexer.indexRepository(rootDir, {
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      excludePatterns: options.excludePatterns,
      includePatterns: options.includePatterns,
    });
    const units = indexResult.units;

    const graphBuilder = new GraphBuilder();
    const graph = graphBuilder.buildGraph(units, { repoDir: rootDir });

    const gitIntelligence = new GitGraphIntelligence({ repoDir: rootDir });

    const kind = options.agentKind || (options.agentModel?.toLowerCase().includes('cursor') ? 'cursor' : 'claude_code');
    let adapter: AgentAdapter;
    if (kind === 'cursor') {
      adapter = new CursorAdapter();
    } else if (kind === 'generic_mcp') {
      adapter = new GenericMcpAdapter();
    } else {
      adapter = new ClaudeCodeAdapter();
    }

    const taskId = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const userPromptEvidence: UserPromptEvidence = {
      evidenceId: 'ev_' + crypto.randomUUID().slice(0, 8),
      kind: TaskEvidenceKind.USER_PROMPT,
      timestamp: new Date().toISOString(),
      prompt: options.prompt,
    };
    const evidenceList: TaskEvidence[] = [userPromptEvidence];

    if (dirtyPaths.length > 0) {
      const diffEvidence: DiffEvidence = {
        evidenceId: 'ev_' + crypto.randomUUID().slice(0, 8),
        kind: TaskEvidenceKind.DIFF,
        timestamp: new Date().toISOString(),
        patchText: '',
        changedFiles: dirtyPaths,
      };
      evidenceList.push(diffEvidence);
    }

    const task = createTaskContext({
      taskId,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      primaryPrompt: options.prompt,
      evidence: evidenceList,
      agentEnvironment: createAgentEnvironment({
        agentProvider: kind === 'cursor' ? 'cursor' : 'anthropic',
        agentVersion: '1.0.0',
        model: options.agentModel || 'claude-3-5-sonnet-20241022',
        harnessVersion: 'v2',
        availableTools: ['read_file', 'edit_file'],
      }),
    });

    let budgetLimits = options.budgetLimits;
    if (!budgetLimits) {
      const profile = options.budgetProfile || 'BALANCED';
      const baseLimits = (profile !== 'CUSTOM' && (BUDGET_PROFILES as any)[profile])
        ? (BUDGET_PROFILES as any)[profile]
        : BUDGET_PROFILES.BALANCED;
      const resolvedLimits: BudgetLimits = { ...baseLimits };
      if (options.tokenBudget !== undefined) {
        resolvedLimits.maxTokens = options.tokenBudget;
      }
      if (options.maxCostUSD !== undefined) {
        resolvedLimits.maxCostUSD = options.maxCostUSD;
      }
      budgetLimits = resolvedLimits;
    }

    const engine = new ContextEngine({
      repoRootDir: rootDir,
      adapter,
      dataRights: options.dataRights,
      budgetProfile: options.budgetProfile,
      budgetLimits,
    });

    const plan = engine.generatePlan({
      task,
      units,
      graph,
      gitIntelligence,
      dirtyPaths,
      seedUnitIds: options.seedUnitIds,
      snapshot,
    });

    return {
      plan,
      engine,
      units,
      graph,
      task,
      formattedContext: plan.formattedContext,
      contextString: plan.formattedContext.promptText,
    };

  }

  /**
   * Transparent candidate ranking for a workspace without composing final bundle.
   */
  public static async rankWorkspace(options: RankWorkspaceOptions): Promise<RankWorkspaceResult> {
    const rootDir = path.resolve(options.workspaceDir || process.cwd());
    const workspaceManager = new WorkspaceManager({ rootDir });
    const snapshot = await workspaceManager.captureSnapshot();

    const indexer = new RepositoryIndexer();
    const indexResult = await indexer.indexRepository(rootDir, {
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      excludePatterns: options.excludePatterns,
      includePatterns: options.includePatterns,
    });
    const units = indexResult.units;

    const graphBuilder = new GraphBuilder();
    const graph = graphBuilder.buildGraph(units, { repoDir: rootDir });
    const gitIntelligence = new GitGraphIntelligence({ repoDir: rootDir });

    const taskId = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const userPromptEvidence: UserPromptEvidence = {
      evidenceId: 'ev_' + crypto.randomUUID().slice(0, 8),
      kind: TaskEvidenceKind.USER_PROMPT,
      timestamp: new Date().toISOString(),
      prompt: options.prompt,
    };

    const task = createTaskContext({
      taskId,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      primaryPrompt: options.prompt,
      evidence: [userPromptEvidence],
      agentEnvironment: createAgentEnvironment({
        agentProvider: 'anthropic',
        agentVersion: '1.0.0',
        model: 'claude-3-5-sonnet-20241022',
        harnessVersion: 'v2',
        availableTools: ['read_file', 'edit_file'],
      }),
    });

    const generator = new CandidateGenerator();
    const candidates = generator.generateCandidates(task, units, graph, gitIntelligence);

    const unitsMap = new Map<string, ContextUnit>();
    for (const u of units) unitsMap.set(u.id, u);

    const featuresList: ContextFeaturesV1[] = [];
    for (const cand of candidates) {
      const u = unitsMap.get(cand.contextUnitId);
      if (!u) continue;
      const f = FeatureBuilderV1.buildFeatures({
        candidate: cand,
        unit: u,
        task,
        graph,
        gitIntelligence,
      });
      featuresList.push(f);
    }

    const ranker = new ContextRanker();
    const ranked = ranker.rank(featuresList);
    const limit = options.limit || 20;

    return {
      task,
      ranked: ranked.slice(0, limit),
      totalCandidates: candidates.length,
    };
  }
}


