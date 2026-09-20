import * as fs from 'fs';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { skeletonizeFile } from '../skeleton/dispatcher';
import { packRepository } from '../core/packer';
import { auditRepository } from '../core/auditor';
import { ContextEngine } from '../engine/context_engine';
import { getResolutionName } from '../context/context_resolution';

export async function runMcpServer() {
  const server = new Server(
    {
      name: 'siftrcode',
      version: '0.1.1'
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
          const resolvedPath = path.resolve(filePath);
          if (!fs.existsSync(resolvedPath)) {
            return {
              content: [{ type: 'text', text: `Error: File not found at ${filePath}` }],
              isError: true
            };
          }
          rawContent = fs.readFileSync(resolvedPath, 'utf-8');
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

        for (const fp of filePaths) {
          try {
            const resolvedPath = path.resolve(fp);
            if (!fs.existsSync(resolvedPath)) {
              results.push({
                filePath: fp,
                originalTokens: 0,
                skeletonTokens: 0,
                reduction: '0%',
                skeletonContent: '',
                error: `File not found at ${fp}`
              });
              continue;
            }
            const rawContent = fs.readFileSync(resolvedPath, 'utf-8');
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
