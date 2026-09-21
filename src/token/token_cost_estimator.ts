/**
 * SiftrCode V2 - Authoritative Token Cost Estimator & Resolution Curves
 * Replaces unreliable metadata estimates with authoritative rendered token counts,
 * resolution cost curves, and post-materialization budget enforcement.
 */

import { ContextResolution } from '../context/context_resolution';
import { ContextUnit, ContextUnitKind } from '../context/context_unit';
import { WorkspaceSnapshot } from '../workspace/workspace_snapshot';
import { AgentEnvironment } from '../agents/agent_environment';
import { ContextUnitMaterializer, DefaultContextUnitMaterializer } from '../materialization/context_unit_materializer';

export type ResolutionSafety = 'SAFE' | 'PARTIAL' | 'UNSAFE';

export interface ResolutionOption {
  contextUnitId: string;
  resolution: ContextResolution;
  tokenCost: number;
  estimatedUtility: number;
  allowed: boolean;
  safety: ResolutionSafety;
  reasonCodes?: string[];
}

export interface TokenCostEstimator {
  estimateMaterialized(
    content: string,
    environment?: AgentEnvironment
  ): number;

  estimateResolution(
    unit: ContextUnit,
    resolution: ContextResolution,
    workspace: WorkspaceSnapshot,
    environment?: AgentEnvironment
  ): Promise<number>;

  estimateResolutionSync(
    unit: ContextUnit,
    resolution: ContextResolution,
    workspace: WorkspaceSnapshot,
    environment?: AgentEnvironment
  ): number;

  computeResolutionCurve(
    unit: ContextUnit,
    workspace: WorkspaceSnapshot,
    environment?: AgentEnvironment,
    estimatedUtility?: number
  ): ResolutionOption[];
}

export class DefaultTokenCostEstimator implements TokenCostEstimator {
  private materializer: ContextUnitMaterializer;
  private cache: Map<string, number> = new Map(); // unitId:resolution:snapshotId -> tokenCost

  constructor(materializer?: ContextUnitMaterializer) {
    this.materializer = materializer || new DefaultContextUnitMaterializer();
  }

  /**
   * Authoritative token estimator for already-materialized text content.
   * Calibrated for modern LLM code tokenizers (Claude, GPT-4o, Llama).
   * 1 code token ~= 3.7 characters.
   */
  public estimateMaterialized(content: string, _environment?: AgentEnvironment): number {
    if (!content || content.length === 0) {
      return 0;
    }
    return Math.max(1, Math.ceil(content.length / 3.7));
  }

  /**
   * Synchronously estimates the token cost for a specific ContextUnit at a given ContextResolution.
   */
  public estimateResolutionSync(
    unit: ContextUnit,
    resolution: ContextResolution,
    workspace: WorkspaceSnapshot,
    environment?: AgentEnvironment
  ): number {
    if (resolution === ContextResolution.OMIT) {
      return 0;
    }

    const cacheKey = `${unit.id}:${resolution}:${workspace.workspaceSnapshotId}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const mat = this.materializer.materializeSync(unit, resolution, workspace, environment);
    const tokens = mat.actualTokenCount || this.estimateMaterialized(mat.content, environment);
    this.cache.set(cacheKey, tokens);
    return tokens;
  }

  /**
   * Asynchronously estimates the token cost for a ContextUnit at a given ContextResolution.
   */
  public async estimateResolution(
    unit: ContextUnit,
    resolution: ContextResolution,
    workspace: WorkspaceSnapshot,
    environment?: AgentEnvironment
  ): Promise<number> {
    if (resolution === ContextResolution.OMIT) {
      return 0;
    }

    const cacheKey = `${unit.id}:${resolution}:${workspace.workspaceSnapshotId}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const mat = await this.materializer.materialize(unit, resolution, workspace, environment);
    const tokens = mat.actualTokenCount || this.estimateMaterialized(mat.content, environment);
    this.cache.set(cacheKey, tokens);
    return tokens;
  }

  /**
   * Computes the full resolution-cost curve for a ContextUnit across all potential resolutions.
   * Section 10: Before final allocation, calculate feasible resolution options.
   */
  public computeResolutionCurve(
    unit: ContextUnit,
    workspace: WorkspaceSnapshot,
    environment?: AgentEnvironment,
    estimatedUtility: number = 1.0
  ): ResolutionOption[] {
    const resolutions: ContextResolution[] = [
      ContextResolution.NAME,
      ContextResolution.SIGNATURE,
      ContextResolution.SKELETON,
      ContextResolution.BODY,
      ContextResolution.FULL,
    ];

    const options: ResolutionOption[] = [];

    for (const res of resolutions) {
      const supported = this.materializer.supports(unit, res);
      let safety: ResolutionSafety = 'SAFE';
      let allowed = supported;
      const reasonCodes: string[] = [];

      const caps = typeof (this.materializer as any).getResolutionCapabilities === 'function'
        ? (this.materializer as any).getResolutionCapabilities(unit)
        : undefined;

      if (!supported) {
        safety = 'UNSAFE';
        allowed = false;
        reasonCodes.push(`UNSUPPORTED_RESOLUTION_FOR_${unit.kind}`);
      }

      if (caps && caps.skeletonSafety === 'UNSAFE' && res === ContextResolution.SKELETON) {
        safety = 'UNSAFE';
        allowed = false;
        if (caps.reasonCodes && caps.reasonCodes.length > 0) {
          reasonCodes.push(...caps.reasonCodes);
        }
      }

      // Special non-code safety rules (e.g. config/lockfile skeletonization is unsafe)
      if (
        (unit.kind === ContextUnitKind.CONFIG || unit.kind === ContextUnitKind.LOCKFILE) &&
        res === ContextResolution.SKELETON
      ) {
        safety = 'UNSAFE';
        allowed = false;
        if (!reasonCodes.includes('NON_CODE_SKELETON_UNSAFE')) {
          reasonCodes.push('NON_CODE_SKELETON_UNSAFE');
        }
      }

      const tokenCost = allowed
        ? this.estimateResolutionSync(unit, res, workspace, environment)
        : 0;

      // Scale utility proportionally with resolution fidelity
      let resUtilityMultiplier = 1.0;
      switch (res) {
        case ContextResolution.FULL:
          resUtilityMultiplier = 1.0;
          break;
        case ContextResolution.BODY:
          resUtilityMultiplier = 0.95;
          break;
        case ContextResolution.SKELETON:
          resUtilityMultiplier = 0.70;
          break;
        case ContextResolution.SIGNATURE:
          resUtilityMultiplier = 0.40;
          break;
        case ContextResolution.NAME:
          resUtilityMultiplier = 0.15;
          break;
        case ContextResolution.OMIT:
          resUtilityMultiplier = 0.0;
          break;
      }

      options.push({
        contextUnitId: unit.id,
        resolution: res,
        tokenCost,
        estimatedUtility: Number((estimatedUtility * resUtilityMultiplier).toFixed(4)),
        allowed,
        safety,
        reasonCodes: reasonCodes.length > 0 ? reasonCodes : undefined,
      });
    }

    return options;
  }
}
