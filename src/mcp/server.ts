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
      version: '0.1.0'
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
          description: 'Returns the pruned AST interface skeleton of a source code file. Strips function bodies and internal implementation loops while preserving 100% of exported types, signatures, classes, and docstrings. Cuts token usage by 80-95%.',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description: 'Relative or absolute path to the TypeScript, JavaScript, or Python file'
              }
            },
            required: ['filePath']
          }
        },
        {
          name: 'siftr_pack',
          description: 'Scans the codebase, analyzes AST dependencies, applies Jev relevance scoring, and compiles a clean, token-slammed context pack (context.md) for the active task.',
          inputSchema: {
            type: 'object',
            properties: {
              focus: {
                type: 'string',
                description: 'The task description or focus area (e.g. "checkout subscription webhook race condition")'
              },
              directory: {
                type: 'string',
                description: 'Directory path to scan (defaults to current directory)'
              },
              output: {
                type: 'string',
                description: 'Output filename for the compiled context pack (defaults to siftr_context.md)'
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
        const filePath = String(args?.filePath);
        const resolvedPath = path.resolve(filePath);

        if (!fs.existsSync(resolvedPath)) {
          return {
            content: [{ type: 'text', text: `Error: File not found at ${filePath}` }],
            isError: true
          };
        }

        const rawContent = fs.readFileSync(resolvedPath, 'utf-8');
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

      if (name === 'siftr_pack') {
        const result = await packRepository({
          focus: args?.focus as string | undefined,
          directory: args?.directory as string | undefined,
          output: args?.output as string | undefined
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
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
                },
                null,
                2
              )
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
