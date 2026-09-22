import * as fs from 'fs';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as crypto from 'crypto';
import { skeletonizeFile } from '../skeleton/dispatcher';
import { packRepository } from '../core/packer';
import { auditRepository } from '../core/auditor';
import { ContextEngine } from '../engine/context_engine';
import { getResolutionName, ContextResolution } from '../context/context_resolution';
import { resolveSafeWorkspacePath, DefaultWorkspaceSourceReader } from '../workspace/workspace_source_reader';
import { createOutcomeEvidence } from '../telemetry/outcome_evidence';
import { createDefaultDataRights } from '../rights/data_rights';
import { SqliteStore } from '../storage/sqlite_store';
import { WorkspaceManager } from '../workspace/workspace_manager';
import { DefaultContextUnitMaterializer } from '../materialization/context_unit_materializer';
import { ContextUnit, ContextUnitKind } from '../context/context_unit';
import { TrustLevel } from '../security/trust';
import { createSiftrSession, SiftrSession, SiftrSessionStatus } from '../telemetry/siftr_session';
import { createContextExpansionEvent, ExpansionReason } from '../telemetry/expansion_event';
import { createProviderUsageEvent } from '../token/provider_usage';
import { createAgentEnvironment } from '../agents/agent_environment';
import { ContextPlan } from '../engine/context_plan';
import { resolveOutcomeLineage } from '../learning/episodes/lineage_resolver';
import {
  MCP_TOOL_SCHEMAS,
  McpToolName,
  validateToolCall,
  zodToJsonSchema,
} from './schemas';

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'siftrcode',
      version: '0.2.1',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'siftr_skeleton',
          description:
            'Returns the pruned AST interface skeleton of a source code file. Strips function bodies and internal implementation loops while preserving 100% of exported types, signatures, classes, and docstrings. Cuts token usage by 80-95%. Supports TypeScript, JavaScript, Python, Go, and Rust.',
          inputSchema: zodToJsonSchema(MCP_TOOL_SCHEMAS.siftr_skeleton),
        },
        {
          name: 'siftr_batch_skeleton',
          description:
            'Batch extracts interface skeletons for multiple source files in a single turn. Ideal for Claude Code and Cursor when inspecting multiple related files simultaneously.',
          inputSchema: zodToJsonSchema(MCP_TOOL_SCHEMAS.siftr_batch_skeleton),
        },
        {
          name: 'siftr_pack',
          description:
            'Scans the codebase, analyzes AST dependencies, applies Jev relevance scoring, and compiles a clean, token-pruned context pack (context.md) for the active task.',
          inputSchema: zodToJsonSchema(MCP_TOOL_SCHEMAS.siftr_pack),
        },
        {
          name: 'siftr_audit',
          description:
            'Audits the current codebase for token bloat and context waste. Returns potential token and cost savings.',
          inputSchema: zodToJsonSchema(MCP_TOOL_SCHEMAS.siftr_audit),
        },
        {
          name: 'siftr_context',
          description:
            'Generates an outcome-aware optimized context bundle for an AI coding task. Discovers multi-channel candidates, ranks by evidence and graph proximity, protects edit targets at full resolution, degrades distant dependencies to AST skeletons, and strictly optimizes token and economic cost limits.',
          inputSchema: zodToJsonSchema(MCP_TOOL_SCHEMAS.siftr_context),
        },
        {
          name: 'siftr_optimize',
          description:
            'Alias for siftr_context. Generates an outcome-aware optimized context bundle for an AI coding task.',
          inputSchema: zodToJsonSchema(MCP_TOOL_SCHEMAS.siftr_optimize),
        },
        {
          name: 'siftr_rank',
          description:
            'Evaluates and ranks candidate files/symbols for a task prompt with transparent heuristic scores, evidence coverage, graph proximity, and penalty breakdowns.',
          inputSchema: zodToJsonSchema(MCP_TOOL_SCHEMAS.siftr_rank),
        },
        {
          name: 'siftr_outcome',
          description:
            'Reports task execution results, oracle test verdicts (unit, regression, security), actual provider token usage, and costs to close the learning loop.',
          inputSchema: zodToJsonSchema(MCP_TOOL_SCHEMAS.siftr_outcome),
        },
        {
          name: 'siftr_expand',
          description:
            'Dynamically expands a skeletonized or signature-level context unit into full implementation body on-demand during an active session.',
          inputSchema: zodToJsonSchema(MCP_TOOL_SCHEMAS.siftr_expand),
        },
        {
          name: 'siftr_session',
          description:
            'Manages or inspects active Siftr coding agent sessions, linking tasks, plans, and token economics.',
          inputSchema: zodToJsonSchema(MCP_TOOL_SCHEMAS.siftr_session),
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const validation = validateToolCall(name as McpToolName, args);
    if (!validation.success) {
      return {
        content: [{ type: 'text', text: `Error: ${validation.error}` }],
        isError: true,
      };
    }

    try {
      if (name === 'siftr_skeleton') {
        const directContent = args?.content as string | undefined;
        const filePath = args?.filePath ? String(args.filePath) : 'source.ts';

        let rawContent = '';
        if (directContent !== undefined) {
          rawContent = directContent;
        } else {
          const workspaceRoot = process.cwd();
          const safePath = resolveSafeWorkspacePath(workspaceRoot, filePath);
          if (!safePath || !fs.existsSync(safePath)) {
            return {
              content: [{ type: 'text', text: `Error: File not found or path outside workspace: ${filePath}` }],
              isError: true
            };
          }
          rawContent = fs.readFileSync(safePath, 'utf-8');
        }

        const skeleton = skeletonizeFile(rawContent, filePath);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  filePath,
                  originalTokens: skeleton.originalTokensEstimate,
                  skeletonTokens: skeleton.skeletonTokensEstimate,
                  reduction: `${(skeleton.reductionRatio * 100).toFixed(1)}%`,
                  skeletonContent: skeleton.skeletonContent
                },
                null,
                2
              )
            }
          ]
        };
      }

      if (name === 'siftr_batch_skeleton') {
        const filePaths = (args?.filePaths as string[]) || [];
        const results: Array<{
          filePath: string;
          originalTokens: number;
          skeletonTokens: number;
          reduction: string;
          skeletonContent: string;
          error?: string;
        }> = [];

        let totalOriginal = 0;
        let totalSkeleton = 0;

        const workspaceRoot = process.cwd();
        for (const fp of filePaths) {
          try {
            const safePath = resolveSafeWorkspacePath(workspaceRoot, fp);
            if (!safePath || !fs.existsSync(safePath)) {
              results.push({
                filePath: fp,
                originalTokens: 0,
                skeletonTokens: 0,
                reduction: '0%',
                skeletonContent: '',
                error: `File not found or path outside workspace: ${fp}`
              });
              continue;
            }
            const rawContent = fs.readFileSync(safePath, 'utf-8');
            const skel = skeletonizeFile(rawContent, fp);
            totalOriginal += skel.originalTokensEstimate;
            totalSkeleton += skel.skeletonTokensEstimate;

            results.push({
              filePath: fp,
              originalTokens: skel.originalTokensEstimate,
              skeletonTokens: skel.skeletonTokensEstimate,
              reduction: `${(skel.reductionRatio * 100).toFixed(1)}%`,
              skeletonContent: skel.skeletonContent
            });
          } catch (err: any) {
            results.push({
              filePath: fp,
              originalTokens: 0,
              skeletonTokens: 0,
              reduction: '0%',
              skeletonContent: '',
              error: err.message
            });
          }
        }

        const overallSavings = totalOriginal > 0
          ? `${(((totalOriginal - totalSkeleton) / totalOriginal) * 100).toFixed(1)}%`
          : '0%';

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  totalFiles: results.length,
                  totalOriginalTokens: totalOriginal,
                  totalSkeletonTokens: totalSkeleton,
                  overallTokenReduction: overallSavings,
                  files: results
                },
                null,
                2
              )
            }
          ]
        };
      }

      if (name === 'siftr_pack') {
        const includeContent = args?.includeContent !== false;
        const result = await packRepository({
          focus: args?.focus as string | undefined,
          directory: args?.directory as string | undefined,
          output: args?.output as string | undefined
        });

        const responsePayload: any = {
          message: 'Repository packed successfully',
          outputFile: result.outputFile,
          scannedFiles: result.totalFilesScanned,
          fullFiles: result.rootCandidateFiles,
          skeletonizedFiles: result.skeletonizedFiles,
          prunedFiles: result.prunedFiles,
          rawTokens: result.rawTokensEstimate,
          packedTokens: result.packedTokensEstimate,
          reduction: `${result.reductionPercentage}%`,
          savedUSD: `$${result.estimatedCostSavedUSD.toFixed(2)}`
        };

        if (includeContent && result.packedContent) {
          responsePayload.content = result.packedContent;
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responsePayload, null, 2)
            }
          ]
        };
      }

      if (name === 'siftr_audit') {
        const audit = await auditRepository((args?.directory as string) || process.cwd());
        return {
          content: [{ type: 'text', text: JSON.stringify(audit, null, 2) }]
        };
      }

      if (name === 'siftr_context' || name === 'siftr_optimize') {
        const prompt = String(args?.prompt || '');
        if (!prompt) {
          return {
            content: [{ type: 'text', text: 'Error: "prompt" parameter is required' }],
            isError: true
          };
        }

        const workspaceDir = (args?.directory as string) || process.cwd();
        const siftrDir = path.join(workspaceDir, '.siftr');
        if (!fs.existsSync(siftrDir)) {
          fs.mkdirSync(siftrDir, { recursive: true });
        }
        const sqlitePath = path.join(siftrDir, 'observations.sqlite');
        const sessionStore = new SqliteStore(sqlitePath);

        let inputSessionId = args?.sessionId ? String(args.sessionId) : undefined;
        let resolvedTaskId = args?.taskId ? String(args.taskId) : undefined;

        let existingSess = inputSessionId ? sessionStore.getSiftrSession(inputSessionId) : undefined;
        if (existingSess) {
          if (!resolvedTaskId) {
            resolvedTaskId = existingSess.taskId;
          }
        }

        const agentModel =
          (args?.agentModel as string) ||
          (existingSess?.metadata?.agentModel as string) ||
          undefined;
        const agentKind =
          (args?.agentKind as any) ||
          (existingSess?.metadata?.agentKind as any) ||
          undefined;
        const budgetProfile = (args?.budgetProfile as any) || undefined;
        const tokenBudget = typeof args?.tokenBudget === 'number' ? args.tokenBudget : undefined;
        const maxCostUSD = typeof args?.maxCostUSD === 'number' ? args.maxCostUSD : undefined;
        const includeContext = args?.includeContext !== false;
        const includePlan = args?.includePlan !== false;

        const result = await ContextEngine.optimizeWorkspace({
          workspaceDir,
          prompt,
          taskId: resolvedTaskId,
          sessionId: inputSessionId,
          agentModel,
          agentKind,
          budgetProfile,
          tokenBudget,
          maxCostUSD,
        });

        const plan = result.plan;
        const allocatedUnits = plan.units.filter((u) => u.resolution > 0);

        const responsePayload: any = {
          planId: plan.planId,
          taskId: plan.taskId,
          sessionId: plan.sessionId,
          workspaceSnapshotId: plan.workspaceSnapshotId,
          totalRawTokens: plan.budgetPlan.rawTotalTokens,
          allocatedTokens: plan.budgetPlan.totalTokens,
          reductionRatio: `${plan.budgetPlan.savingsPercentage.toFixed(1)}%`,
          estimatedCostUSD: `$${plan.budgetPlan.estimatedCostUSD.toFixed(4)}`,
          costSavedUSD: `$${plan.budgetPlan.costSavedUSD.toFixed(4)}`,
          allocatedUnitsCount: allocatedUnits.length,
          units: allocatedUnits.map((u) => ({
            contextUnitId: u.contextUnitId,
            path: u.path,
            title: u.title,
            resolution: u.resolution,
            resolutionName: getResolutionName(u.resolution),
            allocatedTokens: u.tokenEstimate,
            reason: u.reason,
          })),
        };

        if (includeContext) {
          responsePayload.context = result.contextString;
        }

        if (includePlan) {
          responsePayload.plan = plan;
        }


        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responsePayload, null, 2)
            }
          ]
        };
      }

      if (name === 'siftr_rank') {
        const prompt = String(args?.prompt || '');
        if (!prompt) {
          return {
            content: [{ type: 'text', text: 'Error: "prompt" parameter is required' }],
            isError: true
          };
        }

        const workspaceDir = (args?.directory as string) || process.cwd();
        const limit = typeof args?.limit === 'number' ? args.limit : 20;

        const rankResult = await ContextEngine.rankWorkspace({
          workspaceDir,
          prompt,
          limit,
        });

        const responsePayload = {
          taskId: rankResult.task.taskId,
          totalCandidates: rankResult.totalCandidates,
          returnedRankedCount: rankResult.ranked.length,
          ranked: rankResult.ranked.map((rc) => ({
            rank: rc.rank,
            contextUnitId: rc.contextUnitId,
            score: rc.finalScore,
            primaryReason: rc.reasons[0] || 'relevance',
            allReasons: rc.reasons,
            scoreBreakdown: rc.scoreBreakdown,
          })),
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responsePayload, null, 2)
            }
          ]
        };
      }

      if (name === 'siftr_outcome') {
        const workspaceDir = (args?.directory as string) || process.cwd();
        const siftrDir = path.join(workspaceDir, '.siftr');
        const sqlitePath = path.join(siftrDir, 'observations.sqlite');
        const store = (fs.existsSync(sqlitePath) || fs.existsSync(siftrDir)) ? new SqliteStore(sqlitePath) : null;

        if (!store) {
          return {
            content: [{ type: 'text', text: 'Error: Observation store (.siftr/observations.sqlite) does not exist in workspace.' }],
            isError: true,
          };
        }

        const rawArgs = (args || {}) as Record<string, any>;
        const inputPlanId = rawArgs.planId ? String(rawArgs.planId) : undefined;
        const inputSessionId = rawArgs.sessionId ? String(rawArgs.sessionId) : undefined;
        const inputTaskId = rawArgs.taskId ? String(rawArgs.taskId) : undefined;

        const lineage = resolveOutcomeLineage({
          contextPlanId: inputPlanId,
          sessionId: inputSessionId,
          taskId: inputTaskId,
        }, store);

        if (!lineage.valid) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: lineage.error,
                code: lineage.code,
                finalizationErrorCode: lineage.code,
                episodeFinalized: false,
              }),
            }],
            isError: true,
          };
        }

        const resolvedPlanId = lineage.planId;
        const resolvedSessionId = lineage.sessionId;
        const resolvedTaskId = lineage.taskId;
        const resolvedSnapshotId = lineage.workspaceSnapshotId;
        const resolvedAgentEnvId = lineage.agentEnvironmentId;

        // Parse evidence vector
        const ev = (typeof rawArgs.evidence === 'object' && rawArgs.evidence !== null) ? (rawArgs.evidence as Record<string, any>) : {};
        const buildPassed = typeof ev.buildPassed === 'boolean' ? ev.buildPassed : (typeof rawArgs.buildPassed === 'boolean' ? rawArgs.buildPassed : undefined);
        const publicTestsPassed = typeof ev.publicTestsPassed === 'boolean' ? ev.publicTestsPassed : (typeof ev.testsPassed === 'boolean' ? ev.testsPassed : (typeof rawArgs.testsPassed === 'boolean' ? rawArgs.testsPassed : undefined));
        const hiddenTestsPassed = typeof ev.hiddenTestsPassed === 'boolean' ? ev.hiddenTestsPassed : (typeof rawArgs.hiddenTestsPassed === 'boolean' ? rawArgs.hiddenTestsPassed : undefined);
        const regressionTestsPassed = typeof ev.regressionTestsPassed === 'boolean' ? ev.regressionTestsPassed : (typeof rawArgs.regressionTestsPassed === 'boolean' ? rawArgs.regressionTestsPassed : undefined);
        const staticChecksPassed = typeof ev.staticChecksPassed === 'boolean' ? ev.staticChecksPassed : (typeof rawArgs.staticChecksPassed === 'boolean' ? rawArgs.staticChecksPassed : undefined);
        const securityChecksPassed = typeof ev.securityChecksPassed === 'boolean' ? ev.securityChecksPassed : (typeof rawArgs.securityChecksPassed === 'boolean' ? rawArgs.securityChecksPassed : undefined);
        const behavioralOraclePassed = typeof ev.behavioralOraclePassed === 'boolean' ? ev.behavioralOraclePassed : (typeof rawArgs.behavioralOraclePassed === 'boolean' ? rawArgs.behavioralOraclePassed : undefined);
        const userAccepted = typeof ev.userAccepted === 'boolean' ? ev.userAccepted : (typeof rawArgs.userAccepted === 'boolean' ? rawArgs.userAccepted : undefined);
        const agentReportedSuccess = typeof ev.agentReportedSuccess === 'boolean' ? ev.agentReportedSuccess : (typeof rawArgs.agentClaimedSuccess === 'boolean' ? rawArgs.agentClaimedSuccess : undefined);
        const humanReview = ev.humanReview || rawArgs.humanReview;
        const actualProviderInputTokens = typeof ev.actualProviderInputTokens === 'number' ? ev.actualProviderInputTokens : (typeof rawArgs.actualProviderInputTokens === 'number' ? rawArgs.actualProviderInputTokens : undefined);
        const actualProviderOutputTokens = typeof ev.actualProviderOutputTokens === 'number' ? ev.actualProviderOutputTokens : (typeof rawArgs.actualProviderOutputTokens === 'number' ? rawArgs.actualProviderOutputTokens : undefined);
        const costUSD = typeof ev.costUSD === 'number' ? ev.costUSD : (typeof rawArgs.costUSD === 'number' ? rawArgs.costUSD : undefined);
        const wallTimeMs = typeof ev.wallTimeMs === 'number' ? ev.wallTimeMs : (typeof rawArgs.wallTimeMs === 'number' ? rawArgs.wallTimeMs : undefined);
        const notes = rawArgs.notes ? String(rawArgs.notes) : undefined;

        const outcomeEvidence = createOutcomeEvidence({
          taskId: resolvedTaskId,
          sessionId: resolvedSessionId,
          contextPlanId: resolvedPlanId,
          agentEnvironmentId: resolvedAgentEnvId,
          workspaceSnapshotBefore: resolvedSnapshotId,
          buildPassed,
          publicTestsPassed,
          hiddenTestsPassed,
          regressionTestsPassed,
          staticChecksPassed,
          securityChecksPassed,
          behavioralOraclePassed,
          userAccepted,
          agentReportedSuccess,
          humanReview,
          actualProviderInputTokens,
          actualProviderOutputTokens,
          costUSD,
          wallTimeMs,
        });

        // Persist exact lineage and preserve tri-state UNKNOWN (null !== 0)
        let episodeFinalized = false;
        let finalizationErrorCode: string | undefined;
        try {
          const saveRes = store.saveTaskOutcome(outcomeEvidence);
          if (saveRes && typeof saveRes === 'object') {
            episodeFinalized = Boolean(saveRes.episodeFinalized);
            finalizationErrorCode = saveRes.finalizationErrorCode;
          } else {
            episodeFinalized = Boolean(store.getTaskEpisode(resolvedPlanId || resolvedTaskId));
          }
        } catch (err: any) {
          finalizationErrorCode = err.code || err.message || 'FINALIZATION_FAILED';
        }

        store.saveOutcomeEvidence([
          {
            evidenceId: outcomeEvidence.outcomeId,
            taskId: outcomeEvidence.taskId,
            sessionId: outcomeEvidence.sessionId,
            contextPlanId: resolvedPlanId,
            snapshotId: resolvedSnapshotId,
            labelType: 'VERIFIED_SUCCESS',
            value: outcomeEvidence.verifiedSuccess === true ? 1 : (outcomeEvidence.verifiedSuccess === false ? 0 : null),
            verifiedSuccess: outcomeEvidence.verifiedSuccess,
            confidence: outcomeEvidence.confidence,
            strength: outcomeEvidence.confidence >= 0.9 ? 'STRONG' : 'MEDIUM',
            source: 'outcome_policy',
            details: {
              rationale: outcomeEvidence.evaluationRationale,
              planId: resolvedPlanId,
              policyId: outcomeEvidence.policyId,
              policyVersion: outcomeEvidence.policyVersion,
              notes,
            },
          },
        ]);

        if (resolvedPlanId && actualProviderInputTokens !== undefined) {
          store.updatePlanActualProviderTokens(resolvedPlanId, actualProviderInputTokens);
        }

        if (actualProviderInputTokens !== undefined || actualProviderOutputTokens !== undefined) {
          store.saveProviderUsageEvent(createProviderUsageEvent({
            sessionId: resolvedSessionId,
            provider: 'mcp_outcome_report',
            inputTokens: actualProviderInputTokens ?? null,
            outputTokens: actualProviderOutputTokens ?? null,
            costUsd: costUSD ?? null,
          }));
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                outcomeRecorded: true,
                episodeFinalized,
                trainingEligible: outcomeEvidence.verifiedSuccess === true,
                finalizationErrorCode,
                taskId: outcomeEvidence.taskId,
                sessionId: outcomeEvidence.sessionId,
                planId: resolvedPlanId,
                outcomeId: outcomeEvidence.outcomeId,
                verifiedSuccess: outcomeEvidence.verifiedSuccess,
                confidence: outcomeEvidence.confidence,
                policyId: outcomeEvidence.policyId,
                policyVersion: outcomeEvidence.policyVersion,
                rationale: outcomeEvidence.evaluationRationale,
                persisted: true,
              }, null, 2),
            },
          ],
        };
      }

      if (name === 'siftr_expand') {
        const workspaceDir = (args?.directory as string) || process.cwd();
        const filePath = args?.filePath ? String(args.filePath) : undefined;
        const contextUnitId = args?.contextUnitId ? String(args.contextUnitId) : undefined;
        const targetResolutionStr = String(args?.targetResolution || 'body').toLowerCase();
        const inputTaskId = args?.taskId ? String(args.taskId) : undefined;
        const inputSessionId = args?.sessionId ? String(args.sessionId) : undefined;
        const inputPlanId = args?.planId ? String(args.planId) : undefined;

        if (!filePath && !contextUnitId) {
          return {
            content: [{ type: 'text', text: 'Error: Either "filePath" or "contextUnitId" must be provided' }],
            isError: true,
          };
        }

        const sqlitePath = path.join(workspaceDir, '.siftr', 'observations.sqlite');
        const store = fs.existsSync(sqlitePath) ? new SqliteStore(sqlitePath) : null;

        // Section 8: ContextUnit IDs must NEVER be interpreted as filesystem paths!
        if (contextUnitId) {
          if (!store) {
            return {
              content: [{ type: 'text', text: 'Error: Observation store required to resolve contextUnitId.' }],
              isError: true,
            };
          }

          let plan: ContextPlan | undefined;
          if (inputPlanId) {
            plan = store.getContextPlan(inputPlanId);
          } else if (inputSessionId) {
            const plans = store.listContextPlans(undefined, inputSessionId);
            plan = plans[plans.length - 1];
          } else if (inputTaskId) {
            const plans = store.listContextPlans(inputTaskId);
            plan = plans[plans.length - 1];
          }

          if (!plan) {
            return {
              content: [{ type: 'text', text: 'Error: Cannot expand contextUnitId without an active plan or session.' }],
              isError: true,
            };
          }

          const effectiveSessionId = plan.sessionId || inputSessionId;
          if (!effectiveSessionId) {
            return {
              content: [{ type: 'text', text: 'Error: Cannot expand contextUnitId without an active session. Expansion rejected.' }],
              isError: true,
            };
          }

          // Section 40: ContextUnit cannot belong to wrong plan/workspace
          const plannedUnit = plan.units.find((u) => u.contextUnitId === contextUnitId);
          if (!plannedUnit) {
            return {
              content: [{ type: 'text', text: `Error: ContextUnit "${contextUnitId}" does not belong to plan "${plan.planId}" or task "${plan.taskId}". Expansion rejected.` }],
              isError: true,
            };
          }

          const snapshotId = plan.workspaceSnapshotId || (plan as any).snapshotId;
          if (!snapshotId) {
            return {
              content: [{ type: 'text', text: `Error: Snapshot ID not found on plan "${plan.planId}". Expansion rejected.` }],
              isError: true,
            };
          }
          const snapshot = store.getSnapshot(snapshotId);
          if (!snapshot) {
            return {
              content: [{ type: 'text', text: `Error: Snapshot "${snapshotId}" associated with plan "${plan.planId}" was not found in the observation store. Expansion rejected.` }],
              isError: true,
            };
          }

          const snapshotUnits = store.getContextUnitsBySnapshot(snapshot.workspaceSnapshotId);
          let unit = snapshotUnits.find((u) => u.id === contextUnitId) || store.getContextUnit(contextUnitId);
          if (!unit) {
            return {
              content: [{ type: 'text', text: `Error: ERROR_CONTEXT_UNIT_NOT_FOUND - ContextUnit "${contextUnitId}" was not found in snapshot "${snapshot.workspaceSnapshotId}" or store. Expansion rejected.` }],
              isError: true,
            };
          }

          const targetResolution = targetResolutionStr === 'full' ? ContextResolution.FULL : ContextResolution.BODY;

          // Section 10 & 39: Use canonical materializer with workspace source reader
          const materializer = new DefaultContextUnitMaterializer(new DefaultWorkspaceSourceReader(workspaceDir));
          const materialized = materializer.materializeSync(unit, targetResolution, snapshot);

          let fallbackReason: string | undefined = undefined;
          if (targetResolution === ContextResolution.BODY && materialized.resolution === ContextResolution.FULL) {
            fallbackReason = 'Symbol line range unavailable for target unit; fell back to full file content';
          }

          // Section 13: Append immutable ContextExpansionEvent
          const expansionEvent = createContextExpansionEvent({
            taskId: plan.taskId,
            sessionId: effectiveSessionId,
            contextPlanId: plan.planId,
            workspaceSnapshotId: snapshot.workspaceSnapshotId,
            agentEnvironmentId: plan.agentEnvironmentId || 'unknown',
            contextUnitId,
            previousResolution: plannedUnit.resolution,
            requestedResolution: targetResolution,
            actualResolution: materialized.resolution,
            tokenEstimate: materialized.actualTokenCount,
            fallbackReason,
            reason: ExpansionReason.AGENT_EXPLICIT_REQUEST,
          });

          store.saveExpansionEvent(expansionEvent);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  contextUnitId,
                  path: unit.path,
                  requestedResolution: getResolutionName(targetResolution),
                  actualResolution: getResolutionName(materialized.resolution),
                  fallbackReason,
                  tokens: materialized.actualTokenCount,
                  content: materialized.content,
                  eventId: expansionEvent.eventId,
                }, null, 2),
              },
            ],
          };
        }

        // File path handling (separate namespace)
        if (targetResolutionStr === 'body') {
          return {
            content: [{ type: 'text', text: 'Error: targetResolution "body" requires a contextUnitId to resolve discrete symbol AST boundaries. File paths only support targetResolution "full".' }],
            isError: true,
          };
        }

        const safePath = resolveSafeWorkspacePath(workspaceDir, filePath!);
        if (!safePath || !fs.existsSync(safePath)) {
          return {
            content: [{ type: 'text', text: `Error: File not found or path outside workspace: ${filePath}` }],
            isError: true,
          };
        }

        const rawContent = fs.readFileSync(safePath, 'utf-8');
        const tokenEstimate = Math.ceil(rawContent.length / 3.7);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                path: filePath,
                resolution: targetResolutionStr,
                tokens: tokenEstimate,
                content: rawContent,
              }, null, 2),
            },
          ],
        };
      }

      if (name === 'siftr_session') {
        const action = String(args?.action || 'status').toLowerCase();
        const inputTaskId = args?.taskId ? String(args.taskId) : undefined;
        const inputSessionId = args?.sessionId ? String(args.sessionId) : undefined;
        const workspaceDir = (args?.directory as string) || process.cwd();
        const agentModel = args?.agentModel ? String(args.agentModel) : undefined;

        const siftrDir = path.join(workspaceDir, '.siftr');
        if (!fs.existsSync(siftrDir)) {
          fs.mkdirSync(siftrDir, { recursive: true });
        }
        const sqlitePath = path.join(siftrDir, 'observations.sqlite');
        const store = new SqliteStore(sqlitePath);

        if (action === 'start') {
          const taskId = inputTaskId || `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
          const workspaceManager = new WorkspaceManager({ rootDir: workspaceDir });
          const snapshot = await workspaceManager.captureSnapshot();
          store.saveSnapshot(snapshot);

          const env = createAgentEnvironment({
            model: agentModel || 'unknown',
            agentProvider: 'unknown',
          });

          const session = createSiftrSession({
            sessionId: inputSessionId,
            taskId,
            agentEnvironmentId: env.systemConfigurationHash,
            initialWorkspaceSnapshotId: snapshot.workspaceSnapshotId,
            latestWorkspaceSnapshotId: snapshot.workspaceSnapshotId,
            status: 'ACTIVE',
            metadata: {
              agentModel: agentModel || 'unknown',
              agentKind: 'unknown',
            },
          });

          store.saveSiftrSession(session);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'start',
                  sessionId: session.sessionId,
                  taskId: session.taskId,
                  agentEnvironmentId: session.agentEnvironmentId,
                  initialWorkspaceSnapshotId: session.initialWorkspaceSnapshotId,
                  latestWorkspaceSnapshotId: session.latestWorkspaceSnapshotId,
                  status: session.status,
                  createdAt: session.createdAt,
                }, null, 2),
              },
            ],
          };
        }

        if (action === 'end') {
          let session: SiftrSession | undefined;
          if (inputSessionId) {
            session = store.getSiftrSession(inputSessionId);
          } else if (inputTaskId) {
            const plans = store.listContextPlans(inputTaskId);
            if (plans.length > 0 && plans[0].sessionId) {
              session = store.getSiftrSession(plans[0].sessionId);
            }
          }

          if (!session) {
            return {
              content: [{ type: 'text', text: `Error: ERROR_SESSION_NOT_FOUND - SiftrSession "${inputSessionId || inputTaskId || 'unknown'}" was not found in storage. Cannot end non-existent session.` }],
              isError: true,
            };
          }

          const targetStatus: SiftrSessionStatus = args?.status === 'ABORTED' ? 'ABORTED' : 'COMPLETED';
          const endedAt = new Date().toISOString();
          store.updateSessionStatus(session.sessionId, targetStatus, endedAt);
          session.status = targetStatus;
          session.endedAt = endedAt;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'end',
                  sessionId: session.sessionId,
                  taskId: session.taskId,
                  status: session.status,
                  endedAt: session.endedAt,
                }, null, 2),
              },
            ],
          };
        }

        // action === 'status'
        let session: SiftrSession | undefined;
        if (inputSessionId) {
          session = store.getSiftrSession(inputSessionId);
          if (!session) {
            return {
              content: [{ type: 'text', text: `Error: ERROR_SESSION_NOT_FOUND - SiftrSession "${inputSessionId}" was not found in storage.` }],
              isError: true,
            };
          }
        }

        const taskId = session?.taskId || inputTaskId;
        let plansCount = 0;
        let outcomesCount = 0;
        let totalTokens = 0;

        if (taskId) {
          const plans = store.listContextPlans(taskId);
          plansCount = plans.length;
          for (const p of plans) {
            totalTokens += p.actualProviderInputTokens || p.actualRenderedTokens || 0;
          }
          const outcomes = store.listOutcomeEvidence(taskId);
          outcomesCount = outcomes.length;
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'status',
                sessionId: session?.sessionId || inputSessionId,
                taskId: taskId || session?.taskId,
                status: session?.status || 'UNKNOWN',
                agentModel,
                plansCount,
                outcomesCount,
                totalTokens,
                createdAt: session?.createdAt,
                updatedAt: session?.updatedAt,
                endedAt: session?.endedAt,
              }, null, 2),
            },
          ],
        };
      }

      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true
      };

    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `SiftrCode error: ${err.message}` }],
        isError: true
      };
    }
  });

  return server;
}

export async function runMcpServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
