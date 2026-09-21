/**
 * SiftrCode V2 - JEV Shadow Runner (Milestone Part III-VI, XI-XIII, XVIII)
 * Executes TypeSafe JEV evaluation in pure SHADOW mode.
 * Evaluates candidate subsets through structured egress with bounded concurrency and call budgets.
 * Invariant: JEV shadow signals are securely persisted and NEVER alter the ContextPlan during this milestone.
 */

import { ContextUnit, ContextUnitKind } from '../../../context/context_unit';
import { TaskContext } from '../../../context/task_context';
import { ContextGraph } from '../../../graph/context_graph';
import { ContextFeaturesV1 } from '../../../ranking/feature_schema';
import { RankedCandidate } from '../../../ranking/context_rank';
import { WorkspaceSnapshot } from '../../../workspace/workspace_snapshot';
import { DataClass, DataRights, isDataClassPermitted, isRemoteProcessingPermitted } from '../../../rights/data_rights';
import { TrustLevel } from '../../../security/trust';
import { StructuredEgressGateway, EgressField, SanitizedEgressPayload } from '../../../security/structured_egress';
import { SystemOneClient, TypeSafeSystemOneClient, FakeSystemOneClient } from './typesafe_client';
import { JEV_QUESTION_SET_VERSION_V1 } from './jev_questions';
import { JevSignalV1, JevFallbackReason, JevMode, createJevSignalV1 } from './jev_signal';
import { JevDecisionBudget, DEFAULT_JEV_DECISION_BUDGET, JevCallTracker, Semaphore } from './jev_budget';
import { JevCandidateStateV1 } from './jev_state';
import { SqliteStore } from '../../../storage/sqlite_store';

export interface JevShadowRunnerOptions {
  client?: SystemOneClient;
  apiKey?: string | null;
  mode?: JevMode;
  budget?: Partial<JevDecisionBudget>;
  egressGateway?: StructuredEgressGateway;
  sqliteStore?: SqliteStore;
  model?: string | null;
}

export class JevShadowRunner {
  private client?: SystemOneClient;
  private mode: JevMode;
  private budget: JevDecisionBudget;
  private egressGateway: StructuredEgressGateway;
  private sqliteStore?: SqliteStore;
  private model: string | null;
  private lastTracker?: JevCallTracker;

  constructor(options: JevShadowRunnerOptions = {}) {
    const envKey = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
    const envMode = process.env.SIFTR_JEV_MODE ? (process.env.SIFTR_JEV_MODE.toUpperCase() as JevMode) : undefined;
    this.mode = options.mode || envMode || (process.env.SIFTR_JEV_ENABLED === 'true' ? JevMode.SHADOW : JevMode.OFF);

    const envMaxCalls = process.env.SIFTR_JEV_MAX_CALLS ? parseInt(process.env.SIFTR_JEV_MAX_CALLS, 10) : undefined;
    const envMaxCandidates = process.env.SIFTR_JEV_MAX_CANDIDATES ? parseInt(process.env.SIFTR_JEV_MAX_CANDIDATES, 10) : undefined;
    const envBudget: Partial<JevDecisionBudget> = {};
    if (envMaxCalls && !isNaN(envMaxCalls)) {
      envBudget.maxCallsPerTask = envMaxCalls;
    }
    if (envMaxCandidates && !isNaN(envMaxCandidates)) {
      envBudget.maxCandidates = envMaxCandidates;
    }
    this.budget = { ...DEFAULT_JEV_DECISION_BUDGET, ...envBudget, ...options.budget };
    this.egressGateway = options.egressGateway || new StructuredEgressGateway();
    this.sqliteStore = options.sqliteStore;
    this.model = options.model !== undefined ? options.model : (process.env.SIFTR_JEV_MODEL || null);

    if (options.client) {
      this.client = options.client;
    } else if (options.apiKey !== null && (options.apiKey || (this.mode === JevMode.SHADOW && process.env.SIFTR_JEV_ENABLED === 'true' && envKey))) {
      const activeKey = options.apiKey || envKey;
      if (activeKey) {
        try {
          this.client = new TypeSafeSystemOneClient({
            apiKey: activeKey,
            defaultModel: this.model || undefined,
            timeoutMs: this.budget.maxLatencyMs,
          });
        } catch {
          this.client = undefined;
        }
      }
    }
  }

  public getMode(): JevMode {
    return this.mode;
  }

  public getBudget(): JevDecisionBudget {
    return { ...this.budget };
  }

  public getLastTracker(): JevCallTracker | undefined {
    return this.lastTracker;
  }

  /**
   * Selects candidate subset for JEV shadow evaluation (Part IV Section 9):
   * Top 12 local-ranked candidates + up to 8 uncertainty/diversity candidates.
   */
  public selectShadowCandidates(
    rankedCandidates: RankedCandidate[],
    unitsMap: Map<string, ContextUnit>,
    featuresMap: Map<string, ContextFeaturesV1>,
    budget: JevDecisionBudget = this.budget
  ): ContextUnit[] {
    const selected: ContextUnit[] = [];
    const selectedIds = new Set<string>();

    // 1. Top 12 local-ranked candidates
    const topRankedLimit = Math.min(12, budget.maxCandidates);
    for (const rc of rankedCandidates) {
      if (selected.length >= topRankedLimit) break;
      const u = unitsMap.get(rc.contextUnitId);
      if (u && !selectedIds.has(u.id)) {
        selected.push(u);
        selectedIds.add(u.id);
      }
    }

    // 2. Up to 8 uncertainty / diversity candidates (Part IV Section 9)
    const remainingSlots = Math.min(budget.maxCandidates - selected.length, 8);
    if (remainingSlots > 0) {
      const diversityCandidates: ContextUnit[] = [];

      for (const rc of rankedCandidates) {
        if (selectedIds.has(rc.contextUnitId)) continue;
        const u = unitsMap.get(rc.contextUnitId);
        const f = featuresMap.get(rc.contextUnitId);
        if (!u || !f) continue;

        const isDiverse =
          (f.bm25Score > 0.4 && f.graphDegree === 0) || // high semantic / low graph
          ((f.isDirectDependency || f.isDirectDependent) && !f.exactSymbolMatch && !f.exactPathMatch) || // graph connected / no exact match
          (f.maxCoChangeWithSeeds > 0.3) || // high git co-change
          (u.kind === ContextUnitKind.CONFIG || u.kind === ContextUnitKind.SCHEMA || u.kind === ContextUnitKind.TEST);

        if (isDiverse) {
          diversityCandidates.push(u);
          selectedIds.add(u.id);
          if (diversityCandidates.length >= remainingSlots) break;
        }
      }

      selected.push(...diversityCandidates);
    }

    // 3. Backfill with next ranked candidates if slots remain up to maxCandidates
    if (selected.length < budget.maxCandidates) {
      for (const rc of rankedCandidates) {
        if (selected.length >= budget.maxCandidates) break;
        if (!selectedIds.has(rc.contextUnitId)) {
          const u = unitsMap.get(rc.contextUnitId);
          if (u) {
            selected.push(u);
            selectedIds.add(u.id);
          }
        }
      }
    }

    return selected;
  }

  /**
   * Evaluates candidates in SHADOW mode.
   * Emits JevSignalV1 records to storage, never altering the caller's ContextPlan.
   */
  public async evaluate(params: {
    task: TaskContext;
    workspaceSnapshot: WorkspaceSnapshot;
    rankedCandidates: RankedCandidate[];
    units: ContextUnit[];
    graph?: ContextGraph;
    featuresMap: Map<string, ContextFeaturesV1>;
    dataRights: DataRights;
    contextPlanId?: string;
    tracker?: JevCallTracker;
  }): Promise<JevSignalV1[]> {
    if (this.mode === JevMode.OFF) {
      return [];
    }

    const {
      task,
      workspaceSnapshot,
      rankedCandidates,
      units,
      graph,
      featuresMap,
      dataRights,
      contextPlanId,
    } = params;

    const unitsMap = new Map<string, ContextUnit>();
    for (const u of units) unitsMap.set(u.id, u);

    // 1. Candidate selection
    const shadowUnits = this.selectShadowCandidates(
      rankedCandidates,
      unitsMap,
      featuresMap,
      this.budget
    );

    const tracker = params.tracker || new JevCallTracker(this.budget);
    this.lastTracker = tracker;
    const semaphore = new Semaphore(this.budget.maxConcurrency);
    const signals: JevSignalV1[] = [];

    // Evaluate in parallel with bounded concurrency
    const evalPromises = shadowUnits.map((unit) =>
      semaphore.run(async () => {
        tracker.recordEligibleCandidate();
        const startTime = Date.now();
        const features = featuresMap.get(unit.id);

        // 2. Pre-flight check: API key / client
        if (!this.client) {
          signals.push(
            createJevSignalV1({
              taskId: task.taskId,
              sessionId: task.sessionId,
              workspaceSnapshotId: workspaceSnapshot.workspaceSnapshotId,
              contextUnitId: unit.id,
              contextPlanId,
              semanticRelevanceProbability: null,
              implementationNeededProbability: null,
              likelyEditTargetProbability: null,
              likelyRootCauseProbability: null,
              model: this.model,
              questionSetVersion: JEV_QUESTION_SET_VERSION_V1,
              latencyMs: Date.now() - startTime,
              redactionApplied: false,
              fallbackReason: JevFallbackReason.NO_API_KEY,
            })
          );
          return;
        }

        // 3. Pre-flight check: Call budget (Part XI Section 28 - increment BEFORE attempting work)
        const canCall = tracker.recordCallAttempt();
        if (!canCall) {
          signals.push(
            createJevSignalV1({
              taskId: task.taskId,
              sessionId: task.sessionId,
              workspaceSnapshotId: workspaceSnapshot.workspaceSnapshotId,
              contextUnitId: unit.id,
              contextPlanId,
              semanticRelevanceProbability: null,
              implementationNeededProbability: null,
              likelyEditTargetProbability: null,
              likelyRootCauseProbability: null,
              model: this.model,
              questionSetVersion: JEV_QUESTION_SET_VERSION_V1,
              latencyMs: Date.now() - startTime,
              redactionApplied: false,
              fallbackReason: JevFallbackReason.BUDGET_EXHAUSTED,
            })
          );
          return;
        }

        // 4. Construct egress fields for candidate
        const egressFields: EgressField[] = [
          { key: 'prompt', dataClass: DataClass.TASK_PROMPT, value: task.primaryPrompt },
          { key: 'title', dataClass: DataClass.SYMBOL_NAME, value: unit.title },
        ];
        if (unit.path) {
          egressFields.push({ key: 'path', dataClass: DataClass.PATH, value: unit.path });
        }
        if ((unit as any).signature) {
          egressFields.push({
            key: 'signature',
            dataClass: DataClass.SYMBOL_METADATA,
            value: (unit as any).signature,
          });
        }

        // 5. Execute through StructuredEgressGateway with strict sanitization (Part VII Section 17)
        try {
          const { result, payload } = await this.egressGateway.execute(
            egressFields,
            unit.trustLevel,
            dataRights,
            async (sanitized: SanitizedEgressPayload) => {
              // Construct JevCandidateStateV1 strictly from sanitized and rights-gated fields
              // Invariant: Gate graph/numeric outbound features through processing.remote, not legacy retention permissions.
              const allowGraph = isRemoteProcessingPermitted(dataRights, DataClass.GRAPH_TOPOLOGY);
              const allowNumeric = isRemoteProcessingPermitted(dataRights, DataClass.NUMERIC_FEATURE);
              const maxInputChars = this.budget.maxInputCharacters ?? 8000;

              let promptStr = sanitized.fields.prompt || '';
              if (promptStr.length > maxInputChars) {
                promptStr = promptStr.slice(0, maxInputChars);
              }

              const candidateState: JevCandidateStateV1 = {
                schemaVersion: 'jev-state-v1',
                task: {
                  prompt: promptStr,
                  evidenceSummary: task.evidence?.length ? `[${task.evidence.map((e) => e.kind).join(', ')}]` : undefined,
                  taskType: task.evidence && task.evidence.length > 0 ? task.evidence[0].kind : undefined,
                },
                candidate: {
                  contextUnitId: unit.id,
                  kind: unit.kind,
                  title: sanitized.fields.title || unit.title,
                  path: sanitized.fields.path,
                  signature: sanitized.fields.signature,
                },
                relationships: {
                  references: (allowGraph && graph)
                    ? graph.getOutgoing(unit.id).slice(0, 8).map((e) => e.to)
                    : undefined,
                },
                history: {
                  coChange: (allowNumeric && features) ? features.maxCoChangeWithSeeds : undefined,
                  recentChange: (allowNumeric && features) ? features.recentChangeFrequency : undefined,
                },
              };

              // Enforce maxInputCharacters bounds on candidate state
              const stateJson = JSON.stringify(candidateState);
              if (stateJson.length > maxInputChars) {
                const excess = stateJson.length - maxInputChars;
                if (candidateState.candidate.signature && candidateState.candidate.signature.length > excess + 50) {
                  candidateState.candidate.signature = candidateState.candidate.signature.slice(0, candidateState.candidate.signature.length - excess - 50) + '...';
                } else if (candidateState.task.prompt.length > excess + 50) {
                  candidateState.task.prompt = candidateState.task.prompt.slice(0, candidateState.task.prompt.length - excess - 50) + '...';
                }
              }

              // Invoke SystemOneClient
              return await this.client!.evaluate({
                state: candidateState as any,
                model: this.model || undefined,
              });
            }
          );

          tracker.recordCallSuccess();
          const latencyMs = Date.now() - startTime;

          // Validate response structure
          if (!result || !result.answers || typeof result.answers !== 'object') {
            signals.push(
              createJevSignalV1({
                taskId: task.taskId,
                sessionId: task.sessionId,
                workspaceSnapshotId: workspaceSnapshot.workspaceSnapshotId,
                contextUnitId: unit.id,
                contextPlanId,
                semanticRelevanceProbability: null,
                implementationNeededProbability: null,
                likelyEditTargetProbability: null,
                likelyRootCauseProbability: null,
                model: result?.model || this.model,
                questionSetVersion: JEV_QUESTION_SET_VERSION_V1,
                requestId: result?.requestId,
                latencyMs,
                inputTokens: result?.usage?.input_tokens,
                redactionApplied: payload.redactionCount > 0,
                fallbackReason: JevFallbackReason.MALFORMED_RESPONSE,
              })
            );
            return;
          }

          signals.push(
            createJevSignalV1({
              taskId: task.taskId,
              sessionId: task.sessionId,
              workspaceSnapshotId: workspaceSnapshot.workspaceSnapshotId,
              contextUnitId: unit.id,
              contextPlanId,
              semanticRelevanceProbability: result.answers?.semanticRelevance?.noul ?? null,
              implementationNeededProbability: result.answers?.implementationNeeded?.noul ?? null,
              likelyEditTargetProbability: result.answers?.likelyEditTarget?.noul ?? null,
              likelyRootCauseProbability: result.answers?.likelyRootCause?.noul ?? null,
              model: result.model || this.model,
              questionSetVersion: JEV_QUESTION_SET_VERSION_V1,
              requestId: result.requestId,
              latencyMs,
              inputTokens: result.usage?.input_tokens,
              redactionApplied: payload.redactionCount > 0,
            })
          );
        } catch (err: any) {
          tracker.recordCallFailure();
          const latencyMs = Date.now() - startTime;
          const msg = (err?.message || '').toLowerCase();
          const errName = (err?.name || '').toLowerCase();

          let fallbackReason = JevFallbackReason.PROVIDER_ERROR;
          if (msg.includes('rights') || msg.includes('remote processing')) {
            fallbackReason = JevFallbackReason.RIGHTS_DENIED;
            tracker.recordRightsDenied();
          } else if (msg.includes('trust') || msg.includes('untrusted')) {
            fallbackReason = JevFallbackReason.TRUST_DENIED;
          } else if (
            errName.includes('timeout') ||
            msg.includes('timeout') ||
            msg.includes('timed out') ||
            msg.includes('abort')
          ) {
            fallbackReason = JevFallbackReason.TIMEOUT;
          } else if (msg.includes('rate') || msg.includes('429') || err?.status === 429) {
            fallbackReason = JevFallbackReason.RATE_LIMITED;
          } else if (msg.includes('malformed') || msg.includes('syntax') || msg.includes('parse')) {
            fallbackReason = JevFallbackReason.MALFORMED_RESPONSE;
          }

          signals.push(
            createJevSignalV1({
              taskId: task.taskId,
              sessionId: task.sessionId,
              workspaceSnapshotId: workspaceSnapshot.workspaceSnapshotId,
              contextUnitId: unit.id,
              contextPlanId,
              semanticRelevanceProbability: null,
              implementationNeededProbability: null,
              likelyEditTargetProbability: null,
              likelyRootCauseProbability: null,
              model: this.model,
              questionSetVersion: JEV_QUESTION_SET_VERSION_V1,
              latencyMs,
              redactionApplied: false,
              fallbackReason,
            })
          );
        }
      })
    );

    await Promise.all(evalPromises);

    // 6. Durable persistence (Part XIII Section 35)
    if (this.sqliteStore && signals.length > 0) {
      try {
        this.sqliteStore.saveJevShadowJudgments(signals, dataRights);
      } catch (persistErr) {
        console.warn('[JevShadowRunner] Failed to persist JEV shadow judgments:', persistErr);
      }
    }

    return signals;
  }
}
