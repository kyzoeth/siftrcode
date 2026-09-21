/**
 * SiftrCode V2 - Point-in-Time Feature Builder
 * Extracts immutable ContextFeaturesV1 for a given Candidate and TaskContext.
 */

import { ContextUnit, ContextUnitKind, isCodeSymbolUnit } from '../context/context_unit';
import { Candidate } from '../retrieval/candidate';
import { TaskContext } from '../context/task_context';
import {
  TaskEvidenceKind,
  StackTraceEvidence,
  TestFailureEvidence,
  CompilerErrorEvidence,
} from '../context/task_evidence';
import { ContextGraph } from '../graph/context_graph';
import { GitGraphIntelligence } from '../graph/git_graph';
import { FeatureCutoff } from '../learning/point_in_time_features';
import { ContextFeaturesV1 } from './feature_schema';

export interface BuildFeaturesParams {
  candidate: Candidate;
  unit: ContextUnit;
  task: TaskContext;
  graph?: ContextGraph;
  gitIntelligence?: GitGraphIntelligence;
  featureCutoff?: FeatureCutoff;
  seedUnitIds?: string[];
  dirtyPaths?: string[];
  recentWindowDays?: number;
}

export class FeatureBuilderV1 {
  /**
   * Build immutable ContextFeaturesV1 for a candidate unit.
   */
  public static buildFeatures(params: BuildFeaturesParams): ContextFeaturesV1 {
    const {
      candidate,
      unit,
      task,
      graph,
      gitIntelligence,
      featureCutoff,
      seedUnitIds = [],
      dirtyPaths = [],
      recentWindowDays = 30,
    } = params;

    // 1. Static Unit Features
    let tokenEstimate = typeof unit.metadata?.tokenEstimate === 'number' && unit.metadata.tokenEstimate > 0
      ? (unit.metadata.tokenEstimate as number)
      : Math.ceil(String(unit.metadata?.content || '').length / 4);

    if (tokenEstimate === 0) {
      if (isCodeSymbolUnit(unit) && unit.endLine >= unit.startLine) {
        tokenEstimate = Math.max(10, (unit.endLine - unit.startLine + 1) * 8);
      } else {
        tokenEstimate = 50;
      }
    }

    const isTest = unit.kind === ContextUnitKind.TEST || (unit.path?.toLowerCase().includes('test') ?? false);
    const isConfig = unit.kind === ContextUnitKind.CONFIG;
    const isDocumentation = unit.kind === ContextUnitKind.DOCUMENTATION;
    const isSchema = unit.kind === ContextUnitKind.SCHEMA || unit.kind === ContextUnitKind.MIGRATION;
    const isExported = Boolean(unit.metadata?.isExported);

    // 2. Lexical & Query Match Features
    const queryTokens = FeatureBuilderV1.tokenize(task.primaryPrompt);
    const unitText = `${unit.path || ''} ${unit.id} ${unit.metadata?.qualifiedName || ''} ${unit.metadata?.content || ''} ${unit.title}`;
    const unitTokens = new Set(FeatureBuilderV1.tokenize(unitText));

    let overlapCount = 0;
    for (const qt of queryTokens) {
      if (unitTokens.has(qt)) overlapCount++;
    }
    const tokenOverlapRatio = queryTokens.length > 0 ? overlapCount / queryTokens.length : 0;

    const exactSymbolMatch = candidate.exactMatch ||
      candidate.retrievalSources.includes('exact') ||
      Boolean(unit.metadata?.name && task.primaryPrompt.toLowerCase().includes(String(unit.metadata.name).toLowerCase())) ||
      Boolean(unit.title && task.primaryPrompt.toLowerCase().includes(unit.title.toLowerCase()));

    const exactPathMatch = Boolean(
      unit.path && task.primaryPrompt.toLowerCase().includes(unit.path.toLowerCase())
    );

    const bm25Score = candidate.lexicalScore ?? (tokenOverlapRatio * 10);

    // 3. Graph Topology Features
    let graphDegree = 0;
    let minDistanceToSeed: number | null = null;
    let isDirectDependency = false;
    let isDirectDependent = false;

    if (graph && graph.hasNode(unit.id)) {
      const incoming = graph.getIncoming(unit.id);
      const outgoing = graph.getOutgoing(unit.id);
      graphDegree = incoming.length + outgoing.length;

      for (const seedId of seedUnitIds) {
        if (!graph.hasNode(seedId)) continue;
        const d = graph.getShortestDistance(seedId, unit.id);
        if (d !== null) {
          if (minDistanceToSeed === null || d < minDistanceToSeed) {
            minDistanceToSeed = d;
          }
          if (d === 1) {
            if (outgoing.some((e) => e.to === seedId)) isDirectDependency = true;
            if (incoming.some((e) => e.from === seedId)) isDirectDependent = true;
          }
        }
      }
    }

    // 4. Runtime Evidence Features & Min Distance to Error Frames
    let inStackTrace = false;
    let isFailingTestTarget = false;
    let inCompilerError = false;
    const errorUnitPaths = new Set<string>();

    for (const ev of task.evidence || []) {
      if (ev.kind === TaskEvidenceKind.STACK_TRACE) {
        const trace = ev as StackTraceEvidence;
        for (const frame of trace.frames || []) {
          errorUnitPaths.add(frame.file);
          if (unit.path && frame.file.includes(unit.path)) {
            inStackTrace = true;
          }
        }
      } else if (ev.kind === TaskEvidenceKind.TEST_FAILURE) {
        const failure = ev as TestFailureEvidence;
        if (failure.testFilePath) errorUnitPaths.add(failure.testFilePath);
        if (unit.path && failure.testFilePath && failure.testFilePath.includes(unit.path)) {
          isFailingTestTarget = true;
        }
      } else if (ev.kind === TaskEvidenceKind.COMPILER_ERROR) {
        const comp = ev as CompilerErrorEvidence;
        if (comp.filePath) errorUnitPaths.add(comp.filePath);
        if (unit.path && comp.filePath && comp.filePath.includes(unit.path)) {
          inCompilerError = true;
        }
      }
    }

    const inDirtyDiff = Boolean(
      unit.path && dirtyPaths.some((dp) => dp.includes(unit.path!) || unit.path!.includes(dp))
    );

    // Distance to error frames in graph
    let minDistanceToErrorFrame: number | null = null;
    if (graph && graph.hasNode(unit.id)) {
      for (const errPath of errorUnitPaths) {
        for (const node of graph.getAllNodes()) {
          const nodePath = String(node.metadata?.path || '');
          if (nodePath && (nodePath.includes(errPath) || errPath.includes(nodePath))) {
            const d = graph.getShortestDistance(node.contextUnitId, unit.id);
            if (d !== null && (minDistanceToErrorFrame === null || d < minDistanceToErrorFrame)) {
              minDistanceToErrorFrame = d;
            }
          }
        }
      }
    }

    // 5. Point-in-Time Git Features (strictly cutoff-enforced)
    let changeFrequency = 0;
    let recentChangeFrequency = 0;
    let maxCoChangeWithSeeds = 0;

    if (gitIntelligence && unit.path) {
      changeFrequency = gitIntelligence.getFileChangeFrequency(unit.path, featureCutoff);
      recentChangeFrequency = gitIntelligence.getRecentChangeFrequency(unit.path, recentWindowDays, featureCutoff);

      for (const seedId of seedUnitIds) {
        const seedNode = graph?.getNode(seedId);
        const seedPath = seedNode ? String(seedNode.metadata?.path || '') : undefined;
        if (seedPath && seedPath !== unit.path) {
          const coChange = gitIntelligence.calculateCoChange(seedPath, unit.path, featureCutoff);
          if (coChange > maxCoChangeWithSeeds) {
            maxCoChangeWithSeeds = coChange;
          }
        }
      }
    }

    // 6. Heuristic Composite Score
    let heuristicScore = 0;
    if (inStackTrace) heuristicScore += 40;
    if (isFailingTestTarget) heuristicScore += 35;
    if (inCompilerError) heuristicScore += 35;
    if (inDirtyDiff) heuristicScore += 25;
    if (exactSymbolMatch) heuristicScore += 30;
    if (exactPathMatch) heuristicScore += 25;
    heuristicScore += Math.min(25, bm25Score);
    heuristicScore += tokenOverlapRatio * 15;

    if (minDistanceToSeed === 1) heuristicScore += 20;
    else if (minDistanceToSeed === 2) heuristicScore += 10;

    if (minDistanceToErrorFrame === 1) heuristicScore += 20;
    else if (minDistanceToErrorFrame === 2) heuristicScore += 10;

    heuristicScore += maxCoChangeWithSeeds * 15;
    heuristicScore += Math.min(10, recentChangeFrequency * 2);

    return {
      schemaVersion: 'v1',
      contextUnitId: unit.id,
      unitKind: unit.kind,
      tokenEstimate,
      isTest,
      isConfig,
      isDocumentation,
      isSchema,
      isExported,
      exactSymbolMatch,
      exactPathMatch,
      bm25Score,
      tokenOverlapRatio,
      graphDegree,
      minDistanceToSeed,
      minDistanceToErrorFrame,
      isDirectDependency,
      isDirectDependent,
      changeFrequency,
      recentChangeFrequency,
      maxCoChangeWithSeeds,
      inStackTrace,
      isFailingTestTarget,
      inCompilerError,
      inDirtyDiff,
      heuristicScore,
    };
  }

  private static tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2);
  }
}
