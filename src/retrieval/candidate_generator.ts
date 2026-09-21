import { ContextUnit } from '../context/context_unit';
import { TaskContext } from '../context/task_context';
import { ContextGraph, EdgeKind } from '../graph/context_graph';
import { GitGraphIntelligence } from '../graph/git_graph';
import { Candidate, createInitialCandidate, computeRecallAtK } from './candidate';
import { ExactRetriever } from './exact_retriever';
import { LexicalRetriever } from './lexical_retriever';
import { StackTraceRetriever } from './stack_trace_retriever';

export interface CandidateRecallMetrics {
  recallAt20: number;
  recallAt50: number;
  recallAt100: number;
  recallAt200: number;
}

export interface RecallAblationStep {
  name: string;
  edgeKinds?: EdgeKind[];
  candidateCount: number;
  metrics: CandidateRecallMetrics;
}

export interface RecallAblationReport {
  taskId: string;
  steps: RecallAblationStep[];
  upliftSummary: {
    baselineRecallAt20: number;
    fullGraphRecallAt20: number;
    upliftAt20: number;
    baselineRecallAt50: number;
    fullGraphRecallAt50: number;
    upliftAt50: number;
    baselineRecallAt100: number;
    fullGraphRecallAt100: number;
    upliftAt100: number;
  };
}

export interface CandidateGeneratorOptions {
  maxGraphHops?: number;
  maxCandidates?: number;
  edgeKinds?: EdgeKind[];
  traversalDirection?: 'outgoing' | 'incoming' | 'both';
}

export class CandidateGenerator {
  private exactRetriever = new ExactRetriever();
  private lexicalRetriever = new LexicalRetriever();
  private stackTraceRetriever = new StackTraceRetriever();

  /**
   * Generates candidate ContextUnits across independent retrieval channels:
   * exact matching, lexical search, runtime/stack trace matching, graph traversal, and git co-change.
   */
  public generateCandidates(
    task: TaskContext,
    units: ContextUnit[],
    graph?: ContextGraph,
    gitIntel?: GitGraphIntelligence,
    options: CandidateGeneratorOptions = {}
  ): Candidate[] {
    const candidateMap = new Map<string, Candidate>();
    const getOrCreate = (id: string): Candidate => {
      if (!candidateMap.has(id)) {
        candidateMap.set(id, createInitialCandidate(id));
      }
      return candidateMap.get(id)!;
    };

    // 1. Exact Retrieval
    const exactMatches = this.exactRetriever.retrieve(task, units);
    for (const match of exactMatches) {
      const c = getOrCreate(match.unitId);
      c.exactMatch = true;
      if (!c.retrievalSources.includes('exact')) {
        c.retrievalSources.push('exact');
      }
    }

    // 2. Lexical Retrieval
    const lexicalMatches = this.lexicalRetriever.search(task, units, 100);
    for (const match of lexicalMatches) {
      const c = getOrCreate(match.unitId);
      c.lexicalScore = match.score;
      if (!c.retrievalSources.includes('lexical')) {
        c.retrievalSources.push('lexical');
      }
    }

    // 3. Stack Trace / Runtime Evidence Retrieval
    const stackMatches = this.stackTraceRetriever.retrieve(task, units);
    for (const match of stackMatches) {
      const c = getOrCreate(match.unitId);
      c.runtimeEvidenceMatch = true;
      if (!c.retrievalSources.includes('stack_trace')) {
        c.retrievalSources.push('stack_trace');
      }
    }

    // 4. Graph Neighborhood Traversal from Seed Candidates
    if (graph) {
      const seeds = Array.from(candidateMap.keys());
      const maxHops = options.maxGraphHops ?? 2;
      const direction = options.traversalDirection ?? 'both';

      for (const seedId of seeds) {
        const neighbors = graph.getNeighborhood(seedId, maxHops, options.edgeKinds, direction);
        for (const neighbor of neighbors) {
          const c = getOrCreate(neighbor.nodeId);
          if (c.graphDistance === undefined || neighbor.distance < c.graphDistance) {
            c.graphDistance = neighbor.distance;
          }
          if (neighbor.path.includes(EdgeKind.TESTS)) {
            c.testRelationship = true;
          }
          if (!c.retrievalSources.includes('graph')) {
            c.retrievalSources.push('graph');
          }
        }
      }
    }

    // 5. Git Co-Change Expansion
    if (gitIntel) {
      const unitPathMap = new Map<string, string>();
      for (const u of units) {
        if (u.path) unitPathMap.set(u.path.toLowerCase(), u.id);
      }

      const seedUnits = units.filter((u) => candidateMap.has(u.id) && u.path);
      const coChanges = gitIntel.extractCoChangePairs();
      const coChangesByFrom = new Map<string, Array<{ fromPath: string; toPath: string; score: number }>>();

      for (const pair of coChanges) {
        const k = pair.fromPath.toLowerCase();
        if (!coChangesByFrom.has(k)) {
          coChangesByFrom.set(k, []);
        }
        coChangesByFrom.get(k)!.push(pair);
      }

      for (const seed of seedUnits) {
        if (!seed.path) continue;
        const pairs = coChangesByFrom.get(seed.path.toLowerCase());
        if (pairs) {
          for (const pair of pairs) {
            const partnerUnitId = unitPathMap.get(pair.toPath.toLowerCase());
            if (partnerUnitId) {
              const c = getOrCreate(partnerUnitId);
              c.coChangeScore = Math.max(c.coChangeScore || 0, pair.score);
              if (!c.retrievalSources.includes('git_co_change')) {
                c.retrievalSources.push('git_co_change');
              }
            }
          }
        }
      }
    }


    // Convert to array and rank by multi-channel fusion score
    const candidates = Array.from(candidateMap.values());
    candidates.sort((a, b) => this.calculateFusionScore(b) - this.calculateFusionScore(a));

    const maxCandidates = options.maxCandidates ?? 200;
    return candidates.slice(0, maxCandidates);
  }

  /**
   * Evaluates Candidate Recall across standard Recall@K thresholds (Section 40).
   */
  public evaluateRecall(candidates: Candidate[], groundTruthIds: string[]): CandidateRecallMetrics {
    return {
      recallAt20: computeRecallAtK(candidates, groundTruthIds, 20),
      recallAt50: computeRecallAtK(candidates, groundTruthIds, 50),
      recallAt100: computeRecallAtK(candidates, groundTruthIds, 100),
      recallAt200: computeRecallAtK(candidates, groundTruthIds, 200),
    };
  }

  /**
   * Evaluates Candidate Recall across edge ablations (Section 34):
   * 1. Lexical baseline (no graph traversal)
   * 2. Lexical + Import graph
   * 3. + CALLS
   * 4. + REFERENCES
   * 5. + TYPE_USES (Full graph)
   * Demonstrates empirical recall uplift before incorporating graph complexity.
   */
  public evaluateRecallAblation(
    task: TaskContext,
    units: ContextUnit[],
    graph: ContextGraph,
    groundTruthIds: string[],
    gitIntel?: GitGraphIntelligence
  ): RecallAblationReport {
    const ablationConfigs: Array<{ name: string; edgeKinds?: EdgeKind[]; useGraph: boolean }> = [
      { name: 'lexical_baseline', edgeKinds: [], useGraph: false },
      {
        name: 'lexical_plus_imports',
        edgeKinds: [EdgeKind.IMPORTS, EdgeKind.CONTAINS, EdgeKind.DECLARED_IN],
        useGraph: true,
      },
      {
        name: 'plus_calls',
        edgeKinds: [EdgeKind.IMPORTS, EdgeKind.CONTAINS, EdgeKind.DECLARED_IN, EdgeKind.CALLS],
        useGraph: true,
      },
      {
        name: 'plus_references',
        edgeKinds: [
          EdgeKind.IMPORTS,
          EdgeKind.CONTAINS,
          EdgeKind.DECLARED_IN,
          EdgeKind.CALLS,
          EdgeKind.REFERENCES,
        ],
        useGraph: true,
      },
      {
        name: 'plus_type_uses',
        edgeKinds: [
          EdgeKind.IMPORTS,
          EdgeKind.CONTAINS,
          EdgeKind.DECLARED_IN,
          EdgeKind.CALLS,
          EdgeKind.REFERENCES,
          EdgeKind.TYPE_USES,
          EdgeKind.IMPLEMENTS,
          EdgeKind.INHERITS,
        ],
        useGraph: true,
      },
    ];

    const steps: RecallAblationStep[] = [];

    for (const config of ablationConfigs) {
      const g = config.useGraph ? graph : undefined;
      const candidates = this.generateCandidates(task, units, g, gitIntel, {
        edgeKinds: config.edgeKinds,
        traversalDirection: 'both',
      });
      const metrics = this.evaluateRecall(candidates, groundTruthIds);
      steps.push({
        name: config.name,
        edgeKinds: config.edgeKinds,
        candidateCount: candidates.length,
        metrics,
      });
    }

    const baseline = steps.find((s) => s.name === 'lexical_plus_imports') || steps[0];
    const fullGraph = steps[steps.length - 1];

    return {
      taskId: task.taskId,
      steps,
      upliftSummary: {
        baselineRecallAt20: baseline.metrics.recallAt20,
        fullGraphRecallAt20: fullGraph.metrics.recallAt20,
        upliftAt20: Number((fullGraph.metrics.recallAt20 - baseline.metrics.recallAt20).toFixed(4)),
        baselineRecallAt50: baseline.metrics.recallAt50,
        fullGraphRecallAt50: fullGraph.metrics.recallAt50,
        upliftAt50: Number((fullGraph.metrics.recallAt50 - baseline.metrics.recallAt50).toFixed(4)),
        baselineRecallAt100: baseline.metrics.recallAt100,
        fullGraphRecallAt100: fullGraph.metrics.recallAt100,
        upliftAt100: Number((fullGraph.metrics.recallAt100 - baseline.metrics.recallAt100).toFixed(4)),
      },
    };
  }

  private calculateFusionScore(c: Candidate): number {
    let score = 0;
    if (c.exactMatch) score += 5.0;
    if (c.runtimeEvidenceMatch) score += 6.0;
    if (c.testRelationship) score += 2.0;
    if (c.lexicalScore) score += c.lexicalScore * 2.0;
    if (c.coChangeScore) score += c.coChangeScore * 2.0;
    if (c.graphDistance !== undefined) {
      score += Math.max(0, 3.0 - c.graphDistance);
    }
    score += c.retrievalSources.length;
    return score;
  }
}
