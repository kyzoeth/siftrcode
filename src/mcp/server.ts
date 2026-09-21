import * as fs from 'fs';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { skeletonizeFile } from '../skeleton/dispatcher';
import { packRepository } from '../core/packer';
import { auditRepository } from '../core/auditor';
import { ContextEngine } from '../engine/context_engine';
import { getResolutionName, ContextResolution } from '../context/context_resolution';
import { resolveSafeWorkspacePath } from '../workspace/workspace_source_reader';
import { createOutcomeEvidence } from '../telemetry/outcome_evidence';
import { createDefaultDataRights } from '../rights/data_rights';
import { SqliteStore } from '../storage/sqlite_store';

export async function runMcpServer() {
  const server = new Server(
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'siftr_skeleton',
          description: 'Returns the pruned AST interface skeleton of a source code file. Strips function bodies and internal implementation loops while preserving 100% of exported types, signatures, classes, and docstrings. Cuts token usage by 80-95%. Supports TypeScript, JavaScript, Python, Go, and Rust.',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description: 'Relative or absolute path to the source file on disk'
              },
              content: {
                type: 'string',
                description: 'Optional: Direct in-memory source code content to skeletonize (bypasses reading from disk)'
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
          description: 'Scans the codebase, analyzes AST dependencies, applies Jev relevance scoring, and compiles a clean, token-pruned context pack (context.md) for the active task.',
          inputSchema: {
            type: 'object',
            properties: {
              focus: {
                type: 'string',
                description: 'The task description or focus area (e.g. "checkout subscription webhook race condition")'
              },
              directory: {
                type: 'string',
                description: 'Directory path to scan (defaults to current working directory)'
              },
              output: {
                type: 'string',
                description: 'Output filename for the compiled context pack (defaults to siftr_context.md)'
              },
              includeContent: {
                type: 'boolean',
                description: 'Whether to return the compiled context pack directly in the response text (defaults to true)'
              }
            }
          }
        },
        {
          name: 'siftr_audit',
          description: 'Audits the current codebase for token bloat and context waste. Returns potential token and cost savings.',
          inputSchema: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Directory path to audit'
              }
            }
          }
        },
        {
          name: 'siftr_context',
          description:
            'Generates an outcome-aware optimized context bundle for an AI coding task. Discovers multi-channel candidates, ranks by evidence and graph proximity, protects edit targets at full resolution, degrades distant dependencies to AST skeletons, and strictly optimizes token and economic cost limits.',
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
          description:
            'Alias for siftr_context. Generates an outcome-aware optimized context bundle for an AI coding task.',
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
              }
            },
            required: ['prompt']
          }
        },
        {
          name: 'siftr_rank',
          description:
            'Evaluates and ranks candidate files/symbols for a task prompt with transparent heuristic scores, evidence coverage, graph proximity, and penalty breakdowns.',
          inputSchema: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description: 'Developer task description or issue prompt'
              },
              directory: {
                type: 'string',
                description: 'Target workspace directory path (defaults to current working directory)'
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
                description: 'Whether type-checking and linter checks passed'
              },
              securityChecksPassed: {
                type: 'boolean',
                description: 'Whether security scanners passed'
              },
              agentClaimedSuccess: {
                type: 'boolean',
                description: 'Whether the coding agent self-reported completion'
              },
              actualProviderInputTokens: {
                type: 'number',
                description: 'Post-turn input token consumption reported by LLM provider'
              },
              actualProviderOutputTokens: {
                type: 'number',
                description: 'Post-turn output token consumption reported by LLM provider'
              },
              costUSD: {
                type: 'number',
                description: 'Actual monetary cost incurred in USD'
              },
              wallTimeMs: {
                type: 'number',
                description: 'Total task execution wall time in milliseconds'
              },
              notes: {
                type: 'string',
                description: 'Optional execution notes or failure rationale'
              },
              directory: {
                type: 'string',
                description: 'Target workspace directory path'
              }
            },
            required: ['taskId']
          }
        },
        {
          name: 'siftr_expand',
          description:
            'Dynamically expands a skeletonized or signature-level context unit into full implementation body on-demand during an active session.',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description: 'Relative or absolute file path to expand'
              },
              contextUnitId: {
                type: 'string',
                description: 'Context unit ID to expand'
              },
              targetResolution: {
                type: 'string',
                enum: ['body', 'full'],
                description: 'Target expansion resolution (defaults to body)'
              },
              taskId: {
                type: 'string',
                description: 'Active task identifier'
              },
              directory: {
                type: 'string',
                description: 'Target workspace directory path'
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
                description: 'Session lifecycle action (defaults to status)'
              },
              taskId: {
                type: 'string',
                description: 'Active task identifier'
              },
              sessionId: {
                type: 'string',
                description: 'Optional explicit session identifier'
              },
              agentModel: {
                type: 'string',
                description: 'Agent model name'
              },
              directory: {
                type: 'string',
                description: 'Target workspace directory path'
              }
            },
            required: ['taskId']
          }
        }
      ]
    };

  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

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
        const taskId = String(args?.taskId || '');
        if (!taskId) {
          return {
            content: [{ type: 'text', text: 'Error: "taskId" parameter is required' }],
            isError: true,
          };
        }

        const workspaceDir = (args?.directory as string) || process.cwd();
        const planId = args?.planId ? String(args.planId) : undefined;
        const testsPassed = typeof args?.testsPassed === 'boolean' ? args.testsPassed : undefined;
        const regressionTestsPassed = typeof args?.regressionTestsPassed === 'boolean' ? args.regressionTestsPassed : undefined;
        const staticChecksPassed = typeof args?.staticChecksPassed === 'boolean' ? args.staticChecksPassed : undefined;
        const securityChecksPassed = typeof args?.securityChecksPassed === 'boolean' ? args.securityChecksPassed : undefined;
        const agentClaimedSuccess = typeof args?.agentClaimedSuccess === 'boolean' ? args.agentClaimedSuccess : undefined;
        const actualProviderInputTokens = typeof args?.actualProviderInputTokens === 'number' ? args.actualProviderInputTokens : undefined;
        const actualProviderOutputTokens = typeof args?.actualProviderOutputTokens === 'number' ? args.actualProviderOutputTokens : undefined;
        const costUSD = typeof args?.costUSD === 'number' ? args.costUSD : undefined;
        const wallTimeMs = typeof args?.wallTimeMs === 'number' ? args.wallTimeMs : undefined;
        const notes = args?.notes ? String(args.notes) : undefined;

        const outcomeEvidence = createOutcomeEvidence({
          taskId,
          sessionId: `sess_${taskId}`,
          agentEnvironmentId: 'default',
          workspaceSnapshotBefore: 'snapshot_initial',
          publicTestsPassed: testsPassed,
          regressionTestsPassed,
          staticChecksPassed,
          securityChecksPassed,
          agentReportedSuccess: agentClaimedSuccess,
          actualProviderInputTokens,
          actualProviderOutputTokens,
          costUSD,
          wallTimeMs,
        });

        const siftrDir = path.join(workspaceDir, '.siftr');
        const sqlitePath = path.join(siftrDir, 'observations.sqlite');
        let persisted = false;

        try {
          if (fs.existsSync(sqlitePath) || fs.existsSync(siftrDir)) {
            if (!fs.existsSync(siftrDir)) {
              fs.mkdirSync(siftrDir, { recursive: true });
            }
            const store = new SqliteStore(sqlitePath);
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
                  planId,
                  notes,
                },
              },
            ]);
            if (planId && actualProviderInputTokens !== undefined) {
              store.updatePlanActualProviderTokens(planId, actualProviderInputTokens);
            }
            persisted = true;
          }
        } catch {
          // Resilience: store warning shouldn't fail outcome reporting
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                taskId,
                outcomeId: outcomeEvidence.outcomeId,
                verifiedSuccess: outcomeEvidence.verifiedSuccess,
                confidence: outcomeEvidence.confidence,
                rationale: outcomeEvidence.evaluationRationale,
                persisted,
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
        const taskId = args?.taskId ? String(args.taskId) : undefined;

        if (!filePath && !contextUnitId) {
          return {
            content: [{ type: 'text', text: 'Error: Either "filePath" or "contextUnitId" must be provided' }],
            isError: true,
          };
        }

        const resolvedPath = filePath || contextUnitId!;
        const safePath = resolveSafeWorkspacePath(workspaceDir, resolvedPath);
        if (!safePath || !fs.existsSync(safePath)) {
          return {
            content: [{ type: 'text', text: `Error: File not found or path outside workspace: ${resolvedPath}` }],
            isError: true,
          };
        }

        const rawContent = fs.readFileSync(safePath, 'utf-8');
        const tokenEstimate = Math.ceil(rawContent.length / 3.7);

        try {
          const sqlitePath = path.join(workspaceDir, '.siftr', 'observations.sqlite');
          if (taskId && fs.existsSync(sqlitePath)) {
            const store = new SqliteStore(sqlitePath);
            store.saveTrajectoryEvents([
              {
                eventId: `ev_exp_${Date.now().toString(36)}`,
                taskId,
                kind: 'EXPAND_UNIT' as any,
                payload: {
                  path: resolvedPath,
                  targetResolution: targetResolutionStr,
                  tokenEstimate,
                },
                timestamp: Date.now(),
                dataRights: createDefaultDataRights(),
              },
            ]);
          }
        } catch {
          // ignore
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                path: resolvedPath,
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
        const taskId = String(args?.taskId || '');
        if (!taskId) {
          return {
            content: [{ type: 'text', text: 'Error: "taskId" parameter is required' }],
            isError: true,
          };
        }

        const workspaceDir = (args?.directory as string) || process.cwd();
        const sessionId = args?.sessionId ? String(args.sessionId) : `sess_${taskId}`;
        const agentModel = args?.agentModel ? String(args.agentModel) : undefined;

        let plansCount = 0;
        let outcomesCount = 0;
        let totalTokens = 0;

        try {
          const sqlitePath = path.join(workspaceDir, '.siftr', 'observations.sqlite');
          if (fs.existsSync(sqlitePath)) {
            const store = new SqliteStore(sqlitePath);
            const plans = store.listContextPlans(taskId);
            plansCount = plans.length;
            for (const p of plans) {
              totalTokens += p.actualProviderInputTokens || p.actualRenderedTokens || 0;
            }
            const outcomes = store.listOutcomeEvidence(taskId);
            outcomesCount = outcomes.length;
          }
        } catch {
          // ignore
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action,
                sessionId,
                taskId,
                agentModel,
                plansCount,
                outcomesCount,
                totalTokens,
                status: action === 'end' ? 'COMPLETED' : 'ACTIVE',
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
