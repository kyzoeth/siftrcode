/**
 * Gemini Agent Configuration & Environment Resolver
 *
 * Configures the Google Gemini model settings for coding-agent task evaluations.
 * Adheres strictly to security rules: never logs or leaks credentials.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BillingTier } from '../provider_pricing';

export interface GeminiAgentConfig {
  model: string;
  apiKey: string;
  temperature: number;
  maxTurns: number;
  toolTimeoutMs: number;
  maxOutputBytes: number;
  maxRetries: number;
  baseRetryDelayMs: number;
  billingTier?: BillingTier;
}

/**
 * Loads .env file if present in the workspace root without overwriting existing env.
 */
export function loadLocalEnvIfPresent(rootDir?: string): void {
  const root = rootDir || process.cwd();
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch {
    // Ignore read errors
  }
}

/**
 * Resolves the Gemini API key safely from environment.
 * Returns null if missing.
 */
export function resolveGeminiApiKey(): string | null {
  loadLocalEnvIfPresent();
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key || key.trim().length === 0) {
    return null;
  }
  return key.trim();
}

/**
 * Resolves full Gemini configuration with conservative, deterministic defaults.
 */
export function resolveGeminiConfig(overrides?: Partial<GeminiAgentConfig>): GeminiAgentConfig {
  const apiKey = overrides?.apiKey ?? resolveGeminiApiKey() ?? '';
  const model = overrides?.model ?? process.env.GEMINI_MODEL ?? 'gemini-3.6-flash';

  return {
    model,
    apiKey,
    temperature: overrides?.temperature ?? 0.0,
    maxTurns: overrides?.maxTurns ?? 15,
    toolTimeoutMs: overrides?.toolTimeoutMs ?? 60_000,
    maxOutputBytes: overrides?.maxOutputBytes ?? 100_000,
    maxRetries: overrides?.maxRetries ?? 3,
    baseRetryDelayMs: overrides?.baseRetryDelayMs ?? 2000,
    billingTier: overrides?.billingTier ?? (process.env.GEMINI_BILLING_TIER as BillingTier) ?? 'unknown',
  };
}
