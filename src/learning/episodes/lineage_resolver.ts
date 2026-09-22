/**
 * SiftrCode V2 - Authoritative Outcome Lineage Resolver (Phase 20.3)
 *
 * Single source of truth for resolving and binding task outcomes to exact context plans,
 * sessions, workspaces, and pre-outcome snapshots.
 *
 * Invariants:
 * 1. If contextPlanId is supplied, it is authoritative. Disagreements with caller-supplied
 *    taskId or sessionId strictly FAIL CLOSED with FAIL_CLOSED_LINEAGE_MISMATCH.
 * 2. If contextPlanId is omitted, taskId-only submission is permitted IF AND ONLY IF exactly
 *    one eligible ContextPlan exists for that taskId. Multiple plans fail with
 *    FAIL_CLOSED_AMBIGUOUS_LINEAGE.
 * 3. Never use "latest by taskId" heuristics for training lineage.
 * 4. Never generate synthetic session IDs during outcome finalization.
 */

import { ContextPlan } from '../../engine/context_plan';
import { PreOutcomeEpisodeSnapshot } from './pre_outcome_snapshot';
import { SqliteStore } from '../../storage/sqlite_store';

export interface LineageResolutionInput {
  contextPlanId?: string;
  taskId?: string;
  sessionId?: string;
  workspaceSnapshotId?: string;
  agentEnvironmentId?: string;
}

export interface LineageResolutionSuccess {
  valid: true;
  planId: string;
  taskId: string;
  sessionId: string;
  workspaceSnapshotId: string;
  agentEnvironmentId: string;
  episodeId: string;
  plan: ContextPlan;
  snapshot: PreOutcomeEpisodeSnapshot;
}

export interface LineageResolutionFailure {
  valid: false;
  code:
    | 'FAIL_CLOSED_NO_PLAN'
    | 'FAIL_CLOSED_LINEAGE_MISMATCH'
    | 'FAIL_CLOSED_AMBIGUOUS_LINEAGE'
    | 'FAIL_CLOSED_SNAPSHOT_NOT_FOUND';
  error: string;
}

export type LineageResolution = LineageResolutionSuccess | LineageResolutionFailure;

/**
 * Resolves outcome lineage strictly against stored durable records.
 */
export function resolveOutcomeLineage(
  input: LineageResolutionInput,
  store: SqliteStore
): LineageResolution {
  const planId = input.contextPlanId ? input.contextPlanId.trim() : undefined;
  const taskId = input.taskId ? input.taskId.trim() : undefined;
  const sessionId = input.sessionId ? input.sessionId.trim() : undefined;
  const workspaceSnapshotId = input.workspaceSnapshotId ? input.workspaceSnapshotId.trim() : undefined;

  let plan: ContextPlan | undefined;

  // Rule 1: contextPlanId is authoritative if provided
  if (planId) {
    plan = store.getContextPlan(planId);
    if (!plan) {
      return {
        valid: false,
        code: 'FAIL_CLOSED_LINEAGE_MISMATCH',
        error: `Referential integrity failure: ContextPlan "${planId}" does not exist in store.`,
      };
    }

    if (taskId && plan.taskId !== taskId) {
      return {
        valid: false,
        code: 'FAIL_CLOSED_LINEAGE_MISMATCH',
        error: `Lineage mismatch: ContextPlan "${planId}" belongs to taskId "${plan.taskId}", not "${taskId}".`,
      };
    }

    if (sessionId && plan.sessionId && plan.sessionId !== sessionId) {
      return {
        valid: false,
        code: 'FAIL_CLOSED_LINEAGE_MISMATCH',
        error: `Lineage mismatch: ContextPlan "${planId}" belongs to session "${plan.sessionId}", not "${sessionId}".`,
      };
    }

    if (workspaceSnapshotId && plan.workspaceSnapshotId && plan.workspaceSnapshotId !== workspaceSnapshotId) {
      return {
        valid: false,
        code: 'FAIL_CLOSED_LINEAGE_MISMATCH',
        error: `Lineage mismatch: ContextPlan "${planId}" belongs to workspaceSnapshotId "${plan.workspaceSnapshotId}", not "${workspaceSnapshotId}".`,
      };
    }
  } else {
    // Rule 2: contextPlanId omitted, require exactly 1 unambiguous plan for taskId
    if (!taskId) {
      return {
        valid: false,
        code: 'FAIL_CLOSED_NO_PLAN',
        error: 'Lineage failure: Either contextPlanId or taskId must be provided.',
      };
    }

    const plans = store.listContextPlans(taskId, sessionId);
    if (plans.length === 0) {
      return {
        valid: false,
        code: 'FAIL_CLOSED_NO_PLAN',
        error: `Lineage failure: No ContextPlan found for taskId "${taskId}".`,
      };
    }

    if (plans.length > 1) {
      return {
        valid: false,
        code: 'FAIL_CLOSED_AMBIGUOUS_LINEAGE',
        error: `Ambiguous lineage: Multiple ContextPlans (${plans.length}) found for task "${taskId}". Exact contextPlanId is required.`,
      };
    }

    plan = plans[0];
  }

  // Resolve associated PreOutcomeEpisodeSnapshot
  let snapshot: PreOutcomeEpisodeSnapshot | undefined;

  if (plan.preOutcomeSnapshot) {
    snapshot = plan.preOutcomeSnapshot;
  } else {
    // Try resolving from store by episodeId if known, or by taskId if single
    const episodeId = (plan as any).episodeId || (plan.preOutcomeSnapshot as any)?.episodeId;
    if (episodeId) {
      snapshot = store.getPreOutcomeSnapshot(episodeId) || undefined;
    }
    if (!snapshot) {
      const candidateSnapshots = store.listPreOutcomeSnapshots
        ? store.listPreOutcomeSnapshots().filter((s) => s.taskId === plan!.taskId)
        : [];
      if (candidateSnapshots.length === 1) {
        snapshot = candidateSnapshots[0];
      } else if (candidateSnapshots.length > 1) {
        // Find snapshot matching workspaceSnapshotId
        const matched = candidateSnapshots.find((s) => s.workspaceSnapshotId === plan!.workspaceSnapshotId);
        if (matched) {
          snapshot = matched;
        }
      }
    }
  }

  if (!snapshot) {
    // Final attempt: lookup by task in store
    const snap = store.getPreOutcomeSnapshotByTaskId(plan.taskId);
    if (snap && snap.taskId === plan.taskId) {
      snapshot = snap;
    }
  }

  if (!snapshot) {
    return {
      valid: false,
      code: 'FAIL_CLOSED_SNAPSHOT_NOT_FOUND',
      error: `Pre-outcome snapshot missing for plan "${plan.planId}" (task "${plan.taskId}").`,
    };
  }

  const effectiveSessionId = plan.sessionId || sessionId || snapshot.episodeId;
  const effectiveAgentEnvId =
    input.agentEnvironmentId ||
    plan.agentEnvironmentId ||
    (snapshot as any).agentEnvironmentId ||
    'unknown';
  const effectiveSnapshotId = plan.workspaceSnapshotId || snapshot.workspaceSnapshotId || 'unknown';

  return {
    valid: true,
    planId: plan.planId,
    taskId: plan.taskId,
    sessionId: effectiveSessionId,
    workspaceSnapshotId: effectiveSnapshotId,
    agentEnvironmentId: effectiveAgentEnvId,
    episodeId: snapshot.episodeId,
    plan,
    snapshot,
  };
}
