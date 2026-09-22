/**
 * SiftrCode V3.1 - Product Context Providers
 *
 * Implements true end-to-end context generation for evaluation:
 * - FrozenV2ContextProvider: loads authoritative V2 ContextEngine from .v2-baseline-worktree
 *   with strict cryptographic verification of commit 1eedac03b0d83025ebf08ed2945e0ab015c46f6a.
 *   Fails closed (no fallback).
 * - LearnedV3ContextProvider: runs ContextEngine.optimizeWorkspace using V3TreeRankerAdapter,
 *   exercising the real DefaultContextUnitMaterializer, ResolutionRanker, BudgetSolver,
 *   and BundleComposer.
 * - Both providers support candidateBudget and export ranked units, selected units,
 *   and full cryptographic provenance.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { ContextEngine } from '../../engine/context_engine';
import { TreeRanker } from '../models/context_rank/tree_ranker';
import { V3TreeRankerAdapter } from '../models/context_rank/v3_tree_ranker_adapter';

export * from './evaluation_context_result';
export * from './frozen_v2_bridge';
export * from './v3_evaluation_provider';

export const AUTHORITATIVE_V2_SHA = '1eedac03b0d83025ebf08ed2945e0ab015c46f6a';

export interface ProviderBundleProvenance {
  providerName: 'FrozenV2ContextProvider' | 'LearnedV3ContextProvider';
  implementation: string;
  baseCommit?: string;
  bundleChecksum: string;
  tokenBudget: number;
  candidateBudget: number;
}

export interface ContextBundleResult {
  contextString: string;
  tokenEstimate: number;
  selectedUnits: Array<{ id: string; path?: string; resolution?: string; tokenEstimate?: number }>;
  decisions: any[];
  plan: any;
  rankedUnits: Array<{ contextUnitId: string; path?: string; tokenEstimate?: number; resolution?: string }>;
  candidateCount: number;
  provenance: ProviderBundleProvenance;
}

export interface ContextProviderOptions {
  workspaceDir: string;
  prompt: string;
  tokenBudget?: number;
  candidateBudget?: number;
  baseCommit?: string;
  repoId?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export interface ContextProvider {
  getContext(options: ContextProviderOptions): Promise<ContextBundleResult>;
  getImplementation(): string;
}

export const REPO_FILTERS: Record<string, { includePatterns?: string[]; excludePatterns?: string[] }> = {
  express: {},
  fastapi: { includePatterns: ['fastapi/**'], excludePatterns: ['**/tests/**', '**/docs/**'] },
  commander: { includePatterns: ['lib/**'], excludePatterns: ['**/tests/**'] },
  siftrcode: { includePatterns: ['src/**'], excludePatterns: ['**/node_modules/**', '**/dist/**', '**/benchmarks/**'] },
};

function extractRankedUnits(
  res: any,
  candidateBudget: number
): Array<{ contextUnitId: string; path?: string; tokenEstimate?: number; resolution?: string }> {
  const unitMap = new Map<string, any>();
  for (const u of res.units || []) {
    unitMap.set(u.id, u);
  }

  const decisions = res.plan?.exposureDecisions || [];
  if (Array.isArray(decisions) && decisions.length > 0) {
    const candidates = decisions
      .filter((d: any) => typeof d.exposureRank === 'number' && d.exposureRank <= candidateBudget)
      .sort((a: any, b: any) => a.exposureRank - b.exposureRank)
      .map((d: any) => {
        const u = unitMap.get(d.contextUnitId);
        const pu = res.plan?.units?.find((p: any) => p.contextUnitId === d.contextUnitId);
        return {
          contextUnitId: d.contextUnitId,
          path: u?.path || pu?.path,
          tokenEstimate: d.exposureCostTokens || pu?.tokenEstimate || u?.tokenEstimate || 100,
          resolution: String(d.exposureResolution ?? pu?.resolution ?? 'NAME'),
        };
      });

    if (candidates.length > 0) {
      return candidates;
    }
  }

  // Fallback to plan.units if exposureDecisions are not populated
  return (res.plan?.units || []).slice(0, candidateBudget).map((pu: any) => ({
    contextUnitId: pu.contextUnitId,
    path: pu.path,
    tokenEstimate: pu.tokenEstimate || 100,
    resolution: String(pu.resolution),
  }));
}

export class FrozenV2ContextProvider implements ContextProvider {
  private v2Module: any;
  private readonly baselineDir: string;

  constructor(baselineDir?: string) {
    const rootDir = path.resolve(__dirname, '../../..');
    this.baselineDir = baselineDir || path.join(rootDir, '.v2-baseline-worktree');

    if (!fs.existsSync(this.baselineDir)) {
      throw new Error(`FAIL_CLOSED: .v2-baseline-worktree not found at: ${this.baselineDir}`);
    }

    const currentSha = execSync(`git -C "${this.baselineDir}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
    if (currentSha !== AUTHORITATIVE_V2_SHA) {
      throw new Error(
        `FAIL_CLOSED: .v2-baseline-worktree HEAD (${currentSha}) does not match authoritative V2 SHA (${AUTHORITATIVE_V2_SHA})`
      );
    }

    const distPath = path.join(this.baselineDir, 'dist');
    if (!fs.existsSync(distPath)) {
      throw new Error(`FAIL_CLOSED: .v2-baseline-worktree/dist missing at: ${distPath}`);
    }

    this.v2Module = require(distPath);
    if (!this.v2Module.ContextEngine || typeof this.v2Module.ContextEngine.optimizeWorkspace !== 'function') {
      throw new Error(`FAIL_CLOSED: ContextEngine.optimizeWorkspace missing in .v2-baseline-worktree/dist`);
    }
  }

  public getImplementation(): string {
    return `.v2-baseline-worktree/dist @ ${AUTHORITATIVE_V2_SHA}`;
  }

  public async getContext(options: ContextProviderOptions): Promise<ContextBundleResult> {
    const filters = options.repoId ? REPO_FILTERS[options.repoId] : undefined;
    const includePatterns = options.includePatterns || filters?.includePatterns;
    const excludePatterns = options.excludePatterns || filters?.excludePatterns;
    const candidateBudget = options.candidateBudget ?? 50;
    const tokenBudget = options.tokenBudget ?? 8000;

    const res = await this.v2Module.ContextEngine.optimizeWorkspace({
      workspaceDir: options.workspaceDir,
      prompt: options.prompt,
      tokenBudget,
      candidateBudget,
      includePatterns,
      excludePatterns,
    });

    const contextString = res.contextString || res.formattedContext?.promptText || '';
    const tokenEstimate = res.plan?.actualRenderedTokens || res.plan?.estimatedRenderedTokens || 0;
    const selectedUnits: Array<{ id: string; path?: string; resolution?: string; tokenEstimate?: number }> = (
      res.plan?.units || []
    ).map((u: any) => ({
      id: u.contextUnitId,
      path: u.path,
      resolution: String(u.resolution),
      tokenEstimate: u.tokenEstimate,
    }));

    const rankedUnits = extractRankedUnits(res, candidateBudget);
    const bundleChecksum = crypto.createHash('sha256').update(contextString).digest('hex');

    return {
      contextString,
      tokenEstimate,
      selectedUnits,
      decisions: res.plan?.exposureDecisions || [],
      plan: res.plan,
      rankedUnits,
      candidateCount: rankedUnits.length,
      provenance: {
        providerName: 'FrozenV2ContextProvider',
        implementation: this.getImplementation(),
        baseCommit: options.baseCommit,
        bundleChecksum,
        tokenBudget,
        candidateBudget,
      },
    };
  }
}

export class LearnedV3ContextProvider implements ContextProvider {
  private v3Adapter: V3TreeRankerAdapter;

  constructor(treeRanker?: TreeRanker) {
    if (treeRanker) {
      this.v3Adapter = new V3TreeRankerAdapter(treeRanker);
    } else {
      const rootDir = path.resolve(__dirname, '../../..');
      const gbdtArtifactPath = path.join(rootDir, 'data/models/gbdt_pairwise_v1.json');
      if (!fs.existsSync(gbdtArtifactPath)) {
        throw new Error(`FAIL_CLOSED: GBDT artifact missing at ${gbdtArtifactPath}`);
      }
      const gbdtArtifact = JSON.parse(fs.readFileSync(gbdtArtifactPath, 'utf8'));
      const tr = TreeRanker.fromArtifact(gbdtArtifact);
      this.v3Adapter = new V3TreeRankerAdapter(tr);
    }
  }

  public getImplementation(): string {
    return 'ContextEngine.optimizeWorkspace with V3TreeRankerAdapter (GBDT pairwise v1)';
  }

  public async getContext(options: ContextProviderOptions): Promise<ContextBundleResult> {
    const filters = options.repoId ? REPO_FILTERS[options.repoId] : undefined;
    const includePatterns = options.includePatterns || filters?.includePatterns;
    const excludePatterns = options.excludePatterns || filters?.excludePatterns;
    const candidateBudget = options.candidateBudget ?? 50;
    const tokenBudget = options.tokenBudget ?? 8000;

    const res = await ContextEngine.optimizeWorkspace({
      workspaceDir: options.workspaceDir,
      prompt: options.prompt,
      tokenBudget,
      candidateBudget,
      ranker: this.v3Adapter,
      includePatterns,
      excludePatterns,
    });

    const contextString = res.contextString || res.formattedContext?.promptText || '';
    const tokenEstimate = res.plan?.actualRenderedTokens || res.plan?.estimatedRenderedTokens || 0;
    const selectedUnits: Array<{ id: string; path?: string; resolution?: string; tokenEstimate?: number }> = (
      res.plan?.units || []
    ).map((u: any) => ({
      id: u.contextUnitId,
      path: u.path,
      resolution: String(u.resolution),
      tokenEstimate: u.tokenEstimate,
    }));

    const rankedUnits = extractRankedUnits(res, candidateBudget);
    const bundleChecksum = crypto.createHash('sha256').update(contextString).digest('hex');

    return {
      contextString,
      tokenEstimate,
      selectedUnits,
      decisions: res.plan?.exposureDecisions || [],
      plan: res.plan,
      rankedUnits,
      candidateCount: rankedUnits.length,
      provenance: {
        providerName: 'LearnedV3ContextProvider',
        implementation: this.getImplementation(),
        baseCommit: options.baseCommit,
        bundleChecksum,
        tokenBudget,
        candidateBudget,
      },
    };
  }
}
