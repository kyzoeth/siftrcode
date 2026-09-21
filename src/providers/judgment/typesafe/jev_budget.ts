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
  rightsDeniedCalls: number;
  budgetSkippedCandidates: number;
}

export class JevCallTracker {
  private budget: JevDecisionBudget;
  private stats: JevCallStats = {
    eligibleCandidates: 0,
    attemptedCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    rightsDeniedCalls: 0,
    budgetSkippedCandidates: 0,
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
      return false;
    }
    this.stats.attemptedCalls++;
    return true;
  }

  public recordCallSuccess(): void {
    this.stats.successfulCalls++;
  }

  public recordCallFailure(): void {
    this.stats.failedCalls++;
  }

  public recordRightsDenied(): void {
    this.stats.rightsDeniedCalls++;
  }

  public recordBudgetSkipped(): void {
    this.stats.budgetSkippedCandidates++;
  }
}

/**
 * Concurrency worker pool / semaphore enforcing maxConcurrency limit.
 */
export class Semaphore {
  private currentCount: number;
  private maxConcurrency: number;
  private queue: Array<() => void> = [];

  constructor(maxConcurrency: number = 4) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.currentCount = this.maxConcurrency;
  }

  public async acquire(): Promise<void> {
    if (this.currentCount > 0) {
      this.currentCount--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  public release(): void {
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
