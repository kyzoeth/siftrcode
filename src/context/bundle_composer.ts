/**
 * SiftrCode V2 - BundleComposer (Submodular Synergy & Evidence Coverage)
 * Composes coherent context bundles optimizing marginal utility, graph closure, and evidence coverage.
 */

import { RankedCandidate } from '../ranking/context_rank';
import { ContextUnit } from './context_unit';
import { ContextGraph } from '../graph/context_graph';
import {
  TaskEvidence,
  TaskEvidenceKind,
  StackTraceEvidence,
  TestFailureEvidence,
  CompilerErrorEvidence,
} from './task_evidence';

export interface BundleSelectionStep {
  contextUnitId: string;
  marginalGain: number;
  reasons: string[];
}

export interface ComposedBundle {
  selectedUnitIds: string[];
  totalTokens: number;
  bundleUtility: number;
  evidenceCoverageRatio: number; // [0.0, 1.0]
  selectionOrder: BundleSelectionStep[];
}

export interface BundleComposerOptions {
  maxUnits?: number;
  maxTokens?: number;
  synergyWeight?: number; // default: 1.5
  evidenceWeight?: number; // default: 3.0
  redundancyPenalty?: number; // default: 0.5
}

export class BundleComposer {
  private options: Required<BundleComposerOptions>;

  constructor(options: BundleComposerOptions = {}) {
    this.options = {
      maxUnits: options.maxUnits ?? 25,
      maxTokens: options.maxTokens ?? 16000,
      synergyWeight: options.synergyWeight ?? 1.5,
      evidenceWeight: options.evidenceWeight ?? 3.0,
      redundancyPenalty: options.redundancyPenalty ?? 0.5,
    };
  }

  /**
   * Composes a synergistic bundle from ranked candidates.
   */
  public compose(params: {
    rankedCandidates: RankedCandidate[];
    units: Map<string, ContextUnit>;
    graph?: ContextGraph;
    evidence?: TaskEvidence[];
  }): ComposedBundle {
    const { rankedCandidates, units, graph, evidence = [] } = params;

    // 1. Extract ground-truth evidence targets needing coverage
    const targetEvidencePaths = new Set<string>();
    for (const ev of evidence) {
      if (ev.kind === TaskEvidenceKind.STACK_TRACE) {
        const st = ev as StackTraceEvidence;
        for (const f of st.frames || []) targetEvidencePaths.add(f.file);
      } else if (ev.kind === TaskEvidenceKind.TEST_FAILURE) {
        const tf = ev as TestFailureEvidence;
        if (tf.testFilePath) targetEvidencePaths.add(tf.testFilePath);
      } else if (ev.kind === TaskEvidenceKind.COMPILER_ERROR) {
        const ce = ev as CompilerErrorEvidence;
        if (ce.filePath) targetEvidencePaths.add(ce.filePath);
      }
    }

    const coveredEvidencePaths = new Set<string>();
    const selectedIds = new Set<string>();
    const selectionOrder: BundleSelectionStep[] = [];
    let currentTokens = 0;
    let totalUtility = 0;

    const remainingCandidates = [...rankedCandidates];

    while (
      remainingCandidates.length > 0 &&
      selectedIds.size < this.options.maxUnits &&
      currentTokens < this.options.maxTokens
    ) {
      let bestCandidateIdx = -1;
      let bestMarginalGain = -Infinity;
      let bestReasons: string[] = [];

      for (let i = 0; i < remainingCandidates.length; i++) {
        const cand = remainingCandidates[i];
        const unit = units.get(cand.contextUnitId);
        const unitTokens = typeof unit?.metadata?.tokenEstimate === 'number'
          ? (unit.metadata.tokenEstimate as number)
          : cand.features.tokenEstimate;

        if (currentTokens + unitTokens > this.options.maxTokens) {
          continue; // Exceeds budget
        }

        // Compute Base Score contribution
        const baseGain = cand.finalScore / 10;
        const reasons: string[] = [`base_rank_score (+${baseGain.toFixed(1)})`];

        // Compute Synergy with already selected units in S
        let synergyGain = 0;
        if (graph) {
          for (const sId of selectedIds) {
            const dist = graph.getShortestDistance(sId, cand.contextUnitId);
            if (dist === 1) {
              synergyGain += this.options.synergyWeight;
              reasons.push(`direct_graph_synergy (+${this.options.synergyWeight})`);
              break;
            }
          }
        }

        // Compute Evidence Coverage marginal value
        let evidenceGain = 0;
        if (unit?.path && targetEvidencePaths.size > 0) {
          for (const ep of targetEvidencePaths) {
            if (!coveredEvidencePaths.has(ep) && (unit.path.includes(ep) || ep.includes(unit.path))) {
              evidenceGain += this.options.evidenceWeight * 10;
              reasons.push(`uncovered_evidence_target (+${(this.options.evidenceWeight * 10).toFixed(1)})`);
              break;
            }
          }
        }

        // Compute Redundancy Penalty
        let penalty = 0;
        if (unit?.path) {
          let sameFileCount = 0;
          for (const sId of selectedIds) {
            const sUnit = units.get(sId);
            if (sUnit?.path === unit.path) sameFileCount++;
          }
          if (sameFileCount > 2) {
            penalty = (sameFileCount - 2) * this.options.redundancyPenalty * 5;
            reasons.push(`file_saturation_redundancy (-${penalty.toFixed(1)})`);
          }
        }

        const marginalGain = baseGain + synergyGain + evidenceGain - penalty;

        if (marginalGain > bestMarginalGain) {
          bestMarginalGain = marginalGain;
          bestCandidateIdx = i;
          bestReasons = reasons;
        }
      }

      if (bestCandidateIdx === -1 || bestMarginalGain <= 0) {
        // No further candidate improves the bundle
        break;
      }

      const selected = remainingCandidates.splice(bestCandidateIdx, 1)[0];
      const selectedUnit = units.get(selected.contextUnitId);
      const unitTokens = typeof selectedUnit?.metadata?.tokenEstimate === 'number'
        ? (selectedUnit.metadata.tokenEstimate as number)
        : selected.features.tokenEstimate;

      selectedIds.add(selected.contextUnitId);
      currentTokens += unitTokens;
      totalUtility += bestMarginalGain;

      // Mark evidence paths as covered
      if (selectedUnit?.path) {
        for (const ep of targetEvidencePaths) {
          if (selectedUnit.path.includes(ep) || ep.includes(selectedUnit.path)) {
            coveredEvidencePaths.add(ep);
          }
        }
      }

      selectionOrder.push({
        contextUnitId: selected.contextUnitId,
        marginalGain: Number(bestMarginalGain.toFixed(2)),
        reasons: bestReasons,
      });
    }

    const evidenceCoverageRatio = targetEvidencePaths.size > 0
      ? coveredEvidencePaths.size / targetEvidencePaths.size
      : 1.0;

    return {
      selectedUnitIds: Array.from(selectedIds),
      totalTokens: currentTokens,
      bundleUtility: Number(totalUtility.toFixed(2)),
      evidenceCoverageRatio: Number(evidenceCoverageRatio.toFixed(2)),
      selectionOrder,
    };
  }
}
