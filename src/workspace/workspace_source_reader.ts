import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WorkspaceSnapshot } from './workspace_snapshot';

export type SourceReadStatus = 'OK' | 'WORKSPACE_CHANGED' | 'FILE_NOT_FOUND' | 'OUTSIDE_WORKSPACE';

export interface SourceReadResult {
  content: string;
  contentHash: string;
  byteLength: number;
  status: SourceReadStatus;
  errorMessage?: string;
}

export interface WorkspaceSourceReader {
  readFile(
    snapshot: WorkspaceSnapshot,
    repositoryId: string,
    relativePath: string
  ): Promise<SourceReadResult>;

  readFileSync(
    snapshot: WorkspaceSnapshot,
    repositoryId: string,
    relativePath: string
  ): SourceReadResult;

  resolveSafeWorkspacePath(
    workspaceRoot: string,
    targetPath: string
  ): string | null;

  validateSnapshotIntegrity(
    snapshot: WorkspaceSnapshot,
    repositoryId: string
  ): Promise<{ valid: boolean; reason?: string }>;
}

export class DefaultWorkspaceSourceReader implements WorkspaceSourceReader {
  private rootDir: string;
  private knownFileHashes: Map<string, string> = new Map(); // snapshotId:path -> hash

  constructor(rootDir: string = process.cwd()) {
    this.rootDir = path.resolve(rootDir);
  }

  /**
   * Resolves targetPath relative to workspaceRoot, verifying strictly that the
   * canonical resolved path is a descendant of the workspace root.
   * Defends against directory traversal (../), absolute paths, and symlink escapes.
   */
  public resolveSafeWorkspacePath(workspaceRoot: string, targetPath: string): string | null {
    try {
      const rootResolved = path.resolve(workspaceRoot);
      let realRoot = rootResolved;
      try {
        if (fs.existsSync(rootResolved)) {
          realRoot = fs.realpathSync(rootResolved);
        }
      } catch {
        // Fall back to resolved path
      }

      // Check for path traversal or absolute escape
      const candidatePath = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(realRoot, targetPath);

      // Verify prefix before resolving symlinks
      const normRealRoot = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
      if (candidatePath !== realRoot && !candidatePath.startsWith(normRealRoot)) {
        return null; // Outside workspace
      }

      // If file exists, resolve its realpath to catch symlink escapes
      if (fs.existsSync(candidatePath)) {
        const realCandidate = fs.realpathSync(candidatePath);
        if (realCandidate !== realRoot && !realCandidate.startsWith(normRealRoot)) {
          return null; // Symlink escaped workspace root!
        }
        return realCandidate;
      }

      return candidatePath;
    } catch {
      return null;
    }
  }

  /**
   * Records expected file hash for a snapshot to detect WORKSPACE_CHANGED on materialization.
   */
  public recordExpectedHash(snapshotId: string, relativePath: string, expectedHash: string): void {
    const key = `${snapshotId}:${relativePath.replace(/\\/g, '/')}`;
    this.knownFileHashes.set(key, expectedHash);
  }

  /**
   * Reads a file synchronously for a specific WorkspaceSnapshot, verifying path containment and snapshot validity.
   */
  public readFileSync(
    snapshot: WorkspaceSnapshot,
    repositoryId: string,
    relativePath: string
  ): SourceReadResult {
    const repo = snapshot.repositories.find((r) => r.repositoryId === repositoryId) || snapshot.repositories[0];
    const repoPath = repo && repo.repositoryId !== 'root'
      ? path.resolve(this.rootDir, repo.repositoryId)
      : this.rootDir;

    const safePath = this.resolveSafeWorkspacePath(repoPath, relativePath);
    if (!safePath) {
      return {
        content: '',
        contentHash: '',
        byteLength: 0,
        status: 'OUTSIDE_WORKSPACE',
        errorMessage: `Path "${relativePath}" escapes workspace boundary "${repoPath}".`,
      };
    }

    if (!fs.existsSync(safePath)) {
      return {
        content: '',
        contentHash: '',
        byteLength: 0,
        status: 'FILE_NOT_FOUND',
        errorMessage: `File not found on disk: "${relativePath}".`,
      };
    }

    try {
      const rawBuffer = fs.readFileSync(safePath);
      const content = rawBuffer.toString('utf-8');
      const contentHash = crypto.createHash('sha256').update(content).digest('hex');

      // Check if this file had an expected hash associated with this snapshot
      const normRelPath = relativePath.replace(/\\/g, '/');
      const key = `${snapshot.workspaceSnapshotId}:${normRelPath}`;
      const expectedHash = this.knownFileHashes.get(key);

      if (expectedHash && expectedHash !== contentHash) {
        return {
          content,
          contentHash,
          byteLength: rawBuffer.length,
          status: 'WORKSPACE_CHANGED',
          errorMessage: `File content hash "${contentHash.slice(0, 12)}" does not match snapshot hash "${expectedHash.slice(0, 12)}" for ${relativePath}.`,
        };
      }

      return {
        content,
        contentHash,
        byteLength: rawBuffer.length,
        status: 'OK',
      };
    } catch (err: any) {
      return {
        content: '',
        contentHash: '',
        byteLength: 0,
        status: 'FILE_NOT_FOUND',
        errorMessage: err.message,
      };
    }
  }

  /**
   * Reads a file asynchronously for a specific WorkspaceSnapshot.
   */
  public async readFile(
    snapshot: WorkspaceSnapshot,
    repositoryId: string,
    relativePath: string
  ): Promise<SourceReadResult> {
    return this.readFileSync(snapshot, repositoryId, relativePath);
  }

  /**
   * Validates whether live repository state on disk still matches the snapshot.
   */
  public async validateSnapshotIntegrity(
    snapshot: WorkspaceSnapshot,
    repositoryId: string
  ): Promise<{ valid: boolean; reason?: string }> {
    const repo = snapshot.repositories.find((r) => r.repositoryId === repositoryId);
    if (!repo) {
      return { valid: false, reason: `Repository "${repositoryId}" not found in snapshot.` };
    }

    // If dirty patch was recorded as 'clean', check if git is still clean
    if (repo.dirtyPatchHash === 'clean') {
      try {
        const out = require('child_process').execSync('git status --porcelain', {
          cwd: this.rootDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        if (out.trim().length > 0) {
          return { valid: false, reason: 'Workspace has dirty uncommitted changes that were not in snapshot.' };
        }
      } catch {
        // Not a git repo or check skipped
      }
    }

    return { valid: true };
  }
}
