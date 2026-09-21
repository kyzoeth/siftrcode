/**
 * SiftrCode V2 - Remediation PR 12 Test Suite:
 * Rights / Lineage Enforcement & Deletion Traceability (Sections 50 - 52)
 */

import {
  SourceProvenance,
  createSourceProvenance,
  isProvenanceEligibleForTraining,
  isProvenanceEligibleForRedistribution,
} from '../rights/source_provenance';
import { RightsFilter } from '../rights/rights_filter';
import { createDefaultDataRights } from '../rights/data_rights';
import {
  CandidateObservationV2,
  createCandidateObservationV2,
} from '../telemetry/candidate_observation';
import { ExposureDecisionV2 } from '../telemetry/exposure_decision';
import { ContextFeaturesV1 } from '../ranking/feature_schema';
import { ContextUnitKind } from '../context/context_unit';
import {
  DerivedDataLineage,
  TrainingRow,
  createTrainingRow,
  createDerivedDataLineage,
} from '../learning/lineage';
import { TrainingExporter } from '../learning/training_exporter';
import { SqliteStore } from '../storage/sqlite_store';
import { DeletionManager } from '../rights/deletion_manager';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  ❌ FAILED: ${message}`);
    throw new Error(message);
  }
  console.log(`  ✔ ${message}`);
}

export async function runRightsLineageEnforcementTests(): Promise<void> {
  console.log('\n=== Running V2 Rights / Lineage Enforcement Tests (Remediation PR 12) ===\n');

  // Dummy baseline features
  const dummyFeatures: ContextFeaturesV1 = {
    schemaVersion: 'v1',
    contextUnitId: 'u_test_1',
    unitKind: ContextUnitKind.CODE_SYMBOL,
    tokenEstimate: 120,
    isTest: false,
    isConfig: false,
    isDocumentation: false,
    isSchema: false,
    isExported: true,
    exactSymbolMatch: true,
    exactPathMatch: false,
    bm25Score: 0.85,
    tokenOverlapRatio: 0.45,
    graphDegree: 4,
    minDistanceToSeed: 1,
    minDistanceToErrorFrame: null,
    isDirectDependency: true,
    isDirectDependent: false,
    changeFrequency: 3,
    recentChangeFrequency: 1,
    maxCoChangeWithSeeds: 0.6,
    inStackTrace: false,
    isFailingTestTarget: false,
    inCompilerError: false,
    inDirtyDiff: false,
    heuristicScore: 0.75,
  };

  const exposedDecision: ExposureDecisionV2 = {
    contextPlanId: 'cplan_test',
    contextUnitId: 'u_test_1',
    policyId: 'policy_v2',
    policyVersion: '2.0.0',
    eligibleForSelection: true,
    selected: true,
    resolution: 5,
    timestamp: new Date().toISOString(),
  };

  const unexposedDecision: ExposureDecisionV2 = {
    contextPlanId: 'cplan_test',
    contextUnitId: 'u_test_2',
    policyId: 'policy_v2',
    policyVersion: '2.0.0',
    eligibleForSelection: true,
    selected: false,
    resolution: 0, // OMIT
    timestamp: new Date().toISOString(),
  };

  // ---------------------------------------------------------------------------
  // 1. Source Provenance & Default Rights (Section 51)
  // ---------------------------------------------------------------------------
  console.log('--- 1. Source Provenance & Invariants (Section 51) ---');

  const defaultProv = createSourceProvenance({
    origin: 'SWE-bench',
    repository: 'django/django',
  });

  assert(defaultProv.origin === 'SWE-bench', 'Origin captured');
  assert(defaultProv.repository === 'django/django', 'Repository captured');
  assert(defaultProv.license === 'Unknown', 'Default license is Unknown');
  assert(defaultProv.trainingPermission === 'REVIEW', 'Unknown rights default to REVIEW');
  assert(defaultProv.redistributionPermission === 'REVIEW', 'Redistribution defaults to REVIEW');
  assert(defaultProv.verified === false, 'Default verification status is false');

  // Eligibility evaluation: REVIEW should be strictly rejected
  const reviewEligibility = isProvenanceEligibleForTraining(defaultProv);
  assert(!reviewEligibility.eligible, 'Provenance in REVIEW is rejected from training');
  assert(
    reviewEligibility.reason?.includes('TRAINING_PERMISSION_REVIEW') === true,
    'Rejection reason indicates REVIEW'
  );

  // Missing provenance should be rejected
  const missingEligibility = isProvenanceEligibleForTraining(undefined);
  assert(!missingEligibility.eligible, 'Missing provenance is rejected from training');

  // Forbidden provenance should be rejected
  const forbiddenProv = createSourceProvenance({
    origin: 'CustomerSession',
    repository: 'private/customer-core',
    license: 'Proprietary',
    trainingPermission: 'FORBIDDEN',
    verified: true,
  });
  const forbiddenEligibility = isProvenanceEligibleForTraining(forbiddenProv);
  assert(!forbiddenEligibility.eligible, 'FORBIDDEN provenance is rejected from training');
  assert(
    forbiddenEligibility.reason?.includes('TRAINING_PERMISSION_FORBIDDEN') === true,
    'Reason indicates FORBIDDEN'
  );

  // Verified open-source permissive provenance
  const allowedProv = createSourceProvenance({
    origin: 'OpenSource',
    repository: 'psf/requests',
    license: 'Apache-2.0',
    trainingPermission: 'ALLOWED',
    redistributionPermission: 'ALLOWED',
    cutoffDate: '2024-01-01T00:00:00.000Z',
    verified: true,
  });
  const allowedEligibility = isProvenanceEligibleForTraining(allowedProv, {
    maxCutoffDate: '2024-06-01T00:00:00.000Z',
    requireVerified: true,
  });
  assert(allowedEligibility.eligible, 'Verified ALLOWED provenance within cutoff is eligible');

  // Cutoff date exceeded should be rejected
  const expiredCutoffEligibility = isProvenanceEligibleForTraining(allowedProv, {
    maxCutoffDate: '2023-01-01T00:00:00.000Z',
  });
  assert(!expiredCutoffEligibility.eligible, 'Provenance after temporal cutoff is rejected');
  assert(
    expiredCutoffEligibility.reason?.includes('CUTOFF_EXCEEDED') === true,
    'Reason indicates CUTOFF_EXCEEDED'
  );

  // Unverified provenance rejected when verification required
  const unverifiedAllowedProv = createSourceProvenance({
    origin: 'SWE-bench',
    repository: 'scikit-learn/scikit-learn',
    license: 'BSD-3-Clause',
    trainingPermission: 'ALLOWED',
    verified: false,
  });
  const unverifiedCheck = isProvenanceEligibleForTraining(unverifiedAllowedProv, {
    requireVerified: true,
  });
  assert(!unverifiedCheck.eligible, 'Unverified provenance rejected when verification required');

  // Redistribution check
  const redistAllowed = isProvenanceEligibleForRedistribution(allowedProv);
  assert(redistAllowed.eligible, 'Allowed & verified provenance eligible for redistribution');
  const redistReview = isProvenanceEligibleForRedistribution(defaultProv);
  assert(!redistReview.eligible, 'REVIEW provenance cannot be redistributed');

  // ---------------------------------------------------------------------------
  // 2. Rights Filter & Export Boundary (Section 50)
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Rights Filter & Export Boundary (Section 50) ---');

  const rightsFilter = new RightsFilter({
    requireVerifiedProvenance: true,
    allowWeakNegatives: true,
  });

  const validObs = createCandidateObservationV2({
    taskId: 'task_1',
    siftrSessionId: 'sess_1',
    workspaceSnapshotId: 'snap_1',
    contextUnitId: 'unit_1',
    agentEnvironmentId: 'env_1',
    observabilityLevel: 'FULL_TOOL_TRACE',
    features: dummyFeatures,
    candidate: { generated: true, candidateRank: 1, retrievalSources: ['exact'] },
    exposure: exposedDecision,
    observedBehavior: { edited: true },
    rightsReference: 'customer_default',
  });

  // Test 2a: Customer with trainingAllowed = false (Section 50 Primary Invariant)
  const strictRights = createDefaultDataRights({ trainingAllowed: false });
  const evalStrict = rightsFilter.evaluate({
    observation: validObs,
    dataRights: strictRights,
    provenance: allowedProv,
  });
  assert(!evalStrict.passed, 'Observation rejected when trainingAllowed is false');
  assert(evalStrict.status === 'REJECTED', 'Status marked REJECTED');
  assert(
    evalStrict.reasons.some((r) => r.includes('TRAINING_NOT_ALLOWED')),
    'Rejection explicitly notes TRAINING_NOT_ALLOWED'
  );

  // Test 2b: Customer with trainingAllowed = true and verified ALLOWED provenance -> ACCEPTED
  const permissiveRights = createDefaultDataRights({
    trainingAllowed: true,
    derivedNumericFeaturesAllowed: true,
  });
  const evalPermissive = rightsFilter.evaluate({
    observation: validObs,
    dataRights: permissiveRights,
    provenance: allowedProv,
  });
  assert(evalPermissive.passed, 'Observation accepted when trainingAllowed is true and provenance is ALLOWED');
  assert(evalPermissive.status === 'ACCEPTED', 'Status marked ACCEPTED');
  assert(evalPermissive.sanitizedFeatures !== undefined, 'Features sanitized and attached');

  // Test 2c: Invariant - Unexposed candidate cannot enter training export
  const unexposedObs = createCandidateObservationV2({
    taskId: 'task_1',
    siftrSessionId: 'sess_1',
    workspaceSnapshotId: 'snap_1',
    contextUnitId: 'unit_unexposed',
    agentEnvironmentId: 'env_1',
    observabilityLevel: 'FULL_TOOL_TRACE',
    features: dummyFeatures,
    candidate: { generated: true, retrievalSources: ['bm25'] },
    exposure: unexposedDecision,
    rightsReference: 'customer_default',
  });
  const evalUnexposed = rightsFilter.evaluate({
    observation: unexposedObs,
    dataRights: permissiveRights,
    provenance: allowedProv,
  });
  assert(!evalUnexposed.passed, 'UNEXPOSED_UNKNOWN candidate rejected from training export');
  assert(
    evalUnexposed.reasons.some((r) => r.includes('INVALID_LABEL_UNEXPOSED')),
    'Rejection reason indicates INVALID_LABEL_UNEXPOSED'
  );

  // Test 2d: Missing features rejected
  const missingFeaturesObs = { ...validObs, features: undefined as any };
  const evalMissingFeatures = rightsFilter.evaluate({
    observation: missingFeaturesObs,
    dataRights: permissiveRights,
    provenance: allowedProv,
  });
  assert(!evalMissingFeatures.passed, 'Observation with missing features rejected');

  // Test 2e: Batch filtering partition
  const batchResult = rightsFilter.filterBatch([
    { observation: validObs, dataRights: permissiveRights, provenance: allowedProv },
    { observation: validObs, dataRights: strictRights, provenance: allowedProv },
    { observation: unexposedObs, dataRights: permissiveRights, provenance: allowedProv },
  ]);
  assert(batchResult.accepted.length === 1, 'Batch filter accepted exactly 1 valid item');
  assert(batchResult.rejected.length === 2, 'Batch filter rejected 2 invalid items');

  // ---------------------------------------------------------------------------
  // 3. Derived-Data Lineage & Training Rows (Section 52)
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. Derived-Data Lineage & Training Rows (Section 52) ---');

  const lineage: DerivedDataLineage = createDerivedDataLineage({
    trainingRowId: 'trow_1',
    sourceObservationIds: ['obs_a', 'obs_b'],
    sourceTaskId: 'task_swe_123',
    sourceSessionId: 'sess_99',
    repository: 'django/django',
    tenantId: 'tenant_test',
    labelerVersion: 'v1.0.0',
    featureBuilderVersion: 'feature_schema_v2',
    datasetVersion: 'v2.0.0-alpha',
    provenanceId: allowedProv.provenanceId,
  });

  assert(lineage.lineageId.startsWith('lin_'), 'Lineage ID has lin_ prefix');
  assert(lineage.sourceObservationIds.length === 2, 'Lineage tracks source observation IDs');
  assert(lineage.labelerVersion === 'v1.0.0', 'Lineage tracks labeler version');
  assert(lineage.featureBuilderVersion === 'feature_schema_v2', 'Lineage tracks featureBuilder version');
  assert(lineage.datasetVersion === 'v2.0.0-alpha', 'Lineage tracks dataset version');
  assert(lineage.repository === 'django/django', 'Lineage tracks repository');

  const trainingRow: TrainingRow = createTrainingRow({
    datasetVersion: 'v2.0.0-alpha',
    contextUnitId: 'unit_auth_py',
    taskId: 'task_swe_123',
    sessionId: 'sess_99',
    repository: 'django/django',
    tenantId: 'tenant_test',
    features: dummyFeatures,
    label: 1,
    confidence: 0.98,
    outcomeLabel: 'POSITIVE',
    sourceObservationIds: ['obs_a', 'obs_b'],
    labelerVersion: 'v1.0.0',
    featureBuilderVersion: 'feature_schema_v2',
    provenanceId: allowedProv.provenanceId,
    rightsReference: 'swe_bench_verified',
  });

  assert(trainingRow.rowId.startsWith('trow_'), 'Training row ID has trow_ prefix');
  assert(trainingRow.label === 1, 'Positive label set to 1');
  assert(trainingRow.confidence === 0.98, 'Confidence preserved');
  assert(trainingRow.lineage.sourceTaskId === 'task_swe_123', 'Lineage attached to row');
  assert(trainingRow.lineage.sourceObservationIds.includes('obs_a'), 'Lineage contains obs_a');

  // ---------------------------------------------------------------------------
  // 4. TrainingExporter Service Execution
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. TrainingExporter Service Execution (Section 50 & 52) ---');

  const exporter = new TrainingExporter({
    requireVerifiedProvenance: true,
  });

  const mixedObservations: CandidateObservationV2[] = [
    // 1. Valid positive observation with permissive rights & verified provenance -> ACCEPT
    createCandidateObservationV2({
      observationId: 'obs_accepted_1',
      taskId: 'task_exp_1',
      siftrSessionId: 'sess_exp_1',
      workspaceSnapshotId: 'snap_1',
      contextUnitId: 'unit_controller',
      agentEnvironmentId: 'env_1',
      observabilityLevel: 'FULL_TOOL_TRACE',
      features: dummyFeatures,
      candidate: { generated: true, candidateRank: 1, retrievalSources: ['exact'] },
      exposure: exposedDecision,
      observedBehavior: { edited: true },
      rightsReference: 'ref_open_source',
    }),
    // 2. Strict rights (trainingAllowed = false) -> REJECT
    createCandidateObservationV2({
      observationId: 'obs_rejected_rights',
      taskId: 'task_exp_2',
      siftrSessionId: 'sess_exp_2',
      workspaceSnapshotId: 'snap_1',
      contextUnitId: 'unit_secret',
      agentEnvironmentId: 'env_1',
      observabilityLevel: 'FULL_TOOL_TRACE',
      features: dummyFeatures,
      candidate: { generated: true, candidateRank: 2, retrievalSources: ['exact'] },
      exposure: exposedDecision,
      observedBehavior: { edited: true },
      rightsReference: 'ref_private_customer',
    }),
    // 3. Provenance in REVIEW -> REJECT
    createCandidateObservationV2({
      observationId: 'obs_rejected_prov_review',
      taskId: 'task_exp_3',
      siftrSessionId: 'sess_exp_3',
      workspaceSnapshotId: 'snap_1',
      contextUnitId: 'unit_external',
      agentEnvironmentId: 'env_1',
      observabilityLevel: 'FULL_TOOL_TRACE',
      features: dummyFeatures,
      candidate: { generated: true, candidateRank: 3, retrievalSources: ['lexical'] },
      exposure: exposedDecision,
      observedBehavior: { read: true },
      rightsReference: 'ref_unreviewed',
    }),
    // 4. Unexposed candidate -> REJECT
    createCandidateObservationV2({
      observationId: 'obs_rejected_unexposed',
      taskId: 'task_exp_4',
      siftrSessionId: 'sess_exp_4',
      workspaceSnapshotId: 'snap_1',
      contextUnitId: 'unit_omitted',
      agentEnvironmentId: 'env_1',
      observabilityLevel: 'FULL_TOOL_TRACE',
      features: dummyFeatures,
      candidate: { generated: true, retrievalSources: ['bm25'] },
      exposure: unexposedDecision,
      rightsReference: 'ref_open_source',
    }),
  ];

  const exportResult = exporter.exportTrainingRows(
    mixedObservations,
    (obs) => {
      if (obs.rightsReference === 'ref_private_customer') {
        return {
          dataRights: strictRights,
          provenance: allowedProv,
          repository: 'customer/core',
          tenantId: 'tenant_private',
        };
      }
      if (obs.rightsReference === 'ref_unreviewed') {
        return {
          dataRights: permissiveRights,
          provenance: defaultProv, // trainingPermission: 'REVIEW'
          repository: 'unreviewed/repo',
        };
      }
      return {
        dataRights: permissiveRights,
        provenance: allowedProv,
        repository: 'psf/requests',
      };
    },
    {
      datasetVersion: 'v2.0.0-beta',
      labelerVersion: 'v1.0.0',
      featureBuilderVersion: 'feature_schema_v2',
    }
  );

  assert(exportResult.totalEvaluated === 4, 'Evaluated all 4 observations');
  assert(exportResult.totalAccepted === 1, 'Accepted exactly 1 compliant observation');
  assert(exportResult.totalRejected === 3, 'Rejected 3 non-compliant observations');
  assert(exportResult.rows.length === 1, 'Generated 1 TrainingRow');
  assert(exportResult.rows[0].lineage.sourceObservationIds[0] === 'obs_accepted_1', 'Row points to correct source observation');
  assert(exportResult.rejectionSummary['TRAINING_NOT_ALLOWED'] === 1, 'Captured TRAINING_NOT_ALLOWED rejection');
  assert(exportResult.rejectionSummary['TRAINING_PERMISSION_REVIEW'] === 1, 'Captured TRAINING_PERMISSION_REVIEW rejection');
  assert(exportResult.rejectionSummary['INVALID_LABEL_UNEXPOSED'] === 1, 'Captured INVALID_LABEL_UNEXPOSED rejection');

  // ---------------------------------------------------------------------------
  // 5. Durable SQLite Persistence & Queries
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. Durable SQLite Persistence & Queries (Migration 004) ---');

  const store = new SqliteStore(':memory:');

  // Save & retrieve SourceProvenance
  store.saveSourceProvenance(allowedProv);
  store.saveSourceProvenance(forbiddenProv);

  const retrievedProv = store.getSourceProvenance(allowedProv.repository);
  assert(retrievedProv !== undefined, 'Retrieved source provenance from SQLite');
  assert(retrievedProv?.license === 'Apache-2.0', 'Preserved license');
  assert(retrievedProv?.trainingPermission === 'ALLOWED', 'Preserved training permission');
  assert(retrievedProv?.verified === true, 'Preserved verified status');

  const allProvs = store.listSourceProvenances();
  assert(allProvs.length === 2, 'Listed 2 stored source provenances');

  // Save & retrieve TrainingRows
  store.saveTrainingRows(exportResult.rows);
  const retrievedRow = store.getTrainingRow(exportResult.rows[0].rowId);
  assert(retrievedRow !== undefined, 'Retrieved TrainingRow from SQLite');
  assert(retrievedRow?.datasetVersion === 'v2.0.0-beta', 'Preserved datasetVersion');
  assert(retrievedRow?.lineage.sourceObservationIds.includes('obs_accepted_1') === true, 'Preserved source observation ID in lineage');

  const listedRows = store.listTrainingRows({ datasetVersion: 'v2.0.0-beta' });
  assert(listedRows.length === 1, 'Listed training rows by datasetVersion');

  // Save observations for task_exp_1 into store
  store.saveCandidateObservations([mixedObservations[0]]);
  const storedObs = store.getCandidateObservation('obs_accepted_1');
  assert(storedObs !== undefined, 'Stored source candidate observation in SQLite');

  // ---------------------------------------------------------------------------
  // 6. Deletion Traceability & Right-to-be-Forgotten (Section 52)
  // ---------------------------------------------------------------------------
  console.log('\n--- 6. Deletion Traceability & Purge (Section 52) ---');

  const deletionManager = new DeletionManager(store);

  // Trace lineage for psf/requests
  const trace = deletionManager.traceLineage({ repository: 'psf/requests' });
  assert(trace.matchedTrainingRowIds.length === 1, 'Trace found 1 matching training row');
  assert(trace.affectedDatasetVersions.includes('v2.0.0-beta'), 'Trace identified affected datasetVersion v2.0.0-beta');
  assert(trace.matchedObservationIds.includes('obs_accepted_1'), 'Trace identified source observation obs_accepted_1');

  // Execute traceable purge
  const audit = deletionManager.executePurge({
    repository: 'psf/requests',
    reason: 'GDPR Right-to-be-Forgotten customer request',
  });

  assert(audit.status === 'COMPLETED', 'Purge status is COMPLETED');
  assert(audit.purgedTrainingRowsCount === 1, 'Purged 1 training row');
  assert(audit.purgedObservationsCount >= 1, 'Purged matching candidate observations');
  assert(audit.affectedDatasets.includes('v2.0.0-beta'), 'Audit recorded affected dataset');

  // Verify deletion from database
  const afterPurgeRows = store.listTrainingRows({ repository: 'psf/requests' });
  assert(afterPurgeRows.length === 0, '0 training rows remain after purge');

  const afterPurgeObs = store.getCandidateObservation('obs_accepted_1');
  assert(afterPurgeObs === undefined, 'Source observation purged from SQLite');

  // Verify audit log record
  const audits = store.listDeletionAuditRecords();
  assert(audits.length === 1, 'Stored deletion audit record');
  assert(audits[0].criteria.repository === 'psf/requests', 'Audit recorded target repository');
  assert(audits[0].purgedTrainingRowsCount === 1, 'Audit recorded purged training count');

  console.log('\n🎉 All Rights / Lineage Enforcement & Deletion Traceability tests passed successfully!');
}

runRightsLineageEnforcementTests().catch((err) => {
  console.error('❌ Rights / Lineage Enforcement test failed:', err);
  process.exit(1);
});
