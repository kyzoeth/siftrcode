/**
 * SiftrCode V2 - ContextEngine Master Orchestrator
 * Connects candidate discovery, point-in-time features, ranking, bundle synergy,
 * budget solving, skeleton materialization, and agent adaptation into a unified pipeline.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { TaskContext } from '../context/task_context';
import { ContextUnit, ContextUnitKind } from '../context/context_unit';
import { ContextGraph } from '../graph/context_graph';
import { GitGraphIntelligence } from '../graph/git_graph';
import { FeatureCutoff } from '../learning/point_in_time_features';
import { DataRights, createDefaultDataRights } from '../rights/data_rights';
import { AgentAdapter, ClaudeCodeAdapter, ContextUnitResolved } from '../agents/agent_adapter';
import { CandidateGenerator } from '../retrieval/candidate_generator';
import { FeatureBuilderV1 } from '../ranking/feature_builder';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { ContextRanker } from '../ranking/context_rank';
import { BundleComposer } from '../context/bundle_composer';
import { BudgetSolver, BudgetLimits, BUDGET_PROFILES, BudgetProfileName } from '../context/budget_solver';
import { ContextResolution } from '../context/context_resolution';
import { skeletonizeFile } from '../skeleton/dispatcher';
import { createExposureDecision, ExposureDecision } from '../telemetry/exposure_decision';
import { TrajectoryLogger } from '../telemetry/trajectory_event';
import { ContextPlan, PlannedUnit } from './context_plan';

export interface ContextEngineOptions {
  repoRootDir?: string;
  adapter?: AgentAdapter;
  dataRights?: DataRights;
  budgetProfile?: BudgetProfileName;
  budgetLimits?: BudgetLimits;
  dirtyPaths?: string[];
  seedUnitIds?: string[];
}

export class ContextEngine {
  private repoRootDir?: string;
  private adapter: AgentAdapter;
  private dataRights: DataRights;
  private budgetProfile: BudgetProfileName;
  private budgetLimits: BudgetLimits;

  constructor(options: ContextEngineOptions = {}) {
    this.repoRootDir = options.repoRootDir;
    this.adapter = options.adapter || new ClaudeCodeAdapter();
    this.dataRights = options.dataRights || createDefaultDataRights();
    this.budgetProfile = options.budgetProfile || 'BALANCED';
    this.budgetLimits = options.budgetLimits || (
      this.budgetProfile !== 'CUSTOM' ? BUDGET_PROFILES[this.budgetProfile] : { maxTokens: 16000 }
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
  }): ContextPlan {
    const {
      task,
      units,
      graph,
      gitIntelligence,
      featureCutoff,
      dirtyPaths = [],
      seedUnitIds = [],
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

      const rawContent = this.loadUnitContent(u);
      const materializedContent = this.materializeContent(rawContent, u, alloc.resolution);

      plannedUnits.push({
        contextUnitId: u.id,
        title: u.title,
        path: u.path,
        resolution: alloc.resolution,
        content: materializedContent,
        tokenEstimate: alloc.tokenCost,
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
   * Helper to load raw content for a unit from metadata or disk.
   */
  private loadUnitContent(unit: ContextUnit): string {
    if (typeof unit.metadata?.content === 'string') {
      return unit.metadata.content;
    }

    if (this.repoRootDir && unit.path) {
      const fullPath = path.resolve(this.repoRootDir, unit.path);
      try {
        if (fs.existsSync(fullPath)) {
          return fs.readFileSync(fullPath, 'utf8');
        }
      } catch {
        // Fallback below
      }
    }

    return `// ${unit.title} (${unit.path || 'in repository'})`;
  }

  /**
   * Materializes the content for a unit given its resolution level.
   */
  private materializeContent(
    rawContent: string,
    unit: ContextUnit,
    resolution: ContextResolution
  ): string {
    switch (resolution) {
      case ContextResolution.FULL:
      case ContextResolution.BODY:
        return rawContent;

      case ContextResolution.SKELETON: {
        const filePath = unit.path || (unit.title.endsWith('.ts') ? unit.title : `${unit.title}.ts`);
        const skeleton = skeletonizeFile(rawContent, filePath);
        return skeleton.skeletonContent || rawContent;
      }

      case ContextResolution.SIGNATURE: {
        const lines = rawContent.split('\n');
        // Take signature header (up to opening brace or first 3 lines)
        return lines.slice(0, 3).join('\n');
      }

      case ContextResolution.NAME:
        return `// [EXISTS] ${unit.path || unit.title}`;

      case ContextResolution.OMIT:
      default:
        return '';
    }
  }
}
