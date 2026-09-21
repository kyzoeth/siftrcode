/**
 * SiftrCode V2 - Tokenizer Registry & Precise Token Estimation
 * Distinguishes exact tokenizers, calibrated model-specific estimators,
 * and conservative upper-bound fallbacks for unknown models (Closure PR 0.5).
 */

import { AgentEnvironment } from '../agents/agent_environment';

export type TokenEstimationMethod =
  | 'EXACT_TOKENIZER'
  | 'CALIBRATED_ESTIMATE'
  | 'CONSERVATIVE_FALLBACK';

export interface TokenEstimate {
  tokens: number;
  method: TokenEstimationMethod;
  safetyMargin: number;
  modelUsed?: string;
}

export interface TokenizerRegistry {
  estimate(text: string, environment?: AgentEnvironment): TokenEstimate;
  registerTokenizer(modelPattern: string, tokenizer: (text: string) => number): void;
}

export class DefaultTokenizerRegistry implements TokenizerRegistry {
  private exactTokenizers: Map<string, (text: string) => number> = new Map();

  private static instance?: DefaultTokenizerRegistry;

  public static getInstance(): DefaultTokenizerRegistry {
    if (!DefaultTokenizerRegistry.instance) {
      DefaultTokenizerRegistry.instance = new DefaultTokenizerRegistry();
    }
    return DefaultTokenizerRegistry.instance;
  }

  /**
   * Registers a user-supplied or library exact tokenizer function for a model prefix.
   */
  public registerTokenizer(modelPattern: string, tokenizer: (text: string) => number): void {
    this.exactTokenizers.set(modelPattern.toLowerCase(), tokenizer);
  }

  /**
   * Authoritatively estimates tokens for text given an agent environment.
   */
  public estimate(text: string, environment?: AgentEnvironment): TokenEstimate {
    if (!text || text.length === 0) {
      return {
        tokens: 0,
        method: 'CALIBRATED_ESTIMATE',
        safetyMargin: 1.0,
      };
    }

    const rawModel = (environment?.model || 'unknown').toLowerCase().trim();
    const provider = (environment?.agentProvider || 'unknown').toLowerCase().trim();

    // 1. Check for Exact Tokenizer registration
    for (const [pattern, tokenizerFn] of this.exactTokenizers.entries()) {
      if (rawModel.includes(pattern) || provider.includes(pattern)) {
        try {
          const exactCount = tokenizerFn(text);
          return {
            tokens: Math.max(1, exactCount),
            method: 'EXACT_TOKENIZER',
            safetyMargin: 1.0,
            modelUsed: rawModel,
          };
        } catch {
          // Fall through to calibrated or conservative fallback if registered tokenizer fails
        }
      }
    }

    // 2. Calibrated Estimation for Known Model Families
    if (this.isClaudeModel(rawModel, provider)) {
      // Claude BPE calibration: ~3.7 chars per code token, 1.15 safety margin
      const baseEstimate = this.estimateCalibratedChars(text, 3.7);
      return {
        tokens: Math.max(1, Math.ceil(baseEstimate * 1.15)),
        method: 'CALIBRATED_ESTIMATE',
        safetyMargin: 1.15,
        modelUsed: rawModel,
      };
    }

    if (this.isOpenAIModel(rawModel, provider)) {
      // OpenAI cl100k / o200k calibration: ~3.6 chars per code token, 1.15 safety margin
      const baseEstimate = this.estimateCalibratedChars(text, 3.6);
      return {
        tokens: Math.max(1, Math.ceil(baseEstimate * 1.15)),
        method: 'CALIBRATED_ESTIMATE',
        safetyMargin: 1.15,
        modelUsed: rawModel,
      };
    }

    if (this.isCursorModel(rawModel, provider)) {
      // Cursor / IDE integration calibration: ~3.7 chars per token, 1.15 safety margin
      const baseEstimate = this.estimateCalibratedChars(text, 3.7);
      return {
        tokens: Math.max(1, Math.ceil(baseEstimate * 1.15)),
        method: 'CALIBRATED_ESTIMATE',
        safetyMargin: 1.15,
        modelUsed: rawModel,
      };
    }

    // 3. Conservative Fallback for Unknown / Uncalibrated Models
    // For unknown models, use a conservative upper-bound approximation (~3.0 chars/token, safety margin 1.35)
    // so prompts never accidentally breach unverified model context limits.
    const fallbackBase = Math.ceil(text.length / 3.0);
    const conservativeTokens = Math.max(1, Math.ceil(fallbackBase * 1.35));

    return {
      tokens: conservativeTokens,
      method: 'CONSERVATIVE_FALLBACK',
      safetyMargin: 1.35,
      modelUsed: rawModel !== 'unknown' ? rawModel : undefined,
    };
  }

  private isClaudeModel(model: string, provider: string): boolean {
    return (
      model.includes('claude') ||
      model.includes('sonnet') ||
      model.includes('opus') ||
      model.includes('haiku') ||
      provider.includes('anthropic') ||
      provider.includes('claude')
    );
  }

  private isOpenAIModel(model: string, provider: string): boolean {
    return (
      model.includes('gpt-') ||
      model.includes('o1') ||
      model.includes('o3') ||
      model.includes('text-embedding-3') ||
      provider.includes('openai')
    );
  }

  private isCursorModel(model: string, provider: string): boolean {
    return (
      model.includes('cursor') ||
      provider.includes('cursor')
    );
  }

  /**
   * Helper that counts tokens based on character count and word/whitespace heuristics.
   */
  private estimateCalibratedChars(text: string, charsPerToken: number): number {
    return Math.ceil(text.length / charsPerToken);
  }
}

export const defaultTokenizerRegistry = DefaultTokenizerRegistry.getInstance();
