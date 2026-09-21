/**
 * SiftrCode V3 - Point-in-Time Feature Builder V3.1 (Phase V3.1D)
 *
 * Extracts immutable ContextFeaturesV3_1 for candidate ContextUnits under strict
 * point-in-time constraints (Git history <= C0, no post-outcome evidence leakage).
 */

import { ContextUnit, ContextUnitKind, isCodeSymbolUnit } from '../../context/context_unit';
import { Candidate } from '../../retrieval/candidate';
import { TaskContext } from '../../context/task_context';
import {
  TaskEvidenceKind,
  StackTraceEvidence,
  TestFailureEvidence,
  CompilerErrorEvidence,
} from '../../context/task_evidence';
import { ContextGraph } from '../../graph/context_graph';
import { GitGraphIntelligence } from '../../graph/git_graph';
import { FeatureCutoff, createFeatureCutoff } from '../point_in_time_features';
import { JudgmentResult } from '../../jev/judgment_provider';
import {
  ContextFeaturesV3_1,
  CONTEXT_RANK_FEATURES_V3_1_SCHEMA,
  PROHIBITED_FEATURE_FIELDS,
} from './feature_set_v3_1';

export interface BuildFeaturesV3_1Params {
  candidate: Candidate;
  unit: ContextUnit;
  task: TaskContext;
  graph?: ContextGraph;
  gitIntelligence?: GitGraphIntelligence;
  featureCutoff?: FeatureCutoff;
  seedUnitIds?: string[];
  dirtyPaths?: string[];
  judgment?: JudgmentResult;
  recentWindowDays?: number;
}

export class FeatureBuilderV3_1 {
  /**
   * Build immutable ContextFeaturesV3_1 for a candidate unit.
   */
  public static buildFeatures(params: BuildFeaturesV3_1Params): ContextFeaturesV3_1 {
    const {
      candidate,
      unit,
      task,
      graph,
      gitIntelligence,
      featureCutoff,
      seedUnitIds = [],
      dirtyPaths = [],
      judgment,
      recentWindowDays = 30,
    } = params;

    const cutoff = featureCutoff || createFeatureCutoff({
      workspaceSnapshotId: task.workspaceSnapshotId,
    });

    // 1. Static Unit Features
    let tokenEstimate =
      typeof unit.metadata?.tokenEstimate === 'number' && unit.metadata.tokenEstimate > 0
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
    const queryTokens = FeatureBuilderV3_1.tokenize(task.primaryPrompt);
    const unitText = `${unit.path || ''} ${unit.id} ${unit.metadata?.qualifiedName || ''} ${unit.metadata?.content || ''} ${unit.title}`;
    const unitTokens = new Set(FeatureBuilderV3_1.tokenize(unitText));

    let overlapCount = 0;
    for (const qt of queryTokens) {
      if (unitTokens.has(qt)) overlapCount++;
    }
    const tokenOverlapRatio = queryTokens.length > 0 ? overlapCount / queryTokens.length : 0;

    const exactSymbolMatch =
      candidate.exactMatch ||
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

    // 5. Point-in-Time Git Features (strictly cutoff-enforced <= C0)
    let changeFrequency = 0;
    let recentChangeFrequency = 0;
    let maxCoChangeWithSeeds = 0;

    if (gitIntelligence && unit.path) {
      changeFrequency = gitIntelligence.getFileChangeFrequency(unit.path, cutoff);
      recentChangeFrequency = gitIntelligence.getRecentChangeFrequency(unit.path, recentWindowDays, cutoff);

      for (const seedId of seedUnitIds) {
        const seedNode = graph?.getNode(seedId);
        const seedPath = seedNode ? String(seedNode.metadata?.path || '') : undefined;
        if (seedPath && seedPath !== unit.path) {
          const coChange = gitIntelligence.calculateCoChange(seedPath, unit.path, cutoff);
          if (coChange > maxCoChangeWithSeeds) {
            maxCoChangeWithSeeds = coChange;
          }
        }
      }
    }

    // 6. Retrieval Source Indicators
    const sources = candidate.retrievalSources || [];
    const fromExactRetrieval = sources.includes('exact');
    const fromLexicalRetrieval = sources.includes('lexical') || sources.includes('bm25');
    const fromGraphRetrieval = sources.includes('graph');
    const fromGitRetrieval = sources.includes('git');
    const fromRuntimeRetrieval = sources.includes('runtime') || sources.includes('stack_trace');

    // 7. Deterministic Baseline Heuristic Score
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

    // 8. Continuous JEV Probabilities (Teacher / Feature signals)
    const hasJevSignals = Boolean(judgment);
    const semanticRelevanceProbability = judgment?.semanticRelevanceProbability ?? null;
    const implementationNeededProbability = judgment?.implementationNeededProbability ?? null;
    const likelyEditTargetProbability = judgment?.likelyEditTargetProbability ?? null;
    const likelyRootCauseProbability = judgment?.likelyRootCauseProbability ?? null;

    const features: ContextFeaturesV3_1 = {
      schemaVersion: CONTEXT_RANK_FEATURES_V3_1_SCHEMA,
      contextUnitId: unit.id,
      temporalCutoff: cutoff.timestamp,
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
      fromExactRetrieval,
      fromLexicalRetrieval,
      fromGraphRetrieval,
      fromGitRetrieval,
      fromRuntimeRetrieval,
      heuristicScore,
      hasJevSignals,
      semanticRelevanceProbability,
      implementationNeededProbability,
      likelyEditTargetProbability,
      likelyRootCauseProbability,
    };

    // Assert no prohibited fields leaked into feature map
    FeatureBuilderV3_1.assertNoLeakage(features as unknown as Record<string, unknown>);

    return features;
  }

  /**
   * Asserts that no post-outcome, future, or ground-truth properties are attached.
   */
  public static assertNoLeakage(features: Record<string, unknown>): void {
    for (const prohibited of PROHIBITED_FEATURE_FIELDS) {
      if (prohibited in features && features[prohibited] !== undefined) {
        throw new Error(`FEATURE_LEAKAGE_DETECTED: Prohibited field "${prohibited}" found in model features.`);
      }
    }
  }

  private static tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2);
  }
}
