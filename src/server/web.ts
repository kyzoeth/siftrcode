import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { skeletonizeFile } from '../skeleton/dispatcher';
import { packRepository } from '../core/packer';
import { auditRepository } from '../core/auditor';
import { ContextEngine } from '../engine/context_engine';
import { getResolutionName } from '../context/context_resolution';
import { SqliteStore, getDefaultDatabasePath } from '../storage/sqlite_store';
import { DeletionManager } from '../rights/deletion_manager';
import { SourceProvenance, createSourceProvenance } from '../rights/source_provenance';
import { createOutcomeEvidence } from '../telemetry/outcome_evidence';
import { resolveSafeWorkspacePath, DefaultWorkspaceSourceReader } from '../workspace/workspace_source_reader';
import { ContextResolution } from '../context/context_resolution';
import { WorkspaceManager } from '../workspace/workspace_manager';
import { ContextPlan } from '../engine/context_plan';
import { ContextUnitKind } from '../context/context_unit';
import { TrustLevel } from '../security/trust';
import { DefaultContextUnitMaterializer } from '../materialization/context_unit_materializer';
import { createContextExpansionEvent, ExpansionReason } from '../telemetry/expansion_event';
import { createSiftrSession, SiftrSession, SiftrSessionStatus } from '../telemetry/siftr_session';
import { createProviderUsageEvent } from '../token/provider_usage';
import { createAgentEnvironment } from '../agents/agent_environment';
import * as crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  MCP_TOOL_SCHEMAS,
  McpToolName,
  validateToolCall,
  zodToJsonSchema,
} from '../mcp/schemas';
import { resolveApplicationDataRights } from '../rights/data_rights';
import { loadResearchStatus, ResearchStatusResponse } from './research_status';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_DIR = path.join(__dirname, '..', '..', 'web');

let sharedStore: SqliteStore | null = null;
function getSharedStore(): SqliteStore | null {
  if (!sharedStore) {
    try {
      const dbPath = getDefaultDatabasePath();
      sharedStore = new SqliteStore(dbPath);
    } catch (diskErr) {
      console.warn('⚠️ [Web Admin] Failed to open persistent SQLite store, falling back to memory store:', diskErr);
      try {
        sharedStore = new SqliteStore(':memory:');
      } catch (memErr) {
        console.error('❌ [Web Admin] SQLite store unavailable:', memErr);
        return null;
      }
    }
  }
  return sharedStore;
}

// Static MCP Server Card definition per SEP-1649 / Smithery specification
const SERVER_CARD = {
  serverInfo: {
    name: 'siftrcode',
    version: '0.2.1',
    description: 'Outcome-aware context optimization engine for AI coding agents. Discovers, ranks, bundles, and safely degrades repository context to maximize task success under strict token and economic budgets.'
  },
  authentication: {
    required: false
  },
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
  resources: [],
  prompts: []
};

function createMcpServerInstance() {
  const mcpServer = new Server(
    {
      name: 'siftrcode',
      version: '0.2.1'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: SERVER_CARD.tools
    };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const validation = validateToolCall(name as McpToolName, args);
    if (!validation.success) {
      return {
        content: [{ type: 'text', text: `Error: ${validation.error}` }],
        isError: true,
      };
    }
    try {
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

        // Auto-create session if omitted (Milestone Part XVI Section 42)
        if (!inputSessionId) {
          const workspaceManager = new WorkspaceManager({ rootDir: workspaceDir });
          const snapshot = await workspaceManager.captureSnapshot();
          sessionStore.saveSnapshot(snapshot);

          const autoTaskId = resolvedTaskId || `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
          resolvedTaskId = autoTaskId;

          const env = createAgentEnvironment({
            model: (args?.agentModel as string) || 'unknown',
            agentProvider: 'unknown',
          });

          const autoSession = createSiftrSession({
            taskId: autoTaskId,
            agentEnvironmentId: env.systemConfigurationHash,
            initialWorkspaceSnapshotId: snapshot.workspaceSnapshotId,
            latestWorkspaceSnapshotId: snapshot.workspaceSnapshotId,
            status: 'ACTIVE',
          });
          sessionStore.saveSiftrSession(autoSession);
          inputSessionId = autoSession.sessionId;
        } else if (!resolvedTaskId) {
          const sess = sessionStore.getSiftrSession(inputSessionId);
          if (sess) {
            resolvedTaskId = sess.taskId;
          }
        }

        const agentModel = (args?.agentModel as string) || undefined;
        const agentKind = (args?.agentKind as any) || undefined;
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
          dataRights: resolveApplicationDataRights(),
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

        const result = await ContextEngine.rankWorkspace({
          workspaceDir,
          prompt,
          limit,
          dataRights: resolveApplicationDataRights(),
        });

        const rankedFormatted = result.ranked.map((rc) => ({
          rank: rc.rank,
          contextUnitId: rc.contextUnitId,
          score: Number(rc.finalScore.toFixed(4)),
          primaryReason: rc.reasons[0] || 'relevance',
          allReasons: rc.reasons,
          scoreBreakdown: rc.scoreBreakdown,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  taskId: result.task.taskId,
                  totalCandidatesEvaluated: result.totalCandidates,
                  returnedCount: rankedFormatted.length,
                  ranked: rankedFormatted,
                },
                null,
                2
              )
            }
          ]
        };
      }

      if (name === 'siftr_skeleton') {
        const directContent = (args?.content ?? args?.code) as string | undefined;
        const filePath = (args?.filePath || args?.filename) ? String(args.filePath || args.filename) : 'source.ts';

        let rawContent = '';
        if (directContent !== undefined) {
          rawContent = directContent;
        } else {
          const workspaceRoot = (args?.directory as string) || process.cwd();
          const safePath = resolveSafeWorkspacePath(workspaceRoot, filePath);
          if (!safePath || !fs.existsSync(safePath)) {
            return {
              content: [{ type: 'text', text: `Error: File not found or path outside workspace: ${filePath}` }],
              isError: true
            };
          }
          rawContent = fs.readFileSync(safePath, 'utf-8');
        }

        const result = skeletonizeFile(rawContent, filePath);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  filePath,
                  originalTokens: result.originalTokensEstimate,
                  skeletonTokens: result.skeletonTokensEstimate,
                  reduction: `${(result.reductionRatio * 100).toFixed(1)}%`,
                  skeletonContent: result.skeletonContent
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

        const workspaceRoot = (args?.directory as string) || process.cwd();
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

        const overallReduction =
          totalOriginal > 0 ? `${(((totalOriginal - totalSkeleton) / totalOriginal) * 100).toFixed(1)}%` : '0%';

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  filesProcessed: results.length,
                  totalOriginalTokens: totalOriginal,
                  totalSkeletonTokens: totalSkeleton,
                  overallReduction,
                  results
                },
                null,
                2
              )
            }
          ]
        };
      }

      if (name === 'siftr_audit') {
        if (args?.code) {
          const code = String(args.code);
          const filename = String(args.filename || 'snippet.ts');
          const result = skeletonizeFile(code, filename);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    originalTokens: result.originalTokensEstimate,
                    skeletonTokens: result.skeletonTokensEstimate,
                    reduction: `${(result.reductionRatio * 100).toFixed(1)}%`,
                    estimatedSavedUSD: Number(((result.originalTokensEstimate - result.skeletonTokensEstimate) / 1000000 * 3.0).toFixed(4))
                  },
                  null,
                  2
                )
              }
            ]
          };
        }
        const audit = await auditRepository((args?.directory as string) || process.cwd());
        return {
          content: [{ type: 'text', text: JSON.stringify(audit, null, 2) }]
        };
      }

      if (name === 'siftr_pack') {
        const result = await packRepository({
          focus: args?.focus as string | undefined,
          directory: args?.directory as string | undefined,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (name === 'siftr_outcome') {
        const workspaceDir = (args?.directory as string) || process.cwd();
        const siftrDir = path.join(workspaceDir, '.siftr');
        const sqlitePath = path.join(siftrDir, 'observations.sqlite');
        const store = (fs.existsSync(sqlitePath) || fs.existsSync(siftrDir)) ? new SqliteStore(sqlitePath) : getSharedStore();

        if (!store) {
          return {
            content: [{ type: 'text', text: 'Error: Observation store does not exist in workspace.' }],
            isError: true,
          };
        }

        const rawArgs = (args || {}) as Record<string, any>;
        const inputPlanId = rawArgs.planId ? String(rawArgs.planId) : undefined;
        const inputSessionId = rawArgs.sessionId ? String(rawArgs.sessionId) : undefined;
        const inputTaskId = rawArgs.taskId ? String(rawArgs.taskId) : undefined;

        let resolvedPlanId: string | undefined = inputPlanId;
        let resolvedSessionId: string | undefined = inputSessionId;
        let resolvedTaskId: string | undefined = inputTaskId;
        let resolvedSnapshotId: string = 'snapshot_init';
        let resolvedAgentEnvId: string = 'unknown';

        // 1. Resolve via planId
        if (resolvedPlanId) {
          const plan = store.getContextPlan(resolvedPlanId);
          if (!plan) {
            return {
              content: [{ type: 'text', text: `Error: ContextPlan "${resolvedPlanId}" not found in observation store.` }],
              isError: true,
            };
          }
          if (resolvedTaskId && plan.taskId !== resolvedTaskId) {
            return {
              content: [{ type: 'text', text: `Error: ContextPlan "${resolvedPlanId}" belongs to taskId "${plan.taskId}", not "${resolvedTaskId}".` }],
              isError: true,
            };
          }
          if (inputSessionId && plan.sessionId && plan.sessionId !== inputSessionId) {
            return {
              content: [{ type: 'text', text: `Error: ContextPlan "${resolvedPlanId}" belongs to session "${plan.sessionId}", not "${inputSessionId}".` }],
              isError: true,
            };
          }
          resolvedTaskId = plan.taskId;
          resolvedSessionId = inputSessionId || plan.sessionId;
          resolvedSnapshotId = plan.workspaceSnapshotId || (plan as any).snapshotId || 'snapshot_init';
          resolvedAgentEnvId = plan.agentEnvironmentId || 'unknown';

          if (resolvedSessionId) {
            const session = store.getSession(resolvedSessionId);
            if (session && session.taskId !== resolvedTaskId) {
              return {
                content: [{ type: 'text', text: `Error: Session "${resolvedSessionId}" belongs to task "${session.taskId}", not "${resolvedTaskId}".` }],
                isError: true,
              };
            }
          }
        }
        // 2. Resolve via sessionId if planId not provided
        else if (resolvedSessionId) {
          const session = store.getSiftrSession(resolvedSessionId) || store.getSession(resolvedSessionId);
          if (!session) {
            return {
              content: [{ type: 'text', text: `Error: Session "${resolvedSessionId}" not found in observation store.` }],
              isError: true,
            };
          }
          if (resolvedTaskId && session.taskId !== resolvedTaskId) {
            return {
              content: [{ type: 'text', text: `Error: Session "${resolvedSessionId}" belongs to taskId "${session.taskId}", not "${resolvedTaskId}".` }],
              isError: true,
            };
          }
          resolvedTaskId = session.taskId;
          resolvedSnapshotId = ('latestWorkspaceSnapshotId' in session && session.latestWorkspaceSnapshotId)
            ? session.latestWorkspaceSnapshotId
            : (('snapshotId' in session && (session as any).snapshotId) ? (session as any).snapshotId : 'snapshot_init');
          resolvedAgentEnvId = ('agentEnvironmentId' in session && session.agentEnvironmentId)
            ? session.agentEnvironmentId
            : 'unknown';

          const sessionPlans = store.listContextPlans(resolvedTaskId, resolvedSessionId);
          if (sessionPlans.length === 1) {
            resolvedPlanId = sessionPlans[0].planId;
          } else if (sessionPlans.length > 1) {
            return {
              content: [{ type: 'text', text: `Error: Multiple plans (${sessionPlans.length}) exist for session "${resolvedSessionId}". Explicit planId is required to disambiguate.` }],
              isError: true,
            };
          } else {
            const taskPlans = store.listContextPlans(resolvedTaskId);
            if (taskPlans.length === 1) {
              resolvedPlanId = taskPlans[0].planId;
            }
          }
        }
        // 3. Fallback via taskId
        else if (resolvedTaskId) {
          const plans = store.listContextPlans(resolvedTaskId);
          if (plans.length === 1) {
            resolvedPlanId = plans[0].planId;
            resolvedSessionId = plans[0].sessionId;
            resolvedSnapshotId = plans[0].workspaceSnapshotId || (plans[0] as any).snapshotId || 'snapshot_init';
            resolvedAgentEnvId = plans[0].agentEnvironmentId || 'unknown';
          } else if (plans.length > 1) {
            return {
              content: [{ type: 'text', text: `Error: Multiple plans exist for task "${resolvedTaskId}". Explicit planId or sessionId is required to disambiguate.` }],
              isError: true,
            };
          } else {
            return {
              content: [{ type: 'text', text: `Error: Cannot resolve outcome lineage for task "${resolvedTaskId}". No matching plan or session found in store.` }],
              isError: true,
            };
          }
        } else {
          return {
            content: [{ type: 'text', text: 'Error: At least one of "planId", "sessionId", or "taskId" is required to resolve outcome lineage.' }],
            isError: true,
          };
        }

        // Section 2: Never fabricate placeholder identifiers!
        if (!resolvedSessionId) {
          return {
            content: [{ type: 'text', text: 'Error: Cannot resolve durable session lineage for outcome. Please provide sessionId or planId.' }],
            isError: true,
          };
        }

        // Section 36-37: Validate referential integrity at write time
        const integrityCheck = store.validateOutcomeIntegrity({
          sessionId: resolvedSessionId,
          taskId: resolvedTaskId,
          planId: resolvedPlanId,
          snapshotId: resolvedSnapshotId,
          agentEnvironmentId: resolvedAgentEnvId,
        });
        if (!integrityCheck.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${integrityCheck.reason}` }],
            isError: true,
          };
        }

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
        store.saveTaskOutcome(outcomeEvidence);
        store.saveOutcomeEvidence([
          {
            evidenceId: outcomeEvidence.outcomeId,
            taskId: outcomeEvidence.taskId,
            sessionId: outcomeEvidence.sessionId,
            contextPlanId: resolvedPlanId,
            snapshotId: resolvedSnapshotId,
            labelType: 'VERIFIED_SUCCESS',
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
        const store = fs.existsSync(sqlitePath) ? new SqliteStore(sqlitePath) : getSharedStore();

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
        const store = fs.existsSync(sqlitePath) ? new SqliteStore(sqlitePath) : (getSharedStore() || new SqliteStore(sqlitePath));

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
                  status: targetStatus,
                  endedAt: session.endedAt,
                }, null, 2),
              },
            ],
          };
        }

        // status
        if (inputSessionId) {
          const checkSession = store.getSiftrSession(inputSessionId);
          if (!checkSession) {
            return {
              content: [{ type: 'text', text: `Error: ERROR_SESSION_NOT_FOUND - SiftrSession "${inputSessionId}" was not found in storage.` }],
              isError: true,
            };
          }
        }
        let plansCount = 0;
        let outcomesCount = 0;
        let totalTokens = 0;
        let sessionStatus = 'ACTIVE';

        if (inputSessionId) {
          const s = store.getSiftrSession(inputSessionId);
          if (s) {
            sessionStatus = s.status;
          }
          const plans = store.listContextPlans(undefined, inputSessionId);
          plansCount = plans.length;
          for (const p of plans) {
            totalTokens += p.actualProviderInputTokens || p.actualRenderedTokens || 0;
          }
          const outcomes = store.listOutcomeEvidence(inputTaskId, inputSessionId);
          outcomesCount = outcomes.length;
        } else if (inputTaskId) {
          const plans = store.listContextPlans(inputTaskId);
          plansCount = plans.length;
          for (const p of plans) {
            totalTokens += p.actualProviderInputTokens || p.actualRenderedTokens || 0;
          }
          const outcomes = store.listOutcomeEvidence(inputTaskId);
          outcomesCount = outcomes.length;
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'status',
                sessionId: inputSessionId,
                taskId: inputTaskId,
                plansCount,
                outcomesCount,
                totalTokens,
                status: sessionStatus,
                timestamp: new Date().toISOString(),
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

  return mcpServer;
}

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
const TELEMETRY_FILE = path.join(DATA_DIR, 'telemetry.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadLeads(): any[] {
  ensureDataDir();
  if (fs.existsSync(LEADS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
      if (Array.isArray(data)) return data;
    } catch (e) {}
  }
  return [];
}

function saveLeads(leads: any[]) {
  ensureDataDir();
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8');
}

function loadFeedback(): any[] {
  ensureDataDir();
  if (fs.existsSync(FEEDBACK_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8'));
      if (Array.isArray(data)) return data;
    } catch (e) {}
  }
  return [];
}

function saveFeedback(feedback: any[]) {
  ensureDataDir();
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback, null, 2), 'utf-8');
}

function loadTelemetry(): any {
  ensureDataDir();
  if (fs.existsSync(TELEMETRY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf-8'));
    } catch (e) {}
  }
  const initial = {
    summary: {
      totalPageviews: 0,
      uniqueVisitors: 0,
      simulatorRuns: 0,
      tokensPrunedTotal: 0,
      estimatedSavedDollars: 0,
      cliCopies: 0,
      leadsCount: 0,
      feedbackCount: 0
    },
    v2Summary: {
      totalOptimizations: 0,
      totalTokensEvaluated: 0,
      totalTokensAllocated: 0,
      totalTokensSaved: 0,
      estimatedSavedUSD: 0,
      resolutionCounts: { FULL: 0, BODY: 0, SKELETON: 0, SIGNATURE: 0, NAME: 0, OMIT: 0 },
    },
    pageTraffic: {},
    simulatorLanguages: {},
    agentPreferences: {},
    topCliCommands: {},
    recentEvents: [],
    visitorSessions: []
  };
  saveTelemetry(initial);
  return initial;
}

function saveTelemetry(data: any) {
  ensureDataDir();
  fs.writeFileSync(TELEMETRY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export function isAdminConfigured(): boolean {
  const token = process.env.ADMIN_TOKEN || process.env.ADMIN_API_KEY;
  return !!(token && token.trim().length > 0);
}

export function isInsecureDevAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.SIFTR_ADMIN_INSECURE_DEV === 'true';
}

export function isAdminEnabled(): boolean {
  return isAdminConfigured() || isInsecureDevAllowed();
}

export function verifyAdminToken(req: http.IncomingMessage): boolean {
  if (isInsecureDevAllowed()) {
    return true;
  }
  const adminToken = process.env.ADMIN_TOKEN || process.env.ADMIN_API_KEY;
  if (!adminToken || adminToken.trim().length === 0) {
    return false;
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader || typeof authHeader !== 'string') {
    return false;
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }
  const providedToken = match[1].trim();
  const hashA = crypto.createHash('sha256').update(providedToken).digest();
  const hashB = crypto.createHash('sha256').update(adminToken.trim()).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function handleAdminAuthFailure(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  // Overwrite wildcard CORS on protected admin endpoints
  res.removeHeader('Access-Control-Allow-Origin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');

  if (!isAdminEnabled()) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Service Unavailable: Admin interface is disabled (ADMIN_TOKEN not configured)'
    }));
    return true;
  }

  if (!verifyAdminToken(req)) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="SiftrCode Admin"'
    });
    res.end(JSON.stringify({
      error: 'Unauthorized: Invalid or missing admin bearer token'
    }));
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Accept');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Healthcheck endpoint
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'siftrcode', version: SERVER_CARD.serverInfo.version }));
    return;
  }

  // Static MCP Server Card (SEP-1649 / Smithery automatic discovery)
  if (pathname === '/.well-known/mcp/server-card.json' || pathname === '/.well-known/mcp/server-card') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(SERVER_CARD, null, 2));
    return;
  }

  // Live MCP Streamable HTTP & SSE Transport (Glama & Smithery native)
  if (pathname === '/mcp' || pathname === '/sse' || pathname === '/mcp/messages') {
    if (!req.headers.accept || !req.headers.accept.includes('text/event-stream')) {
      req.headers.accept = (req.headers.accept ? req.headers.accept + ', ' : '') + 'application/json, text/event-stream';
    }
    try {
      const transport = new StreamableHTTPServerTransport();
      const mcpServer = createMcpServerInstance();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err: any) {
      console.error('Streamable HTTP error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }




  // Live AST Skeleton API
  if (pathname === '/api/skeleton' && req.method === 'POST') {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > 5 * 1024 * 1024) { // 5MB limit
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (aborted || res.headersSent) return;
      try {
        const payload = JSON.parse(body || '{}');
        const code = payload.code || '';
        const lang = (payload.language || 'typescript').toLowerCase();
        
        let ext = '.ts';
        if (lang === 'python' || lang === 'py') ext = '.py';
        else if (lang === 'go' || lang === 'golang') ext = '.go';
        else if (lang === 'rust' || lang === 'rs') ext = '.rs';
        else if (lang === 'javascript' || lang === 'js') ext = '.js';

        const filename = payload.filename || `snippet${ext}`;
        const result = skeletonizeFile(code, filename);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Invalid request' }));
      }
    });
    return;
  }

  // Live Outcome-Aware Context Optimization API
  if (pathname === '/api/context' && req.method === 'POST') {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', async () => {
      if (aborted || res.headersSent) return;
      try {
        const payload = JSON.parse(body || '{}');
        const prompt = String(payload.prompt || '').trim();
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Field "prompt" is required' }));
          return;
        }

        const workspaceDir = String(payload.directory || process.cwd());
        const budgetProfile = payload.budgetProfile as any;
        const tokenBudget = typeof payload.tokenBudget === 'number' ? payload.tokenBudget : undefined;
        const maxCostUSD = typeof payload.maxCostUSD === 'number' ? payload.maxCostUSD : undefined;
        const agentModel = payload.agentModel as string | undefined;

        const result = await ContextEngine.optimizeWorkspace({
          workspaceDir,
          prompt,
          agentModel,
          budgetProfile,
          tokenBudget,
          maxCostUSD,
          dataRights: resolveApplicationDataRights(),
        });

        const plan = result.plan;
        const allocatedUnits = plan.units.filter((u) => u.resolution > 0);

        // Update V2 telemetry
        try {
          const telemetry = loadTelemetry();
          if (!telemetry.v2Summary) {
            telemetry.v2Summary = {
              totalOptimizations: 0,
              totalTokensEvaluated: 0,
              totalTokensAllocated: 0,
              totalTokensSaved: 0,
              estimatedSavedUSD: 0,
              resolutionCounts: { FULL: 0, BODY: 0, SKELETON: 0, SIGNATURE: 0, NAME: 0, OMIT: 0 },
            };
          }
          telemetry.v2Summary.totalOptimizations = (telemetry.v2Summary.totalOptimizations || 0) + 1;
          telemetry.v2Summary.totalTokensEvaluated = (telemetry.v2Summary.totalTokensEvaluated || 0) + (plan.budgetPlan.rawTotalTokens || 0);
          telemetry.v2Summary.totalTokensAllocated = (telemetry.v2Summary.totalTokensAllocated || 0) + (plan.budgetPlan.totalTokens || 0);
          telemetry.v2Summary.totalTokensSaved = (telemetry.v2Summary.totalTokensSaved || 0) + Math.max(0, (plan.budgetPlan.rawTotalTokens || 0) - (plan.budgetPlan.totalTokens || 0));
          telemetry.v2Summary.estimatedSavedUSD = Number(((telemetry.v2Summary.estimatedSavedUSD || 0) + (plan.budgetPlan.costSavedUSD || 0)).toFixed(4));
          
          if (!telemetry.v2Summary.resolutionCounts) {
            telemetry.v2Summary.resolutionCounts = { FULL: 0, BODY: 0, SKELETON: 0, SIGNATURE: 0, NAME: 0, OMIT: 0 };
          }
          for (const u of plan.units) {
            const resName = getResolutionName(u.resolution);
            telemetry.v2Summary.resolutionCounts[resName] = (telemetry.v2Summary.resolutionCounts[resName] || 0) + 1;
          }

          telemetry.recentEvents.unshift({
            id: `ev_${Date.now()}_v2opt`,
            event: 'v2_context_optimize',
            path: '/api/context',
            properties: {
              planId: plan.planId,
              prompt: prompt.slice(0, 80),
              rawTokens: plan.budgetPlan.rawTotalTokens,
              allocatedTokens: plan.budgetPlan.totalTokens,
              savingsPercentage: `${plan.budgetPlan.savingsPercentage.toFixed(1)}%`,
              costSavedUSD: `$${plan.budgetPlan.costSavedUSD.toFixed(4)}`,
            },
            sessionId: 'v2_optimizer',
            timestamp: new Date().toISOString()
          });
          if (telemetry.recentEvents.length > 150) telemetry.recentEvents = telemetry.recentEvents.slice(0, 150);
          saveTelemetry(telemetry);
        } catch (e) {}

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          planId: plan.planId,
          taskId: plan.taskId,
          totalRawTokens: plan.budgetPlan.rawTotalTokens,
          allocatedTokens: plan.budgetPlan.totalTokens,
          reductionRatio: `${plan.budgetPlan.savingsPercentage.toFixed(1)}%`,
          estimatedCostUSD: `$${plan.budgetPlan.estimatedCostUSD.toFixed(4)}`,
          costSavedUSD: `$${plan.budgetPlan.costSavedUSD.toFixed(4)}`,
          allocatedUnitsCount: allocatedUnits.length,
          units: allocatedUnits.map((u) => ({
            path: u.path,
            title: u.title,
            resolution: u.resolution,
            resolutionName: getResolutionName(u.resolution),
            allocatedTokens: u.tokenEstimate,
            reason: u.reason,
          })),
          context: result.contextString,
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Optimization failed' }));
      }
    });
    return;
  }

  // Live Heuristic Candidate Rank API
  if (pathname === '/api/rank' && req.method === 'POST') {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', async () => {
      if (aborted || res.headersSent) return;
      try {
        const payload = JSON.parse(body || '{}');
        const prompt = String(payload.prompt || '').trim();
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Field "prompt" is required' }));
          return;
        }

        const workspaceDir = String(payload.directory || process.cwd());
        const limit = typeof payload.limit === 'number' ? payload.limit : 20;

        const result = await ContextEngine.rankWorkspace({
          workspaceDir,
          prompt,
          limit,
          dataRights: resolveApplicationDataRights(),
        });

        const rankedFormatted = result.ranked.map((rc) => ({
          rank: rc.rank,
          contextUnitId: rc.contextUnitId,
          score: Number(rc.finalScore.toFixed(4)),
          primaryReason: rc.reasons[0] || 'relevance',
          allReasons: rc.reasons,
          scoreBreakdown: rc.scoreBreakdown,
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          taskId: result.task.taskId,
          totalCandidates: result.totalCandidates,
          ranked: rankedFormatted,
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Ranking failed' }));
      }
    });
    return;
  }

  // Verified Outcome Reporting API (Audit Section 14)
  if (pathname === '/api/outcome' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const taskId = String(payload.taskId || '').trim();
        if (!taskId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Field "taskId" is required' }));
          return;
        }

        const store = getSharedStore();
        const existingPlan = store?.getContextPlanByTask(taskId);
        const existingDecisions = store?.listCandidateDecisionObservations({ taskId });
        const snapshot = store?.getPreOutcomeSnapshotByTaskId(taskId);
        const existingSession = existingPlan?.sessionId ? store?.getSiftrSession(existingPlan.sessionId) : undefined;

        const resolvedSessionId =
          (typeof payload.sessionId === 'string' && payload.sessionId.trim().length > 0 ? payload.sessionId.trim() : undefined) ||
          existingPlan?.sessionId ||
          (existingDecisions && existingDecisions.length > 0 ? existingDecisions[0].sessionId : undefined) ||
          `sess_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

        const resolvedAgentEnvId =
          (typeof payload.agentEnvironmentId === 'string' && payload.agentEnvironmentId.trim().length > 0 ? payload.agentEnvironmentId.trim() : undefined) ||
          existingPlan?.agentEnvironmentId ||
          existingSession?.agentEnvironmentId ||
          'unknown';

        const resolvedSnapshotBefore =
          (typeof payload.workspaceSnapshotBefore === 'string' && payload.workspaceSnapshotBefore.trim().length > 0 ? payload.workspaceSnapshotBefore.trim() : undefined) ||
          existingPlan?.workspaceSnapshotId ||
          snapshot?.workspaceSnapshotId ||
          'unknown';

        const outcomeEvidence = createOutcomeEvidence({
          taskId,
          sessionId: resolvedSessionId,
          contextPlanId: existingPlan?.planId || payload.planId,
          agentEnvironmentId: resolvedAgentEnvId,
          workspaceSnapshotBefore: resolvedSnapshotBefore,
          publicTestsPassed: typeof payload.testsPassed === 'boolean' ? payload.testsPassed : undefined,
          regressionTestsPassed: typeof payload.regressionTestsPassed === 'boolean' ? payload.regressionTestsPassed : undefined,
          staticChecksPassed: typeof payload.staticChecksPassed === 'boolean' ? payload.staticChecksPassed : undefined,
          securityChecksPassed: typeof payload.securityChecksPassed === 'boolean' ? payload.securityChecksPassed : undefined,
          agentReportedSuccess: typeof payload.agentClaimedSuccess === 'boolean' ? payload.agentClaimedSuccess : undefined,
          actualProviderInputTokens: typeof payload.actualProviderInputTokens === 'number' ? payload.actualProviderInputTokens : undefined,
          actualProviderOutputTokens: typeof payload.actualProviderOutputTokens === 'number' ? payload.actualProviderOutputTokens : undefined,
          costUSD: typeof payload.costUSD === 'number' ? payload.costUSD : undefined,
          wallTimeMs: typeof payload.wallTimeMs === 'number' ? payload.wallTimeMs : undefined,
        });

        let persisted = false;
        if (store) {
          try {
            store.saveTaskOutcome(outcomeEvidence);
            store.saveOutcomeEvidence([
              {
                evidenceId: outcomeEvidence.outcomeId,
                taskId: outcomeEvidence.taskId,
                sessionId: outcomeEvidence.sessionId,
                labelType: 'VERIFIED_SUCCESS',
                value: outcomeEvidence.verifiedSuccess ? 1 : 0,
                confidence: outcomeEvidence.confidence,
                strength: outcomeEvidence.confidence >= 0.9 ? 'STRONG' : 'MEDIUM',
                source: 'outcome_policy',
                details: {
                  rationale: outcomeEvidence.evaluationRationale,
                  planId: payload.planId,
                  notes: payload.notes,
                },
              },
            ]);
            if (payload.planId && payload.actualProviderInputTokens !== undefined) {
              store.updatePlanActualProviderTokens(payload.planId, payload.actualProviderInputTokens);
            }
            persisted = true;
          } catch {}
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          taskId,
          outcomeId: outcomeEvidence.outcomeId,
          verifiedSuccess: outcomeEvidence.verifiedSuccess,
          confidence: outcomeEvidence.confidence,
          rationale: outcomeEvidence.evaluationRationale,
          persisted,
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Outcome evaluation failed' }));
      }
    });
    return;
  }

  // Dynamic Context Resolution Expansion API (Audit Section 14)
  if (pathname === '/api/expand' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const filePath = payload.filePath || payload.contextUnitId;
        if (!filePath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Field "filePath" or "contextUnitId" is required' }));
          return;
        }

        const workspaceDir = String(payload.directory || process.cwd());
        const safePath = resolveSafeWorkspacePath(workspaceDir, filePath);
        if (!safePath || !fs.existsSync(safePath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `File not found: ${filePath}` }));
          return;
        }

        const rawContent = fs.readFileSync(safePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          path: filePath,
          resolution: payload.targetResolution || 'body',
          tokens: Math.ceil(rawContent.length / 3.7),
          content: rawContent,
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Expansion failed' }));
      }
    });
    return;
  }

  // Coding Agent Session Lifecycle API (Audit Section 14)
  if (pathname === '/api/session' && (req.method === 'POST' || req.method === 'GET')) {
    const handleSession = (payload: any) => {
      const taskId = String(payload.taskId || '').trim();
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Field "taskId" is required' }));
        return;
      }

      const store = getSharedStore();
      let plansCount = 0;
      let outcomesCount = 0;
      let totalTokens = 0;

      if (store) {
        try {
          const plans = store.listContextPlans(taskId);
          plansCount = plans.length;
          for (const p of plans) {
            totalTokens += p.actualProviderInputTokens || p.actualRenderedTokens || 0;
          }
          const outcomes = store.listOutcomeEvidence(taskId);
          outcomesCount = outcomes.length;
        } catch {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        action: payload.action || 'status',
        taskId,
        plansCount,
        outcomesCount,
        totalTokens,
        status: payload.action === 'end' ? 'COMPLETED' : 'ACTIVE',
        timestamp: new Date().toISOString(),
      }));
    };

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          handleSession(JSON.parse(body || '{}'));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    } else {
      const parsedUrl = new URL(req.url || '', `http://${req.headers.host}`);
      handleSession({
        taskId: parsedUrl.searchParams.get('taskId'),
        action: parsedUrl.searchParams.get('action') || 'status',
      });
    }
    return;
  }

  // B2B Team Trial & Lead Capture API
  if (pathname === '/api/leads' && req.method === 'POST') {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > 64 * 1024) { // 64KB limit
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (aborted || res.headersSent) return;
      try {
        const payload = JSON.parse(body || '{}');
        const email = String(payload.email || '').trim().toLowerCase();
        const teamSize = String(payload.teamSize || '1-5');
        const agent = String(payload.agent || 'Cursor');
        const repoUrl = String(payload.repoUrl || '').trim();
        const notes = String(payload.notes || '').trim();

        if (!email || !email.includes('@') || !email.includes('.')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Please enter a valid work email address.' }));
          return;
        }

        const leads = loadLeads();
        const newLead = {
          id: `lead_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          email,
          teamSize,
          agent,
          repoUrl,
          notes,
          ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown',
          createdAt: new Date().toISOString(),
          status: 'pending_pilot'
        };

        leads.unshift(newLead);
        saveLeads(leads);

        // Update telemetry
        try {
          const telemetry = loadTelemetry();
          telemetry.summary.leadsCount = leads.length;
          if (agent && telemetry.agentPreferences) {
            telemetry.agentPreferences[agent] = (telemetry.agentPreferences[agent] || 0) + 1;
          }
          telemetry.recentEvents.unshift({
            id: `ev_${Date.now()}_lead`,
            event: 'lead_submit',
            path: '/',
            properties: { email: newLead.email, teamSize: newLead.teamSize, agent: newLead.agent },
            sessionId: 'session_lead',
            timestamp: new Date().toISOString()
          });
          if (telemetry.recentEvents.length > 150) telemetry.recentEvents = telemetry.recentEvents.slice(0, 150);
          saveTelemetry(telemetry);
        } catch (e) {}

        console.log(`🔥 [NEW SIFTRCODE PRO LEAD] ${email} | Team: ${teamSize} | Agent: ${agent} | Created: ${newLead.createdAt}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Your 14-day SiftrCode Pro team trial has been registered! Check your inbox shortly for your priority onboarding key.',
          leadId: newLead.id
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Failed to save lead' }));
      }
    });
    return;
  }

  // Admin Leads View (Protected)
  if (pathname === '/api/leads' && req.method === 'GET') {
    if (handleAdminAuthFailure(req, res)) return;
    const leads = loadLeads();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private'
    });
    res.end(JSON.stringify({ count: leads.length, leads }));
    return;
  }

  // Anonymous Feedback API
  if (pathname === '/api/feedback' && req.method === 'POST') {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > 64 * 1024) { // 64KB limit
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (aborted || res.headersSent) return;
      try {
        const payload = JSON.parse(body || '{}');
        const message = String(payload.message || '').trim();
        const category = String(payload.category || 'general').trim();
        const email = String(payload.email || '').trim();
        const page = String(payload.page || '/').trim();

        if (!message || message.length < 3) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Please enter a feedback message (at least 3 characters).' }));
          return;
        }

        const feedbackList = loadFeedback();
        const newFeedback = {
          id: `fb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          category,
          message,
          email: email || 'anonymous',
          page,
          createdAt: new Date().toISOString()
        };

        feedbackList.unshift(newFeedback);
        saveFeedback(feedbackList);

        // Update telemetry
        try {
          const telemetry = loadTelemetry();
          telemetry.summary.feedbackCount = feedbackList.length;
          telemetry.recentEvents.unshift({
            id: `ev_${Date.now()}_fb`,
            event: 'feedback_submit',
            path: newFeedback.page,
            properties: { category: newFeedback.category, message: newFeedback.message.substring(0, 60) },
            sessionId: 'session_fb',
            timestamp: new Date().toISOString()
          });
          if (telemetry.recentEvents.length > 150) telemetry.recentEvents = telemetry.recentEvents.slice(0, 150);
          saveTelemetry(telemetry);
        } catch (e) {}

        console.log(`💬 [FEEDBACK] [${category}] on ${page}: ${message.substring(0, 80)}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Thank you! Your feedback has been received and shared with the engineering team.'
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Failed to save feedback' }));
      }
    });
    return;
  }

  // Admin Feedback View (Protected)
  if (pathname === '/api/feedback' && req.method === 'GET') {
    if (handleAdminAuthFailure(req, res)) return;
    const feedbackList = loadFeedback();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private'
    });
    res.end(JSON.stringify({ count: feedbackList.length, feedback: feedbackList }));
    return;
  }

  // Telemetry Event Ingestion API
  if (pathname === '/api/telemetry/event' && req.method === 'POST') {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > 64 * 1024) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (aborted || res.headersSent) return;
      try {
        const payload = JSON.parse(body || '{}');
        const event = String(payload.event || 'unknown').trim();
        const eventPath = String(payload.path || '/').trim();
        const properties = payload.properties || {};
        const sessionId = String(payload.sessionId || 'anonymous');

        const telemetry = loadTelemetry();

        // Track unique visitor sessions
        if (sessionId && sessionId !== 'anonymous') {
          if (!Array.isArray(telemetry.visitorSessions)) {
            telemetry.visitorSessions = [];
          }
          if (!telemetry.visitorSessions.includes(sessionId)) {
            telemetry.visitorSessions.push(sessionId);
            if (telemetry.visitorSessions.length > 10000) {
              telemetry.visitorSessions.shift();
            }
            telemetry.summary.uniqueVisitors = (telemetry.summary.uniqueVisitors || 0) + 1;
          }
        }

        // Update summaries
        if (event === 'pageview') {
          telemetry.summary.totalPageviews = (telemetry.summary.totalPageviews || 0) + 1;
          telemetry.pageTraffic[eventPath] = (telemetry.pageTraffic[eventPath] || 0) + 1;
        } else if (event === 'simulator_scan') {
          telemetry.summary.simulatorRuns = (telemetry.summary.simulatorRuns || 0) + 1;
          const lang = String(properties.language || 'typescript').toLowerCase();
          telemetry.simulatorLanguages[lang] = (telemetry.simulatorLanguages[lang] || 0) + 1;
          if (properties.tokensReduced) {
            telemetry.summary.tokensPrunedTotal = (telemetry.summary.tokensPrunedTotal || 0) + Number(properties.tokensReduced);
            telemetry.summary.estimatedSavedDollars = Number(((telemetry.summary.tokensPrunedTotal / 1000000) * 3.0).toFixed(2));
          }
        } else if (event === 'cli_copy') {
          telemetry.summary.cliCopies = (telemetry.summary.cliCopies || 0) + 1;
          const cmd = String(properties.command || '').trim();
          if (cmd) {
            telemetry.topCliCommands[cmd] = (telemetry.topCliCommands[cmd] || 0) + 1;
          }
        } else if (event === 'lead_submit') {
          telemetry.summary.leadsCount = (telemetry.summary.leadsCount || 0) + 1;
          const agent = String(properties.agent || 'Cursor');
          telemetry.agentPreferences[agent] = (telemetry.agentPreferences[agent] || 0) + 1;
        }

        // Add to recent events
        telemetry.recentEvents.unshift({
          id: `ev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          event,
          path: eventPath,
          properties,
          sessionId,
          timestamp: new Date().toISOString()
        });

        if (telemetry.recentEvents.length > 150) {
          telemetry.recentEvents = telemetry.recentEvents.slice(0, 150);
        }

        saveTelemetry(telemetry);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Invalid telemetry payload' }));
      }
    });
    return;
  }

  // Admin Token Verification Endpoint
  if (pathname === '/api/admin/auth/verify' && (req.method === 'POST' || req.method === 'GET')) {
    if (handleAdminAuthFailure(req, res)) return;
    res.removeHeader('Access-Control-Allow-Origin');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private'
    });
    res.end(JSON.stringify({ success: true, message: 'Admin authenticated successfully' }));
    return;
  }

  // Admin Canonical Research Status API
  if (pathname === '/api/admin/research-status' && req.method === 'GET') {
    if (handleAdminAuthFailure(req, res)) return;
    res.removeHeader('Access-Control-Allow-Origin');
    const status = loadResearchStatus();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private'
    });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  // Admin Consolidated Metrics API (Protected)
  if (pathname === '/api/admin/metrics' && req.method === 'GET') {
    if (handleAdminAuthFailure(req, res)) return;
    res.removeHeader('Access-Control-Allow-Origin');

    const telemetry = loadTelemetry();
    const leads = loadLeads();
    const feedback = loadFeedback();

    telemetry.summary.leadsCount = leads.length;
    telemetry.summary.feedbackCount = feedback.length;

    // Calculate lead agent distributions
    const agentMap: Record<string, number> = { ...telemetry.agentPreferences };
    leads.forEach(l => {
      if (l.agent) {
        agentMap[l.agent] = (agentMap[l.agent] || 0) + 1;
      }
    });

    const defaultV2Summary = {
      totalOptimizations: 0,
      totalTokensEvaluated: 0,
      totalTokensAllocated: 0,
      totalTokensSaved: 0,
      estimatedSavedUSD: 0,
      resolutionCounts: { FULL: 0, BODY: 0, SKELETON: 0, SIGNATURE: 0, NAME: 0, OMIT: 0 },
    };

    const store = getSharedStore();
    const sourceProvenances = store ? store.listSourceProvenances() : [];
    const taskOutcomes = store ? store.listTaskOutcomes(20) : [];
    const deletionAudits = store ? store.listDeletionAuditRecords() : [];
    const trainingRows = store ? store.listTrainingRows() : [];
    const researchStatus = loadResearchStatus();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private'
    });
    res.end(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      summary: telemetry.summary,
      v2Summary: telemetry.v2Summary || defaultV2Summary,
      pageTraffic: telemetry.pageTraffic,
      simulatorLanguages: telemetry.simulatorLanguages,
      agentPreferences: agentMap,
      topCliCommands: telemetry.topCliCommands,
      recentEvents: telemetry.recentEvents.slice(0, 50),
      leads: leads.slice(0, 50),
      feedback: feedback.slice(0, 50),
      researchStatus,
      learningPlane: {
        sourceProvenances,
        taskOutcomes,
        deletionAudits,
        trainingRowsCount: trainingRows.length,
        recentTrainingRows: trainingRows.slice(0, 10),
        rightsStats: {
          totalProvenance: sourceProvenances.length,
          allowedCount: sourceProvenances.filter(p => p.trainingPermission === 'ALLOWED').length,
          reviewCount: sourceProvenances.filter(p => p.trainingPermission === 'REVIEW').length,
          forbiddenCount: sourceProvenances.filter(p => p.trainingPermission === 'FORBIDDEN').length,
          exportBoundaryStatus: 'ENFORCED',
          rightsFilterGate: 'ACTIVE',
          deletionTraceabilityStatus: 'COMPLIANT',
        },
        graphProvenanceStats: {
          status: 'NOT_MEASURED',
          totalEdges: null,
          dataClassification: 'UNAVAILABLE',
          notes: 'Runtime web server process does not maintain active graph in memory; see offline indexing benchmarks.'
        },
        jevSignals: {
          providerName: 'typesafe-jev',
          status: 'STANDBY',
          dataClassification: 'RESEARCH',
          signalsSupported: ['semanticRelevance', 'likelyEditTarget', 'likelyRootCause'],
          resilienceFallback: 'local-heuristic',
        }
      }
    }));
    return;
  }

  // Admin Traceable Purge & Right-to-be-Forgotten API (Section 52)
  if (pathname === '/api/admin/purge' && req.method === 'POST') {
    if (handleAdminAuthFailure(req, res)) return;
    res.removeHeader('Access-Control-Allow-Origin');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const store = getSharedStore();
        if (!store) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Database storage is temporarily unavailable' }));
          return;
        }
        const deletionManager = new DeletionManager(store);
        const criteria = {
          repository: payload.repository ? String(payload.repository).trim() : undefined,
          tenantId: payload.tenantId ? String(payload.tenantId).trim() : undefined,
          taskId: payload.taskId ? String(payload.taskId).trim() : undefined,
          reason: payload.reason ? String(payload.reason).trim() : 'Manual admin purge request',
        };
        if (!criteria.repository && !criteria.tenantId && !criteria.taskId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'At least one of repository, tenantId, or taskId is required' }));
          return;
        }
        const audit = deletionManager.executePurge(criteria);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, audit }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Failed to execute purge' }));
      }
    });
    return;
  }

  // Learning Flywheel Summary API (Phase 20V)
  if (pathname === '/api/admin/learning/summary' && req.method === 'GET') {
    if (handleAdminAuthFailure(req, res)) return;
    res.removeHeader('Access-Control-Allow-Origin');
    const store = getSharedStore();
    if (!store) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Database store unavailable' }));
      return;
    }
    const summary = store.getLearningFlywheelSummary();
    const dataQuality = store.getDataQualityReport();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    });
    res.end(JSON.stringify({ summary, dataQuality }, null, 2));
    return;
  }

  // Learning Flywheel V3.2 Data Readiness API (Phase 20V)
  if (pathname === '/api/admin/learning/readiness' && req.method === 'GET') {
    if (handleAdminAuthFailure(req, res)) return;
    res.removeHeader('Access-Control-Allow-Origin');
    const store = getSharedStore();
    if (!store) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Database store unavailable' }));
      return;
    }
    const readiness = store.getV32DataReadinessReport();
    const summary = store.getLearningFlywheelSummary();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    });
    res.end(JSON.stringify({ readiness, summary }, null, 2));
    return;
  }

  // Learning Flywheel Episodes List API (Phase 20V)
  if (pathname === '/api/admin/learning/episodes' && req.method === 'GET') {
    if (handleAdminAuthFailure(req, res)) return;
    res.removeHeader('Access-Control-Allow-Origin');
    const store = getSharedStore();
    if (!store) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Database store unavailable' }));
      return;
    }
    const repo = parsedUrl.searchParams.get('repositoryId') || undefined;
    const taskType = (parsedUrl.searchParams.get('taskType') as any) || undefined;
    const vSuccessParam = parsedUrl.searchParams.get('verifiedSuccess');
    const verifiedSuccess =
      vSuccessParam === 'true'
        ? true
        : vSuccessParam === 'false'
        ? false
        : vSuccessParam === 'null'
        ? null
        : undefined;
    const trainingParam = parsedUrl.searchParams.get('trainingAllowed');
    const trainingAllowed =
      trainingParam === 'true' ? true : trainingParam === 'false' ? false : undefined;
    const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);

    const episodes = store.listTaskEpisodes({
      repositoryId: repo,
      taskType,
      verifiedSuccess,
      trainingAllowed,
      limit,
    });

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    });
    res.end(JSON.stringify({ episodes, count: episodes.length }, null, 2));
    return;
  }

  // Learning Flywheel Episode Detail API (Phase 20V/W)
  const episodeMatch = pathname.match(/^\/api\/admin\/learning\/episodes\/([a-zA-Z0-9_\-]+)$/);
  if (episodeMatch && req.method === 'GET') {
    if (handleAdminAuthFailure(req, res)) return;
    res.removeHeader('Access-Control-Allow-Origin');
    const store = getSharedStore();
    if (!store) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Database store unavailable' }));
      return;
    }
    const episodeId = episodeMatch[1];
    const episode = store.getTaskEpisode(episodeId);
    if (!episode) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Episode ${episodeId} not found` }));
      return;
    }

    const candidates = store.getEpisodeCandidates(episodeId);
    const exposures = store.getContextExposures(episodeId);
    const trajectory = store.getEpisodeTrajectoryEvents(episodeId);
    const snapshot = store.getPreOutcomeSnapshot(episodeId);
    const isRevoked = store.isEpisodeRevoked(episodeId);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    });
    res.end(
      JSON.stringify(
        {
          episode,
          candidates,
          exposures,
          trajectory,
          snapshot,
          isRevoked,
        },
        null,
        2
      )
    );
    return;
  }

  // Admin Source Provenance Registration API (Section 51)
  if (pathname === '/api/admin/provenance' && req.method === 'POST') {
    if (handleAdminAuthFailure(req, res)) return;
    res.removeHeader('Access-Control-Allow-Origin');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const repo = String(payload.repository || '').trim();
        if (!repo) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Field "repository" is required' }));
          return;
        }
        const store = getSharedStore();
        if (!store) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Database storage is temporarily unavailable' }));
          return;
        }
        const prov = createSourceProvenance({
          origin: payload.origin || 'OpenSource',
          repository: repo,
          license: payload.license || 'Unknown',
          trainingPermission: payload.trainingPermission || 'REVIEW',
          redistributionPermission: payload.redistributionPermission || 'REVIEW',
          cutoffDate: payload.cutoffDate || '2024-01-01T00:00:00.000Z',
          verified: payload.verified === true,
          notes: payload.notes || 'Admin manual registration',
        });
        store.saveSourceProvenance(prov);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, provenance: prov }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Failed to save provenance' }));
      }
    });
    return;
  }

  // Admin CSV Export API
  if (pathname === '/api/admin/export' && req.method === 'GET') {
    if (handleAdminAuthFailure(req, res)) return;
    res.removeHeader('Access-Control-Allow-Origin');
    const exportType = parsedUrl.searchParams.get('type') || 'leads';
    if (exportType === 'leads') {
      const leads = loadLeads();
      const csvHeader = 'ID,Email,TeamSize,PrimaryAgent,RepoUrl,Notes,IP,CreatedAt,Status\n';
      const csvRows = leads.map(l => 
        `"${l.id}","${l.email}","${l.teamSize}","${l.agent}","${(l.repoUrl || '').replace(/"/g, '""')}","${(l.notes || '').replace(/"/g, '""')}","${l.ip}","${l.createdAt}","${l.status}"`
      ).join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="siftrcode_leads.csv"'
      });
      res.end(csvHeader + csvRows);
      return;
    } else if (exportType === 'feedback') {
      const feedback = loadFeedback();
      const csvHeader = 'ID,Category,Message,Email,Page,CreatedAt\n';
      const csvRows = feedback.map(f =>
        `"${f.id}","${f.category}","${(f.message || '').replace(/"/g, '""')}","${f.email}","${f.page}","${f.createdAt}"`
      ).join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="siftrcode_feedback.csv"'
      });
      res.end(csvHeader + csvRows);
      return;
    } else if (exportType === 'deletions') {
      const store = getSharedStore();
      const audits = store ? store.listDeletionAuditRecords() : [];
      const csvHeader = 'DeletionID,RequestedAt,ExecutedAt,Repository,TenantID,TaskID,PurgedObservations,PurgedTrainingRows,AffectedDatasets,Status,Reason\n';
      const csvRows = audits.map(a =>
        `"${a.deletionId}","${a.requestedAt}","${a.executedAt}","${a.criteria.repository || ''}","${a.criteria.tenantId || ''}","${a.criteria.taskId || ''}",${a.purgedObservationsCount},${a.purgedTrainingRowsCount},"${(a.affectedDatasets || []).join(';')}","${a.status}","${(a.criteria.reason || '').replace(/"/g, '""')}"`
      ).join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="siftrcode_deletion_audits.csv"'
      });
      res.end(csvHeader + csvRows);
      return;
    } else if (exportType === 'provenance') {
      const store = getSharedStore();
      const provs = store ? store.listSourceProvenances() : [];
      const csvHeader = 'ProvenanceID,Origin,Repository,License,TrainingPermission,RedistributionPermission,CutoffDate,Verified,CreatedAt\n';
      const csvRows = provs.map(p =>
        `"${p.provenanceId}","${p.origin}","${p.repository}","${p.license}","${p.trainingPermission}","${p.redistributionPermission}","${p.cutoffDate}",${p.verified ? 'true' : 'false'},"${p.createdAt}"`
      ).join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="siftrcode_source_provenances.csv"'
      });
      res.end(csvHeader + csvRows);
      return;
    } else if (exportType === 'outcomes') {
      const store = getSharedStore();
      const outcomes = store ? store.listTaskOutcomes(100) : [];
      const csvHeader = 'OutcomeID,TaskID,SessionID,AgentEnvironment,BuildPassed,HiddenTestsPassed,RegressionTestsPassed,HumanReview,VerifiedSuccess,Confidence,RecordedAt\n';
      const csvRows = outcomes.map(o =>
        `"${o.outcomeId}","${o.taskId}","${o.sessionId}","${o.agentEnvironmentId}",${o.buildPassed ?? ''},${o.hiddenTestsPassed ?? ''},${o.regressionTestsPassed ?? ''},"${o.humanReview || ''}",${o.verifiedSuccess === null ? 'null' : (o.verifiedSuccess ? 'true' : 'false')},${o.confidence},"${o.recordedAt}"`
      ).join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="siftrcode_task_outcomes.csv"'
      });
      res.end(csvHeader + csvRows);
      return;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid export type. Use ?type=leads, ?type=feedback, ?type=deletions, ?type=provenance, or ?type=outcomes' }));
      return;
    }
  }

  // Admin page protection (fail closed if admin disabled)
  if (pathname === '/admin' || pathname === '/admin.html') {
    if (!isAdminEnabled()) {
      res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, private'
      });
      res.end('Service Unavailable: Admin interface is disabled (ADMIN_TOKEN not configured).');
      return;
    }
    const adminHtmlPath = path.join(WEB_DIR, 'admin.html');
    if (fs.existsSync(adminHtmlPath)) {
      res.removeHeader('Access-Control-Allow-Origin');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, private'
      });
      fs.createReadStream(adminHtmlPath).pipe(res);
      return;
    }
  }

  // Serve static files from web/
  let filePath = path.join(WEB_DIR, pathname === '/' ? 'index.html' : pathname);
  
  // Security check: prevent directory traversal
  const resolvedFilePath = path.resolve(filePath);
  const resolvedWebDir = path.resolve(WEB_DIR);
  if (resolvedFilePath !== resolvedWebDir && !resolvedFilePath.startsWith(resolvedWebDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  filePath = resolvedFilePath;

  // Support clean extensionless URLs: e.g. /privacy -> web/privacy.html
  if (!fs.existsSync(filePath) && fs.existsSync(filePath + '.html')) {
    filePath = filePath + '.html';
  }

  if (path.basename(filePath) === 'admin.html') {
    if (!isAdminEnabled()) {
      res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, private'
      });
      res.end('Service Unavailable: Admin interface is disabled (ADMIN_TOKEN not configured).');
      return;
    }
    res.removeHeader('Access-Control-Allow-Origin');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Fallback to index.html for SPA routing
  const fallbackPath = path.join(WEB_DIR, 'index.html');
  if (fs.existsSync(fallbackPath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(fallbackPath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`🌐 [SiftrCode Web Server] Running on http://${HOST}:${PORT}`);
  });
}

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`⚠️ [SiftrCode Web Server] Port ${PORT} in use, skipping background listen in test/import mode.`);
  } else {
    console.error('🌐 [SiftrCode Web Server Error]:', err);
  }
});

process.on('uncaughtException', (err) => {
  console.error('🌐 [SiftrCode Uncaught Exception]:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('🌐 [SiftrCode Unhandled Rejection]:', reason);
});
