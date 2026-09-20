/**
 * SiftrCode V2 - Trajectory Event Logging
 * Records step-by-step agent lifecycle events subject to DataRights.
 */

import * as crypto from 'crypto';
import { DataRights, createDefaultDataRights } from '../rights/data_rights';

export type TrajectoryEventKind =
  | 'CONTEXT_ALLOCATED'
  | 'TOOL_CALL'
  | 'AGENT_TURN'
  | 'TEST_RUN'
  | 'DIFF_APPLIED'
  | 'SECURITY_BLOCKED';

export interface TrajectoryEvent {
  eventId: string;
  taskId: string;
  kind: TrajectoryEventKind;
  payload: Record<string, unknown>;
  timestamp: number;
  dataRights: DataRights;
}

export class TrajectoryLogger {
  private events: TrajectoryEvent[] = [];
  private taskId: string;
  private dataRights: DataRights;

  constructor(taskId: string, dataRights?: DataRights) {
    this.taskId = taskId;
    this.dataRights = dataRights ?? createDefaultDataRights();
  }

  public logEvent(kind: TrajectoryEventKind, payload: Record<string, unknown>): TrajectoryEvent | null {
    // If customer data rights prohibit trajectory retention, refuse to store
    if (!this.dataRights.trajectoryRetentionAllowed) {
      return null;
    }

    const event: TrajectoryEvent = {
      eventId: 'evt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      taskId: this.taskId,
      kind,
      payload: { ...payload },
      timestamp: Date.now(),
      dataRights: this.dataRights,
    };

    this.events.push(event);
    return event;
  }

  public getEvents(): TrajectoryEvent[] {
    return [...this.events];
  }

  public clear(): void {
    this.events = [];
  }
}
