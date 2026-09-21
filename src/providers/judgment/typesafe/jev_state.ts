/**
 * SiftrCode V2 - JEV Candidate State V1 (Milestone Part V Sections 10-13)
 * Compact, bounded structured evidence representation for evaluating candidate utility.
 * Invariant: Never includes full repo files, ContextRank score, future outcomes, or gold labels.
 */

import { ContextUnit, ContextUnitKind, CodeSymbolUnit, isCodeSymbolUnit } from '../../../context/context_unit';
import { TaskContext } from '../../../context/task_context';
import { ContextGraph } from '../../../graph/context_graph';
import { ContextFeaturesV1 } from '../../../ranking/feature_schema';
import { WorkspaceSnapshot } from '../../../workspace/workspace_snapshot';

export interface JevCandidateStateV1 {
  schemaVersion: 'jev-state-v1';
  task: {
    prompt: string;
    evidenceSummary?: string;
    taskType?: string;
  };
  candidate: {
    contextUnitId: string;
    kind: ContextUnitKind;
    title: string;
    path?: string;
    signature?: string;
    safeSourceExcerpt?: string;
  };
  relationships: {
    callers?: string[];
    callees?: string[];
    references?: string[];
    tests?: string[];
    types?: string[];
    configures?: string[];
  };
  history: {
    coChange?: number;
    recentChange?: number;
  };
}

export function buildJevCandidateState(params: {
  task: TaskContext;
  candidate: ContextUnit;
  graph?: ContextGraph;
  features?: ContextFeaturesV1;
  snapshot?: WorkspaceSnapshot;
  safeSourceExcerpt?: string;
}): JevCandidateStateV1 {
  const { task, candidate, graph, features, safeSourceExcerpt } = params;

  // 1. Task evidence summary (Part V Section 12)
  let evidenceSummary: string | undefined = undefined;
  if (task.evidence && task.evidence.length > 0) {
    const kinds = task.evidence.map((e) => e.kind).join(', ');
    evidenceSummary = `Evidence attached: [${kinds}]`;
  }

  // 2. Candidate bounded representation (Part V Section 13)
  const isSymbol = isCodeSymbolUnit(candidate);
  const signature = isSymbol ? (candidate as CodeSymbolUnit).signature : undefined;

  // 3. Relationships from graph (Part V Section 10)
  const relationships: JevCandidateStateV1['relationships'] = {};
  if (graph) {
    const outgoing = graph.getOutgoing(candidate.id);
    if (outgoing.length > 0) {
      relationships.references = outgoing.slice(0, 10).map((e) => e.to);
    }
  }

  // 4. History signals
  const history: JevCandidateStateV1['history'] = {
    coChange: features?.maxCoChangeWithSeeds,
    recentChange: features?.recentChangeFrequency,
  };

  return {
    schemaVersion: 'jev-state-v1',
    task: {
      prompt: task.primaryPrompt,
      evidenceSummary,
      taskType: task.evidence && task.evidence.length > 0 ? task.evidence[0].kind : undefined,
    },
    candidate: {
      contextUnitId: candidate.id,
      kind: candidate.kind,
      title: candidate.title,
      path: candidate.path,
      signature,
      safeSourceExcerpt: safeSourceExcerpt ? safeSourceExcerpt.slice(0, 1500) : undefined,
    },
    relationships,
    history,
  };
}
