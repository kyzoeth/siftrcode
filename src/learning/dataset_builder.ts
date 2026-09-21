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
import { isExposedV2 } from '../telemetry/exposure_decision';
import { TrainingEvidenceRecord, createTrainingEvidenceRecord } from './lineage';
import { DataRights, isOperationPermitted, DataClass } from '../rights/data_rights';

export const CANDIDATE_OBSERVATION_DATA_CLASSES: DataClass[] = [
  DataClass.NUMERIC_FEATURE,
  DataClass.OUTCOME,
];

export const TRAINING_EVIDENCE_RECORD_DATA_CLASSES: DataClass[] = [
  DataClass.NUMERIC_FEATURE,
  DataClass.OUTCOME,
  DataClass.TRAJECTORY,
];

export interface BuildObservationOptions {
  decision: CandidateDecisionObservation;
  behavior?: ObservedBehavior;
  outcomeEvidence?: OutcomeEvidence;
  taskSucceeded?: boolean;
  siftrSessionId?: string;
  outcomeId?: string;
  rightsReference?: string;
  dataRights: DataRights;
}

export interface BuildDatasetOptions {
  decisions: CandidateDecisionObservation[];
  behaviorsByUnitId?: Map<string, ObservedBehavior> | Record<string, ObservedBehavior>;
  outcomeEvidence?: OutcomeEvidence;
  taskSucceeded?: boolean;
  siftrSessionId?: string;
  outcomeId?: string;
  rightsReference?: string;
  dataRights: DataRights;
}

function assertTrainingPermitted(
  rights: DataRights,
  representedClasses: DataClass[] = CANDIDATE_OBSERVATION_DATA_CLASSES
): void {
  if (!rights) {
    throw new Error('TRAINING_FORBIDDEN: Customer DataRights must be provided explicitly.');
  }
  if (!rights.trainingAllowed) {
    throw new Error('TRAINING_FORBIDDEN: Customer DataRights forbids training (trainingAllowed = false).');
  }
  if (rights.operationRights) {
    for (const dc of representedClasses) {
      if (!isOperationPermitted(rights.operationRights, dc, 'training')) {
        throw new Error(`TRAINING_FORBIDDEN: operationRights forbids training on ${dc}.`);
      }
    }
  }
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
    assertTrainingPermitted(options.dataRights, CANDIDATE_OBSERVATION_DATA_CLASSES);
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

    if (options.outcomeEvidence && options.outcomeEvidence.verifiedSuccess !== null) {
      evidence.push({
        labelType: 'OUTCOME_ASSOCIATION',
        value: options.outcomeEvidence.verifiedSuccess ? 1.0 : 0.0,
        confidence: options.outcomeEvidence.confidence,
        strength: options.outcomeEvidence.confidence >= 0.8 ? 'STRONG' : 'WEAK',
        source: options.outcomeEvidence.evaluationRationale || 'outcome_evidence',
      });
    }

    const observationId = `cobs_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const siftrSessionId = options.siftrSessionId || decision.sessionId;
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
    assertTrainingPermitted(options.dataRights, CANDIDATE_OBSERVATION_DATA_CLASSES);
    const { decisions, behaviorsByUnitId, outcomeEvidence, taskSucceeded, siftrSessionId, outcomeId, rightsReference, dataRights } = options;

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
        dataRights,
      });
    });
  }

  /**
   * Builds a multi-dimensional TrainingEvidenceRecord preserving granular signals (Audit Section 13).
   */
  public static buildTrainingEvidenceRecord(params: {
    decision: CandidateDecisionObservation;
    behavior?: ObservedBehavior;
    outcomeEvidence?: OutcomeEvidence;
    datasetVersion?: string;
    repository?: string;
    tenantId?: string;
    rightsReference?: string;
    dataRights: DataRights;
  }): TrainingEvidenceRecord {
    assertTrainingPermitted(params.dataRights, TRAINING_EVIDENCE_RECORD_DATA_CLASSES);
    const { decision, behavior, outcomeEvidence } = params;
    const wasExposed = isExposedV2(decision.exposureDecision);
    const obsLevel = decision.observabilityLevel;
    const read = behavior?.read === true;
    const edited = behavior?.edited === true;

    let wasRead: boolean | null = null;
    if (wasExposed) {
      if (read) {
        wasRead = true;
      } else if (obsLevel === 'FULL_TOOL_TRACE' || obsLevel === 'HARNESS_NATIVE') {
        wasRead = false;
      } else {
        wasRead = null; // Unobserved under limited trace
      }
    } else {
      wasRead = null; // Unexposed
    }

    return createTrainingEvidenceRecord({
      datasetVersion: params.datasetVersion || 'v2.0.0-evidence',
      contextUnitId: decision.contextUnitId,
      taskId: decision.taskId,
      sessionId: decision.sessionId,
      repository: params.repository || 'unknown',
      tenantId: params.tenantId,
      features: decision.features,
      semanticRelevance: decision.features.heuristicScore,
      exposure: {
        wasExposed,
        resolution: decision.exposureDecision.resolution,
        policyId: decision.exposureDecision.policyId,
      },
      observabilityLevel: obsLevel,
      readEvidence: {
        wasRead,
        readCount: read ? 1 : 0,
        confidence: read ? 0.95 : (wasRead === false ? 0.8 : 0.5),
      },
      editEvidence: {
        wasEdited: edited,
        editCount: edited ? 1 : 0,
        confidence: edited ? 0.99 : 0.8,
      },
      testEvidence: {
        testsPassed: outcomeEvidence?.publicTestsPassed,
        regressionTestsPassed: outcomeEvidence?.regressionTestsPassed,
        confidence: outcomeEvidence ? outcomeEvidence.confidence : 0.5,
      },
      rootCauseEvidence: {
        isRootCause: edited && outcomeEvidence?.verifiedSuccess === true,
        confidence: outcomeEvidence?.confidence || 0.5,
      },
      verifiedOutcomeAssociation: {
        verifiedSuccess: outcomeEvidence ? outcomeEvidence.verifiedSuccess : null,
        confidence: outcomeEvidence?.confidence || 0.5,
      },
      sourceObservationIds: [decision.decisionObservationId],
      rightsReference: params.rightsReference || `rights_${decision.workspaceSnapshotId}`,
    });
  }
}
