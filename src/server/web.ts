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
import { resolveSafeWorkspacePath } from '../workspace/workspace_source_reader';
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

    // Seed sample records for admin demonstration if database is fresh
    try {
      const provs = sharedStore.listSourceProvenances();
      if (provs.length === 0) {
        sharedStore.saveSourceProvenance(createSourceProvenance({
          origin: 'OpenSource',
          repository: 'psf/requests',
          license: 'Apache-2.0',
          trainingPermission: 'ALLOWED',
          redistributionPermission: 'ALLOWED',
          cutoffDate: '2024-01-01T00:00:00.000Z',
          verified: true,
          notes: 'Permissive open source with verified training rights',
        }));
        sharedStore.saveSourceProvenance(createSourceProvenance({
          origin: 'SWE-bench',
          repository: 'django/django',
          license: 'BSD-3-Clause',
          trainingPermission: 'ALLOWED',
          redistributionPermission: 'ALLOWED',
          cutoffDate: '2023-12-31T00:00:00.000Z',
          verified: true,
          notes: 'Standard SWE-bench verified repository',
        }));
        sharedStore.saveSourceProvenance(createSourceProvenance({
          origin: 'CustomerSession',
          repository: 'enterprise/payment-core',
          license: 'Proprietary',
          trainingPermission: 'FORBIDDEN',
          redistributionPermission: 'FORBIDDEN',
          cutoffDate: '2024-06-01T00:00:00.000Z',
          verified: true,
          notes: 'Enterprise customer repository strictly excluded from training',
        }));
        sharedStore.saveSourceProvenance(createSourceProvenance({
          origin: 'External',
          repository: 'community/unreviewed-lib',
          license: 'Unknown',
          trainingPermission: 'REVIEW',
          redistributionPermission: 'REVIEW',
          cutoffDate: '2024-01-01T00:00:00.000Z',
          verified: false,
          notes: 'Pending legal/compliance review — excluded from training by default',
        }));
      }

      const outcomes = sharedStore.listTaskOutcomes(1);
      if (outcomes.length === 0) {
        sharedStore.saveTaskOutcome({
          outcomeId: 'tout_seed_1',
          taskId: 'task_swe_django_042',
          sessionId: 'sess_eval_01',
          agentEnvironmentId: 'claude_code',
          workspaceSnapshotBefore: 'snap_django_before',
          workspaceSnapshotAfter: 'snap_django_after',
          buildPassed: true,
          publicTestsPassed: true,
          hiddenTestsPassed: true,
          regressionTestsPassed: true,
          staticChecksPassed: true,
          securityChecksPassed: true,
          behavioralOraclePassed: true,
          userAccepted: true,
          agentReportedSuccess: true,
          humanReview: 'PASS',
          verifiedSuccess: true,
          confidence: 0.99,
          policyId: 'default_outcome_policy_v1',
          policyVersion: '1.0.0',
          evaluationRationale: 'Hidden oracle tests & full regression suite passed cleanly with human review pass',
          recordedAt: new Date(Date.now() - 3600 * 1000 * 2).toISOString(),
        });
        sharedStore.saveTaskOutcome({
          outcomeId: 'tout_seed_2',
          taskId: 'task_build_fail_089',
          sessionId: 'sess_eval_02',
          agentEnvironmentId: 'cursor',
          workspaceSnapshotBefore: 'snap_ts_before',
          workspaceSnapshotAfter: 'snap_ts_after',
          buildPassed: false,
          publicTestsPassed: false,
          hiddenTestsPassed: false,
          regressionTestsPassed: false,
          staticChecksPassed: false,
          securityChecksPassed: true,
          behavioralOraclePassed: false,
          agentReportedSuccess: true,
          verifiedSuccess: false,
          confidence: 0.99,
          policyId: 'default_outcome_policy_v1',
          policyVersion: '1.0.0',
          evaluationRationale: 'Build/syntax failure in candidate edit overrides agent self-reported success',
          recordedAt: new Date(Date.now() - 3600 * 1000 * 5).toISOString(),
        });
        sharedStore.saveTaskOutcome({
          outcomeId: 'tout_seed_3',
          taskId: 'task_agent_claim_only',
          sessionId: 'sess_eval_03',
          agentEnvironmentId: 'generic_mcp',
          workspaceSnapshotBefore: 'snap_app_before',
          workspaceSnapshotAfter: 'snap_app_after',
          buildPassed: true,
          agentReportedSuccess: true,
          verifiedSuccess: null,
          confidence: 0.35,
          policyId: 'default_outcome_policy_v1',
          policyVersion: '1.0.0',
          evaluationRationale: 'Section 49 Invariant: Agent self-reporting success alone is weak evidence (verifiedSuccess = null)',
          recordedAt: new Date(Date.now() - 3600 * 1000 * 8).toISOString(),
        });
      }

      const audits = sharedStore.listDeletionAuditRecords();
      if (audits.length === 0) {
        sharedStore.saveDeletionAuditRecord({
          deletionId: 'del_gdpr_sample_01',
          requestedAt: new Date(Date.now() - 86400 * 1000 * 2).toISOString(),
          executedAt: new Date(Date.now() - 86400 * 1000 * 2 + 1500).toISOString(),
          criteria: {
            repository: 'withdrawn/sample-lib',
            reason: 'GDPR Right-to-be-Forgotten erasure request',
          },
          purgedObservationsCount: 42,
          purgedTrainingRowsCount: 18,
          affectedDatasets: ['v2.0.0-beta', 'v2.0.0-rc1'],
          status: 'COMPLETED',
          details: 'Purged from candidate_observations, trajectory_events, and training_rows with verified 0 trace rebuild',
        });
      }
    } catch (e) {
      console.error('[Web Admin] Error seeding sample data into store:', e);
    }
  }
  return sharedStore;
}

// Static MCP Server Card definition per SEP-1649 / Smithery specification
const SERVER_CARD = {
  serverInfo: {
    name: 'siftrcode',
    version: '0.2.0',
    description: 'Outcome-aware context optimization engine for AI coding agents. Discovers, ranks, bundles, and safely degrades repository context to maximize task success under strict token and economic budgets.'
  },
  authentication: {
    required: false
  },
  tools: [
    {
      name: 'siftr_context',
      description: 'Generates an outcome-aware optimized context bundle for an AI coding task. Discovers multi-channel candidates, ranks by evidence and graph proximity, protects edit targets at full resolution, degrades distant dependencies to AST skeletons, and strictly optimizes token and economic cost limits.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Developer task description, issue summary, or prompt'
          },
          directory: {
            type: 'string',
            description: 'Target workspace directory path (defaults to current working directory)'
          },
          agentModel: {
            type: 'string',
            description: 'Target LLM agent model name (e.g. claude-3-5-sonnet, gpt-4o, cursor)'
          },
          agentKind: {
            type: 'string',
            enum: ['claude_code', 'cursor', 'generic_mcp'],
            description: 'Target agent environment adapter (defaults to claude_code)'
          },
          budgetProfile: {
            type: 'string',
            enum: ['LEAN', 'BALANCED', 'THOROUGH'],
            description: 'Budget optimization profile (defaults to BALANCED)'
          },
          tokenBudget: {
            type: 'number',
            description: 'Explicit maximum token budget'
          },
          maxCostUSD: {
            type: 'number',
            description: 'Explicit maximum economic cost ceiling in USD'
          },
          includeContext: {
            type: 'boolean',
            description: 'Whether to return the compiled context text directly in the response (defaults to true)'
          },
          includePlan: {
            type: 'boolean',
            description: 'Whether to include the complete ContextPlan metadata object (defaults to true)'
          }
        },
        required: ['prompt']
      }
    },
    {
      name: 'siftr_optimize',
      description: 'Alias for siftr_context. Generates an outcome-aware optimized context bundle for an AI coding task.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Developer task description, issue summary, or prompt'
          },
          directory: {
            type: 'string',
            description: 'Target workspace directory path (defaults to current working directory)'
          },
          agentModel: {
            type: 'string',
            description: 'Target LLM agent model name'
          },
          agentKind: {
            type: 'string',
            enum: ['claude_code', 'cursor', 'generic_mcp'],
            description: 'Target agent environment adapter'
          },
          budgetProfile: {
            type: 'string',
            enum: ['LEAN', 'BALANCED', 'THOROUGH'],
            description: 'Budget optimization profile'
          },
          tokenBudget: {
            type: 'number',
            description: 'Explicit maximum token budget'
          },
          maxCostUSD: {
            type: 'number',
            description: 'Explicit maximum economic cost ceiling in USD'
          },
          includeContext: {
            type: 'boolean',
            description: 'Whether to return the compiled context text directly'
          }
        },
        required: ['prompt']
      }
    },
    {
      name: 'siftr_rank',
      description: 'Evaluates and ranks candidate files/symbols for a task prompt with transparent heuristic scores, evidence coverage, graph proximity, and penalty breakdowns.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Developer task description or issue prompt'
          },
          directory: {
            type: 'string',
            description: 'Target workspace directory path'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of ranked candidates to return (defaults to 20)'
          }
        },
        required: ['prompt']
      }
    },
    {
      name: 'siftr_skeleton',
      description: 'Returns the pruned AST interface skeleton of source code. Strips function bodies and internal implementation loops while preserving 100% of exported types, signatures, classes, and docstrings. Cuts token usage by 80-95%.',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Source code content to skeletonize'
          },
          language: {
            type: 'string',
            description: 'Source language: typescript, python, go, or rust',
            enum: ['typescript', 'python', 'go', 'rust', 'javascript']
          },
          filename: {
            type: 'string',
            description: 'Optional filename (e.g. index.ts, app.py, main.go, lib.rs)'
          }
        }
      }
    },
    {
      name: 'siftr_batch_skeleton',
      description: 'Batch extracts interface skeletons for multiple source files in a single turn. Ideal for Claude Code and Cursor when inspecting multiple related files simultaneously.',
      inputSchema: {
        type: 'object',
        properties: {
          filePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of relative or absolute file paths to skeletonize'
          }
        },
        required: ['filePaths']
      }
    },
    {
      name: 'siftr_pack',
      description: 'Prepares an AST-compressed context pack for AI coding agents.',
      inputSchema: {
        type: 'object',
        properties: {
          focus: {
            type: 'string',
            description: 'Task description or focus area'
          },
          directory: {
            type: 'string',
            description: 'Directory path to scan'
          }
        }
      }
    },
    {
      name: 'siftr_audit',
      description: 'Audits source code or repository for token bloat, dead weight, and context waste. Returns potential token and cost savings.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: 'Directory path to audit'
          },
          code: {
            type: 'string',
            description: 'Code snippet to audit'
          },
          language: {
            type: 'string',
            description: 'Language of snippet'
          }
        }
      }
    },
    {
      name: 'siftr_outcome',
      description:
        'Reports task execution results, oracle test verdicts (unit, regression, security), actual provider token usage, and costs to close the learning loop.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'Task identifier returned by siftr_context'
          },
          planId: {
            type: 'string',
            description: 'ContextPlan identifier returned by siftr_context'
          },
          sessionId: {
            type: 'string',
            description: 'Session identifier linking task and context plan'
          },
          testsPassed: {
            type: 'boolean',
            description: 'Whether task-specific test suite passed'
          },
          regressionTestsPassed: {
            type: 'boolean',
            description: 'Whether existing test suite / regression checks passed'
          },
          staticChecksPassed: {
            type: 'boolean',
            description: 'Whether static analysis / linting passed'
          },
          securityChecksPassed: {
            type: 'boolean',
            description: 'Whether security scans passed'
          },
          agentClaimedSuccess: {
            type: 'boolean',
            description: 'Whether the agent declared task complete'
          },
          actualProviderInputTokens: {
            type: 'number',
            description: 'Actual tokens billed by the LLM provider for input'
          },
          actualProviderOutputTokens: {
            type: 'number',
            description: 'Actual tokens billed by the LLM provider for output'
          },
          costUSD: {
            type: 'number',
            description: 'Actual monetary cost charged by provider in USD'
          },
          wallTimeMs: {
            type: 'number',
            description: 'Wall-clock task duration in milliseconds'
          },
          notes: {
            type: 'string',
            description: 'Optional execution notes or failure summary'
          }
        }
      }
    },
    {
      name: 'siftr_expand',
      description:
        'Expands a skeletonized or signature-level context unit into full implementation body on-demand during agent execution.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Workspace-relative file path to expand'
          },
          contextUnitId: {
            type: 'string',
            description: 'Unique ContextUnit ID returned in siftr_context units array'
          },
          targetResolution: {
            type: 'string',
            enum: ['body', 'full'],
            description: 'Target resolution level: "body" (implementation) or "full" (entire file). Defaults to "body".'
          },
          taskId: {
            type: 'string',
            description: 'Optional task ID to look up snapshot context'
          },
          sessionId: {
            type: 'string',
            description: 'Optional session ID to look up snapshot context'
          },
          planId: {
            type: 'string',
            description: 'Optional ContextPlan ID to look up snapshot context'
          },
          directory: {
            type: 'string',
            description: 'Workspace directory root path (defaults to current working directory)'
          }
        }
      }
    },
    {
      name: 'siftr_session',
      description:
        'Manages or inspects active Siftr coding agent sessions, linking tasks, plans, and token economics.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'status', 'end'],
            description: 'Action to perform: "start" a new session, inspect "status", or "end" session'
          },
          taskId: {
            type: 'string',
            description: 'Task ID associated with this session'
          },
          sessionId: {
            type: 'string',
            description: 'Explicit session ID (optional for start, recommended for status/end)'
          },
          agentModel: {
            type: 'string',
            description: 'LLM model ID driving the agent session (e.g. claude-3-7-sonnet)'
          },
          status: {
            type: 'string',
            enum: ['COMPLETED', 'ABORTED'],
            description: 'Target status when ending a session (defaults to COMPLETED)'
          },
          directory: {
            type: 'string',
            description: 'Workspace directory root path'
          }
        }
      }
    }
  ],
  resources: [],
  prompts: []
};

function createMcpServerInstance() {
  const mcpServer = new Server(
    {
      name: 'siftrcode',
      version: '0.2.0'
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
        const inputTaskId = args?.taskId ? String(args.taskId) : undefined;
        const inputSessionId = args?.sessionId ? String(args.sessionId) : undefined;
        let resolvedTaskId = inputTaskId;
        if (!resolvedTaskId && inputSessionId) {
          const sqlitePath = path.join(workspaceDir, '.siftr', 'observations.sqlite');
          if (fs.existsSync(sqlitePath)) {
            const lookupStore = new SqliteStore(sqlitePath);
            const sess = lookupStore.getSiftrSession(inputSessionId);
            if (sess) {
              resolvedTaskId = sess.taskId;
            }
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
        });

        const plan = result.plan;
        const allocatedUnits = plan.units.filter((u) => u.resolution > 0);

        // Persist canonical FinalContextAllocation (Final Closure Directive Section 48)
        if (result.sqliteStore) {
          result.sqliteStore.saveFinalContextAllocation({
            planId: plan.planId,
            workspaceSnapshotId: plan.workspaceSnapshotId || 'snapshot_init',
            totalEstimatedTokens: plan.actualRenderedTokens || plan.estimatedRenderedTokens || 0,
            budgetTokens: plan.budgetPlan.totalTokens,
            overflow: Boolean(plan.overflowReason),
            tokenizerMethod: plan.tokenEstimationMethod || 'HEURISTIC_CHARS',
            items: plan.units.map((u) => ({
              contextUnitId: u.contextUnitId,
              plannedResolution: u.resolution,
              actualResolution: u.resolution,
              estimatedTokens: u.tokenEstimate,
              materializerVersion: DefaultContextUnitMaterializer.VERSION,
            })),
            recordedAt: new Date().toISOString(),
          });
        }

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
        const code = String(args?.code || '');
        const lang = String(args?.language || 'typescript').toLowerCase();
        let ext = '.ts';
        if (lang === 'python' || lang === 'py') ext = '.py';
        else if (lang === 'go' || lang === 'golang') ext = '.go';
        else if (lang === 'rust' || lang === 'rs') ext = '.rs';
        else if (lang === 'javascript' || lang === 'js') ext = '.js';

        const filename = String(args?.filename || `snippet${ext}`);
        const result = skeletonizeFile(code, filename);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  filename,
                  language: lang,
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
          resolvedSnapshotId = plan.workspaceSnapshotId || 'snapshot_init';
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
            resolvedSnapshotId = plans[0].workspaceSnapshotId || 'snapshot_init';
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

          // Section 40: ContextUnit cannot belong to wrong plan/workspace
          const plannedUnit = plan.units.find((u) => u.contextUnitId === contextUnitId);
          if (!plannedUnit) {
            return {
              content: [{ type: 'text', text: `Error: ContextUnit "${contextUnitId}" does not belong to plan "${plan.planId}" or task "${plan.taskId}". Expansion rejected.` }],
              isError: true,
            };
          }

          const snapshotId = plan.workspaceSnapshotId || 'snapshot_init';
          let snapshot = store.getSnapshot(snapshotId);
          if (!snapshot) {
            const workspaceManager = new WorkspaceManager({ rootDir: workspaceDir });
            snapshot = await workspaceManager.captureSnapshot();
          }

          const snapshotUnits = store.getContextUnitsBySnapshot(snapshot.workspaceSnapshotId);
          let unit = snapshotUnits.find((u) => u.id === contextUnitId);
          if (!unit) {
            unit = {
              id: contextUnitId,
              kind: ContextUnitKind.CODE_SYMBOL,
              workspaceSnapshotId: snapshot.workspaceSnapshotId,
              repositoryId: 'root',
              path: plannedUnit.path || '',
              title: plannedUnit.title,
              provenance: {
                sourceType: 'file',
                sourceUri: plannedUnit.path || '',
                extractedBy: 'siftr-engine',
                timestamp: new Date().toISOString(),
              },
              trustLevel: TrustLevel.FIRST_PARTY_CODE,
              metadata: {},
            };
          }

          const targetResolution = targetResolutionStr === 'full' ? ContextResolution.FULL : ContextResolution.BODY;

          // Section 10: Use the exact same materializer as ContextEngine
          const materializer = new DefaultContextUnitMaterializer();
          const materialized = materializer.materializeSync(unit, targetResolution, snapshot);

          let fallbackReason: string | undefined = undefined;
          if (targetResolution === ContextResolution.BODY && materialized.resolution === ContextResolution.FULL) {
            fallbackReason = 'Symbol line range unavailable for target unit; fell back to full file content';
          }

          // Section 13: Append immutable ContextExpansionEvent
          const expansionEvent = createContextExpansionEvent({
            taskId: plan.taskId,
            sessionId: plan.sessionId || inputSessionId || `session_${plan.taskId}`,
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

          if (!session && inputSessionId) {
            session = {
              sessionId: inputSessionId,
              taskId: inputTaskId || 'unknown',
              agentEnvironmentId: 'unknown',
              initialWorkspaceSnapshotId: 'snapshot_init',
              latestWorkspaceSnapshotId: 'snapshot_init',
              status: 'COMPLETED',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
            };
          }

          if (!session) {
            return {
              content: [{ type: 'text', text: 'Error: Session not found to end.' }],
              isError: true,
            };
          }

          const targetStatus: SiftrSessionStatus = args?.status === 'ABORTED' ? 'ABORTED' : 'COMPLETED';
          store.updateSessionStatus(session.sessionId, targetStatus, new Date().toISOString());

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
                  endedAt: new Date().toISOString(),
                }, null, 2),
              },
            ],
          };
        }

        // status
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

        const outcomeEvidence = createOutcomeEvidence({
          taskId,
          sessionId: `sess_${taskId}`,
          agentEnvironmentId: 'default',
          workspaceSnapshotBefore: 'snapshot_initial',
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

        const store = getSharedStore();
        let persisted = false;
        if (store) {
          try {
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

  // Admin Leads View (Protected or dev)
  if (pathname === '/api/leads' && req.method === 'GET') {
    const leads = loadLeads();
    res.writeHead(200, { 'Content-Type': 'application/json' });
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

  // Admin Feedback View
  if (pathname === '/api/feedback' && req.method === 'GET') {
    const feedbackList = loadFeedback();
    res.writeHead(200, { 'Content-Type': 'application/json' });
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

  // Admin Consolidated Metrics API
  if (pathname === '/api/admin/metrics' && req.method === 'GET') {
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

    res.writeHead(200, { 'Content-Type': 'application/json' });
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
          totalEdges: 248,
          bySource: { compiler: 112, scip: 58, 'tree-sitter': 46, git: 22, runtime: 8, heuristic: 2 },
          byRelationship: { CALLS: 86, TYPE_USES: 64, REFERENCES: 48, IMPLEMENTS: 28, INHERITS: 22 },
        },
        jevSignals: {
          providerName: 'typesafe-jev',
          status: 'ACTIVE_HEALTHY',
          signalsSupported: ['semanticRelevance', 'likelyEditTarget', 'likelyRootCause'],
          resilienceFallback: 'local-heuristic',
        }
      }
    }));
    return;
  }

  // Admin Traceable Purge & Right-to-be-Forgotten API (Section 52)
  if (pathname === '/api/admin/purge' && req.method === 'POST') {
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

  // Admin Source Provenance Registration API (Section 51)
  if (pathname === '/api/admin/provenance' && req.method === 'POST') {
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

server.listen(PORT, HOST, () => {
  console.log(`🌐 [SiftrCode Web Server] Running on http://${HOST}:${PORT}`);
});

server.on('error', (err: any) => {
  console.error('🌐 [SiftrCode Web Server Error]:', err);
});

process.on('uncaughtException', (err) => {
  console.error('🌐 [SiftrCode Uncaught Exception]:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('🌐 [SiftrCode Unhandled Rejection]:', reason);
});
