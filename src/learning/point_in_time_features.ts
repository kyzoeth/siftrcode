export interface FeatureCutoff {
  timestamp: string;
  workspaceSnapshotId: string;
}

export function createFeatureCutoff(params: {
  timestamp?: string;
  workspaceSnapshotId: string;
}): FeatureCutoff {
  return {
    timestamp: params.timestamp || new Date().toISOString(),
    workspaceSnapshotId: params.workspaceSnapshotId,
  };
}

export function isTimestampBeforeCutoff(timestampIsoOrEpoch: string | number, cutoff: FeatureCutoff): boolean {
  const targetMs = typeof timestampIsoOrEpoch === 'number'
    ? (timestampIsoOrEpoch < 10000000000 ? timestampIsoOrEpoch * 1000 : timestampIsoOrEpoch)
    : new Date(timestampIsoOrEpoch).getTime();

  const cutoffMs = new Date(cutoff.timestamp).getTime();
  return targetMs <= cutoffMs;
}
