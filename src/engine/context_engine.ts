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
import { DataRights, createDefaultDataRights, resolveApplicationDataRights } from '../rights/data_rights';
import { AgentAdapter, ClaudeCodeAdapter, CursorAdapter, GenericMcpAdapter, ContextUnitResolved, FormattedContext } from '../agents/agent_adapter';
import { CandidateGenerator } from '../retrieval/candidate_generator';
import { FeatureBuilderV1 } from '../ranking/feature_builder';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { ContextRanker, RankedCandidate } from '../ranking/context_rank';
import { BundleComposer } from '../context/bundle_composer';
import { BudgetSolver, BudgetLimits, BUDGET_PROFILES, BudgetProfileName, BudgetAllocationPlan, SolvedUnitAllocation, calculateCostUSD } from '../context/budget_solver';
import { ContextResolution } from '../context/context_resolution';
import { ResolutionRanker } from '../context/resolution_rank';
import { createExposureDecision, createExposureDecisionV2, ExposureDecision, ExposureDecisionV2 } from '../telemetry/exposure_decision';
import { TrajectoryLogger } from '../telemetry/trajectory_event';
import { ContextPlan, PlannedUnit } from './context_plan';
import { WorkspaceManager } from '../workspace/workspace_manager';
import { RepositoryIndexer } from '../indexing/repository_index';
import { GraphBuilder } from '../graph/graph_builder';
import { TaskEvidence, TaskEvidenceKind, UserPromptEvidence, DiffEvidence } from '../context/task_evidence';
import { createAgentEnvironment } from '../agents/agent_environment';
import { ContextUnitMaterializer, DefaultContextUnitMaterializer } from '../materialization/context_unit_materializer';
import { WorkspaceSnapshot, createWorkspaceSnapshot, WorkspaceChangedError, isWorkspaceChangedError } from '../workspace/workspace_snapshot';
import { DefaultWorkspaceSourceReader } from '../workspace/workspace_source_reader';
import { TokenCostEstimator, DefaultTokenCostEstimator, ResolutionOption } from '../token/token_cost_estimator';
import { defaultTokenizerRegistry } from '../token/tokenizer_registry';
import { SqliteStore } from '../storage/sqlite_store';
import { CandidateDecisionObservation, createCandidateDecisionObservation } from '../telemetry/decision_observation';
import { createFinalContextAllocation, FinalContextAllocationItem } from '../token/final_allocation';
import { RepositoryTrustPolicy, RepositoryOrigin } from '../security/trust';
import { JevShadowRunner } from '../providers/judgment/typesafe/jev_shadow_runner';
import { JevMode } from '../providers/judgment/typesafe/jev_signal';
import { createSiftrSession, SiftrSession } from '../telemetry/siftr_session';

export { WorkspaceChangedError, isWorkspaceChangedError } from '../workspace/workspace_snapshot';

export interface ContextEngineOptions {
  repoRootDir?: string;
  adapter?: AgentAdapter;
  dataRights?: DataRights;
  budgetProfile?: BudgetProfileName;
  budgetLimits?: BudgetLimits;
  dirtyPaths?: string[];
  seedUnitIds?: string[];
  materializer?: ContextUnitMaterializer;
  tokenCostEstimator?: TokenCostEstimator;
  sqliteStore?: SqliteStore;
  maxReplanningRetries?: number;
  jevShadowRunner?: JevShadowRunner;
  enableJevShadow?: boolean;
  ranker?: { rank(candidates: ContextFeaturesV1[], judgments?: any): RankedCandidate[] };
  candidateBudget?: number;
}

export interface OptimizeWorkspaceOptions {
  workspaceDir: string;
  prompt: string;
  taskId?: string;
  sessionId?: string;
  agentModel?: string;
  agentKind?: 'claude_code' | 'cursor' | 'generic_mcp';
  availableTools?: string[];
  budgetProfile?: BudgetProfileName;
  budgetLimits?: BudgetLimits;
  tokenBudget?: number;
  candidateBudget?: number;
  maxCostUSD?: number;
  dataRights?: DataRights;
  seedUnitIds?: string[];
  dirtyPaths?: string[];
  excludePatterns?: string[];
  includePatterns?: string[];
  repositoryTrustPolicy?: RepositoryTrustPolicy;
  maxReplanningRetries?: number;
  jevShadowRunner?: JevShadowRunner;
  enableJevShadow?: boolean;
  ranker?: { rank(candidates: ContextFeaturesV1[], judgments?: any): RankedCandidate[] };
}

export interface OptimizeWorkspaceResult {
  plan: ContextPlan;
  engine: ContextEngine;
  units: ContextUnit[];
  graph: ContextGraph;
  task: TaskContext;
  formattedContext: FormattedContext;
  contextString: string;
  replanningAttempts?: number;
  decisionObservations?: CandidateDecisionObservation[];
  sqliteStore?: SqliteStore;
}


export interface RankWorkspaceOptions {
  workspaceDir: string;
  prompt: string;
  taskId?: string;
  sessionId?: string;
  availableTools?: string[];
  limit?: number;
  candidateBudget?: number;
  excludePatterns?: string[];
  includePatterns?: string[];
  dataRights?: DataRights;
  ranker?: { rank(candidates: ContextFeaturesV1[], judgments?: any): RankedCandidate[] };
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
  private tokenCostEstimator: TokenCostEstimator;
  private sqliteStore?: SqliteStore;
  private jevShadowRunner?: JevShadowRunner;
  private sessionCache = new Map<string, SiftrSession>();
  private ranker?: { rank(candidates: ContextFeaturesV1[], judgments?: any): RankedCandidate[] };
  private candidateBudget?: number;

  constructor(options: ContextEngineOptions = {}) {
    this.repoRootDir = options.repoRootDir;
    this.ranker = options.ranker;
    this.candidateBudget = options.candidateBudget;
    this.adapter = options.adapter || new ClaudeCodeAdapter();
    this.dataRights = resolveApplicationDataRights(options.dataRights);
    this.budgetProfile = options.budgetProfile || 'BALANCED';
    this.budgetLimits = options.budgetLimits || (
      this.budgetProfile !== 'CUSTOM' ? BUDGET_PROFILES[this.budgetProfile] : { maxTokens: 16000 }
    );
    this.materializer = options.materializer || new DefaultContextUnitMaterializer({
      sourceReader: new DefaultWorkspaceSourceReader(this.repoRootDir || process.cwd()),
      throwOnWorkspaceChanged: true,
    });
    this.tokenCostEstimator = options.tokenCostEstimator || new DefaultTokenCostEstimator(this.materializer);
    this.sqliteStore = options.sqliteStore;

    if (options.jevShadowRunner) {
      this.jevShadowRunner = options.jevShadowRunner;
      if (this.sqliteStore && !this.jevShadowRunner.getSqliteStore()) {
        this.jevShadowRunner.setSqliteStore(this.sqliteStore);
      }
    } else if (options.enableJevShadow || process.env.SIFTR_JEV_ENABLED === 'true') {
      this.jevShadowRunner = new JevShadowRunner({
        sqliteStore: this.sqliteStore,
      });
    }
  }

  public getDataRights(): DataRights {
    return this.dataRights;
  }

  /**
   * Authoritative session management: retrieves an existing active session or creates and persists a new one.
   * Enforces agentEnvironmentId and taskId lineage consistency (Sections 5-7).
   */
  public getOrCreateSession(params: {
    sessionId?: string;
    taskId: string;
    agentEnvironmentId?: string;
    snapshotId?: string;
  }): SiftrSession {
    const effectiveSessionId =
      params.sessionId ||
      `sess_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

    const reqEnvId = params.agentEnvironmentId || 'unknown';

    let existing: SiftrSession | undefined = undefined;
    if (this.sqliteStore) {
      existing = this.sqliteStore.getSiftrSession(effectiveSessionId);
    }
    if (!existing) {
      existing = this.sessionCache.get(effectiveSessionId);
    }

    if (existing) {
      // 1. Check AgentEnvironment mismatch (Sections 5 & 6)
      if (existing.agentEnvironmentId !== reqEnvId) {
        // Section 7: Controlled one-time upgrade for legacy/unknown sessions if no conflicting observations exist
        let canUpgrade = false;
        if (existing.agentEnvironmentId === 'unknown') {
          let hasObservations = false;
          if (this.sqliteStore) {
            const decs = this.sqliteStore.listCandidateDecisionObservations({ sessionId: existing.sessionId });
            const plans = this.sqliteStore.listContextPlans(undefined, existing.sessionId);
            if (decs.length > 0 || plans.length > 0) {
              hasObservations = true;
            }
          }
          if (!hasObservations) {
            canUpgrade = true;
          }
        }

        if (canUpgrade) {
          existing.agentEnvironmentId = reqEnvId;
          if (this.sqliteStore && this.dataRights.telemetryAllowed !== false) {
            try {
              this.sqliteStore.saveSiftrSession(existing);
            } catch (err) {
              console.warn('[ContextEngine] Failed to save upgraded session:', err);
            }
          }
          this.sessionCache.set(existing.sessionId, existing);
          return existing;
        }

        const mismatchErr = new Error(
          `AGENT_ENVIRONMENT_MISMATCH: Session "${existing.sessionId}" is bound to agentEnvironmentId "${existing.agentEnvironmentId}", which does not match requested "${reqEnvId}".`
        );
        (mismatchErr as any).code = 'AGENT_ENVIRONMENT_MISMATCH';
        throw mismatchErr;
      }

      // 2. Check task ID mismatch where appropriate
      if (existing.taskId && params.taskId && existing.taskId !== params.taskId) {
        const taskMismatchErr = new Error(
          `SESSION_TASK_MISMATCH: Session "${existing.sessionId}" is bound to taskId "${existing.taskId}", which does not match requested "${params.taskId}".`
        );
        (taskMismatchErr as any).code = 'SESSION_TASK_MISMATCH';
        throw taskMismatchErr;
      }

      return existing;
    }

    const session = createSiftrSession({
      sessionId: effectiveSessionId,
      taskId: params.taskId,
      agentEnvironmentId: reqEnvId,
      initialWorkspaceSnapshotId: params.snapshotId || 'snapshot_init',
      latestWorkspaceSnapshotId: params.snapshotId || 'snapshot_init',
      status: 'ACTIVE',
    });

    if (this.sqliteStore && this.dataRights.telemetryAllowed !== false) {
      try {
        this.sqliteStore.saveSiftrSession(session);
      } catch (err) {
        console.warn('[ContextEngine] Failed to persist session:', err);
      }
    }

    this.sessionCache.set(session.sessionId, session);
    return session;
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
    candidateBudget?: number;
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
      candidateBudget,
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
    const effectiveCandidateBudget = candidateBudget ?? this.candidateBudget ?? 50;
    const generator = new CandidateGenerator();
    const candidates = generator.generateCandidates(task, units, graph, gitIntelligence, {
      maxCandidates: effectiveCandidateBudget,
    });
    const candidateMap = new Map<string, (typeof candidates)[0]>();
    for (const c of candidates) candidateMap.set(c.contextUnitId, c);

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

    // 4. Candidate Ranking (ContextRanker or learned ranker)
    const ranker = this.ranker || new ContextRanker();
    const rankedCandidates = ranker.rank(featuresList);

    // Section 11 & 36: Compute resolution curves and minimum useful resolutions
    const resolutionCurves = new Map<string, ResolutionOption[]>();
    const minimumUsefulResolutions = new Map<string, ContextResolution>();
    const resRanker = new ResolutionRanker();

    for (const cand of rankedCandidates) {
      const u = unitsMap.get(cand.contextUnitId);
      const f = featuresMap.get(cand.contextUnitId);
      if (!u || !f) continue;

      const curve = this.tokenCostEstimator.computeResolutionCurve(
        u,
        snapshot,
        task.agentEnvironment,
        cand.finalScore
      );
      resolutionCurves.set(u.id, curve);

      const minUseful = resRanker.getMinimumUsefulResolution(u, f);
      minimumUsefulResolutions.set(u.id, minUseful);
    }

    // 5. Submodular Bundle Composition (BundleComposer)
    const composer = new BundleComposer({
      maxTokens: this.budgetLimits.maxTokens,
    });
    const bundle = composer.compose({
      rankedCandidates,
      units: unitsMap,
      graph,
      evidence: task.evidence,
      resolutionCurves,
      minimumUsefulResolutions,
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

      // Section 38: Enforce ResolutionCapabilities runtime invariant
      let effectiveRes = alloc.resolution;
      if (!this.materializer.supports(u, effectiveRes)) {
        effectiveRes = typeof this.materializer.getNearestSafeAlternative === 'function'
          ? this.materializer.getNearestSafeAlternative(u, effectiveRes)
          : ContextResolution.NAME;
        alloc.resolution = effectiveRes;
      }

      const mat = this.materializer.materializeSync(u, alloc.resolution, snapshot);
      const materializedContent = mat.content;

      if (materializedContent.startsWith('// [WORKSPACE_CHANGED]')) {
        throw new WorkspaceChangedError({
          workspaceSnapshotId: snapshot?.workspaceSnapshotId || 'unknown',
          filePath: u.path || 'unknown',
          expectedHash: 'recorded',
          actualHash: 'mutated',
          message: `Workspace changed concurrently during materialization for "${u.path}".`,
        });
      }

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
    let formattedContext = this.adapter.formatContext(resolvedForAdapter, {
      includeInstructions: true,
      instructionPrefix: `Task Prompt: ${task.primaryPrompt}`,
      maxTokens: this.budgetLimits.maxTokens,
    });

    // 8.5 Hard Post-Render Budget Gate (Sections 12 & 13)
    let actualRenderedTokens = this.tokenCostEstimator.estimateMaterialized(
      formattedContext.promptText,
      task.agentEnvironment
    );

    const maxAllowedTokens = this.budgetLimits.maxTokens;
    let overflowReason: string | undefined = undefined;

    // Identify mandatory units: edit targets from dirtyPaths, seedUnitIds, or stack trace evidence
    const mandatoryUnitIds = new Set<string>();
    for (const seedId of seedUnitIds) {
      mandatoryUnitIds.add(seedId);
    }
    for (const u of units) {
      if (u.path && dirtyPaths.some((dp) => dp.replace(/\\/g, '/').endsWith(u.path!.replace(/\\/g, '/')))) {
        mandatoryUnitIds.add(u.id);
      }
    }
    for (const ev of task.evidence || []) {
      if (ev.kind === TaskEvidenceKind.STACK_TRACE && (ev as any).frames) {
        for (const f of (ev as any).frames) {
          for (const u of units) {
            if (u.path && f.filePath && f.filePath.replace(/\\/g, '/').endsWith(u.path.replace(/\\/g, '/'))) {
              mandatoryUnitIds.add(u.id);
            }
          }
        }
      }
    }

    // Post-render budget gate loop:
    // Degradation order:
    // 1 remove lowest marginal utility optional unit
    // 2 FULL -> BODY
    // 3 BODY -> SKELETON where safe
    // 4 SKELETON -> SIGNATURE
    // 5 SIGNATURE -> NAME
    // 6 remove optional NAME
    while (actualRenderedTokens > maxAllowedTokens) {
      let degraded = false;

      // 1. Degrade FULL -> BODY on any unit (prefer optional first)
      const fullUnits = plannedUnits.filter((pu) => pu.resolution === ContextResolution.FULL);
      if (fullUnits.length > 0) {
        const target = fullUnits.find((u) => !mandatoryUnitIds.has(u.contextUnitId)) || fullUnits[fullUnits.length - 1];
        const u = unitsMap.get(target.contextUnitId);
        const minUseful = (u ? minimumUsefulResolutions.get(u.id) : undefined) ?? ContextResolution.NAME;
        if (u && ContextResolution.BODY >= minUseful && this.materializer.supports(u, ContextResolution.BODY)) {
          target.resolution = ContextResolution.BODY;
          degraded = true;
        }
      }

      // 2. Degrade BODY -> SKELETON on optional units where safe and >= minUseful
      if (!degraded) {
        const bodyOptionalUnits = plannedUnits.filter(
          (pu) => pu.resolution === ContextResolution.BODY && !mandatoryUnitIds.has(pu.contextUnitId)
        );
        for (const bu of bodyOptionalUnits) {
          const u = unitsMap.get(bu.contextUnitId);
          const minUseful = (u ? minimumUsefulResolutions.get(u.id) : undefined) ?? ContextResolution.NAME;
          if (u && ContextResolution.SKELETON >= minUseful && this.materializer.supports(u, ContextResolution.SKELETON)) {
            bu.resolution = ContextResolution.SKELETON;
            degraded = true;
            break;
          }
        }
      }

      // 3. Degrade SKELETON -> SIGNATURE on optional units where safe and >= minUseful
      if (!degraded) {
        const skelOptionalUnits = plannedUnits.filter(
          (pu) => pu.resolution === ContextResolution.SKELETON && !mandatoryUnitIds.has(pu.contextUnitId)
        );
        for (let i = skelOptionalUnits.length - 1; i >= 0; i--) {
          const su = skelOptionalUnits[i];
          const u = unitsMap.get(su.contextUnitId);
          const minUseful = (u ? minimumUsefulResolutions.get(u.id) : undefined) ?? ContextResolution.NAME;
          if (u && ContextResolution.SIGNATURE >= minUseful && this.materializer.supports(u, ContextResolution.SIGNATURE)) {
            su.resolution = ContextResolution.SIGNATURE;
            degraded = true;
            break;
          }
        }
      }

      // 4. Degrade SIGNATURE -> NAME on optional units where safe and >= minUseful
      if (!degraded) {
        const sigOptionalUnits = plannedUnits.filter(
          (pu) => pu.resolution === ContextResolution.SIGNATURE && !mandatoryUnitIds.has(pu.contextUnitId)
        );
        for (let i = sigOptionalUnits.length - 1; i >= 0; i--) {
          const su = sigOptionalUnits[i];
          const u = unitsMap.get(su.contextUnitId);
          const minUseful = (u ? minimumUsefulResolutions.get(u.id) : undefined) ?? ContextResolution.NAME;
          if (u && ContextResolution.NAME >= minUseful && this.materializer.supports(u, ContextResolution.NAME)) {
            su.resolution = ContextResolution.NAME;
            degraded = true;
            break;
          }
        }
      }

      // 5. Remove optional units completely if they cannot be degraded further without breaching minUseful
      if (!degraded) {
        const optionalIndices = plannedUnits
          .map((pu, idx) => ({ pu, idx }))
          .filter(({ pu }) => !mandatoryUnitIds.has(pu.contextUnitId));

        if (optionalIndices.length > 0) {
          const toRemove = optionalIndices[optionalIndices.length - 1];
          plannedUnits.splice(toRemove.idx, 1);
          degraded = true;
        }
      }

      // If only mandatory units remain and still exceeding budget
      if (!degraded) {
        overflowReason = `MANDATORY_CONTEXT_OVERFLOW: Mandatory context requires ${actualRenderedTokens} actual rendered tokens exceeding budget limit of ${maxAllowedTokens} tokens.`;
        break;
      }

      // Re-render and re-format
      resolvedForAdapter.length = 0;
      for (const pu of plannedUnits) {
        const u = unitsMap.get(pu.contextUnitId);
        if (!u) continue;
        const mat = this.materializer.materializeSync(u, pu.resolution, snapshot);
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

      formattedContext = this.adapter.formatContext(resolvedForAdapter, {
        includeInstructions: true,
        instructionPrefix: `Task Prompt: ${task.primaryPrompt}`,
        maxTokens: this.budgetLimits.maxTokens,
      });

      actualRenderedTokens = this.tokenCostEstimator.estimateMaterialized(
        formattedContext.promptText,
        task.agentEnvironment
      );
    }

    // 9. Telemetry: Record Exposure Decisions & Trajectory Log
    const exposureDecisions: ExposureDecision[] = [];
    const exposureDecisionsV2: ExposureDecisionV2[] = [];
    const recordedUnitIds = new Set<string>();

    const policyId = 'siftr-deterministic';
    const policyVersion = '2.1.0';

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

      const decisionV2 = createExposureDecisionV2({
        contextUnitId: rc.contextUnitId,
        eligibleForSelection: true,
        selected: planned !== undefined,
        candidateRank: i + 1,
        finalBundleRank: planned ? plannedUnits.indexOf(planned) + 1 : undefined,
        resolution: planned ? planned.resolution : ContextResolution.OMIT,
        actualTokenCost: planned ? planned.tokenEstimate : 0,
        contextPlanId: planId,
        policyId,
        policyVersion,
        selectionProbability: planned ? 1.0 : undefined,
        timestamp: createdAt,
      });
      exposureDecisionsV2.push(decisionV2);

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
            exposureRank: nextRank,
            exposureCostTokens: 0,
          })
        );
        exposureDecisionsV2.push(
          createExposureDecisionV2({
            contextUnitId: u.id,
            eligibleForSelection: false,
            selected: false,
            candidateRank: undefined,
            finalBundleRank: undefined,
            resolution: ContextResolution.OMIT,
            actualTokenCost: 0,
            contextPlanId: planId,
            policyId,
            policyVersion,
            selectionProbability: undefined,
            timestamp: createdAt,
          })
        );
        nextRank++;
        recordedUnitIds.add(u.id);
      }
    }

    // Section 8: TaskContext must always carry an authoritative sessionId before planning
    if (!task.sessionId || task.sessionId.trim() === '') {
      const sessionErr = new Error(
        'SESSION_REQUIRED: TaskContext must carry an authoritative sessionId before planning.'
      );
      (sessionErr as any).code = 'SESSION_REQUIRED';
      throw sessionErr;
    }

    // Enforce WorkspaceSnapshot equality: TaskContext.workspaceSnapshotId must match WorkspaceSnapshot.workspaceSnapshotId
    if (task.workspaceSnapshotId && task.workspaceSnapshotId !== snapshot.workspaceSnapshotId) {
      const snapshotErr = new Error(
        `WORKSPACE_SNAPSHOT_MISMATCH: TaskContext "${task.taskId}" workspaceSnapshotId "${task.workspaceSnapshotId}" does not match WorkspaceSnapshot id "${snapshot.workspaceSnapshotId}".`
      );
      (snapshotErr as any).code = 'WORKSPACE_SNAPSHOT_MISMATCH';
      throw snapshotErr;
    }

    if (!task.workspaceSnapshotId) {
      task.workspaceSnapshotId = snapshot.workspaceSnapshotId;
    }

    // Enforce WorkspaceSnapshot equality on input units
    for (const u of units) {
      if (u.workspaceSnapshotId && u.workspaceSnapshotId !== snapshot.workspaceSnapshotId) {
        const unitMismatchErr = new Error(
          `WORKSPACE_SNAPSHOT_MISMATCH: ContextUnit "${u.id}" workspaceSnapshotId "${u.workspaceSnapshotId}" does not match WorkspaceSnapshot id "${snapshot.workspaceSnapshotId}".`
        );
        (unitMismatchErr as any).code = 'WORKSPACE_SNAPSHOT_MISMATCH';
        throw unitMismatchErr;
      }
    }

    // ContextEngine authoritatively retrieves and validates active SiftrSession
    const session = this.getOrCreateSession({
      sessionId: task.sessionId,
      taskId: task.taskId,
      agentEnvironmentId: task.agentEnvironment?.systemConfigurationHash || 'unknown',
      snapshotId: snapshot.workspaceSnapshotId,
    });
    const effectiveSessionId = session.sessionId;

    // Immediately bind effectiveSessionId and workspaceSnapshotId to TaskContext
    task.sessionId = effectiveSessionId;
    const boundTask: TaskContext = {
      ...task,
      sessionId: effectiveSessionId,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
    };

    const decisionObservations: CandidateDecisionObservation[] = [];
    for (let i = 0; i < rankedCandidates.length; i++) {
      const rc = rankedCandidates[i];
      const decV2 = exposureDecisionsV2[i];
      const feat = featuresMap.get(rc.contextUnitId);
      if (feat && decV2) {
        decisionObservations.push(
          createCandidateDecisionObservation({
            taskId: boundTask.taskId,
            sessionId: effectiveSessionId,
            workspaceSnapshotId: snapshot.workspaceSnapshotId,
            contextUnitId: rc.contextUnitId,
            candidate: {
              generated: true,
              candidateRank: i + 1,
              retrievalSources: candidateMap.get(rc.contextUnitId)?.retrievalSources || ['lexical'],
            },
            features: feat,
            rank: i + 1,
            exposureDecision: decV2,
            policyId,
            policyVersion,
            agentEnvironment: boundTask.agentEnvironment,
            observabilityLevel: this.adapter.observabilityLevel,
          })
        );
      }
    }

    // Reconcile Final Allocation & truth-in-advertising metrics (Audit Section 8)
    const finalAllocations: SolvedUnitAllocation[] = [];
    let finalAllocatedTokens = 0;

    for (const pu of plannedUnits) {
      const initialAlloc = budgetPlan.allocations.find((a) => a.contextUnitId === pu.contextUnitId);
      const rawTokens = initialAlloc?.rawTokens ?? pu.tokenEstimate;
      finalAllocations.push({
        contextUnitId: pu.contextUnitId,
        resolution: pu.resolution,
        tokenCost: pu.tokenEstimate,
        rawTokens,
        justification: pu.reason || `Allocated at ${pu.resolution}`,
      });
      finalAllocatedTokens += pu.tokenEstimate;
    }

    const tokensSaved = Math.max(0, budgetPlan.rawTotalTokens - finalAllocatedTokens);
    const savingsPercentage = budgetPlan.rawTotalTokens > 0
      ? Number(((tokensSaved / budgetPlan.rawTotalTokens) * 100).toFixed(1))
      : 0;

    const estimatedCostUSD = calculateCostUSD(
      finalAllocatedTokens,
      task.agentEnvironment?.model || 'default'
    );
    const costSavedUSD = Math.max(0, Number((budgetPlan.baselineCostUSD - estimatedCostUSD).toFixed(6)));

    const reconciledBudgetPlan: BudgetAllocationPlan = {
      ...budgetPlan,
      allocations: finalAllocations,
      totalTokens: finalAllocatedTokens,
      tokensSaved,
      savingsPercentage,
      estimatedCostUSD,
      costSavedUSD,
    };

    const detailedEstimate = this.tokenCostEstimator.getDetailedEstimate
      ? this.tokenCostEstimator.getDetailedEstimate(formattedContext.promptText, task.agentEnvironment)
      : defaultTokenizerRegistry.estimate(formattedContext.promptText, task.agentEnvironment);

    const estimatedRenderedTokens = detailedEstimate.tokens;

    trajectoryLogger.logEvent('CONTEXT_ALLOCATED', {
      planId,
      totalUnits: plannedUnits.length,
      allocatedTokens: reconciledBudgetPlan.totalTokens,
      estimatedRenderedTokens,
      actualRenderedTokens: estimatedRenderedTokens,
      tokenEstimationMethod: detailedEstimate.method,
      tokenSafetyMargin: detailedEstimate.safetyMargin,
      savingsPercentage: reconciledBudgetPlan.savingsPercentage,
      costSavedUSD: reconciledBudgetPlan.costSavedUSD,
      overflowReason,
      policyId,
      policyVersion,
    });

    const contextPlan: ContextPlan = {
      taskId: boundTask.taskId,
      planId,
      sessionId: effectiveSessionId,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      agentEnvironmentId: boundTask.agentEnvironment.systemConfigurationHash,
      budgetPlan: reconciledBudgetPlan,
      units: plannedUnits,
      formattedContext,
      exposureDecisions,
      exposureDecisionsV2,
      decisionObservations,
      policyId,
      policyVersion,
      dataRights: this.dataRights,
      estimatedRenderedTokens,
      actualRenderedTokens: estimatedRenderedTokens, // backward-compatible alias
      actualProviderInputTokens: undefined, // reported downstream by provider
      tokenEstimationMethod: detailedEstimate.method,
      tokenSafetyMargin: detailedEstimate.safetyMargin,
      overflowReason,
      createdAt,
    };

    // If a persistent store is configured and telemetry is allowed, persist all runtime and learning records (Closure PR 0.4 & Milestone PR J1)
    if (this.sqliteStore && this.dataRights.telemetryAllowed !== false) {
      try {
        // Section 37: Persist rights-safe ContextUnit metadata at indexing/optimization time
        const rightsSafeUnits = units.map((u) => ({
          ...u,
          metadata: { ...u.metadata },
        }));
        this.sqliteStore.saveContextUnits(rightsSafeUnits, this.dataRights);

        this.sqliteStore.saveSiftrSession(session);
        this.sqliteStore.saveSnapshot(snapshot);
        this.sqliteStore.saveTaskContext(boundTask, this.dataRights);
        this.sqliteStore.saveContextPlan(contextPlan, snapshot.workspaceSnapshotId);
        if (exposureDecisionsV2.length > 0) {
          this.sqliteStore.saveExposureDecisions(exposureDecisionsV2, boundTask.taskId);
        }
        if (decisionObservations.length > 0) {
          this.sqliteStore.saveCandidateDecisionObservations(decisionObservations, this.dataRights);
        }
        this.sqliteStore.saveTrajectoryEvents(
          trajectoryLogger.getEvents(),
          effectiveSessionId,
          snapshot.workspaceSnapshotId,
          this.dataRights
        );

        // Sections 45-48: Persist FinalContextAllocation with 3-stage resolution lineage
        const allocationItems: FinalContextAllocationItem[] = plannedUnits.map((pu) => {
          const u = unitsMap.get(pu.contextUnitId);
          const f = featuresMap.get(pu.contextUnitId);
          const rankerRes = (u && f) ? resRanker.allocateResolution(u, f, false, 1.0).resolution : pu.resolution;
          const budgetedRes = budgetPlan.allocations.find((a) => a.contextUnitId === pu.contextUnitId)?.resolution || pu.resolution;
          return {
            contextUnitId: pu.contextUnitId,
            rankerResolution: rankerRes,
            budgetedResolution: budgetedRes,
            finalResolution: pu.resolution,
            plannedResolution: budgetedRes,
            actualResolution: pu.resolution,
            estimatedTokens: pu.tokenEstimate,
            materializerVersion: 'DefaultContextUnitMaterializer@1.0.0',
          };
        });

        const finalAllocation = createFinalContextAllocation({
          planId: contextPlan.planId,
          workspaceSnapshotId: snapshot.workspaceSnapshotId,
          items: allocationItems,
          budgetLimitTokens: this.budgetLimits.maxTokens,
          allocatedEstimatedTokens: reconciledBudgetPlan.totalTokens,
          renderedEstimatedTokens: estimatedRenderedTokens,
          tokenizerMethod: detailedEstimate.method,
          overflow: Boolean(overflowReason),
        });

        this.sqliteStore.saveFinalContextAllocation(finalAllocation);
      } catch (storeErr) {
        console.warn('[ContextEngine] Failed to persist local learning records:', storeErr);
      }
    }

    // Milestone Part V: Execute JEV in SHADOW mode if configured (never mutates ContextPlan)
    if (this.jevShadowRunner && this.jevShadowRunner.getMode() === JevMode.SHADOW) {
      const shadowPromise = this.jevShadowRunner
        .evaluate({
          task: boundTask,
          workspaceSnapshot: snapshot,
          rankedCandidates,
          units,
          graph,
          featuresMap,
          dataRights: this.dataRights,
          contextPlanId: planId,
        })
        .then((signals) => {
          contextPlan.jevSignals = signals;
          return signals;
        })
        .catch((shadowErr) => {
          console.warn('[ContextEngine] JEV shadow evaluation error:', shadowErr);
          contextPlan.jevError = shadowErr instanceof Error ? shadowErr : new Error(String(shadowErr));
          return [];
        });
      contextPlan.jevPromise = shadowPromise;
    }

    return contextPlan;
  }

  /**
   * Generates a ContextPlan and awaits shadow JEV evaluation if enabled.
   */
  public async generatePlanAsync(params: {
    task: TaskContext;
    units: ContextUnit[];
    graph?: ContextGraph;
    gitIntelligence?: GitGraphIntelligence;
    featureCutoff?: FeatureCutoff;
    dirtyPaths?: string[];
    seedUnitIds?: string[];
    snapshot?: WorkspaceSnapshot;
    candidateBudget?: number;
  }): Promise<ContextPlan> {
    const plan = this.generatePlan(params);
    if (plan.jevPromise) {
      await plan.jevPromise;
    }
    return plan;
  }

  /**
   * High-level orchestrator that indexes and optimizes context for a workspace directory.
   */
  public static async optimizeWorkspace(options: OptimizeWorkspaceOptions): Promise<OptimizeWorkspaceResult> {
    const rootDir = path.resolve(options.workspaceDir || process.cwd());
    const workspaceManager = new WorkspaceManager({ rootDir });
    const maxReplanningRetries = options.maxReplanningRetries ?? 2;

    let attempt = 0;
    while (attempt <= maxReplanningRetries) {
      try {
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
            if (line.length > 3) {
              let p = line.substring(3).trim();
              if (p.includes(' -> ')) {
                p = p.split(' -> ')[1].trim();
              }
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
          trustPolicy: options.repositoryTrustPolicy,
        });
        const units = indexResult.units;

        // Record expected file hashes on sourceReader for this snapshot to ensure immutability
        const sourceReader = new DefaultWorkspaceSourceReader(rootDir);
        const recordedPaths = new Set<string>();
        for (const u of units) {
          if (u.path && !recordedPaths.has(u.path)) {
            recordedPaths.add(u.path);
            const safePath = path.resolve(rootDir, u.path);
            if (fs.existsSync(safePath)) {
              try {
                const fileHash = crypto.createHash('sha256').update(fs.readFileSync(safePath)).digest('hex');
                sourceReader.recordExpectedHash(snapshot.workspaceSnapshotId, u.path, fileHash);
              } catch {
                // Ignore read errors
              }
            }
          }
        }

        const graphBuilder = new GraphBuilder();
        const graph = graphBuilder.buildGraph(units, { repoDir: rootDir, sourceReader, snapshot });

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

        // Initialize SQLite store if telemetry is permitted
        let store: SqliteStore | undefined = undefined;
        const telemetryAllowed = options.dataRights ? options.dataRights.telemetryAllowed : true;
        if (telemetryAllowed !== false) {
          try {
            const siftrDir = path.join(rootDir, '.siftr');
            if (!fs.existsSync(siftrDir)) {
              fs.mkdirSync(siftrDir, { recursive: true });
            }
            const dbPath = path.join(siftrDir, 'observations.sqlite');
            store = new SqliteStore(dbPath);
          } catch {
            // Non-fatal if local SQLite store cannot be initialized
          }
        }

        let existingSession: SiftrSession | undefined = undefined;
        if (options.sessionId && store) {
          existingSession = store.getSiftrSession(options.sessionId);
        }

        const taskId =
          options.taskId ||
          existingSession?.taskId ||
          `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
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

        const agentProviderVal = kind === 'cursor' ? 'cursor' : (options.agentKind || 'unknown');
        const modelVal = options.agentModel || (existingSession?.metadata?.agentModel as string) || 'unknown';
        const availableTools = options.availableTools ? [...options.availableTools] : [];

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

        const materializer = new DefaultContextUnitMaterializer({
          sourceReader,
          throwOnWorkspaceChanged: true,
        });

        const engine = new ContextEngine({
          repoRootDir: rootDir,
          adapter,
          dataRights: options.dataRights,
          budgetProfile: options.budgetProfile,
          budgetLimits,
          materializer,
          sqliteStore: store,
          jevShadowRunner: options.jevShadowRunner,
          enableJevShadow: options.enableJevShadow,
          ranker: options.ranker,
          candidateBudget: options.candidateBudget,
        });

        // Canonical construction order (Milestone Part I Sections 2-4):
        // WorkspaceSnapshot -> AgentEnvironment -> systemConfigurationHash -> SiftrSession -> TaskContext -> ContextPlan
        const agentEnvironment = createAgentEnvironment({
          agentProvider: agentProviderVal,
          agentVersion: 'unknown',
          model: modelVal,
          harnessVersion: 'unknown',
          availableTools,
          provenance: {
            agentProvider: {
              value: agentProviderVal !== 'unknown' ? agentProviderVal : null,
              source: options.agentKind ? 'USER_SUPPLIED' : (kind === 'cursor' ? 'DETECTED' : 'UNKNOWN'),
            },
            agentVersion: {
              value: null,
              source: 'UNKNOWN',
            },
            model: {
              value: options.agentModel || null,
              source: options.agentModel ? 'USER_SUPPLIED' : 'UNKNOWN',
            },
            harnessVersion: {
              value: null,
              source: 'UNKNOWN',
            },
          },
        });

        const agentEnvironmentId = agentEnvironment.systemConfigurationHash;

        // Authoritatively obtain/create active session bound to canonical agentEnvironmentId
        const session = engine.getOrCreateSession({
          sessionId: options.sessionId,
          taskId,
          agentEnvironmentId,
          snapshotId: snapshot.workspaceSnapshotId,
        });

        const task = createTaskContext({
          taskId,
          sessionId: session.sessionId,
          workspaceSnapshotId: snapshot.workspaceSnapshotId,
          primaryPrompt: options.prompt,
          evidence: evidenceList,
          agentEnvironment,
        });

        const plan = await engine.generatePlanAsync({
          task,
          units,
          graph,
          gitIntelligence,
          dirtyPaths,
          seedUnitIds: options.seedUnitIds,
          snapshot,
          candidateBudget: options.candidateBudget,
        });

        plan.replanningAttempts = attempt;

        return {
          plan,
          engine,
          units,
          graph,
          task,
          formattedContext: plan.formattedContext,
          contextString: plan.formattedContext.promptText,
          replanningAttempts: attempt,
          decisionObservations: plan.decisionObservations,
          sqliteStore: store,
        };
      } catch (err: unknown) {
        if (isWorkspaceChangedError(err) && attempt < maxReplanningRetries) {
          attempt++;
          console.warn(
            `[ContextEngine] Workspace changed on disk for "${err.filePath}". Replanning with fresh snapshot (attempt ${attempt}/${maxReplanningRetries})...`
          );
          continue;
        }
        throw err;
      }
    }

    throw new Error('Unreachable: Replanning loop terminated unexpectedly.');
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

    const sourceReader = new DefaultWorkspaceSourceReader(rootDir);
    const graphBuilder = new GraphBuilder();
    const graph = graphBuilder.buildGraph(units, { repoDir: rootDir, sourceReader, snapshot });
    const gitIntelligence = new GitGraphIntelligence({ repoDir: rootDir });

    const taskId = options.taskId || `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const userPromptEvidence: UserPromptEvidence = {
      evidenceId: 'ev_' + crypto.randomUUID().slice(0, 8),
      kind: TaskEvidenceKind.USER_PROMPT,
      timestamp: new Date().toISOString(),
      prompt: options.prompt,
    };

    const availableTools = options.availableTools ? [...options.availableTools] : [];

    const task = createTaskContext({
      taskId,
      sessionId: options.sessionId,
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      primaryPrompt: options.prompt,
      evidence: [userPromptEvidence],
      agentEnvironment: createAgentEnvironment({
        agentProvider: 'unknown',
        agentVersion: 'unknown',
        model: 'unknown',
        harnessVersion: 'unknown',
        availableTools,
        provenance: {
          agentProvider: { value: null, source: 'UNKNOWN' },
          agentVersion: { value: null, source: 'UNKNOWN' },
          model: { value: null, source: 'UNKNOWN' },
          harnessVersion: { value: null, source: 'UNKNOWN' },
        },
      }),
    });

    const effectiveMax = options.candidateBudget ?? options.limit ?? 50;
    const generator = new CandidateGenerator();
    const candidates = generator.generateCandidates(task, units, graph, gitIntelligence, {
      maxCandidates: effectiveMax,
    });

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

    const ranker = options.ranker || new ContextRanker();
    const ranked = ranker.rank(featuresList);
    const limit = options.limit || 20;

    return {
      task,
      ranked: ranked.slice(0, limit),
      totalCandidates: candidates.length,
    };
  }

  /**
   * Records measured downstream input token usage from the actual LLM provider (Closure PR 0.5).
   * Updates in-memory plan and persistent SQLite store if available.
   */
  public recordActualProviderTokens(plan: ContextPlan, actualInputTokens: number): void {
    plan.actualProviderInputTokens = actualInputTokens;
    if (this.sqliteStore && this.dataRights.telemetryAllowed !== false) {
      try {
        this.sqliteStore.updatePlanActualProviderTokens(plan.planId, actualInputTokens);
      } catch (err) {
        console.warn('[ContextEngine] Failed to record actual provider tokens:', err);
      }
    }
  }

  /**
   * Static helper to record measured provider tokens on a plan and its store.
   */
  public static recordActualProviderTokens(
    store: SqliteStore | undefined,
    plan: ContextPlan,
    actualInputTokens: number
  ): void {
    plan.actualProviderInputTokens = actualInputTokens;
    if (store) {
      try {
        store.updatePlanActualProviderTokens(plan.planId, actualInputTokens);
      } catch (err) {
        console.warn('[ContextEngine] Failed to update actual provider tokens in store:', err);
      }
    }
  }
}


