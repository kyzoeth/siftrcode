/**
 * SiftrCode V2 - Persisted Session Model (Final Closure Directive Section 14)
 * Authoritative lifecycle tracking connecting tasks, environments, snapshots, and outcomes.
 */

import * as crypto from 'crypto';

export type SiftrSessionStatus = 'STARTED' | 'ACTIVE' | 'COMPLETED' | 'ABORTED';

export interface SiftrSession {
  sessionId: string;
  taskId: string;
  agentEnvironmentId: string;
  initialWorkspaceSnapshotId: string;
  latestWorkspaceSnapshotId: string;
  status: SiftrSessionStatus;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  metadata?: Record<string, unknown>;
}

export function createSiftrSession(params: {
  sessionId?: string;
  taskId: string;
  agentEnvironmentId?: string;
  initialWorkspaceSnapshotId: string;
  latestWorkspaceSnapshotId?: string;
  status?: SiftrSessionStatus;
  metadata?: Record<string, unknown>;
}): SiftrSession {
  const now = new Date().toISOString();
  const sessionId =
    params.sessionId || `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  return {
    sessionId,
    taskId: params.taskId,
    agentEnvironmentId: params.agentEnvironmentId || 'unknown',
    initialWorkspaceSnapshotId: params.initialWorkspaceSnapshotId,
    latestWorkspaceSnapshotId: params.latestWorkspaceSnapshotId || params.initialWorkspaceSnapshotId,
    status: params.status || 'STARTED',
    createdAt: now,
    updatedAt: now,
    metadata: params.metadata,
  };
}
