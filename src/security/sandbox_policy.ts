export interface SandboxPolicy {
  allowNetworkAccess: boolean;
  allowArbitraryScripts: boolean;
  allowedCommands: string[];
  isCommandAllowed(commandLine: string): { allowed: boolean; reason?: string };
}

export class DefaultSandboxPolicy implements SandboxPolicy {
  public readonly allowNetworkAccess: boolean;
  public readonly allowArbitraryScripts: boolean;
  public readonly allowedCommands: string[];

  constructor(options: {
    allowNetworkAccess?: boolean;
    allowArbitraryScripts?: boolean;
    allowedCommands?: string[];
  } = {}) {
    this.allowNetworkAccess = options.allowNetworkAccess ?? false;
    this.allowArbitraryScripts = options.allowArbitraryScripts ?? false;
    this.allowedCommands = options.allowedCommands ?? [
      'git',
      'node',
      'scip',
      'tree-sitter',
    ];
  }

  public isCommandAllowed(commandLine: string): { allowed: boolean; reason?: string } {
    const trimmed = commandLine.trim();
    if (!trimmed) {
      return { allowed: false, reason: 'Empty command' };
    }

    // Check for risky patterns
    if (!this.allowArbitraryScripts) {
      if (
        trimmed.includes('npm install') ||
        trimmed.includes('pip install') ||
        trimmed.includes('curl ') ||
        trimmed.includes('wget ') ||
        trimmed.includes('sh ') ||
        trimmed.includes('bash ') ||
        trimmed.includes('.sh')
      ) {
        return {
          allowed: false,
          reason: 'Arbitrary install scripts or shell hooks are disallowed in indexing sandbox (Section 70)',
        };
      }
    }

    const firstWord = trimmed.split(/\s+/)[0];
    const isAllowedCmd = this.allowedCommands.includes(firstWord);
    if (!isAllowedCmd) {
      return {
        allowed: false,
        reason: `Command "${firstWord}" is not in sandbox allowedCommands allowlist`,
      };
    }

    return { allowed: true };
  }
}
