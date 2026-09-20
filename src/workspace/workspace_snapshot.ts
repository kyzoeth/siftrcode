import * as crypto from 'crypto';
import { RepositoryState, computeRepositoryCompositeHash } from './repository_state';

export interface WorkspaceSnapshot {
  workspaceSnapshotId: string;
  repositories: RepositoryState[];
  contentRootHash: string;
  parentSnapshotId?: string;
  createdAt: string;
}

export function computeWorkspaceContentRootHash(repositories: RepositoryState[]): string {
  const sortedRepoHashes = repositories
    .map((r) => `${r.repositoryId}=${computeRepositoryCompositeHash(r)}`)
    .sort()
    .join(';');

  return crypto.createHash('sha256').update(sortedRepoHashes).digest('hex');
}

export function computeWorkspaceSnapshotId(
  contentRootHash: string,
  parentSnapshotId?: string
): string {
  const payload = `${contentRootHash}:${parentSnapshotId || 'root'}`;
  return 'ws_' + crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function createWorkspaceSnapshot(params: {
  repositories: RepositoryState[];
  parentSnapshotId?: string;
  createdAt?: string;
}): WorkspaceSnapshot {
  const contentRootHash = computeWorkspaceContentRootHash(params.repositories);
  const workspaceSnapshotId = computeWorkspaceSnapshotId(contentRootHash, params.parentSnapshotId);

  return {
    workspaceSnapshotId,
    repositories: params.repositories.map((r) => ({ ...r })),
    contentRootHash,
    parentSnapshotId: params.parentSnapshotId,
    createdAt: params.createdAt || new Date().toISOString(),
  };
}
