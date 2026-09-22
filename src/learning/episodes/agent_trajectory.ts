/**
 * SiftrCode V2 - Agent Trajectory Capture (Phase 20D)
 *
 * Bounded structured trajectory tracking for coding agent actions.
 * Invariant: Never capture secrets, credentials, environment variables, or
 * unbounded raw transcripts. Metadata is scrubbed before retention.
 */

import { scrubTrajectoryMetadata } from '../../security/secret_scrubber';

export type AgentTrajectoryEventType =
  | 'CONTEXT_SHOWN'
  | 'FILE_READ'
  | 'SYMBOL_READ'
  | 'SEARCH'
  | 'FILE_EDIT'
  | 'FILE_CREATE'
  | 'FILE_DELETE'
  | 'TEST_RUN'
  | 'BUILD_RUN'
  | 'TYPECHECK_RUN'
  | 'VERIFIER_RUN'
  | 'TOOL_ERROR'
  | 'AGENT_FINISH';

export interface AgentTrajectoryEvent {
  eventId: string;
  episodeId: string;
  timestamp: string;
  sequence: number;
  type: AgentTrajectoryEventType;
  path?: string;
  contextUnitId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentTrajectorySummary {
  eventCount: number;
  readCount: number;
  editCount: number;
  testRunCount: number;
  buildRunCount: number;
  verifierRunCount: number;
  toolErrorCount: number;
  readPaths: string[];
  editedPaths: string[];
  trajectoryDurationMs?: number;
}

/**
 * Creates a sanitized agent trajectory event, stripping sensitive fields.
 */
export function createAgentTrajectoryEvent(params: {
  eventId?: string;
  episodeId: string;
  timestamp?: string;
  sequence: number;
  type: AgentTrajectoryEventType;
  path?: string;
  contextUnitId?: string;
  metadata?: Record<string, unknown>;
}): AgentTrajectoryEvent {
  const eventId = params.eventId || `ev_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
  const timestamp = params.timestamp || new Date().toISOString();
  const metadata = params.metadata ? scrubTrajectoryMetadata(params.metadata) : undefined;

  return {
    eventId,
    episodeId: params.episodeId,
    timestamp,
    sequence: params.sequence,
    type: params.type,
    path: params.path,
    contextUnitId: params.contextUnitId,
    metadata,
  };
}

/**
 * Computes a summary over an ordered series of trajectory events.
 */
export function summarizeTrajectory(events: AgentTrajectoryEvent[]): AgentTrajectorySummary {
  const readPaths = new Set<string>();
  const editedPaths = new Set<string>();

  let readCount = 0;
  let editCount = 0;
  let testRunCount = 0;
  let buildRunCount = 0;
  let verifierRunCount = 0;
  let toolErrorCount = 0;

  for (const ev of events) {
    switch (ev.type) {
      case 'FILE_READ':
      case 'SYMBOL_READ':
        readCount++;
        if (ev.path) readPaths.add(ev.path);
        break;
      case 'FILE_EDIT':
      case 'FILE_CREATE':
      case 'FILE_DELETE':
        editCount++;
        if (ev.path) editedPaths.add(ev.path);
        break;
      case 'TEST_RUN':
        testRunCount++;
        break;
      case 'BUILD_RUN':
      case 'TYPECHECK_RUN':
        buildRunCount++;
        break;
      case 'VERIFIER_RUN':
        verifierRunCount++;
        break;
      case 'TOOL_ERROR':
        toolErrorCount++;
        break;
    }
  }

  let trajectoryDurationMs: number | undefined;
  if (events.length > 1) {
    const start = new Date(events[0].timestamp).getTime();
    const end = new Date(events[events.length - 1].timestamp).getTime();
    if (!isNaN(start) && !isNaN(end) && end >= start) {
      trajectoryDurationMs = end - start;
    }
  }

  return {
    eventCount: events.length,
    readCount,
    editCount,
    testRunCount,
    buildRunCount,
    verifierRunCount,
    toolErrorCount,
    readPaths: Array.from(readPaths),
    editedPaths: Array.from(editedPaths),
    trajectoryDurationMs,
  };
}
