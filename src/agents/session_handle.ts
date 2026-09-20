/**
 * SiftrCode V2 - Stateless Session Handles
 * Enables state preservation across independent MCP calls without relying on server process state.
 */

import * as crypto from 'crypto';

export interface SessionHandle {
  taskId: string;
  siftrSessionId: string;
  workspaceSnapshotId: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

const SESSION_HANDLE_MAGIC = 'siftr_sess_';

export function createSessionHandle(
  taskId: string,
  siftrSessionId: string,
  workspaceSnapshotId: string,
  metadata?: Record<string, unknown>
): SessionHandle {
  const now = Date.now();
  return {
    taskId,
    siftrSessionId,
    workspaceSnapshotId,
    createdAt: now,
    updatedAt: now,
    metadata,
  };
}

/**
 * Serializes a SessionHandle into a secure, URL-safe base64 string with checksum
 */
export function serializeSessionHandle(handle: SessionHandle, secretKey = 'siftr_stateless_v2'): string {
  const payloadJson = JSON.stringify({
    taskId: handle.taskId,
    siftrSessionId: handle.siftrSessionId,
    workspaceSnapshotId: handle.workspaceSnapshotId,
    createdAt: handle.createdAt,
    updatedAt: handle.updatedAt,
    metadata: handle.metadata || {},
  });

  const payloadBase64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(payloadBase64)
    .digest('base64url')
    .slice(0, 16);

  return `${SESSION_HANDLE_MAGIC}${payloadBase64}.${signature}`;
}

/**
 * Deserializes and verifies a session handle token
 */
export function deserializeSessionHandle(token: string, secretKey = 'siftr_stateless_v2'): SessionHandle {
  if (!token || !token.startsWith(SESSION_HANDLE_MAGIC)) {
    throw new Error('Invalid session handle format: missing prefix');
  }

  const tokenBody = token.slice(SESSION_HANDLE_MAGIC.length);
  const parts = tokenBody.split('.');
  if (parts.length !== 2) {
    throw new Error('Invalid session handle format: expected payload and signature');
  }

  const [payloadBase64, providedSig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', secretKey)
    .update(payloadBase64)
    .digest('base64url')
    .slice(0, 16);

  if (providedSig !== expectedSig) {
    throw new Error('Invalid session handle: signature verification failed');
  }

  try {
    const rawJson = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    const parsed = JSON.parse(rawJson);

    if (!parsed.taskId || !parsed.siftrSessionId || !parsed.workspaceSnapshotId) {
      throw new Error('Invalid session handle: missing required fields');
    }

    return {
      taskId: String(parsed.taskId),
      siftrSessionId: String(parsed.siftrSessionId),
      workspaceSnapshotId: String(parsed.workspaceSnapshotId),
      createdAt: Number(parsed.createdAt) || Date.now(),
      updatedAt: Number(parsed.updatedAt) || Date.now(),
      metadata: parsed.metadata,
    };
  } catch (err) {
    throw new Error(`Failed to decode session handle payload: ${err instanceof Error ? err.message : String(err)}`);
  }
}
