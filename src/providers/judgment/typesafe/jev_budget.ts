/**
 * SiftrCode V2 - JEV Decision Budget & Concurrency Pool (Milestone Part IV Section 8 & Part XI Sections 28-30)
 * Manages rate limits, per-task call counts, and bounded worker pools.
 */

export interface JevDecisionBudget {
  maxCandidates: number;
  maxCallsPerTask: number;
  maxConcurrency: number;
  maxLatencyMs: number;
  maxInputCharacters?: number;
}

export const DEFAULT_JEV_DECISION_BUDGET: JevDecisionBudget = {
  maxCandidates: 20,
  maxCallsPerTask: 20,
  maxConcurrency: 4,
  maxLatencyMs: 2000,
  maxInputCharacters: 8000,
};

export interface JevCallStats {
  eligibleCandidates: number;
  attemptedCalls: number;
  successfulCalls: number;
  failedCalls: number;
  fallbackCalls: number;
  trustDeniedCalls: number;
  rightsDeniedCalls: number;
  budgetSkippedCandidates: number;
  timeouts: number;
  rateLimited: number;
  malformed: number;
  connectionErrors: number;
  providerErrors: number;
  retries: number;
  httpRequests: number;
}

export class JevCallTracker {
  private budget: JevDecisionBudget;
  private stats: JevCallStats = {
    eligibleCandidates: 0,
    attemptedCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    fallbackCalls: 0,
    trustDeniedCalls: 0,
    rightsDeniedCalls: 0,
    budgetSkippedCandidates: 0,
    timeouts: 0,
    rateLimited: 0,
    malformed: 0,
    connectionErrors: 0,
    providerErrors: 0,
    retries: 0,
    httpRequests: 0,
  };

  constructor(budget: Partial<JevDecisionBudget> = {}) {
    this.budget = { ...DEFAULT_JEV_DECISION_BUDGET, ...budget };
  }

  public getBudget(): JevDecisionBudget {
    return { ...this.budget };
  }

  public getStats(): JevCallStats {
    return { ...this.stats };
  }

  public recordEligibleCandidate(): void {
    this.stats.eligibleCandidates++;
  }

  public canAttemptCall(): boolean {
    return this.stats.attemptedCalls < this.budget.maxCallsPerTask;
  }

  /**
   * Section 28 Invariant: Increment BEFORE attempting external/remote work.
   */
  public recordCallAttempt(): boolean {
    if (this.stats.attemptedCalls >= this.budget.maxCallsPerTask) {
      this.stats.budgetSkippedCandidates++;
      this.stats.fallbackCalls++;
      return false;
    }
    this.stats.attemptedCalls++;
    return true;
  }

  public recordCallSuccess(): void {
    this.stats.successfulCalls++;
  }

  public recordRetry(): void {
    this.stats.retries++;
  }

  public recordHttpRequest(): void {
    this.stats.httpRequests++;
  }

  public recordCallFailure(category?: 'TIMEOUT' | 'RATE_LIMITED' | 'MALFORMED' | 'CONNECTION_ERROR' | 'PROVIDER_ERROR' | string): void {
    this.stats.failedCalls++;
    this.stats.fallbackCalls++;
    if (category === 'TIMEOUT') {
      this.stats.timeouts++;
    } else if (category === 'RATE_LIMITED') {
      this.stats.rateLimited++;
    } else if (category === 'MALFORMED') {
      this.stats.malformed++;
    } else if (category === 'CONNECTION_ERROR') {
      this.stats.connectionErrors++;
    } else {
      this.stats.providerErrors++;
    }
  }

  public recordFallback(): void {
    this.stats.fallbackCalls++;
  }

  public recordTrustDenied(): void {
    this.stats.trustDeniedCalls++;
    this.stats.fallbackCalls++;
  }

  public recordRightsDenied(): void {
    this.stats.rightsDeniedCalls++;
    this.stats.fallbackCalls++;
  }

  public recordBudgetSkipped(): void {
    this.stats.budgetSkippedCandidates++;
    this.stats.fallbackCalls++;
  }
}

/**
 * Concurrency worker pool / semaphore enforcing maxConcurrency limit.
 */
export class Semaphore {
  private currentCount: number;
  private maxConcurrency: number;
  private queue: Array<() => void> = [];
  private activeWorkers: number = 0;
  private peakConcurrency: number = 0;

  constructor(maxConcurrency: number = 4) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.currentCount = this.maxConcurrency;
  }

  public getPeakConcurrency(): number {
    return this.peakConcurrency;
  }

  public getActiveWorkers(): number {
    return this.activeWorkers;
  }

  public async acquire(): Promise<void> {
    if (this.currentCount > 0) {
      this.currentCount--;
      this.activeWorkers++;
      if (this.activeWorkers > this.peakConcurrency) {
        this.peakConcurrency = this.activeWorkers;
      }
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.activeWorkers++;
        if (this.activeWorkers > this.peakConcurrency) {
          this.peakConcurrency = this.activeWorkers;
        }
        resolve();
      });
    });
  }

  public release(): void {
    this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.currentCount = Math.min(this.maxConcurrency, this.currentCount + 1);
    }
  }

  public async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
