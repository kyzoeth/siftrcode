export interface SecretMatch {
  rule: string;
  match: string;
  startIndex: number;
  endIndex: number;
}

export interface SecretDetector {
  detectSecrets(text: string): SecretMatch[];
  hasSecrets(text: string): boolean;
  redactSecrets(text: string): string;
}

const COMMON_SECRET_PATTERNS: Array<{ rule: string; regex: RegExp }> = [
  // Private keys
  { rule: 'private_key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  // AWS Access Key ID
  { rule: 'aws_access_key', regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g },
  // AWS Secret Access Key
  { rule: 'aws_secret_key', regex: /(?:aws_secret_access_key|aws_secret_key|secret_key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi },
  // Generic Bearer / API Token
  { rule: 'generic_api_key', regex: /(?:api_key|apikey|api_token|auth_token|secret_token)\s*[:=]\s*["']?([A-Za-z0-9_-]{20,80})["']?/gi },
  // GitHub Personal Access Token
  { rule: 'github_pat', regex: /gh[pousr]_[A-Za-z0-9_]{36,255}/g },
  // Stripe API Key
  { rule: 'stripe_key', regex: /(?:sk|pk)_(?:test|live)_[0-9a-zA-Z]{24,99}/g },
  // OpenAI / LLM API Key
  { rule: 'openai_key', regex: /sk-[a-zA-Z0-9_-]{32,80}/g },
];

export class DefaultSecretDetector implements SecretDetector {
  public detectSecrets(text: string): SecretMatch[] {
    const matches: SecretMatch[] = [];

    for (const pattern of COMMON_SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.regex.exec(text)) !== null) {
        matches.push({
          rule: pattern.rule,
          match: m[0],
          startIndex: m.index,
          endIndex: m.index + m[0].length,
        });
      }
    }

    return matches;
  }

  public hasSecrets(text: string): boolean {
    return this.detectSecrets(text).length > 0;
  }

  public redactSecrets(text: string): string {
    let result = text;
    for (const pattern of COMMON_SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      result = result.replace(pattern.regex, '[REDACTED_SECRET]');
    }
    return result;
  }
}
