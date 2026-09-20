export enum TaskEvidenceKind {
  USER_PROMPT = 'USER_PROMPT',
  ISSUE = 'ISSUE',
  STACK_TRACE = 'STACK_TRACE',
  TEST_FAILURE = 'TEST_FAILURE',
  COMPILER_ERROR = 'COMPILER_ERROR',
  RUNTIME_LOG = 'RUNTIME_LOG',
  DIFF = 'DIFF',
  TICKET = 'TICKET',
}

export interface BaseTaskEvidence {
  evidenceId: string;
  kind: TaskEvidenceKind;
  timestamp: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface UserPromptEvidence extends BaseTaskEvidence {
  kind: TaskEvidenceKind.USER_PROMPT;
  prompt: string;
}

export interface IssueEvidence extends BaseTaskEvidence {
  kind: TaskEvidenceKind.ISSUE;
  issueNumber?: number | string;
  title: string;
  body: string;
  issueUrl?: string;
}

export interface StackTraceFrame {
  file: string;
  line?: number;
  column?: number;
  functionName?: string;
}

export interface StackTraceEvidence extends BaseTaskEvidence {
  kind: TaskEvidenceKind.STACK_TRACE;
  rawTrace: string;
  frames: StackTraceFrame[];
}

export interface TestFailureEvidence extends BaseTaskEvidence {
  kind: TaskEvidenceKind.TEST_FAILURE;
  testSuite?: string;
  testName: string;
  failureMessage: string;
  testFilePath?: string;
  stackTrace?: string;
}

export interface CompilerErrorEvidence extends BaseTaskEvidence {
  kind: TaskEvidenceKind.COMPILER_ERROR;
  compiler: string;
  errorCode?: string;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
}

export interface RuntimeLogEvidence extends BaseTaskEvidence {
  kind: TaskEvidenceKind.RUNTIME_LOG;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  logLines: string[];
  source?: string;
}

export interface DiffEvidence extends BaseTaskEvidence {
  kind: TaskEvidenceKind.DIFF;
  baseCommit?: string;
  targetCommit?: string;
  patchText: string;
  changedFiles: string[];
}

export interface TicketEvidence extends BaseTaskEvidence {
  kind: TaskEvidenceKind.TICKET;
  ticketId: string;
  system: 'jira' | 'linear' | 'github' | 'gitlab' | 'other';
  title: string;
  description: string;
  priority?: string;
}

export type TaskEvidence =
  | UserPromptEvidence
  | IssueEvidence
  | StackTraceEvidence
  | TestFailureEvidence
  | CompilerErrorEvidence
  | RuntimeLogEvidence
  | DiffEvidence
  | TicketEvidence;
