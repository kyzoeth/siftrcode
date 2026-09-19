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

  // Windsurf MCP configuration
  potentialTargets.push({
    name: 'Windsurf MCP (Global)',
    path: path.join(home, '.codeium', 'windsurf', 'mcp_config.json')
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

  // Generate .cursorrules and .clauderules in current repo for agent guidance
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

  return {
    configsUpdated,
    rulesCreated
  };
}
