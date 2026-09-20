import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { RepositoryState } from './repository_state';
import {
  WorkspaceSnapshot,
  createWorkspaceSnapshot,
  computeWorkspaceContentRootHash
} from './workspace_snapshot';

export interface WorkspaceRepoConfig {
  repositoryId: string;
  path: string;
}

export interface WorkspaceManagerOptions {
  rootDir?: string;
  repositories?: WorkspaceRepoConfig[];
}

const COMMON_LOCKFILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',
];

export class WorkspaceManager {
  private repositories: WorkspaceRepoConfig[];
  private snapshots: Map<string, WorkspaceSnapshot> = new Map();
  private latestSnapshotId?: string;

  constructor(options: WorkspaceManagerOptions = {}) {
    const root = path.resolve(options.rootDir || process.cwd());
    if (options.repositories && options.repositories.length > 0) {
      this.repositories = options.repositories.map((r) => ({
        repositoryId: r.repositoryId,
        path: path.resolve(root, r.path),
      }));
    } else {
      this.repositories = [{ repositoryId: 'root', path: root }];
    }
  }

  /**
   * Returns configured repositories.
   */
  public getRepositories(): WorkspaceRepoConfig[] {
    return [...this.repositories];
  }

  /**
   * Captures the live workspace state as an immutable WorkspaceSnapshot.
   */
  public async captureSnapshot(options: { parentSnapshotId?: string } = {}): Promise<WorkspaceSnapshot> {
    const repoStates: RepositoryState[] = [];

    for (const repo of this.repositories) {
      const state = await this.captureRepositoryState(repo.repositoryId, repo.path);
      repoStates.push(state);
    }

    const contentRootHash = computeWorkspaceContentRootHash(repoStates);

    // If workspace is unchanged from latest snapshot and no explicit parent override, return current snapshot
    if (this.latestSnapshotId && options.parentSnapshotId === undefined) {
      const latest = this.snapshots.get(this.latestSnapshotId);
      if (latest && latest.contentRootHash === contentRootHash) {
        return latest;
      }
    }

    const parentId = options.parentSnapshotId !== undefined ? options.parentSnapshotId : this.latestSnapshotId;
    const snapshot = createWorkspaceSnapshot({
      repositories: repoStates,
      parentSnapshotId: parentId,
    });

    this.snapshots.set(snapshot.workspaceSnapshotId, snapshot);
    this.latestSnapshotId = snapshot.workspaceSnapshotId;
    return snapshot;
  }

  /**
   * Helper to create a child snapshot linked to a specific parent snapshot.
   */
  public async createChildSnapshot(parentSnapshotId: string): Promise<WorkspaceSnapshot> {
    return this.captureSnapshot({ parentSnapshotId });
  }

  /**
   * Retrieves a snapshot by ID.
   */
  public getSnapshot(snapshotId: string): WorkspaceSnapshot | undefined {
    return this.snapshots.get(snapshotId);
  }

  /**
   * Retrieves the full lineage chain from root to this snapshot [W0, W1, ... W_target].
   */
  public getLineage(snapshotId: string): WorkspaceSnapshot[] {
    const chain: WorkspaceSnapshot[] = [];
    let currentId: string | undefined = snapshotId;

    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const snap = this.snapshots.get(currentId);
      if (!snap) break;
      chain.unshift(snap);
      currentId = snap.parentSnapshotId;
    }

    return chain;
  }

  /**
   * Captures the git or filesystem state for a single repository directory.
   */
  public async captureRepositoryState(repositoryId: string, repoDir: string): Promise<RepositoryState> {
    const isGit = this.isGitRepo(repoDir);

    if (!isGit) {
      return this.captureNonGitRepositoryState(repositoryId, repoDir);
    }

    return this.captureGitRepositoryState(repositoryId, repoDir);
  }

  private isGitRepo(dir: string): boolean {
    try {
      const res = execSync('git rev-parse --is-inside-work-tree', {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'ignore'],
        encoding: 'utf-8',
      });
      return res.trim() === 'true';
    } catch {
      return false;
    }
  }

  private captureGitRepositoryState(repositoryId: string, repoDir: string): RepositoryState {
    // 1. Base commit SHA
    let baseCommitSha: string | undefined;
    try {
      const commit = execSync('git rev-parse HEAD', {
        cwd: repoDir,
        stdio: ['pipe', 'pipe', 'ignore'],
        encoding: 'utf-8',
      }).trim();
      if (commit && commit.length === 40) {
        baseCommitSha = commit;
      }
    } catch {
      // Empty repository with no commits
      baseCommitSha = undefined;
    }

    // 2. Tracked tree hash (using index write-tree if available, else HEAD tree)
    let trackedTreeHash = 'empty_tree';
    try {
      trackedTreeHash = execSync('git write-tree', {
        cwd: repoDir,
        stdio: ['pipe', 'pipe', 'ignore'],
        encoding: 'utf-8',
      }).trim();
    } catch {
      if (baseCommitSha) {
        try {
          trackedTreeHash = execSync('git rev-parse HEAD^{tree}', {
            cwd: repoDir,
            stdio: ['pipe', 'pipe', 'ignore'],
            encoding: 'utf-8',
          }).trim();
        } catch {
          trackedTreeHash = 'unresolved_tree';
        }
      }
    }

    // 3. Dirty patch hash (captures both staged and working tree diff against HEAD)
    let dirtyPatchHash = 'clean';
    try {
      const diffCmd = baseCommitSha ? 'git diff-index -p HEAD' : 'git diff -p';
      const rawDiff = execSync(diffCmd, {
        cwd: repoDir,
        stdio: ['pipe', 'pipe', 'ignore'],
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });

      if (rawDiff.trim().length > 0) {
        dirtyPatchHash = 'diff_' + crypto.createHash('sha256').update(rawDiff).digest('hex').slice(0, 16);
      }
    } catch {
      dirtyPatchHash = 'clean';
    }

    // 4. Untracked files content hash
    let untrackedContentHash = 'none';
    try {
      const untrackedFilesRaw = execSync('git ls-files --others --exclude-standard', {
        cwd: repoDir,
        stdio: ['pipe', 'pipe', 'ignore'],
        encoding: 'utf-8',
      });

      const untrackedList = untrackedFilesRaw
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => f.length > 0)
        .sort();

      if (untrackedList.length > 0) {
        const untrackedHashes: string[] = [];
        for (const relFile of untrackedList) {
          const fullFile = path.join(repoDir, relFile);
          try {
            if (fs.existsSync(fullFile) && fs.statSync(fullFile).isFile()) {
              const fileBuf = fs.readFileSync(fullFile);
              const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex').slice(0, 16);
              untrackedHashes.push(`${relFile}:${fileHash}`);
            }
          } catch {
            // Ignore unreadable or transient files
          }
        }
        if (untrackedHashes.length > 0) {
          untrackedContentHash =
            'untracked_' +
            crypto.createHash('sha256').update(untrackedHashes.join(';')).digest('hex').slice(0, 16);
        }
      }
    } catch {
      untrackedContentHash = 'none';
    }

    // 5. Submodule state hash
    let submoduleStateHash: string | undefined;
    const gitmodulesPath = path.join(repoDir, '.gitmodules');
    if (fs.existsSync(gitmodulesPath)) {
      try {
        const status = execSync('git submodule status', {
          cwd: repoDir,
          stdio: ['pipe', 'pipe', 'ignore'],
          encoding: 'utf-8',
        }).trim();
        submoduleStateHash =
          'submod_' + crypto.createHash('sha256').update(status).digest('hex').slice(0, 16);
      } catch {
        submoduleStateHash = undefined;
      }
    }

    // 6. Dependency lock hash
    const dependencyLockHash = this.computeDependencyLockHash(repoDir);

    return {
      repositoryId,
      baseCommitSha,
      trackedTreeHash,
      dirtyPatchHash,
      untrackedContentHash,
      submoduleStateHash,
      dependencyLockHash,
    };
  }

  private captureNonGitRepositoryState(repositoryId: string, repoDir: string): RepositoryState {
    const fileHashes: string[] = [];

    const walk = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist' ||
          entry.name === 'build' ||
          entry.name === '.venv'
        ) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          try {
            const relPath = path.relative(repoDir, fullPath).replace(/\\/g, '/');
            const buf = fs.readFileSync(fullPath);
            const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
            fileHashes.push(`${relPath}:${hash}`);
          } catch {
            // Ignore unreadable
          }
        }
      }
    };

    try {
      walk(repoDir);
    } catch {
      // Directory may be unreadable
    }

    fileHashes.sort();
    const treeHash =
      'nongit_' + crypto.createHash('sha256').update(fileHashes.join(';')).digest('hex').slice(0, 16);

    const dependencyLockHash = this.computeDependencyLockHash(repoDir);

    return {
      repositoryId,
      trackedTreeHash: treeHash,
      dirtyPatchHash: 'clean',
      untrackedContentHash: 'none',
      dependencyLockHash,
    };
  }

  private computeDependencyLockHash(repoDir: string): string | undefined {
    const lockContents: string[] = [];
    for (const lockfileName of COMMON_LOCKFILES) {
      const fullPath = path.join(repoDir, lockfileName);
      if (fs.existsSync(fullPath)) {
        try {
          const buf = fs.readFileSync(fullPath);
          const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
          lockContents.push(`${lockfileName}:${hash}`);
        } catch {
          // Ignore
        }
      }
    }

    if (lockContents.length === 0) return undefined;
    lockContents.sort();
    return 'lock_' + crypto.createHash('sha256').update(lockContents.join(';')).digest('hex').slice(0, 16);
  }
}
