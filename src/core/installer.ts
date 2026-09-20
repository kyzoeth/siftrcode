import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface InstallerOptions {
  cursor?: boolean;
  claude?: boolean;
  targetDir?: string;
}

export interface InitResult {
  configsUpdated: string[];
  rulesCreated: string[];
  targetAgents: ('cursor' | 'claude')[];
}

export function runInstaller(options: InstallerOptions = {}): InitResult {
  const home = os.homedir();
  const cwd = options.targetDir ? path.resolve(options.targetDir) : process.cwd();
  const configsUpdated: string[] = [];
  const rulesCreated: string[] = [];

  const shouldInstallCursor = options.cursor || (!options.cursor && !options.claude);
  const shouldInstallClaude = options.claude || (!options.cursor && !options.claude);

  const targetAgents: ('cursor' | 'claude')[] = [];
  if (shouldInstallCursor) targetAgents.push('cursor');
  if (shouldInstallClaude) targetAgents.push('claude');

  const siftrMcpConfig = {
    command: 'npx',
    args: ['-y', 'siftrcode', 'mcp']
  };

  // Helper to safely merge MCP config into a JSON file
  function upsertMcpConfig(filePath: string, label: string) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let config: any = { mcpServers: {} };
      if (fs.existsSync(filePath)) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          config = JSON.parse(raw);
        } catch {
          config = { mcpServers: {} };
        }
      }

      if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        config.mcpServers = {};
      }

      config.mcpServers.siftrcode = siftrMcpConfig;
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      configsUpdated.push(`${label} (${filePath})`);
    } catch {
      // Ignore filesystem permission issues
    }
  }

  // ==========================================
  // 1. CLAUDE CODE & CLAUDE DESKTOP TARGETS
  // ==========================================
  if (shouldInstallClaude) {
    // Global Claude Code CLI config (~/.claude.json)
    const claudeCliConfigPath = path.join(home, '.claude.json');
    upsertMcpConfig(claudeCliConfigPath, 'Claude Code CLI Global');

    // Global Claude settings (~/.claude/settings.json)
    const claudeSettingsDir = path.join(home, '.claude');
    if (fs.existsSync(claudeSettingsDir)) {
      upsertMcpConfig(path.join(claudeSettingsDir, 'settings.json'), 'Claude Settings');
    }

    // Claude Desktop configs
    let claudeDesktopPath = '';
    if (process.platform === 'darwin') {
      claudeDesktopPath = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    } else if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      claudeDesktopPath = path.join(appData, 'Claude', 'claude_desktop_config.json');
    } else {
      claudeDesktopPath = path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    }

    if (fs.existsSync(path.dirname(claudeDesktopPath))) {
      upsertMcpConfig(claudeDesktopPath, 'Claude Desktop');
    }

    // Workspace-level Claude Code MCP configuration (.mcp.json)
    const localClaudeMcpPath = path.join(cwd, '.mcp.json');
    upsertMcpConfig(localClaudeMcpPath, 'Workspace Claude Code MCP (.mcp.json)');

    // Claude Code custom slash command (.claude/commands/siftr.md)
    const claudeCommandsDir = path.join(cwd, '.claude', 'commands');
    const claudeSiftrCmdPath = path.join(claudeCommandsDir, 'siftr.md');
    try {
      if (!fs.existsSync(claudeCommandsDir)) {
        fs.mkdirSync(claudeCommandsDir, { recursive: true });
      }
      if (!fs.existsSync(claudeSiftrCmdPath)) {
        const siftrCmdContent = `# SiftrCode Context Optimization Slash Command (/siftr)

When this command is invoked:
1. If a task description or prompt is provided (\`$ARGUMENTS\`):
   - Call the MCP tool \`siftr_context\` with the prompt parameter set to \`$ARGUMENTS\` to generate an outcome-aware optimized context bundle.
2. If a single file path is provided:
   - Call the MCP tool \`siftr_skeleton\` with the file path to extract its public interface signatures, types, and exported symbols.
3. If a directory path is provided:
   - Call the MCP tool \`siftr_pack\` with the focus parameter set to \`$ARGUMENTS\` to generate an AST-pruned context pack.
4. If no argument is provided:
   - Call the MCP tool \`siftr_audit\` to scan the repository for context bloat, dead weight, and estimate potential token savings.
5. Present the synthesized interface contract concisely to the user, highlighting key exported interfaces, methods, and types.
`;
        fs.writeFileSync(claudeSiftrCmdPath, siftrCmdContent, 'utf-8');
        rulesCreated.push('.claude/commands/siftr.md');
      }
    } catch {}

    // Claude Code project guidelines (CLAUDE.md)
    const claudeRulesPath = path.join(cwd, 'CLAUDE.md');
    try {
      if (!fs.existsSync(claudeRulesPath)) {
        const claudeMdContent = `# Claude Code Guidelines for SiftrCode

## Context Optimization Rules
When exploring, refactoring, or navigating code in this repository:
- **Use SiftrCode MCP Tools**: Before loading large, full-text implementation files into the context window, call \`siftr_context\`, \`siftr_skeleton\`, or \`siftr_pack\`.
- **Task Context First**: Call \`siftr_context\` with the task prompt to get full implementations for edit targets and AST interface skeletons for dependencies.
- **Interface First**: SiftrCode condenses internal method bodies and imperative routines while preserving 100% of interfaces, types, and exported signatures. This preserves reasoning depth and prevents context window exhaustion.
- **Commands**:
  - \`siftr_context\`: Generates outcome-aware context bundle for the active task.
  - \`/siftr <file>\`: Prunes a single file down to its type signatures.
  - \`/siftr <dir>\`: Packs a directory into an AST interface bundle.
  - \`siftr_audit\`: Evaluates repository bloat and potential token savings.
`;
        fs.writeFileSync(claudeRulesPath, claudeMdContent, 'utf-8');
        rulesCreated.push('CLAUDE.md');
      }
    } catch {}
  }


  // ==========================================
  // 2. CURSOR IDE TARGETS
  // ==========================================
  if (shouldInstallCursor) {
    // Global Cursor MCP configuration (~/.cursor/mcp.json)
    const cursorGlobalDir = path.join(home, '.cursor');
    if (fs.existsSync(cursorGlobalDir)) {
      upsertMcpConfig(path.join(cursorGlobalDir, 'mcp.json'), 'Cursor MCP (Global)');
    }

    // Workspace-level Cursor MCP configuration (.cursor/mcp.json)
    const localCursorConfig = path.join(cwd, '.cursor', 'mcp.json');
    upsertMcpConfig(localCursorConfig, 'Workspace Cursor MCP (.cursor/mcp.json)');

    // Cursor universal rules (.cursorrules)
    const cursorRulesPath = path.join(cwd, '.cursorrules');
    try {
      if (!fs.existsSync(cursorRulesPath)) {
        const promptRule = `# SiftrCode Agent Prompt Optimization Rule
When investigating, searching, or refactoring this codebase:
- Call \`siftr_context\` with the task prompt to produce an outcome-aware context bundle with full edit targets and AST dependency skeletons.
- Prefer using SiftrCode MCP tools ('siftr_context', 'siftr_skeleton', or 'siftr_pack') before loading full raw source files into context.
- SiftrCode condenses method bodies into clean interface contracts, slashing token overhead by 80-90% and preserving 100% of types and signatures.
`;
        fs.writeFileSync(cursorRulesPath, promptRule, 'utf-8');
        rulesCreated.push('.cursorrules');
      }
    } catch {}

    // Cursor modern rule format (.cursor/rules/siftrcode.mdc for Cursor v0.45+)
    const cursorMdcDir = path.join(cwd, '.cursor', 'rules');
    const cursorMdcPath = path.join(cursorMdcDir, 'siftrcode.mdc');
    try {
      if (!fs.existsSync(cursorMdcDir)) {
        fs.mkdirSync(cursorMdcDir, { recursive: true });
      }
      if (!fs.existsSync(cursorMdcPath)) {
        const cursorMdcContent = `---
description: SiftrCode interface skeleton and context pruner for Cursor Composer
globs: *
alwaysApply: true
---

# SiftrCode Rules for Cursor
- When working on a task, call \`siftr_context\` with your prompt to optimize context automatically.
- When navigating large modules or exploring dependencies, invoke \`siftr_skeleton\` to inspect exported interfaces and types without loading bloated function bodies.
- For multi-file refactoring or broad task planning, call \`siftr_pack\` with a focus prompt to build a condensed AST context pack.
- This preserves Cursor's context window, eliminates attention dilution, and accelerates agent responses.
`;
        fs.writeFileSync(cursorMdcPath, cursorMdcContent, 'utf-8');

        rulesCreated.push('.cursor/rules/siftrcode.mdc');
      }
    } catch {}
  }

  return {
    configsUpdated,
    rulesCreated,
    targetAgents
  };
}
