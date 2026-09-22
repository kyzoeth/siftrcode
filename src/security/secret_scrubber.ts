/**
 * SiftrCode V2 - Secret & Credential Filtering (Phase 20S)
 *
 * Scans and redacts credentials, access tokens, auth headers, and secrets
 * before telemetry persistence, preventing sensitive material from leaking into
 * episode trajectories or training artifacts.
 */

const SECRET_PATTERNS: RegExp[] = [
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9_\-\.]{8,}/gi,
  // OpenAI API keys
  /sk-[A-Za-z0-9_\-]{20,}/gi,
  // Anthropic API keys
  /sk-ant-[A-Za-z0-9_\-]{20,}/gi,
  // Google / Gemini API keys
  /AIza[0-9A-Za-z-_]{35}/g,
  // GitHub Personal Access Tokens (classic and fine-grained)
  /gh[pousr]_[A-Za-z0-9_]{36,}/gi,
  /github_pat_[A-Za-z0-9_]{82}/gi,
  // AWS Access Key ID
  /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
  // AWS Secret Access Key indicator
  /aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}/gi,
  // Slack Tokens
  /xox[baprs]-[A-Za-z0-9_\-]{10,}/gi,
  // Private keys (RSA, EC, OpenSSH, etc.)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Password parameters in URLs / connection strings
  /([?&;](?:password|passwd|pwd|secret|api_key|token)=)[^&;\s]+/gi,
  // Authorization headers
  /(["']?Authorization["']?\s*:\s*["'])(?:Bearer\s+|Basic\s+)?[^"'\s]+(["'])/gi,
  // Generic password assignments in config or JSON
  /(["']?(?:password|client_secret|access_token|secret_key)["']?\s*[:=]\s*["'])[^"'\s]{4,}(["'])/gi,
];

const ALLOWED_METADATA_KEYS = new Set([
  'command',
  'exitCode',
  'testCount',
  'passedCount',
  'failedCount',
  'durationMs',
  'toolName',
  'caller',
  'query',
  'lineCount',
  'fileSize',
  'language',
  'unitKind',
  'resolution',
  'rank',
  'status',
  'targetPath',
  'relativeFilePath',
]);

/**
 * Redacts secret patterns from a string.
 */
export function scrubSecrets(input: string): string {
  if (!input || typeof input !== 'string') {
    return input;
  }
  let result = input;
  // Connection strings with user:password@host
  result = result.replace(/(:\/\/[^/:\s]+:)[^@\s]+(@)/gi, '$1[REDACTED_SECRET]$2');

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.startsWith('Bearer ')) {
        return 'Bearer [REDACTED_SECRET]';
      }
      return '[REDACTED_SECRET]';
    });
  }
  return result;
}

/**
 * Recursively redacts secrets in an arbitrary object, dictionary, or array.
 * Rejects shell environment dumps or unauthorized dictionary expansions.
 */
export function scrubSecretObject<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj === 'string') {
    return scrubSecrets(obj) as unknown as T;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => scrubSecretObject(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      // Block shell environment dumps or sensitive key names completely
      if (
        lowerKey.includes('secret') ||
        lowerKey.includes('password') ||
        lowerKey.includes('token') ||
        lowerKey.includes('auth') ||
        lowerKey.includes('api_key') ||
        lowerKey.includes('credential') ||
        lowerKey.includes('private_key')
      ) {
        scrubbed[key] = '[REDACTED_SECRET]';
      } else if (typeof value === 'string') {
        scrubbed[key] = scrubSecrets(value);
      } else if (typeof value === 'object' && value !== null) {
        scrubbed[key] = scrubSecretObject(value);
      } else {
        scrubbed[key] = value;
      }
    }
    return scrubbed as T;
  }
  return obj;
}
