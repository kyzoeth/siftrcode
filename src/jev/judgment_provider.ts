import { ContextUnit } from '../context/context_unit';
import { TaskContext } from '../context/task_context';

export interface JudgmentGraphContext {
  graphDistance?: number | null;
  incomingEdgeCount?: number;
  outgoingEdgeCount?: number;
  isDirectDependency?: boolean;
  isDirectDependent?: boolean;
  connectedSymbolNames?: string[];
}

export interface JudgmentResult {
  candidateUnitId: string;
  semanticRelevance: number; // 0.0 to 1.0
  implementationNeeded: boolean;
  likelyEditTarget: boolean;
  likelyRootCause: boolean;
  confidence: number; // 0.0 to 1.0
  provider: string; // 'typesafe-jev' | 'local-heuristic' | 'mock'
  latencyMs: number;
  fallbackReason?: string; // set when fallback to local intelligence occurred
  rationale?: string;
  rawSignals?: Record<string, unknown>;
}

export interface JudgmentProvider {
  /**
   * Evaluates a candidate ContextUnit for a TaskContext using external or local judgment (Section 45).
   * Emits independent signals (Section 46) consumed by ContextRank.
   */
  judge(
    task: TaskContext,
    candidate: ContextUnit,
    graphContext?: JudgmentGraphContext
  ): Promise<JudgmentResult>;

  /**
   * Batch judgment for high-throughput candidate evaluation.
   */
  judgeBatch?(
    task: TaskContext,
    candidates: Array<{ candidate: ContextUnit; graphContext?: JudgmentGraphContext }>
  ): Promise<JudgmentResult[]>;
}
