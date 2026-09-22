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
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ContextEngine } from '../../engine/context_engine';
import { TreeRanker } from '../models/context_rank/tree_ranker';
import { V3TreeRankerAdapter } from '../models/context_rank/v3_tree_ranker_adapter';

export const AUTHORITATIVE_V2_SHA = '1eedac03b0d83025ebf08ed2945e0ab015c46f6a';

export interface ContextBundleResult {
  contextString: string;
  tokenEstimate: number;
  selectedUnits: Array<{ id: string; path?: string; resolution?: string }>;
  decisions: any[];
}

export interface ContextProviderOptions {
  workspaceDir: string;
  prompt: string;
  tokenBudget?: number;
  repoId?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export interface ContextProvider {
  getContext(options: ContextProviderOptions): Promise<ContextBundleResult>;
}

export const REPO_FILTERS: Record<string, { includePatterns?: string[]; excludePatterns?: string[] }> = {
  express: {},
  fastapi: { includePatterns: ['fastapi/**'], excludePatterns: ['**/tests/**', '**/docs/**'] },
  commander: { includePatterns: ['lib/**'], excludePatterns: ['**/tests/**'] },
  siftrcode: { includePatterns: ['src/**'], excludePatterns: ['**/node_modules/**', '**/dist/**', '**/benchmarks/**'] },
};

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

  public async getContext(options: ContextProviderOptions): Promise<ContextBundleResult> {
    const filters = options.repoId ? REPO_FILTERS[options.repoId] : undefined;
    const includePatterns = options.includePatterns || filters?.includePatterns;
    const excludePatterns = options.excludePatterns || filters?.excludePatterns;

    const res = await this.v2Module.ContextEngine.optimizeWorkspace({
      workspaceDir: options.workspaceDir,
      prompt: options.prompt,
      tokenBudget: options.tokenBudget ?? 8000,
      includePatterns,
      excludePatterns,
    });

    const tokenEstimate = res.plan.actualRenderedTokens || res.plan.estimatedRenderedTokens || 0;
    const selectedUnits: Array<{ id: string; path?: string; resolution?: string }> = (res.plan.units || []).map((u: any) => ({
      id: u.contextUnitId,
      path: u.path,
      resolution: String(u.resolution),
    }));

    return {
      contextString: res.contextString || res.formattedContext?.promptText || '',
      tokenEstimate,
      selectedUnits,
      decisions: res.plan.exposureDecisions || [],
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

  public async getContext(options: ContextProviderOptions): Promise<ContextBundleResult> {
    const filters = options.repoId ? REPO_FILTERS[options.repoId] : undefined;
    const includePatterns = options.includePatterns || filters?.includePatterns;
    const excludePatterns = options.excludePatterns || filters?.excludePatterns;

    const res = await ContextEngine.optimizeWorkspace({
      workspaceDir: options.workspaceDir,
      prompt: options.prompt,
      tokenBudget: options.tokenBudget ?? 8000,
      ranker: this.v3Adapter,
      includePatterns,
      excludePatterns,
    });

    const tokenEstimate = res.plan.actualRenderedTokens || res.plan.estimatedRenderedTokens || 0;
    const selectedUnits: Array<{ id: string; path?: string; resolution?: string }> = (res.plan.units || []).map((u: any) => ({
      id: u.contextUnitId,
      path: u.path,
      resolution: String(u.resolution),
    }));

    return {
      contextString: res.contextString || res.formattedContext?.promptText || '',
      tokenEstimate,
      selectedUnits,
      decisions: res.plan.exposureDecisions || [],
    };
  }
}
