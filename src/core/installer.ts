import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface InitResult {
  configsUpdated: string[];
  rulesCreated: string[];
}

export function runInstaller(): InitResult {
  const home = os.homedir();
  const configsUpdated: string[] = [];
  const rulesCreated: string[] = [];

  const siftrMcpConfig = {
    command: 'npx',
    args: ['-y', 'siftrcode', 'mcp']
  };

  // Potential MCP configuration targets across popular tools
  const potentialTargets: { name: string; path: string }[] = [];

  // Claude Desktop
  if (process.platform === 'darwin') {
    potentialTargets.push({
      name: 'Claude Desktop (macOS)',
      path: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    });
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    potentialTargets.push({
      name: 'Claude Desktop (Windows)',
      path: path.join(appData, 'Claude', 'claude_desktop_config.json')
    });
  } else {
    potentialTargets.push({
      name: 'Claude Desktop (Linux)',
      path: path.join(home, '.config', 'Claude', 'claude_desktop_config.json')
    });
  }

  // Cursor MCP configuration
  potentialTargets.push({
    name: 'Cursor MCP (Global)',
    path: path.join(home, '.cursor', 'mcp.json')
  });

  // Claude Code configuration
  potentialTargets.push({
    name: 'Claude Code Settings',
    path: path.join(home, '.claude', 'settings.json')
  });

  for (const target of potentialTargets) {
    try {
      const dir = path.dirname(target.path);
      // If the parent directory exists or if it's Claude Desktop / Cursor
      if (fs.existsSync(dir)) {
        let config: any = { mcpServers: {} };
        if (fs.existsSync(target.path)) {
          const raw = fs.readFileSync(target.path, 'utf-8');
          try {
            config = JSON.parse(raw);
          } catch {
            config = { mcpServers: {} };
          }
        }

        if (!config.mcpServers) {
          config.mcpServers = {};
        }

        config.mcpServers.siftrcode = siftrMcpConfig;
        fs.writeFileSync(target.path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        configsUpdated.push(`${target.name} (${target.path})`);
      }
    } catch {
      // Ignore permission or read errors on absent targets
    }
  }

  // Also configure local workspace .cursor/mcp.json if inside a workspace
  const localCursorDir = path.join(process.cwd(), '.cursor');
  const localCursorConfig = path.join(localCursorDir, 'mcp.json');
  try {
    if (!fs.existsSync(localCursorDir)) {
      fs.mkdirSync(localCursorDir, { recursive: true });
    }
    let localConfig: any = { mcpServers: {} };
    if (fs.existsSync(localCursorConfig)) {
      try {
        localConfig = JSON.parse(fs.readFileSync(localCursorConfig, 'utf-8'));
      } catch {}
    }
    if (!localConfig.mcpServers) localConfig.mcpServers = {};
    localConfig.mcpServers.siftrcode = siftrMcpConfig;
    fs.writeFileSync(localCursorConfig, JSON.stringify(localConfig, null, 2) + '\n', 'utf-8');
    configsUpdated.push(`Workspace Cursor MCP (.cursor/mcp.json)`);
  } catch {}

  // Configure local workspace .mcp.json for Claude Code
  const localClaudeMcpPath = path.join(process.cwd(), '.mcp.json');
  try {
    let claudeConfig: any = { mcpServers: {} };
    if (fs.existsSync(localClaudeMcpPath)) {
      try {
        claudeConfig = JSON.parse(fs.readFileSync(localClaudeMcpPath, 'utf-8'));
      } catch {}
    }
    if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};
    claudeConfig.mcpServers.siftrcode = siftrMcpConfig;
    fs.writeFileSync(localClaudeMcpPath, JSON.stringify(claudeConfig, null, 2) + '\n', 'utf-8');
    configsUpdated.push(`Workspace Claude Code MCP (.mcp.json)`);
  } catch {}

  // Generate Claude Code slash command: .claude/commands/siftr.md
  const claudeCommandsDir = path.join(process.cwd(), '.claude', 'commands');
  const claudeSiftrCmdPath = path.join(claudeCommandsDir, 'siftr.md');
  try {
    if (!fs.existsSync(claudeCommandsDir)) {
      fs.mkdirSync(claudeCommandsDir, { recursive: true });
    }
    if (!fs.existsSync(claudeSiftrCmdPath)) {
      const siftrCmdContent = `# SiftrCode AST Context Pruning Command

When this command is invoked:
1. If an argument (file path or directory) is provided (\`$ARGUMENTS\`):
   - For a single file: Call the MCP tool \`siftr_skeleton\` with the file's content and path to extract its public interface signatures, types, and exported symbols.
   - For a directory: Call the MCP tool \`siftr_pack\` with the focus parameter set to \`$ARGUMENTS\` to generate an AST-pruned context pack.
2. If no argument is provided:
   - Call the MCP tool \`siftr_audit\` to scan the repository for context bloat, dead weight, and estimate potential token savings.
3. Present the synthesized interface contract concisely to the user, highlighting key exported interfaces, methods, and types.
`;
      fs.writeFileSync(claudeSiftrCmdPath, siftrCmdContent, 'utf-8');
      rulesCreated.push('.claude/commands/siftr.md');
    }
  } catch {}

  // Generate .cursorrules in current repo for Cursor
  const promptRule = `# SiftrCode Agent Prompt Optimization Rule
When investigating or refactoring this codebase:
- Use the 'siftr_pack' or 'siftr_skeleton' MCP tools before reading large full source files.
- Stripping implementation bodies down to AST interface skeletons reduces context bloat by 85%+ and eliminates hallucination.
`;

  const cursorRulesPath = path.join(process.cwd(), '.cursorrules');
  if (!fs.existsSync(cursorRulesPath)) {
    fs.writeFileSync(cursorRulesPath, promptRule, 'utf-8');
    rulesCreated.push('.cursorrules');
  }

  // Generate CLAUDE.md in current repo for Claude Code
  const claudeRulesPath = path.join(process.cwd(), 'CLAUDE.md');
  if (!fs.existsSync(claudeRulesPath)) {
    const claudeMdContent = `# Claude Code Guidelines for SiftrCode

## Context Optimization Rules
When exploring, refactoring, or navigating code in this repository:
- **Use SiftrCode MCP Tools**: Before loading large, full-text implementation files into the context window, call \`siftr_skeleton\` or \`siftr_pack\`.
- **AST Interface First**: SiftrCode strips internal method bodies and imperative logic while preserving 100% of interfaces, types, and exported signatures. This preserves reasoning depth and prevents context window exhaustion.
- **Commands**:
  - \`/siftr <file>\`: Prunes a single file down to its type signatures.
  - \`/siftr <dir>\`: Packs a directory into an AST interface bundle.
  - \`siftr_audit\`: Evaluates repository bloat and potential token savings.
`;
    fs.writeFileSync(claudeRulesPath, claudeMdContent, 'utf-8');
    rulesCreated.push('CLAUDE.md');
  }

  return {
    configsUpdated,
    rulesCreated
  };
}
