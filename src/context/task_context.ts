import * as crypto from 'crypto';
import { TaskEvidence, TaskEvidenceKind, UserPromptEvidence } from './task_evidence';
import { AgentEnvironment } from '../agents/agent_environment';

export interface TaskContext {
  taskId: string;
  primaryPrompt: string;
  evidence: TaskEvidence[];
  workspaceSnapshotId: string;
  agentEnvironment: AgentEnvironment;
  createdAt: string;
}

export function createTaskContext(params: {
  taskId?: string;
  primaryPrompt: string;
  evidence?: TaskEvidence[];
  workspaceSnapshotId: string;
  agentEnvironment: AgentEnvironment;
  createdAt?: string;
}): TaskContext {
  const taskId = params.taskId || 'task_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const createdAt = params.createdAt || new Date().toISOString();

  // If evidence doesn't contain a USER_PROMPT evidence for primaryPrompt, synthesize one
  const evidenceList = params.evidence ? [...params.evidence] : [];
  const hasUserPrompt = evidenceList.some((e) => e.kind === TaskEvidenceKind.USER_PROMPT);
  if (!hasUserPrompt && params.primaryPrompt) {
    const promptEv: UserPromptEvidence = {
      evidenceId: 'ev_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      kind: TaskEvidenceKind.USER_PROMPT,
      prompt: params.primaryPrompt,
      timestamp: createdAt,
    };
    evidenceList.unshift(promptEv);
  }

  return {
    taskId,
    primaryPrompt: params.primaryPrompt,
    evidence: evidenceList,
    workspaceSnapshotId: params.workspaceSnapshotId,
    agentEnvironment: params.agentEnvironment,
    createdAt,
  };
}
