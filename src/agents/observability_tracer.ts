/**
 * SiftrCode V2 - Observability Tracer
 * Collects agent tool calls, turns, and computes trajectory telemetry.
 */

import {
  AgentObservation,
  ObservabilityLevel,
  ToolCallRecord,
  extractGenericObservations,
} from './agent_adapter';

export interface AgentTurnRecord {
  role: 'agent' | 'user' | 'system';
  content: string;
  timestamp: number;
}

export interface ObservabilityMetrics {
  totalToolCalls: number;
  errorCount: number;
  errorRate: number;
  touchedFilesCount: number;
  executedCommandsCount: number;
  totalDurationMs: number;
}

export class ObservabilityTracer {
  private toolCalls: ToolCallRecord[] = [];
  private turns: AgentTurnRecord[] = [];
  private level: ObservabilityLevel;
  private taskId: string;

  constructor(taskId: string, level: ObservabilityLevel = 'FULL_TOOL_TRACE') {
    this.taskId = taskId;
    this.level = level;
  }

  public getTaskId(): string {
    return this.taskId;
  }

  public getLevel(): ObservabilityLevel {
    return this.level;
  }

  public recordToolCall(call: ToolCallRecord): void {
    if (this.level === 'SIFTR_CALLS_ONLY' && !call.toolName.startsWith('siftr_')) {
      return;
    }
    this.toolCalls.push(call);
  }

  public recordTurn(turn: { role: 'agent' | 'user' | 'system'; content: string; timestamp?: number }): void {
    this.turns.push({
      role: turn.role,
      content: turn.content,
      timestamp: turn.timestamp || Date.now(),
    });
  }

  public getToolCalls(): ToolCallRecord[] {
    return [...this.toolCalls];
  }

  public getTurns(): AgentTurnRecord[] {
    return [...this.turns];
  }

  public extractObservations(): AgentObservation {
    return extractGenericObservations(this.toolCalls);
  }

  public computeMetrics(): ObservabilityMetrics {
    const total = this.toolCalls.length;
    let errors = 0;
    let totalDuration = 0;

    for (const call of this.toolCalls) {
      if (call.error) errors++;
      if (call.durationMs) totalDuration += call.durationMs;
    }

    const obs = this.extractObservations();

    return {
      totalToolCalls: total,
      errorCount: errors,
      errorRate: total > 0 ? errors / total : 0,
      touchedFilesCount: obs.touchedFiles.length,
      executedCommandsCount: obs.executedCommands.length,
      totalDurationMs: totalDuration,
    };
  }

  public exportTrace(): {
    taskId: string;
    level: ObservabilityLevel;
    metrics: ObservabilityMetrics;
    observations: AgentObservation;
    toolCalls: ToolCallRecord[];
    turns: AgentTurnRecord[];
  } {
    return {
      taskId: this.taskId,
      level: this.level,
      metrics: this.computeMetrics(),
      observations: this.extractObservations(),
      toolCalls: this.getToolCalls(),
      turns: this.getTurns(),
    };
  }
}
