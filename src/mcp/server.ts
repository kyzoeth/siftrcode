import * as fs from 'fs';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { skeletonizeFile } from '../skeleton/dispatcher';
import { packRepository } from '../core/packer';
import { auditRepository } from '../core/auditor';

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
