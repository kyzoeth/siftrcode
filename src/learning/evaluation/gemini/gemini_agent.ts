/**
 * Gemini Coding Agent Harness
 *
 * Implements the autonomous pair-programming loop with local tool execution,
 * token accounting, rate-limit retry resilience, and verifier integration.
 */

import { GoogleGenAI } from '@google/genai';
import { GeminiAgentConfig, resolveGeminiConfig } from './gemini_config';
import {
  GEMINI_TOOL_DECLARATIONS,
  GeminiWorkspaceSandbox,
  ToolExecutionResult,
} from './gemini_tools';
import { calculateModelCostUSD } from '../provider_pricing';

export interface GeminiAgentRunResult {
  completed: boolean;
  turns: number;
  toolCallsCount: number;
  finalText: string;
  totalPromptTokens: number;
  totalCandidateTokens: number;
  totalThoughtsTokens: number;
  totalTokens: number;
  providerCostUSD: number;
  wallClockLatencyMs: number;
  toolHistory: ToolExecutionResult[];
  verifiedSuccess: boolean | null;
  verifierOutput?: string;
  error?: string;
}

export class GeminiCodingAgent {
  private readonly config: GeminiAgentConfig;
  private readonly workspacePath: string;
  private readonly sandbox: GeminiWorkspaceSandbox;
  private readonly client: any;

  constructor(
    workspacePath: string,
    options?: {
      configOverrides?: Partial<GeminiAgentConfig>;
      clientOverride?: any;
    }
  ) {
    this.workspacePath = workspacePath;
    this.config = resolveGeminiConfig(options?.configOverrides);
    this.sandbox = new GeminiWorkspaceSandbox(this.workspacePath, {
      maxOutputBytes: this.config.maxOutputBytes,
      timeoutMs: this.config.toolTimeoutMs,
    });

    if (options?.clientOverride) {
      this.client = options.clientOverride;
    } else {
      if (!this.config.apiKey) {
        throw new Error('Missing GEMINI_API_KEY. Please provide an API key or a mock client.');
      }
      this.client = new GoogleGenAI({ apiKey: this.config.apiKey });
    }
  }

  /**
   * Executes a task in the sandboxed workspace through the multi-turn agent loop.
   */
  public async runTask(
    taskPrompt: string,
    initialContext: string,
    options?: {
      taskVerifierCommand?: string;
    }
  ): Promise<GeminiAgentRunResult> {
    const startTime = Date.now();
    const toolHistory: ToolExecutionResult[] = [];

    let totalPromptTokens = 0;
    let totalCandidateTokens = 0;
    let totalThoughtsTokens = 0;
    let turns = 0;
    let toolCallsCount = 0;
    let finalText = '';
    let completed = false;
    let runError: string | undefined;

    const systemInstruction =
      'You are an expert autonomous software engineer. ' +
      'Solve the user task by inspecting files, making necessary code edits, running tests, and verifying correctness. ' +
      'Always verify your changes before finishing.';

    const userMessageContent =
      `<task_description>\n${taskPrompt}\n</task_description>\n\n` +
      `<initial_context>\n${initialContext || '(No initial context provided)'}\n</initial_context>\n\n` +
      'Please analyze the workspace, fix any issues or implement the requirements, and verify your changes.';

    const contents: any[] = [{ role: 'user', parts: [{ text: userMessageContent }] }];

    try {
      while (turns < this.config.maxTurns && !completed) {
        turns++;

        // Call Gemini model with exponential backoff on 429/503
        const response = await this.callWithRetry(async () => {
          return await this.client.models.generateContent({
            model: this.config.model,
            contents,
            config: {
              systemInstruction,
              tools: [{ functionDeclarations: GEMINI_TOOL_DECLARATIONS }],
              temperature: this.config.temperature,
            },
          });
        });

        // Tally token usage
        if (response.usageMetadata) {
          totalPromptTokens += response.usageMetadata.promptTokenCount ?? 0;
          totalCandidateTokens += response.usageMetadata.candidatesTokenCount ?? 0;
          totalThoughtsTokens += response.usageMetadata.thoughtsTokenCount ?? 0;
        }

        const candidate = response.candidates?.[0];
        if (candidate?.content) {
          contents.push(candidate.content);
        }

        const functionCalls = response.functionCalls;
        if (!functionCalls || functionCalls.length === 0) {
          // Model returned a text response without tool calls - finished
          finalText = response.text || '';
          completed = true;
          break;
        }

        // Execute function calls
        const functionResponseParts: any[] = [];
        for (const fc of functionCalls) {
          toolCallsCount++;
          const execResult = this.sandbox.execute(fc.name, fc.args || {});
          toolHistory.push(execResult);

          functionResponseParts.push({
            functionResponse: {
              name: fc.name,
              id: fc.id,
              response: {
                success: execResult.success,
                output: execResult.output,
                error: execResult.error,
              },
            },
          });
        }

        // In Google GenAI SDK, functionResponse parts are sent as role: 'user'
        contents.push({
          role: 'user',
          parts: functionResponseParts,
        });
      }
    } catch (err: any) {
      runError = err.message || String(err);
    }

    // Execute verifier command if supplied
    let verifiedSuccess: boolean | null = null;
    let verifierOutput: string | undefined;

    if (options?.taskVerifierCommand) {
      try {
        const verifierExec = this.sandbox.runCommand(options.taskVerifierCommand);
        verifiedSuccess = verifierExec.exitCode === 0;
        verifierOutput = `exitCode: ${verifierExec.exitCode}\nSTDOUT:\n${verifierExec.stdout}\nSTDERR:\n${verifierExec.stderr}`;
      } catch (verr: any) {
        verifiedSuccess = false;
        verifierOutput = `Verifier execution exception: ${verr.message}`;
      }
    }

    const wallClockLatencyMs = Date.now() - startTime;
    const totalTokens = totalPromptTokens + totalCandidateTokens + totalThoughtsTokens;
    const providerCostUSD = calculateModelCostUSD(
      this.config.model,
      totalPromptTokens,
      totalCandidateTokens + totalThoughtsTokens
    );

    return {
      completed,
      turns,
      toolCallsCount,
      finalText,
      totalPromptTokens,
      totalCandidateTokens,
      totalThoughtsTokens,
      totalTokens,
      providerCostUSD,
      wallClockLatencyMs,
      toolHistory,
      verifiedSuccess,
      verifierOutput,
      error: runError,
    };
  }

  private async callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        const msg = String(err.message || '');
        const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded');
        const isUnavailable = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand');

        if ((isRateLimit || isUnavailable) && attempt < this.config.maxRetries) {
          // Extract suggested retryDelay if present
          let delayMs = this.config.baseRetryDelayMs * Math.pow(2, attempt);
          const retryMatch = msg.match(/retry in ([0-9.]+)s/);
          if (retryMatch && retryMatch[1]) {
            delayMs = Math.max(delayMs, Math.ceil(parseFloat(retryMatch[1]) * 1000) + 500);
          }

          // Bound delay to max 30s
          delayMs = Math.min(delayMs, 30_000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        throw err;
      }
    }
    throw lastError;
  }
}
