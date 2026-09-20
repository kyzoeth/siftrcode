import * as crypto from 'crypto';

export interface RepositoryState {
  repositoryId: string;
  baseCommitSha?: string;
  trackedTreeHash: string;
  dirtyPatchHash?: string;
  untrackedContentHash?: string;
  submoduleStateHash?: string;
  dependencyLockHash?: string;
}

export function computeRepositoryCompositeHash(state: RepositoryState): string {
  const content = [
    state.repositoryId,
    state.baseCommitSha || '',
    state.trackedTreeHash,
    state.dirtyPatchHash || '',
    state.untrackedContentHash || '',
    state.submoduleStateHash || '',
    state.dependencyLockHash || '',
  ].join(':');

  return crypto.createHash('sha256').update(content).digest('hex');
}
