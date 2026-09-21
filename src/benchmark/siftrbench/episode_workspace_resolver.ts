/**
 * SiftrCode V3 - Episode Workspace Resolver (Phase V3.1 - P0-3)
 *
 * Guarantees point-in-time correctness by provisioning an isolated workspace
 * strictly checked out at episode.baseCommit.
 *
 * Invariants:
 * 1. Never index or execute against current git HEAD (main) for historical episodes.
 * 2. Assert `git rev-parse HEAD === episode.baseCommit` before any indexing or candidate generation.
 * 3. Future files (added after baseCommit) must never appear in the candidate universe.
 * 4. Cache isolated worktrees by `${repositoryId}:${baseCommit}` for deterministic reuse.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

export interface ResolvedWorkspace {
  repositoryId: string;
  baseCommit: string;
  workspacePath: string;
  isWorktree: boolean;
}

export class EpisodeWorkspaceResolver {
  private static cachedWorktrees: Map<string, string> = new Map();
  private static rootDir = path.resolve(__dirname, '../../..');

  /**
   * Resolves the authoritative workspace path for a repository at a given commit.
   * If the local repo clone already matches the commit exactly, returns that path.
   * Otherwise, creates a dedicated, isolated git worktree checked out at baseCommit.
   */
  public static resolveWorkspace(repositoryId: string, baseCommit: string): ResolvedWorkspace {
    const cacheKey = `${repositoryId}:${baseCommit}`;
    if (this.cachedWorktrees.has(cacheKey)) {
      const cachedPath = this.cachedWorktrees.get(cacheKey)!;
      if (fs.existsSync(cachedPath)) {
        this.assertCommit(cachedPath, baseCommit, repositoryId);
        return {
          repositoryId,
          baseCommit,
          workspacePath: cachedPath,
          isWorktree: true,
        };
      }
    }

    const repoDir = this.getSourceRepoDir(repositoryId);
    if (!fs.existsSync(repoDir)) {
      throw new Error(`[EpisodeWorkspaceResolver] Source repository for ${repositoryId} not found at ${repoDir}`);
    }

    // Check current commit of source directory
    let currentCommit = '';
    try {
      currentCommit = execSync(`git -C "${repoDir}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
    } catch (e) {
      throw new Error(`[EpisodeWorkspaceResolver] Failed to read git commit for ${repositoryId}: ${e}`);
    }

    if (currentCommit === baseCommit) {
      // Source repo is already at the exact commit (e.g. pinned express or fastapi repo)
      return {
        repositoryId,
        baseCommit,
        workspacePath: repoDir,
        isWorktree: false,
      };
    }

    // Otherwise (e.g. siftrcode on main where baseCommit is v2-final), create an isolated worktree
    const tempWorktreeDir = path.join(os.tmpdir(), `siftr_ws_${repositoryId}_${baseCommit.slice(0, 8)}_${Date.now()}`);
    fs.mkdirSync(tempWorktreeDir, { recursive: true });

    try {
      execSync(`git -C "${repoDir}" worktree add --detach "${tempWorktreeDir}" ${baseCommit} --quiet`);
    } catch (err) {
      throw new Error(
        `[EpisodeWorkspaceResolver] Failed to create git worktree for ${repositoryId} at ${baseCommit}: ${err}`
      );
    }

    // Symlink node_modules if relevant to avoid re-install
    const rootNodeModules = path.join(this.rootDir, 'node_modules');
    const wtNodeModules = path.join(tempWorktreeDir, 'node_modules');
    if (fs.existsSync(rootNodeModules) && !fs.existsSync(wtNodeModules)) {
      try {
        fs.symlinkSync(rootNodeModules, wtNodeModules, 'dir');
      } catch (e) {}
    }

    this.assertCommit(tempWorktreeDir, baseCommit, repositoryId);
    this.cachedWorktrees.set(cacheKey, tempWorktreeDir);

    return {
      repositoryId,
      baseCommit,
      workspacePath: tempWorktreeDir,
      isWorktree: true,
    };
  }

  /**
   * Asserts that the workspace directory is strictly at the expected base commit.
   * Throws an invariant error if any divergence is found (fail-closed).
   */
  public static assertCommit(dir: string, expectedCommit: string, repositoryId: string): void {
    const actual = execSync(`git -C "${dir}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
    if (actual !== expectedCommit) {
      throw new Error(
        `[EpisodeWorkspaceResolver] INVARIANT VIOLATION: Point-in-time mismatch for ${repositoryId}. ` +
          `Expected commit ${expectedCommit}, but observed ${actual} in ${dir}. Aborting.`
      );
    }
  }

  /**
   * Safely cleans up any cached worktrees.
   */
  public static cleanupAll(): void {
    for (const [key, wtPath] of this.cachedWorktrees.entries()) {
      const [repoId] = key.split(':');
      const sourceDir = this.getSourceRepoDir(repoId);
      try {
        execSync(`git -C "${sourceDir}" worktree remove --force "${wtPath}" --quiet`, { stdio: 'pipe' });
      } catch (e) {}
      if (fs.existsSync(wtPath)) {
        try {
          fs.rmSync(wtPath, { recursive: true, force: true });
        } catch (e) {}
      }
    }
    this.cachedWorktrees.clear();
  }

  private static getSourceRepoDir(repositoryId: string): string {
    if (repositoryId === 'express') {
      return path.join(this.rootDir, 'benchmarks/express-repo');
    }
    if (repositoryId === 'fastapi') {
      return path.join(this.rootDir, 'benchmarks/fastapi-repo');
    }
    if (repositoryId === 'siftrcode') {
      return this.rootDir;
    }
    return path.join(this.rootDir, `benchmarks/${repositoryId}-repo`);
  }
}
