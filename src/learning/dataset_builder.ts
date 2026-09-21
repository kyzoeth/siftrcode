import * as crypto from 'crypto';
import {
  CandidateObservationV2,
  computeLabelEvidence,
  ObservedBehavior,
  ResolvedOutcomeLabel,
  LabelEvidence,
} from '../telemetry/candidate_observation';
import { CandidateDecisionObservation } from '../telemetry/decision_observation';
import { OutcomeEvidence } from '../telemetry/outcome_evidence';

export interface BuildObservationOptions {
  decision: CandidateDecisionObservation;
  behavior?: ObservedBehavior;
  outcomeEvidence?: OutcomeEvidence;
  taskSucceeded?: boolean;
  siftrSessionId?: string;
  outcomeId?: string;
  rightsReference?: string;
}

export interface BuildDatasetOptions {
  decisions: CandidateDecisionObservation[];
  behaviorsByUnitId?: Map<string, ObservedBehavior> | Record<string, ObservedBehavior>;
  outcomeEvidence?: OutcomeEvidence;
  taskSucceeded?: boolean;
  siftrSessionId?: string;
  outcomeId?: string;
  rightsReference?: string;
}

/**
 * SiftrCode V2 DatasetBuilder (Closure PR 0.4)
 * Generates final training observations by joining immutable decision observations
 * with downstream behavior evidence and outcome evidence.
 */
export class DatasetBuilder {
  /**
   * Builds a single CandidateObservationV2 by joining an immutable decision observation
   * with downstream behavior and outcome evidence.
   */
  public static buildCandidateObservation(options: BuildObservationOptions): CandidateObservationV2 {
    const { decision } = options;
    const behavior: ObservedBehavior = options.behavior || {};

    const taskSucceeded = options.taskSucceeded !== undefined
      ? options.taskSucceeded
      : (options.outcomeEvidence ? options.outcomeEvidence.verifiedSuccess === true : undefined);

    const { evidence, outcomeLabel } = computeLabelEvidence({
      exposure: decision.exposureDecision,
      observabilityLevel: decision.observabilityLevel,
      observedBehavior: behavior,
      taskSucceeded,
    });

    if (options.outcomeEvidence) {
      evidence.push({
        labelType: 'OUTCOME_ASSOCIATION',
        value: options.outcomeEvidence.verifiedSuccess ? 1.0 : 0.0,
        confidence: options.outcomeEvidence.confidence,
        strength: options.outcomeEvidence.confidence >= 0.8 ? 'STRONG' : 'WEAK',
        source: options.outcomeEvidence.evaluationRationale || 'outcome_evidence',
      });
    }

    const observationId = `cobs_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const siftrSessionId = options.siftrSessionId || `sess_${decision.taskId}`;
    const rightsReference = options.rightsReference || `rights_${decision.workspaceSnapshotId}`;
    const outcomeId = options.outcomeId || options.outcomeEvidence?.outcomeId;

    return {
      schemaVersion: '2',
      observationId,
      taskId: decision.taskId,
      siftrSessionId,
      workspaceSnapshotId: decision.workspaceSnapshotId,
      contextUnitId: decision.contextUnitId,
      agentEnvironmentId: decision.agentEnvironment.systemConfigurationHash,
      observabilityLevel: decision.observabilityLevel,
      featureSchemaVersion: decision.features.schemaVersion || 'v1',
      features: decision.features,
      candidate: {
        generated: decision.candidate.generated,
        candidateRank: decision.rank,
        retrievalSources: [...decision.candidate.retrievalSources],
      },
      exposure: decision.exposureDecision,
      observedBehavior: behavior,
      evidence,
      outcomeLabel,
      outcomeId,
      rightsReference,
      recordedAt: new Date().toISOString(),
    };
  }

  /**
   * Builds an entire dataset of CandidateObservationV2 records for a collection of decisions.
   */
  public static buildDataset(options: BuildDatasetOptions): CandidateObservationV2[] {
    const { decisions, behaviorsByUnitId, outcomeEvidence, taskSucceeded, siftrSessionId, outcomeId, rightsReference } = options;

    return decisions.map((dec) => {
      let unitBehavior: ObservedBehavior | undefined;
      if (behaviorsByUnitId) {
        unitBehavior = behaviorsByUnitId instanceof Map
          ? behaviorsByUnitId.get(dec.contextUnitId)
          : behaviorsByUnitId[dec.contextUnitId];
      }

      return DatasetBuilder.buildCandidateObservation({
        decision: dec,
        behavior: unitBehavior,
        outcomeEvidence,
        taskSucceeded,
        siftrSessionId,
        outcomeId,
        rightsReference,
      });
    });
  }
}
