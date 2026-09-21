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
  private taskVerifierCommand?: string;

  constructor(workspaceRoot: string, options?: { maxOutputBytes?: number; timeoutMs?: number; taskVerifierCommand?: string }) {
    const resolvedRoot = path.resolve(workspaceRoot);
    this.workspaceRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
    this.maxOutputBytes = options?.maxOutputBytes ?? 100_000;
    this.timeoutMs = options?.timeoutMs ?? 60_000;
    this.taskVerifierCommand = options?.taskVerifierCommand;

    if (!fs.existsSync(this.workspaceRoot)) {
      throw new Error(`Workspace path does not exist: ${this.workspaceRoot}`);
    }
  }

  public setTaskVerifierCommand(cmd?: string): void {
    this.taskVerifierCommand = cmd;
  }

  public runTaskVerifier(): { stdout: string; stderr: string; exitCode: number } {
    if (!this.taskVerifierCommand) {
      return { stdout: '', stderr: 'No task verifier configured for this task.', exitCode: 1 };
    }
    return this.runCommand(this.taskVerifierCommand);
  }

  public runTests(): { stdout: string; stderr: string; exitCode: number } {
    if (fs.existsSync(path.join(this.workspaceRoot, 'package.json'))) {
      return this.runCommand('npm test');
    }
    if (fs.existsSync(path.join(this.workspaceRoot, 'venv/bin/pytest'))) {
      return this.runCommand('./venv/bin/pytest -q');
    }
    return this.runCommand('pytest -q');
  }

  public runTypecheck(): { stdout: string; stderr: string; exitCode: number } {
    if (fs.existsSync(path.join(this.workspaceRoot, 'tsconfig.json'))) {
      return this.runCommand('npx tsc --noEmit');
    }
    if (fs.existsSync(path.join(this.workspaceRoot, 'venv/bin/mypy'))) {
      return this.runCommand('./venv/bin/mypy .');
    }
    return { stdout: 'Typecheck not configured for this project.', stderr: '', exitCode: 0 };
  }

  public runBuild(): { stdout: string; stderr: string; exitCode: number } {
    if (fs.existsSync(path.join(this.workspaceRoot, 'package.json'))) {
      return this.runCommand('npm run build');
    }
    return { stdout: 'Build not required for this project.', stderr: '', exitCode: 0 };
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
        // Allow legitimate build/dependency symlinks placed in the root (e.g. node_modules, venv)
        const isSanctionedSymlink =
          resolved.includes('/node_modules') ||
          resolved.includes('/venv') ||
          resolved.endsWith('/node_modules') ||
          resolved.endsWith('/venv');
        if (!isSanctionedSymlink) {
          throw new Error(`Symlink traversal denied: '${userPath}' points outside workspace boundary.`);
        }
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

    // Prevent overwriting files inside shared dependency directories
    if (
      fullPath.includes('/node_modules/') ||
      fullPath.endsWith('/node_modules') ||
      fullPath.includes('/venv/') ||
      fullPath.endsWith('/venv')
    ) {
      throw new Error(`Cannot write to shared dependency directory: '${filePath}'`);
    }

    // Prevent writing through a symlink pointing outside (check target and all existing ancestors)
    let checkDir: string = fullPath;
    while (checkDir && checkDir !== this.workspaceRoot && checkDir !== path.dirname(checkDir)) {
      if (fs.existsSync(checkDir)) {
        const lstat = fs.lstatSync(checkDir);
        if (lstat.isSymbolicLink()) {
          const real = fs.realpathSync(checkDir);
          const realRel = path.relative(this.workspaceRoot, real);
          if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
            throw new Error(`Cannot write through symlink pointing outside workspace: '${filePath}'`);
          }
        }
      }
      checkDir = path.dirname(checkDir);
    }

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

  public static readonly ENV_ALLOWLIST = new Set([
    'PATH',
    'HOME',
    'TMPDIR',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'NODE_PATH',
    'PYTHONPATH',
    'VIRTUAL_ENV',
    'CI',
    'NODE_ENV',
  ]);

  public runCommand(command: string): { stdout: string; stderr: string; exitCode: number } {
    // Environment allowlist: ONLY copy explicitly permitted system variables
    const allowlistedEnv: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      if (GeminiWorkspaceSandbox.ENV_ALLOWLIST.has(key) && process.env[key] !== undefined) {
        allowlistedEnv[key] = process.env[key]!;
      }
    }

    // Strict command inspection: reject prohibited traversal, sensitive file access, and network
    const forbiddenPatterns = [
      /\.\.\//, // directory traversal
      /\/etc\/passwd/, // system sensitive file
      /\/etc\/shadow/,
      /\$HOME/, // host home escape
      /~[\/\s]/,
      /\b(curl|wget|nc|netcat|ssh|scp|telnet|ping)\b/i, // network access
    ];

    for (const pattern of forbiddenPatterns) {
      if (pattern.test(command)) {
        return {
          stdout: '',
          stderr: `SecurityError: command execution rejected due to prohibited pattern: ${pattern}`,
          exitCode: 126,
        };
      }
    }

    // Isolate HOME and TMPDIR to workspace boundary to prevent accessing host ~/.ssh or ~/.config
    allowlistedEnv['HOME'] = this.workspaceRoot;
    allowlistedEnv['TMPDIR'] = path.join(this.workspaceRoot, '.tmp');
    // Disable outbound network by routing through non-existent loopback proxy
    allowlistedEnv['http_proxy'] = 'http://127.0.0.1:0';
    allowlistedEnv['https_proxy'] = 'http://127.0.0.1:0';
    allowlistedEnv['all_proxy'] = 'http://127.0.0.1:0';

    // Enhance PATH with workspace binaries if present
    const nodeBin = path.join(this.workspaceRoot, 'node_modules/.bin');
    const venvBin = path.join(this.workspaceRoot, 'venv/bin');
    let enhancedPath = allowlistedEnv['PATH'] || process.env.PATH || '';
    if (fs.existsSync(nodeBin)) {
      enhancedPath = `${nodeBin}:${enhancedPath}`;
    }
    if (fs.existsSync(venvBin)) {
      enhancedPath = `${venvBin}:${enhancedPath}`;
      allowlistedEnv['VIRTUAL_ENV'] = path.join(this.workspaceRoot, 'venv');
    }
    allowlistedEnv['PATH'] = enhancedPath;

    try {
      const result = spawnSync('sh', ['-c', command], {
        cwd: this.workspaceRoot,
        env: allowlistedEnv,
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
        case 'run_task_verifier':
          output = this.runTaskVerifier();
          break;
        case 'run_tests':
          output = this.runTests();
          break;
        case 'run_typecheck':
          output = this.runTypecheck();
          break;
        case 'run_build':
          output = this.runBuild();
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
    name: 'run_task_verifier',
    description: 'Runs the task-specific verification test script for this episode to check if requirements are met.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'run_tests',
    description: 'Runs the test suite for the project (e.g. npm test or pytest).',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'run_typecheck',
    description: 'Runs TypeScript or Python typechecker on the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'run_build',
    description: 'Executes the project build command (e.g. npm run build) to compile sources.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'run_command',
    description: 'Executes a sandboxed shell command in the workspace directory.',
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
