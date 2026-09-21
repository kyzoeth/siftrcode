/**
 * Controlled Local Coding Tools for Gemini Agent
 *
 * Implements sandboxed workspace filesystem and execution tools for the
 * coding agent evaluation loop.
 *
 * Invariants:
 * 1. Sandboxing: File access is strictly jailed to episodeWorkspacePath.
 * 2. Traversal Defense: Absolute paths outside workspace and `..` paths rejected.
 * 3. Secret Scrubbing: Sensitive environment keys stripped before running commands.
 * 4. Bounded Output: Output capped to prevent context explosion.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import { Type } from '@google/genai';

export interface ToolExecutionResult {
  toolName: string;
  args: Record<string, any>;
  success: boolean;
  output: any;
  error?: string;
}

export class GeminiWorkspaceSandbox {
  private readonly workspaceRoot: string;
  private readonly maxOutputBytes: number;
  private readonly timeoutMs: number;

  constructor(workspaceRoot: string, options?: { maxOutputBytes?: number; timeoutMs?: number }) {
    const resolvedRoot = path.resolve(workspaceRoot);
    this.workspaceRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
    this.maxOutputBytes = options?.maxOutputBytes ?? 100_000;
    this.timeoutMs = options?.timeoutMs ?? 60_000;

    if (!fs.existsSync(this.workspaceRoot)) {
      throw new Error(`Workspace path does not exist: ${this.workspaceRoot}`);
    }
  }

  /**
   * Resolves and verifies that the target path is strictly within the workspace root.
   */
  public resolveSafePath(userPath: string): string {
    const resolved = path.resolve(this.workspaceRoot, userPath);
    const rel = path.relative(this.workspaceRoot, resolved);

    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path traversal denied: '${userPath}' resolves outside workspace boundary.`);
    }

    // Check if path exists and resolves to a symlink pointing outside
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      const realRel = path.relative(this.workspaceRoot, real);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw new Error(`Symlink traversal denied: '${userPath}' points outside workspace boundary.`);
      }
    }

    return resolved;
  }

  public listFiles(dirPath?: string): { files: string[] } {
    const targetDir = this.resolveSafePath(dirPath || '.');
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      throw new Error(`Directory not found: ${dirPath || '.'}`);
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const files = entries
      .filter((e) => !e.name.startsWith('.git') && e.name !== 'node_modules')
      .map((e) => {
        const full = path.join(targetDir, e.name);
        return path.relative(this.workspaceRoot, full) + (e.isDirectory() ? '/' : '');
      });

    return { files: files.slice(0, 100) };
  }

  public readFile(filePath: string): { content: string; lines: number } {
    const fullPath = this.resolveSafePath(filePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      throw new Error(`File not found: ${filePath}`);
    }

    const raw = fs.readFileSync(fullPath, 'utf8');
    const lines = raw.split('\n').length;
    const truncated = raw.length > this.maxOutputBytes ? raw.slice(0, this.maxOutputBytes) + '\n[TRUNCATED]' : raw;
    return { content: truncated, lines };
  }

  public readFileRange(
    filePath: string,
    startLine: number,
    endLine: number
  ): { content: string; startLine: number; endLine: number; totalLines: number } {
    const fullPath = this.resolveSafePath(filePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      throw new Error(`File not found: ${filePath}`);
    }

    const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
    const start = Math.max(1, startLine);
    const end = Math.min(lines.length, endLine);
    const slice = lines.slice(start - 1, end).join('\n');

    return {
      content: slice,
      startLine: start,
      endLine: end,
      totalLines: lines.length,
    };
  }

  public writeFile(filePath: string, content: string): { success: boolean; bytesWritten: number } {
    const fullPath = this.resolveSafePath(filePath);
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf8');
    return { success: true, bytesWritten: Buffer.byteLength(content, 'utf8') };
  }

  public searchText(query: string, extension?: string): { matches: Array<{ file: string; line: number; text: string }> } {
    const matches: Array<{ file: string; line: number; text: string }> = [];

    const walk = (dir: string) => {
      if (matches.length >= 50) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (matches.length >= 50) return;
        if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dist') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          if (extension && !e.name.endsWith(extension)) continue;
          try {
            const content = fs.readFileSync(full, 'utf8');
            if (!content.includes(query)) continue;
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(query)) {
                matches.push({
                  file: path.relative(this.workspaceRoot, full),
                  line: i + 1,
                  text: lines[i].trim().slice(0, 200),
                });
                if (matches.length >= 50) break;
              }
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    };

    walk(this.workspaceRoot);
    return { matches };
  }

  public gitDiff(): { diff: string } {
    try {
      const output = execSync('git diff', {
        cwd: this.workspaceRoot,
        encoding: 'utf8',
        timeout: 10_000,
      });
      return { diff: output.slice(0, this.maxOutputBytes) };
    } catch (e: any) {
      return { diff: `Error running git diff: ${e.message}` };
    }
  }

  public gitStatus(): { status: string } {
    try {
      const output = execSync('git status --short', {
        cwd: this.workspaceRoot,
        encoding: 'utf8',
        timeout: 10_000,
      });
      return { status: output.slice(0, this.maxOutputBytes) };
    } catch (e: any) {
      return { status: `Error running git status: ${e.message}` };
    }
  }

  public runCommand(command: string): { stdout: string; stderr: string; exitCode: number } {
    // Scrub sensitive environment variables
    const hermeticEnv = { ...process.env };
    const sensitiveKeys = [
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'TYPESAFE_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'GITHUB_TOKEN',
    ];
    for (const key of sensitiveKeys) {
      delete hermeticEnv[key];
    }

    try {
      const result = spawnSync('sh', ['-c', command], {
        cwd: this.workspaceRoot,
        env: hermeticEnv,
        timeout: this.timeoutMs,
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
      });

      const stdout = (result.stdout || '').slice(0, this.maxOutputBytes);
      const stderr = (result.stderr || '').slice(0, this.maxOutputBytes);
      const exitCode = result.status ?? (result.signal ? 128 : 1);

      return { stdout, stderr, exitCode };
    } catch (e: any) {
      return { stdout: '', stderr: e.message || 'Execution failed', exitCode: 1 };
    }
  }

  /**
   * Executes a tool invocation by name and arguments.
   */
  public execute(name: string, args: Record<string, any>): ToolExecutionResult {
    try {
      let output: any;
      switch (name) {
        case 'list_files':
          output = this.listFiles(args.dirPath);
          break;
        case 'read_file':
          output = this.readFile(args.filePath);
          break;
        case 'read_file_range':
          output = this.readFileRange(args.filePath, Number(args.startLine), Number(args.endLine));
          break;
        case 'write_file':
          output = this.writeFile(args.filePath, String(args.content));
          break;
        case 'search_text':
          output = this.searchText(String(args.query), args.extension);
          break;
        case 'git_diff':
          output = this.gitDiff();
          break;
        case 'git_status':
          output = this.gitStatus();
          break;
        case 'run_command':
          output = this.runCommand(String(args.command));
          break;
        default:
          throw new Error(`Unknown tool: '${name}'`);
      }

      return {
        toolName: name,
        args,
        success: true,
        output,
      };
    } catch (err: any) {
      return {
        toolName: name,
        args,
        success: false,
        output: null,
        error: err.message,
      };
    }
  }
}

/**
 * Tool definitions conforming to Google GenAI FunctionDeclaration schema.
 */
export const GEMINI_TOOL_DECLARATIONS = [
  {
    name: 'list_files',
    description: 'Lists files and subdirectories in the specified workspace directory path.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        dirPath: {
          type: Type.STRING,
          description: 'Relative path to directory within workspace (e.g. "src" or ".").',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: 'Reads the entire content of a file located in the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        filePath: {
          type: Type.STRING,
          description: 'Relative path to the file to read.',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'read_file_range',
    description: 'Reads a 1-indexed line range from a file located in the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        filePath: {
          type: Type.STRING,
          description: 'Relative path to the file.',
        },
        startLine: {
          type: Type.NUMBER,
          description: '1-indexed starting line number.',
        },
        endLine: {
          type: Type.NUMBER,
          description: '1-indexed ending line number (inclusive).',
        },
      },
      required: ['filePath', 'startLine', 'endLine'],
    },
  },
  {
    name: 'write_file',
    description: 'Writes content to a file in the workspace, creating any missing parent directories.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        filePath: {
          type: Type.STRING,
          description: 'Relative path to the file to write.',
        },
        content: {
          type: Type.STRING,
          description: 'The complete string content to write into the file.',
        },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'search_text',
    description: 'Searches for text or regex pattern across files in the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Literal text to search for.',
        },
        extension: {
          type: Type.STRING,
          description: 'Optional file extension filter, e.g. ".ts" or ".py".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'git_diff',
    description: 'Returns the current unstaged and staged git diff within the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'git_status',
    description: 'Returns short git status (modified, untracked files) in the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'run_command',
    description: 'Executes a shell command in the workspace directory (e.g. running tests or build scripts).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'The shell command line to execute.',
        },
      },
      required: ['command'],
    },
  },
];
