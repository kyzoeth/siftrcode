/**
 * SiftrCode V2 - Workspace Error Hierarchy (Closure PR 0.2)
 * Defines typed error contracts for snapshot immutability and concurrency violations.
 */

export interface WorkspaceChangedErrorDetails {
  workspaceSnapshotId: string;
  filePath: string;
  expectedHash: string;
  actualHash: string;
  message?: string;
}

/**
 * Thrown when a file's content on disk diverges from the recorded hash of a WorkspaceSnapshot
 * during context planning or unit materialization (Section 39).
 */
export class WorkspaceChangedError extends Error {
  public readonly workspaceSnapshotId: string;
  public readonly filePath: string;
  public readonly expectedHash: string;
  public readonly actualHash: string;

  constructor(details: WorkspaceChangedErrorDetails) {
    const msg =
      details.message ||
      `Workspace modified concurrently during planning: file "${details.filePath}" mutated on disk ` +
      `(expected hash "${details.expectedHash.slice(0, 12)}...", actual hash "${details.actualHash.slice(0, 12)}...") ` +
      `under snapshot "${details.workspaceSnapshotId}".`;
    super(msg);
    this.name = 'WorkspaceChangedError';
    this.workspaceSnapshotId = details.workspaceSnapshotId;
    this.filePath = details.filePath;
    this.expectedHash = details.expectedHash;
    this.actualHash = details.actualHash;

    Object.setPrototypeOf(this, WorkspaceChangedError.prototype);
  }
}

/**
 * Type guard for WorkspaceChangedError.
 */
export function isWorkspaceChangedError(err: unknown): err is WorkspaceChangedError {
  return (
    err instanceof WorkspaceChangedError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as any).name === 'WorkspaceChangedError' &&
      typeof (err as any).workspaceSnapshotId === 'string' &&
      typeof (err as any).filePath === 'string')
  );
}
