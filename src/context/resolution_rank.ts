/**
 * SiftrCode V2 - ResolutionRank (Safe Variable-Resolution Degradation)
 * Assigns optimal and safe resolution levels (FULL, BODY, SKELETON, SIGNATURE, NAME, OMIT)
 * while strictly protecting edit targets and non-skeletonizable artifacts from unsafe degradation.
 */

import { ContextResolution, SkeletonSafetyLevel } from './context_resolution';
import { ContextUnit, ContextUnitKind } from './context_unit';
import { ContextFeaturesV1 } from '../ranking/feature_schema';

export interface UnitResolutionAllocation {
  contextUnitId: string;
  resolution: ContextResolution;
  tokenEstimate: number;
  safetyLevel: SkeletonSafetyLevel;
  justification: string;
}

export interface ResolutionRankerOptions {
  favorSkeletonsForDependencies?: boolean;
}

export class ResolutionRanker {
  private options: ResolutionRankerOptions;

  constructor(options: ResolutionRankerOptions = {}) {
    this.options = {
      favorSkeletonsForDependencies: options.favorSkeletonsForDependencies ?? true,
    };
  }

  /**
   * Determine the safe and optimal resolution for a ContextUnit.
   *
   * @param unit The target context unit
   * @param features Multi-dimensional features for the unit
   * @param isPriorityTarget Whether this unit is the top rank or primary target of the task
   * @param budgetPressure Ratio between desired tokens and available budget (>= 1.0 indicates pressure)
   */
  public allocateResolution(
    unit: ContextUnit,
    features: ContextFeaturesV1,
    isPriorityTarget = false,
    budgetPressure = 1.0
  ): UnitResolutionAllocation {
    const rawTokens = typeof unit.metadata?.tokenEstimate === 'number'
      ? (unit.metadata.tokenEstimate as number)
      : features.tokenEstimate;

    // Invariant 1: Edit & Runtime Error Targets MUST NOT be skeletonized
    const isEditTarget =
      isPriorityTarget ||
      features.inStackTrace ||
      features.isFailingTestTarget ||
      features.inCompilerError ||
      features.inDirtyDiff;

    if (isEditTarget) {
      const resolution = budgetPressure > 1.8 && rawTokens > 500
        ? ContextResolution.BODY
        : ContextResolution.FULL;

      return {
        contextUnitId: unit.id,
        resolution,
        tokenEstimate: this.estimateTokensForResolution(rawTokens, resolution),
        safetyLevel: 'SAFE',
        justification: 'edit_or_failure_target_preserves_full_implementation',
      };
    }

    // Invariant 2: Non-skeletonizable artifacts (Configs, Schemas, Migrations, Lockfiles)
    const isNonSkeletonizable =
      unit.kind === ContextUnitKind.CONFIG ||
      unit.kind === ContextUnitKind.SCHEMA ||
      unit.kind === ContextUnitKind.MIGRATION ||
      unit.kind === ContextUnitKind.LOCKFILE ||
      unit.kind === ContextUnitKind.DOCUMENTATION;

    if (isNonSkeletonizable) {
      if (budgetPressure > 1.3) {
        return {
          contextUnitId: unit.id,
          resolution: ContextResolution.NAME,
          tokenEstimate: this.estimateTokensForResolution(rawTokens, ContextResolution.NAME),
          safetyLevel: 'SAFE',
          justification: 'non_skeletonizable_artifact_degraded_to_name_under_budget_pressure',
        };
      }
      return {
        contextUnitId: unit.id,
        resolution: ContextResolution.FULL,
        tokenEstimate: this.estimateTokensForResolution(rawTokens, ContextResolution.FULL),
        safetyLevel: 'SAFE',
        justification: 'non_skeletonizable_artifact_retained_in_full',
      };
    }

    // Invariant 3: Distant Dependencies (>= 2 hops away)
    if (features.minDistanceToSeed !== null && features.minDistanceToSeed >= 2) {
      const resolution = budgetPressure > 1.2
        ? ContextResolution.SIGNATURE
        : ContextResolution.SKELETON;

      return {
        contextUnitId: unit.id,
        resolution,
        tokenEstimate: this.estimateTokensForResolution(rawTokens, resolution),
        safetyLevel: 'SAFE',
        justification: 'distant_dependency_safely_skeletonized_to_save_context',
      };
    }

    // Invariant 4: Immediate Dependencies (1 hop away)
    if (features.minDistanceToSeed === 1 || features.isDirectDependency || features.isDirectDependent) {
      if (budgetPressure > 1.5) {
        return {
          contextUnitId: unit.id,
          resolution: ContextResolution.SKELETON,
          tokenEstimate: this.estimateTokensForResolution(rawTokens, ContextResolution.SKELETON),
          safetyLevel: 'SAFE',
          justification: 'direct_dependency_skeletonized_under_high_budget_pressure',
        };
      }
      return {
        contextUnitId: unit.id,
        resolution: ContextResolution.BODY,
        tokenEstimate: this.estimateTokensForResolution(rawTokens, ContextResolution.BODY),
        safetyLevel: 'SAFE',
        justification: 'direct_dependency_retains_body_for_immediate_comprehension',
      };
    }

    // Invariant 5: Peripheral Context (no close graph links, moderate lexical match)
    if (budgetPressure > 1.0) {
      return {
        contextUnitId: unit.id,
        resolution: ContextResolution.SIGNATURE,
        tokenEstimate: this.estimateTokensForResolution(rawTokens, ContextResolution.SIGNATURE),
        safetyLevel: 'SAFE',
        justification: 'peripheral_context_degraded_to_signature',
      };
    }

    return {
      contextUnitId: unit.id,
      resolution: ContextResolution.SKELETON,
      tokenEstimate: this.estimateTokensForResolution(rawTokens, ContextResolution.SKELETON),
      safetyLevel: 'SAFE',
      justification: 'standard_structural_skeleton_allocation',
    };
  }

  /**
   * Estimates token cost based on the resolution level.
   */
  public estimateTokensForResolution(rawTokens: number, resolution: ContextResolution): number {
    switch (resolution) {
      case ContextResolution.FULL:
        return rawTokens;
      case ContextResolution.BODY:
        return Math.max(5, Math.ceil(rawTokens * 0.75));
      case ContextResolution.SKELETON:
        return Math.max(5, Math.ceil(rawTokens * 0.25));
      case ContextResolution.SIGNATURE:
        return Math.max(5, Math.ceil(rawTokens * 0.10));
      case ContextResolution.NAME:
        return 5;
      case ContextResolution.OMIT:
        return 0;
      default:
        return rawTokens;
    }
  }
}
