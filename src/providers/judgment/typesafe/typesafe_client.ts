/**
 * SiftrCode V2 - TypeSafe Client Abstraction (Milestone Part II Sections 1-4)
 * Decouples core Siftr from direct SDK instantiation and provides a test fake for deterministic evaluation.
 */

import { TypeSafeClient } from '@typesafe-ai/sdk';
import { JEV_QUESTIONS_V1, JevQuestionsType } from './jev_questions';

export const TYPESAFE_SDK_VERSION = '0.6.0';

export interface SystemOneEvaluationRequest {
  state: Record<string, any> | string;
  questions?: JevQuestionsType | Record<string, any>;
  model?: string;
}

export interface SystemOneEvaluationResponse {
  model: string;
  answers: {
    semanticRelevance?: { noul: number };
    implementationNeeded?: { noul: number };
    likelyEditTarget?: { noul: number };
    likelyRootCause?: { noul: number };
    [key: string]: any;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  requestId?: string;
}

export interface SystemOneClient {
  evaluate(request: SystemOneEvaluationRequest): Promise<SystemOneEvaluationResponse>;
}

export interface TypeSafeSystemOneClientOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  timeoutMs?: number;
  retry?: {
    maxRetries?: number;
    backoffInitialMs?: number;
    backoffMaxMs?: number;
    backoffJitter?: number;
    [key: string]: any;
  };
}

/**
 * Production client wrapping @typesafe-ai/sdk TypeSafeClient.
 */
export class TypeSafeSystemOneClient implements SystemOneClient {
  private client: TypeSafeClient;
  public readonly options: TypeSafeSystemOneClientOptions;

  constructor(options: TypeSafeSystemOneClientOptions = {}) {
    const apiKey = options.apiKey || process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
    if (!apiKey) {
      throw new Error('TYPESAFE_API_KEY or JEV_API_KEY is required to initialize TypeSafeSystemOneClient');
    }

    this.options = { ...options, apiKey };

    this.client = new TypeSafeClient({
      apiKey,
      baseURL: options.baseURL || process.env.TYPESAFE_BASE_URL,
      defaultModel: options.defaultModel || process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest',
      timeout: options.timeoutMs ?? 10000,
      retry: options.retry,
    });
  }

  public async evaluate(request: SystemOneEvaluationRequest): Promise<SystemOneEvaluationResponse> {
    const questions = request.questions || JEV_QUESTIONS_V1;
    const callPromise = this.client.systemOne({
      state: request.state,
      questions,
      model: request.model,
    });

    let res: any;
    let requestId: string | undefined;

    if (typeof (callPromise as any).withResponse === 'function') {
      const wrapped = await (callPromise as any).withResponse();
      res = wrapped.data;
      requestId = wrapped.requestId;
    } else {
      res = await callPromise;
    }

    return {
      model: res.model,
      answers: res.answers as any,
      usage: res.usage ? {
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
      } : undefined,
      requestId,
    };
  }
}

/**
 * Deterministic testing client avoiding live network requests or external credentials.
 */
export class FakeSystemOneClient implements SystemOneClient {
  public callCount = 0;
  public peakConcurrency = 0;
  public currentConcurrency = 0;
  public recordedRequests: SystemOneEvaluationRequest[] = [];
  private mockHandler?: (request: SystemOneEvaluationRequest) => Promise<SystemOneEvaluationResponse>;

  constructor(
    mockHandler?: (request: SystemOneEvaluationRequest) => Promise<SystemOneEvaluationResponse>
  ) {
    this.mockHandler = mockHandler;
  }

  public setMockHandler(handler: (request: SystemOneEvaluationRequest) => Promise<SystemOneEvaluationResponse>): void {
    this.mockHandler = handler;
  }

  public async evaluate(request: SystemOneEvaluationRequest): Promise<SystemOneEvaluationResponse> {
    this.callCount++;
    this.currentConcurrency++;
    if (this.currentConcurrency > this.peakConcurrency) {
      this.peakConcurrency = this.currentConcurrency;
    }
    this.recordedRequests.push(request);

    try {
      if (this.mockHandler) {
        return await this.mockHandler(request);
      }

      // Default deterministic response preserving typical test values
      return {
        model: 'jev-test-mock-v1',
        answers: {
          semanticRelevance: { noul: 0.82 },
          implementationNeeded: { noul: 0.61 },
          likelyEditTarget: { noul: 0.27 },
          likelyRootCause: { noul: 0.74 },
        },
        usage: {
          input_tokens: 145,
          output_tokens: 4,
        },
        requestId: `req_mock_${this.callCount}`,
      };
    } finally {
      this.currentConcurrency--;
    }
  }
}
