import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';

// Safe runtime resolution of node:sqlite (Node.js 22.5.0+ Active LTS)
// Prevents top-level module load failures in environments running Node < 22
let NodeDatabaseSync: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  NodeDatabaseSync = require('node:sqlite').DatabaseSync;
} catch {
  NodeDatabaseSync = null;
}
import { WorkspaceSnapshot } from '../workspace/workspace_snapshot';
import { ContextUnit, ContextUnitKind } from '../context/context_unit';
import { TaskContext } from '../context/task_context';
import { ContextPlan } from '../engine/context_plan';
import { CandidateObservationV2 } from '../telemetry/candidate_observation';
import { CandidateDecisionObservation } from '../telemetry/decision_observation';
import { ExposureDecisionV2, isExposedV2 } from '../telemetry/exposure_decision';
import { TrajectoryEvent } from '../telemetry/trajectory_event';
import { OutcomeEvidence } from '../telemetry/outcome_evidence';
import { SiftrSession, SiftrSessionStatus, createSiftrSession } from '../telemetry/siftr_session';
import { ContextExpansionEvent } from '../telemetry/expansion_event';
import { FinalContextAllocation } from '../token/final_allocation';
import { ProviderUsageEvent } from '../token/provider_usage';
import { JevSignalV1 } from '../providers/judgment/typesafe/jev_signal';
import { SourceProvenance } from '../rights/source_provenance';
import { TrainingRow, TrainingEvidenceRecord } from '../learning/lineage';
import {
  TrainingExportResult,
  TrainingEvidenceExportResult,
  SanctionedTrainingExport,
  SanctionedTrainingEvidenceExport,
  isSanctionedTrainingExport,
  isSanctionedTrainingEvidenceExport,
} from '../learning/training_exporter';
import { DeletionAuditRecord } from '../rights/deletion_manager';
import { DataRights, createDefaultDataRights, DataClass, isDataClassPermitted } from '../rights/data_rights';
import {
  sanitizeContextPlanForPersistence,
  sanitizeContextUnitForPersistence,
  sanitizeTaskContextForPersistence,
  sanitizeCandidateDecisionObservation,
  ContextPlanMetadataRecord,
} from './rights_aware_dto';
import { TaskEpisodeV1, TaskType, loadVerifiedTaskEpisode } from '../learning/episodes/task_episode';
import { CandidateObservation } from '../learning/episodes/candidate_observation';
import { ContextUnitExposureRecord, ContextExposureState } from '../learning/episodes/context_exposure';
import { AgentTrajectoryEvent } from '../learning/episodes/agent_trajectory';
import {
  PreOutcomeEpisodeSnapshot,
  validatePreOutcomeSnapshotIntegrity,
  loadVerifiedPreOutcomeSnapshot,
} from '../learning/episodes/pre_outcome_snapshot';
import { resolveOutcomeLineage } from '../learning/episodes/lineage_resolver';
import { ShadowPolicyComparison } from '../ranking/shadow_policy_runner';
import { resolveTaskOutcomeFromEvidence } from '../learning/outcome/task_outcome';
import {
  evaluateCanonicalReadinessGates,
  CanonicalGateEvaluation,
  CanonicalReadinessEvaluation,
} from '../learning/analytics/readiness_gates';

export {
  sanitizeContextPlanForPersistence,
  sanitizeContextUnitForPersistence,
  sanitizeTaskContextForPersistence,
  sanitizeCandidateDecisionObservation,
  ContextPlanMetadataRecord,
} from './rights_aware_dto';
export { TaskEpisodeV1, TaskType, loadVerifiedTaskEpisode } from '../learning/episodes/task_episode';
export {
  CanonicalGateEvaluation,
  CanonicalReadinessEvaluation,
} from '../learning/analytics/readiness_gates';
export { ContextUnitExposureRecord, ContextExposureState } from '../learning/episodes/context_exposure';
export { AgentTrajectoryEvent } from '../learning/episodes/agent_trajectory';
export { PreOutcomeEpisodeSnapshot } from '../learning/episodes/pre_outcome_snapshot';
export { TrainingEvidenceRecord } from '../learning/lineage';
export { SiftrSession, SiftrSessionStatus } from '../telemetry/siftr_session';
export { ContextExpansionEvent } from '../telemetry/expansion_event';
export { FinalContextAllocation } from '../token/final_allocation';
export { ProviderUsageEvent } from '../token/provider_usage';
export { JevSignalV1 } from '../providers/judgment/typesafe/jev_signal';

export interface EpisodeFilter {
  repositoryId?: string;
  taskId?: string;
  sessionId?: string;
  verifiedSuccess?: boolean | null;
  trainingAllowed?: boolean;
  taskType?: TaskType;
  excludeRevoked?: boolean;
  limit?: number;
}

export interface LearningFlywheelSummary {
  totalEpisodes: number;
  verifiedOutcomeEpisodes: number;
  unknownOutcomeEpisodes: number;
  successfulVerifiedEpisodes: number;
  failedVerifiedEpisodes: number;
  trainingEligibleEpisodes: number;
  rightsBlockedEpisodes: number;
  revokedEpisodes: number;
  episodesByRepositoryFamily: Record<string, number>;
  episodesByTaskType: Record<string, number>;
  totalCandidateObservations: number;
  shownContextUnits: number;
  readContextUnits: number;
  editedContextUnits: number;
}

export interface DataReadinessReport {
  targetVerifiedEpisodes: number;
  currentVerifiedEpisodes: number;
  targetIndependentRepositories: number;
  currentIndependentRepositories: number;
  bugFixEpisodes: number;
  featureAdditionEpisodes: number;
  refactorEpisodes: number;
  testFailureEpisodes: number;
  trainingEligibleEpisodes: number;
  unknownOutcomeRate: number; // percentage [0, 100]
  readinessScore: number; // [0.0, 1.0]
  isV32Ready: boolean;
  version: string;
  canonicalGates?: CanonicalGateEvaluation[];
  canonicalEvaluation?: CanonicalReadinessEvaluation;
}

export interface DataQualityReport {
  verifiedOutcomeRate: number;
  unknownOutcomeRate: number;
  trainingRightsRate: number;
  trajectoryCompletenessRate: number;
  pricingCoverageRate: number;
  baseCommitCoverageRate: number;
  featureSchemaDistribution: Record<string, number>;
  contextPolicyDistribution: Record<string, number>;
}

export interface StoredGraphEdge {
  fromUnitId: string;
  toUnitId: string;
  kind: string;
  confidence: number;
  source: string;
  weight?: number;
  metadata?: Record<string, unknown>;
  snapshotId: string;
}

export interface StoredSession {
  sessionId: string;
  taskId: string;
  snapshotId: string;
  agentEnvironmentId?: string;
  initialSnapshotId?: string;
  latestSnapshotId?: string;
  state?: string;
  status?: SiftrSessionStatus;
  endedAt?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '001_initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        root_dir TEXT NOT NULL,
        name TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        content_root_hash TEXT NOT NULL,
        parent_snapshot_id TEXT,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_ws ON snapshots(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_root_hash ON snapshots(content_root_hash);

      CREATE TABLE IF NOT EXISTS context_units (
        unit_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        repository_id TEXT,
        kind TEXT NOT NULL,
        path TEXT,
        title TEXT,
        trust_level TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_units_snapshot ON context_units(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_units_path ON context_units(path);
      CREATE INDEX IF NOT EXISTS idx_units_kind ON context_units(kind);

      CREATE TABLE IF NOT EXISTS graph_edges (
        from_unit_id TEXT NOT NULL,
        to_unit_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        weight REAL,
        metadata_json TEXT,
        snapshot_id TEXT NOT NULL,
        PRIMARY KEY (from_unit_id, to_unit_id, kind, snapshot_id)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_from ON graph_edges(from_unit_id, snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON graph_edges(to_unit_id, snapshot_id);

      CREATE TABLE IF NOT EXISTS task_contexts (
        task_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        primary_prompt TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        state TEXT,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_plans (
        plan_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: '002_durable_observation_store',
    sql: `
      CREATE TABLE IF NOT EXISTS candidate_observations (
        observation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        context_unit_id TEXT NOT NULL,
        agent_environment_id TEXT NOT NULL,
        observability_level TEXT NOT NULL,
        feature_schema_version TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        was_exposed INTEGER NOT NULL,
        exposure_resolution INTEGER NOT NULL,
        outcome_label TEXT NOT NULL,
        rights_reference TEXT NOT NULL,
        evidence_json TEXT,
        raw_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_obs_task ON candidate_observations(task_id);
      CREATE INDEX IF NOT EXISTS idx_obs_unit ON candidate_observations(context_unit_id);
      CREATE INDEX IF NOT EXISTS idx_obs_policy ON candidate_observations(policy_id, policy_version);
      CREATE INDEX IF NOT EXISTS idx_obs_label ON candidate_observations(outcome_label);

      CREATE TABLE IF NOT EXISTS exposure_decisions (
        decision_id TEXT PRIMARY KEY,
        context_plan_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        context_unit_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        eligible_for_selection INTEGER NOT NULL,
        selected INTEGER NOT NULL,
        candidate_rank INTEGER,
        final_bundle_rank INTEGER,
        resolution INTEGER NOT NULL,
        actual_token_cost INTEGER,
        selection_probability REAL,
        exploration_policy TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_exp_plan ON exposure_decisions(context_plan_id);
      CREATE INDEX IF NOT EXISTS idx_exp_unit ON exposure_decisions(context_unit_id);
      CREATE INDEX IF NOT EXISTS idx_exp_task ON exposure_decisions(task_id);

      CREATE TABLE IF NOT EXISTS trajectory_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT,
        snapshot_id TEXT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_traj_task ON trajectory_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_traj_kind ON trajectory_events(kind);

      CREATE TABLE IF NOT EXISTS outcome_evidence (
        evidence_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT,
        snapshot_id TEXT,
        label_type TEXT NOT NULL,
        value REAL NOT NULL,
        confidence REAL NOT NULL,
        strength TEXT NOT NULL,
        source TEXT NOT NULL,
        context_unit_id TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outcome_task ON outcome_evidence(task_id);
      CREATE INDEX IF NOT EXISTS idx_outcome_unit ON outcome_evidence(context_unit_id);

      CREATE TABLE IF NOT EXISTS provider_calls (
        call_id TEXT PRIMARY KEY,
        task_id TEXT,
        provider_name TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        reason TEXT,
        blocked_units_json TEXT,
        redacted_secrets_count INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_provider_task ON provider_calls(task_id);
    `,
  },
  {
    version: 3,
    name: '003_task_outcome_records',
    sql: `
      CREATE TABLE IF NOT EXISTS task_outcome_records (
        outcome_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_environment_id TEXT NOT NULL,
        workspace_snapshot_before TEXT NOT NULL,
        workspace_snapshot_after TEXT,
        build_passed INTEGER,
        public_tests_passed INTEGER,
        hidden_tests_passed INTEGER,
        regression_tests_passed INTEGER,
        static_checks_passed INTEGER,
        security_checks_passed INTEGER,
        behavioral_oracle_passed INTEGER,
        user_accepted INTEGER,
        agent_reported_success INTEGER,
        human_review TEXT,
        verified_success INTEGER,
        confidence REAL NOT NULL,
        policy_id TEXT,
        policy_version TEXT,
        evaluation_rationale TEXT,
        raw_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_outcome_task ON task_outcome_records(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_outcome_session ON task_outcome_records(session_id);
      CREATE INDEX IF NOT EXISTS idx_task_outcome_verified ON task_outcome_records(verified_success);
    `,
  },
  {
    version: 4,
    name: '004_rights_lineage_and_deletion',
    sql: `
      CREATE TABLE IF NOT EXISTS source_provenances (
        provenance_id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        repository TEXT NOT NULL UNIQUE,
        license TEXT NOT NULL,
        training_permission TEXT NOT NULL,
        redistribution_permission TEXT NOT NULL,
        cutoff_date TEXT NOT NULL,
        verified INTEGER NOT NULL,
        notes TEXT,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_prov_repo ON source_provenances(repository);
      CREATE INDEX IF NOT EXISTS idx_prov_origin ON source_provenances(origin);
      CREATE INDEX IF NOT EXISTS idx_prov_train ON source_provenances(training_permission);

      CREATE TABLE IF NOT EXISTS training_rows (
        row_id TEXT PRIMARY KEY,
        dataset_version TEXT NOT NULL,
        context_unit_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        tenant_id TEXT,
        source_observation_ids TEXT NOT NULL,
        labeler_version TEXT NOT NULL,
        feature_builder_version TEXT NOT NULL,
        label INTEGER,
        confidence REAL NOT NULL,
        outcome_label TEXT NOT NULL,
        rights_reference TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        exported_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trow_dataset ON training_rows(dataset_version);
      CREATE INDEX IF NOT EXISTS idx_trow_repo ON training_rows(repository);
      CREATE INDEX IF NOT EXISTS idx_trow_task ON training_rows(task_id);
      CREATE INDEX IF NOT EXISTS idx_trow_tenant ON training_rows(tenant_id);

      CREATE TABLE IF NOT EXISTS deletion_audit_records (
        deletion_id TEXT PRIMARY KEY,
        requested_at TEXT NOT NULL,
        executed_at TEXT NOT NULL,
        criteria_json TEXT NOT NULL,
        purged_observations_count INTEGER NOT NULL,
        purged_training_rows_count INTEGER NOT NULL,
        affected_datasets_json TEXT NOT NULL,
        status TEXT NOT NULL,
        details TEXT,
        raw_json TEXT NOT NULL
      );

    `,
  },
  {
    version: 6,
    name: '006_candidate_decision_observations',
    sql: `
      CREATE TABLE IF NOT EXISTS candidate_decision_observations (
        decision_observation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        context_unit_id TEXT NOT NULL,
        candidate_rank INTEGER,
        exposure_resolution INTEGER NOT NULL,
        policy_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        observability_level TEXT NOT NULL,
        features_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dec_obs_task ON candidate_decision_observations(task_id);
      CREATE INDEX IF NOT EXISTS idx_dec_obs_unit ON candidate_decision_observations(context_unit_id);
    `,
  },
  {
    version: 7,
    name: '007_training_evidence_records',
    sql: `
      CREATE TABLE IF NOT EXISTS training_evidence_records (
        evidence_id TEXT PRIMARY KEY,
        dataset_version TEXT NOT NULL,
        task_id TEXT NOT NULL,
        context_unit_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        tenant_id TEXT,
        was_read INTEGER,
        was_edited INTEGER,
        verified_success INTEGER,
        rights_reference TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        exported_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evrec_dataset ON training_evidence_records(dataset_version);
      CREATE INDEX IF NOT EXISTS idx_evrec_task ON training_evidence_records(task_id);
      CREATE INDEX IF NOT EXISTS idx_evrec_repo ON training_evidence_records(repository);
    `,
  },
  {
    version: 8,
    name: '008_final_closure_integrity',
    sql: `
      ALTER TABLE task_outcome_records ADD COLUMN context_plan_id TEXT;
      ALTER TABLE outcome_evidence ADD COLUMN context_plan_id TEXT;
      ALTER TABLE outcome_evidence ADD COLUMN verified_success INTEGER;
      ALTER TABLE sessions ADD COLUMN agent_environment_id TEXT;
      ALTER TABLE sessions ADD COLUMN initial_snapshot_id TEXT;
      ALTER TABLE sessions ADD COLUMN latest_snapshot_id TEXT;
      ALTER TABLE sessions ADD COLUMN ended_at TEXT;
      ALTER TABLE context_plans ADD COLUMN session_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_cplans_session ON context_plans(session_id);
      CREATE INDEX IF NOT EXISTS idx_task_outcome_plan ON task_outcome_records(context_plan_id);

      CREATE TABLE IF NOT EXISTS expansion_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        context_plan_id TEXT NOT NULL,
        workspace_snapshot_id TEXT NOT NULL,
        agent_environment_id TEXT NOT NULL,
        context_unit_id TEXT NOT NULL,
        previous_resolution TEXT,
        requested_resolution TEXT NOT NULL,
        actual_resolution TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        fallback_reason TEXT,
        reason TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_exp_event_session ON expansion_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_exp_event_plan ON expansion_events(context_plan_id);
      CREATE INDEX IF NOT EXISTS idx_exp_event_unit ON expansion_events(context_unit_id);

      CREATE TABLE IF NOT EXISTS final_context_allocations (
        plan_id TEXT PRIMARY KEY,
        workspace_snapshot_id TEXT NOT NULL,
        total_estimated_tokens INTEGER NOT NULL,
        budget_tokens INTEGER NOT NULL,
        overflow INTEGER NOT NULL,
        tokenizer_method TEXT NOT NULL,
        items_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_usage_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        cost_usd REAL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_provider_usage_session ON provider_usage_events(session_id);
    `,
  },
  {
    version: 9,
    name: '009_jev_shadow_judgments',
    sql: `
      CREATE TABLE IF NOT EXISTS jev_shadow_judgments (
        signal_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT,
        workspace_snapshot_id TEXT NOT NULL,
        context_unit_id TEXT NOT NULL,
        context_plan_id TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        question_set_version TEXT NOT NULL,
        semantic_relevance_probability REAL,
        implementation_needed_probability REAL,
        likely_edit_target_probability REAL,
        likely_root_cause_probability REAL,
        latency_ms INTEGER NOT NULL,
        input_tokens INTEGER,
        request_id TEXT,
        redaction_applied INTEGER NOT NULL,
        fallback_reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jev_shadow_task ON jev_shadow_judgments(task_id);
      CREATE INDEX IF NOT EXISTS idx_jev_shadow_unit ON jev_shadow_judgments(context_unit_id);
      CREATE INDEX IF NOT EXISTS idx_jev_shadow_session ON jev_shadow_judgments(session_id);
      CREATE INDEX IF NOT EXISTS idx_jev_shadow_plan ON jev_shadow_judgments(context_plan_id);
    `,
  },
  {
    version: 10,
    name: '010_candidate_decision_observations_session_id',
    sql: `
      ALTER TABLE candidate_decision_observations ADD COLUMN session_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_dec_obs_session ON candidate_decision_observations(session_id);
    `,
  },
  {
    version: 11,
    name: '011_training_rows_export_id',
    sql: `
      ALTER TABLE training_rows ADD COLUMN export_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_trow_export ON training_rows(export_id);
    `,
  },
  {
    version: 12,
    name: '012_training_evidence_records_export_id',
    sql: `
      ALTER TABLE training_evidence_records ADD COLUMN export_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_evrec_export ON training_evidence_records(export_id);
    `,
  },
  {
    version: 13,
    name: '013_jev_shadow_judgments_agent_env',
    sql: `
      ALTER TABLE jev_shadow_judgments ADD COLUMN agent_environment_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_jev_shadow_agent_env ON jev_shadow_judgments(agent_environment_id);
    `,
  },
  {
    version: 14,
    name: '014_training_evidence_records_nullable_was_edited',
    sql: `
      CREATE TABLE IF NOT EXISTS training_evidence_records_new (
        evidence_id TEXT PRIMARY KEY,
        dataset_version TEXT NOT NULL,
        task_id TEXT NOT NULL,
        context_unit_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        tenant_id TEXT,
        was_read INTEGER,
        was_edited INTEGER,
        verified_success INTEGER,
        rights_reference TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        exported_at TEXT NOT NULL,
        export_id TEXT
      );

      INSERT OR REPLACE INTO training_evidence_records_new (
        evidence_id, dataset_version, task_id, context_unit_id,
        repository, tenant_id, was_read, was_edited, verified_success,
        rights_reference, raw_json, exported_at, export_id
      )
      SELECT
        evidence_id, dataset_version, task_id, context_unit_id,
        repository, tenant_id, was_read, was_edited, verified_success,
        rights_reference, raw_json, exported_at, export_id
      FROM training_evidence_records;

      DROP TABLE training_evidence_records;
      ALTER TABLE training_evidence_records_new RENAME TO training_evidence_records;

      CREATE INDEX IF NOT EXISTS idx_evrec_dataset ON training_evidence_records(dataset_version);
      CREATE INDEX IF NOT EXISTS idx_evrec_task ON training_evidence_records(task_id);
      CREATE INDEX IF NOT EXISTS idx_evrec_repo ON training_evidence_records(repository);
      CREATE INDEX IF NOT EXISTS idx_evrec_export ON training_evidence_records(export_id);
    `,
  },
  {
    version: 15,
    name: '015_learning_flywheel_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS task_episodes (
        episode_id TEXT PRIMARY KEY,
        tenant_id TEXT,
        repository_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_type TEXT,
        base_commit TEXT NOT NULL,
        context_policy_id TEXT NOT NULL,
        ranker_id TEXT NOT NULL,
        ranker_status TEXT NOT NULL,
        training_allowed INTEGER NOT NULL,
        service_processing_allowed INTEGER NOT NULL,
        redistribution_allowed INTEGER NOT NULL,
        candidate_count INTEGER NOT NULL,
        bundle_sha256 TEXT NOT NULL,
        actual_rendered_tokens INTEGER NOT NULL,
        token_budget INTEGER NOT NULL,
        verified_success INTEGER,
        verification_confidence TEXT NOT NULL,
        total_cost_usd REAL,
        pricing_status TEXT,
        record_sha256 TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tep_repo ON task_episodes(repository_id);
      CREATE INDEX IF NOT EXISTS idx_tep_task ON task_episodes(task_id);
      CREATE INDEX IF NOT EXISTS idx_tep_session ON task_episodes(session_id);
      CREATE INDEX IF NOT EXISTS idx_tep_vsuccess ON task_episodes(verified_success);
      CREATE INDEX IF NOT EXISTS idx_tep_training ON task_episodes(training_allowed);
      CREATE INDEX IF NOT EXISTS idx_tep_type ON task_episodes(task_type);

      CREATE TABLE IF NOT EXISTS episode_candidates (
        candidate_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        context_unit_id TEXT NOT NULL,
        path TEXT,
        unit_kind TEXT NOT NULL,
        retrieval_sources_json TEXT NOT NULL,
        pre_rank_position INTEGER,
        final_rank INTEGER NOT NULL,
        final_score REAL NOT NULL,
        feature_set_version TEXT NOT NULL,
        feature_snapshot_json TEXT,
        estimated_tokens INTEGER NOT NULL,
        selected INTEGER NOT NULL,
        selected_resolution TEXT,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ecand_ep ON episode_candidates(episode_id);
      CREATE INDEX IF NOT EXISTS idx_ecand_unit ON episode_candidates(context_unit_id);

      CREATE TABLE IF NOT EXISTS context_exposures (
        exposure_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        context_unit_id TEXT NOT NULL,
        path TEXT,
        unit_kind TEXT NOT NULL,
        state TEXT NOT NULL,
        final_rank INTEGER,
        resolution TEXT,
        candidate_at TEXT NOT NULL,
        selected_at TEXT,
        materialized_at TEXT,
        shown_at TEXT,
        read_at TEXT,
        edited_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cexp_ep ON context_exposures(episode_id);
      CREATE INDEX IF NOT EXISTS idx_cexp_unit ON context_exposures(context_unit_id);
      CREATE INDEX IF NOT EXISTS idx_cexp_state ON context_exposures(state);

      CREATE TABLE IF NOT EXISTS episode_trajectory_events (
        event_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        path TEXT,
        context_unit_id TEXT,
        metadata_json TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_etraj_ep ON episode_trajectory_events(episode_id);
      CREATE INDEX IF NOT EXISTS idx_etraj_seq ON episode_trajectory_events(episode_id, sequence);

      CREATE TABLE IF NOT EXISTS pre_outcome_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        feature_cutoff_commit TEXT NOT NULL,
        prompt_sha256 TEXT NOT NULL,
        bundle_sha256 TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL,
        token_budget INTEGER NOT NULL,
        actual_rendered_tokens INTEGER NOT NULL,
        context_policy_id TEXT NOT NULL,
        ranker_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_posnap_ep ON pre_outcome_snapshots(episode_id);
      CREATE INDEX IF NOT EXISTS idx_posnap_repo ON pre_outcome_snapshots(repository_id);

      CREATE TABLE IF NOT EXISTS dataset_v2_rows (
        row_id TEXT PRIMARY KEY,
        export_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        context_unit_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        exposure_state TEXT NOT NULL,
        was_selected INTEGER NOT NULL,
        was_shown INTEGER NOT NULL,
        was_read INTEGER NOT NULL,
        was_edited INTEGER NOT NULL,
        was_in_successful_task INTEGER NOT NULL,
        was_in_failed_task INTEGER NOT NULL,
        verified_success INTEGER,
        outcome_confidence TEXT NOT NULL,
        features_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        exported_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dv2_export ON dataset_v2_rows(export_id);
      CREATE INDEX IF NOT EXISTS idx_dv2_ep ON dataset_v2_rows(episode_id);
      CREATE INDEX IF NOT EXISTS idx_dv2_unit ON dataset_v2_rows(context_unit_id);

      CREATE TABLE IF NOT EXISTS episode_revocations (
        revocation_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        revoked_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_erev_ep ON episode_revocations(episode_id);
    `,
  },
  {
    version: 16,
    name: '016_shadow_policy_evaluations_and_attribution',
    sql: `
      CREATE TABLE IF NOT EXISTS shadow_policy_evaluations (
        evaluation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        production_policy_id TEXT NOT NULL,
        shadow_policy_id TEXT NOT NULL,
        candidate_count INTEGER NOT NULL,
        rank_overlap_jaccard REAL NOT NULL,
        token_difference INTEGER NOT NULL,
        shadow_latency_ms INTEGER NOT NULL,
        crashed INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        evaluated_at TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_speval_task ON shadow_policy_evaluations(task_id);
      CREATE INDEX IF NOT EXISTS idx_speval_crash ON shadow_policy_evaluations(crashed);

      ALTER TABLE context_exposures ADD COLUMN attribution_type TEXT;
      ALTER TABLE context_exposures ADD COLUMN read_attribution TEXT;
      ALTER TABLE context_exposures ADD COLUMN edit_attribution TEXT;
    `,
  },
  {
    version: 17,
    name: '017_pre_outcome_integrity_audits_and_shadow_env',
    sql: `
      CREATE TABLE IF NOT EXISTS pre_outcome_integrity_audits (
        audit_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL,
        recomputed_sha256 TEXT NOT NULL,
        passed INTEGER NOT NULL,
        has_leakage INTEGER NOT NULL,
        has_hash_mismatch INTEGER NOT NULL,
        has_provenance_error INTEGER NOT NULL,
        audited_at TEXT NOT NULL,
        details_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_poia_ep ON pre_outcome_integrity_audits(episode_id);
      CREATE INDEX IF NOT EXISTS idx_poia_passed ON pre_outcome_integrity_audits(passed);

      ALTER TABLE shadow_policy_evaluations ADD COLUMN environment TEXT DEFAULT 'PRODUCTION';
      ALTER TABLE shadow_policy_evaluations ADD COLUMN is_synthetic INTEGER DEFAULT 0;
    `,
  },
];

export interface PreOutcomeIntegrityAudit {
  auditId: string;
  episodeId: string;
  snapshotSha256: string;
  recomputedSha256: string;
  passed: boolean;
  hasLeakage: boolean;
  hasHashMismatch: boolean;
  hasProvenanceError: boolean;
  auditedAt: string;
  details?: Record<string, unknown>;
}

export class SqliteStore {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(dbPath: string = ':memory:') {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(path.resolve(dbPath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    if (!NodeDatabaseSync) {
      throw new Error(
        'node:sqlite (DatabaseSync) is not available in the current runtime. ' +
        'Please run SiftrCode on Node.js 22.5.0 or later (Active LTS).'
      );
    }

    this.db = new NodeDatabaseSync(dbPath);
    this.runMigrations();
  }

  public getPath(): string {
    return this.dbPath;
  }

  public close(): void {
    this.db.close();
  }

  /**
   * Executes pending database migrations.
   */
  public runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{
      version: number;
    }>;
    const appliedSet = new Set(appliedRows.map((r) => r.version));

    for (const mig of MIGRATIONS) {
      if (!appliedSet.has(mig.version)) {
        this.db.exec(mig.sql);
        const insertStmt = this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
        insertStmt.run(mig.version, mig.name, new Date().toISOString());
      }
    }
  }

  public getAppliedMigrations(): Array<{ version: number; name: string; applied_at: string }> {
    return this.db.prepare('SELECT * FROM schema_migrations ORDER BY version ASC').all() as Array<{
      version: number;
      name: string;
      applied_at: string;
    }>;
  }

  // ==========================================
  // Snapshot Operations
  // ==========================================

  public saveSnapshot(snapshot: WorkspaceSnapshot, workspaceId: string = 'default'): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO snapshots (snapshot_id, workspace_id, content_root_hash, parent_snapshot_id, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      snapshot.workspaceSnapshotId,
      workspaceId,
      snapshot.contentRootHash,
      snapshot.parentSnapshotId || null,
      JSON.stringify(snapshot),
      snapshot.createdAt
    );
  }

  public getSnapshot(snapshotId: string): WorkspaceSnapshot | undefined {
    const row = this.db.prepare('SELECT raw_json FROM snapshots WHERE snapshot_id = ?').get(snapshotId) as {
      raw_json: string;
    } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.raw_json);
  }

  public listSnapshots(workspaceId?: string): WorkspaceSnapshot[] {
    const query = workspaceId
      ? 'SELECT raw_json FROM snapshots WHERE workspace_id = ? ORDER BY created_at ASC'
      : 'SELECT raw_json FROM snapshots ORDER BY created_at ASC';

    const rows = (workspaceId ? this.db.prepare(query).all(workspaceId) : this.db.prepare(query).all()) as Array<{
      raw_json: string;
    }>;

    return rows.map((r) => JSON.parse(r.raw_json));
  }

  // ==========================================
  // ContextUnit Operations
  // ==========================================

  public saveContextUnits(units: ContextUnit[], rights?: DataRights): void {
    if (units.length === 0) return;

    const effectiveRights = rights || createDefaultDataRights({
      symbolMetadataAllowed: true,
      pathRetentionAllowed: true,
      symbolNameRetentionAllowed: true,
    });

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO context_units (unit_id, snapshot_id, repository_id, kind, path, title, trust_level, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    for (const unit of units) {
      const sanitized = sanitizeContextUnitForPersistence(unit, effectiveRights);
      stmt.run(
        sanitized.id,
        sanitized.workspaceSnapshotId,
        sanitized.repositoryId || null,
        sanitized.kind,
        sanitized.path || null,
        sanitized.title,
        sanitized.trustLevel,
        JSON.stringify(sanitized),
        now
      );
    }
  }

  public getContextUnit(unitId: string): ContextUnit | undefined {
    const row = this.db.prepare('SELECT raw_json FROM context_units WHERE unit_id = ?').get(unitId) as {
      raw_json: string;
    } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.raw_json);
  }

  public listContextUnits(
    snapshotId: string,
    options: { kind?: ContextUnitKind; path?: string } = {}
  ): ContextUnit[] {
    let sql = 'SELECT raw_json FROM context_units WHERE snapshot_id = ?';
    const params: (string | number)[] = [snapshotId];

    if (options.kind !== undefined) {
      sql += ' AND kind = ?';
      params.push(options.kind);
    }

    if (options.path !== undefined) {
      sql += ' AND path = ?';
      params.push(options.path);
    }

    sql += ' ORDER BY unit_id ASC';

    const rows = this.db.prepare(sql).all(...params) as Array<{ raw_json: string }>;
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  public getContextUnitsBySnapshot(snapshotId: string): ContextUnit[] {
    return this.listContextUnits(snapshotId);
  }

  // ==========================================
  // Graph Edge Operations
  // ==========================================

  public saveGraphEdges(edges: StoredGraphEdge[]): void {
    if (edges.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO graph_edges (from_unit_id, to_unit_id, kind, confidence, source, weight, metadata_json, snapshot_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const e of edges) {
      stmt.run(
        e.fromUnitId,
        e.toUnitId,
        e.kind,
        e.confidence,
        e.source,
        e.weight ?? 1.0,
        e.metadata ? JSON.stringify(e.metadata) : null,
        e.snapshotId
      );
    }
  }

  public getOutgoingEdges(fromUnitId: string, snapshotId: string): StoredGraphEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM graph_edges WHERE from_unit_id = ? AND snapshot_id = ?
    `).all(fromUnitId, snapshotId) as Array<{
      from_unit_id: string;
      to_unit_id: string;
      kind: string;
      confidence: number;
      source: string;
      weight: number | null;
      metadata_json: string | null;
      snapshot_id: string;
    }>;

    return rows.map((r) => ({
      fromUnitId: r.from_unit_id,
      toUnitId: r.to_unit_id,
      kind: r.kind,
      confidence: r.confidence,
      source: r.source,
      weight: r.weight ?? undefined,
      metadata: r.metadata_json ? JSON.parse(r.metadata_json) : undefined,
      snapshotId: r.snapshot_id,
    }));
  }

  public getIncomingEdges(toUnitId: string, snapshotId: string): StoredGraphEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM graph_edges WHERE to_unit_id = ? AND snapshot_id = ?
    `).all(toUnitId, snapshotId) as Array<{
      from_unit_id: string;
      to_unit_id: string;
      kind: string;
      confidence: number;
      source: string;
      weight: number | null;
      metadata_json: string | null;
      snapshot_id: string;
    }>;

    return rows.map((r) => ({
      fromUnitId: r.from_unit_id,
      toUnitId: r.to_unit_id,
      kind: r.kind,
      confidence: r.confidence,
      source: r.source,
      weight: r.weight ?? undefined,
      metadata: r.metadata_json ? JSON.parse(r.metadata_json) : undefined,
      snapshotId: r.snapshot_id,
    }));
  }

  // ==========================================
  // TaskContext Operations
  // ==========================================

  public saveTaskContext(task: TaskContext, rights?: DataRights): void {
    const effectiveRights = rights || createDefaultDataRights({
      symbolMetadataAllowed: true,
      pathRetentionAllowed: true,
      symbolNameRetentionAllowed: true,
    });
    const sanitized = sanitizeTaskContextForPersistence(task, effectiveRights);

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO task_contexts (task_id, snapshot_id, primary_prompt, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      sanitized.taskId,
      sanitized.workspaceSnapshotId,
      sanitized.primaryPrompt,
      JSON.stringify(sanitized),
      sanitized.createdAt
    );
  }

  public getTaskContext(taskId: string): TaskContext | undefined {
    const row = this.db.prepare('SELECT raw_json FROM task_contexts WHERE task_id = ?').get(taskId) as {
      raw_json: string;
    } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.raw_json);
  }

  // ==========================================
  // Session Operations (Final Closure Directive Section 14-17)
  // ==========================================

  public saveSession(session: StoredSession | SiftrSession): void {
    const now = new Date().toISOString();
    const createdAt = session.createdAt || now;
    const updatedAt = session.updatedAt || now;
    const snapshotId = ('snapshotId' in session && session.snapshotId)
      ? session.snapshotId
      : (session as SiftrSession).initialWorkspaceSnapshotId || 'snapshot_init';

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (
        session_id, task_id, snapshot_id, state, agent_environment_id,
        initial_snapshot_id, latest_snapshot_id, ended_at, raw_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const statusOrState = 'state' in session ? (session.state || null) : ((session as SiftrSession).status || null);
    const agentEnvId = 'agentEnvironmentId' in session ? ((session as any).agentEnvironmentId || null) : null;
    const initSnapshotId = 'initialWorkspaceSnapshotId' in session ? ((session as any).initialWorkspaceSnapshotId || snapshotId) : snapshotId;
    const latestSnapshotId = 'latestWorkspaceSnapshotId' in session ? ((session as any).latestWorkspaceSnapshotId || snapshotId) : snapshotId;
    const endedAt = 'endedAt' in session ? ((session as any).endedAt || null) : null;

    stmt.run(
      session.sessionId,
      session.taskId,
      snapshotId,
      statusOrState,
      agentEnvId,
      initSnapshotId,
      latestSnapshotId,
      endedAt,
      JSON.stringify(session),
      createdAt,
      updatedAt
    );
  }

  public saveSiftrSession(session: SiftrSession): void {
    this.saveSession(session);
  }

  public getSession(sessionId: string): StoredSession | undefined {
    const row = this.db.prepare('SELECT raw_json FROM sessions WHERE session_id = ?').get(sessionId) as {
      raw_json: string;
    } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.raw_json);
  }

  public getSiftrSession(sessionId: string): SiftrSession | undefined {
    const row = this.db.prepare('SELECT raw_json FROM sessions WHERE session_id = ?').get(sessionId) as {
      raw_json: string;
    } | undefined;

    if (!row) return undefined;
    const parsed = JSON.parse(row.raw_json);
    return {
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      agentEnvironmentId: parsed.agentEnvironmentId || 'unknown',
      initialWorkspaceSnapshotId: parsed.initialWorkspaceSnapshotId || parsed.snapshotId,
      latestWorkspaceSnapshotId: parsed.latestWorkspaceSnapshotId || parsed.initialWorkspaceSnapshotId || parsed.snapshotId,
      status: (parsed.status || parsed.state || 'ACTIVE') as SiftrSessionStatus,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      endedAt: parsed.endedAt,
      metadata: parsed.metadata,
    };
  }

  public updateSessionStatus(sessionId: string, status: SiftrSessionStatus, endedAt?: string): void {
    const session = this.getSiftrSession(sessionId);
    if (!session) return;
    const now = new Date().toISOString();
    session.status = status;
    session.updatedAt = now;
    if (endedAt || status === 'COMPLETED' || status === 'ABORTED') {
      session.endedAt = endedAt || now;
    }
    this.saveSiftrSession(session);
  }

  public updateSessionSnapshot(sessionId: string, snapshotId: string): void {
    const session = this.getSiftrSession(sessionId);
    if (!session) return;
    session.latestWorkspaceSnapshotId = snapshotId;
    session.updatedAt = new Date().toISOString();
    this.saveSiftrSession(session);
  }

  // ==========================================
  // ContextPlan Operations
  // ==========================================

  public saveContextPlan(plan: ContextPlan, snapshotId: string = 'default'): void {
    const rights = plan.dataRights || createDefaultDataRights();
    const sanitizedRecord = sanitizeContextPlanForPersistence(plan, rights, snapshotId);

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO context_plans (plan_id, task_id, snapshot_id, raw_json, created_at, session_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      plan.planId,
      plan.taskId,
      snapshotId,
      JSON.stringify(sanitizedRecord),
      plan.createdAt,
      plan.sessionId || null
    );
  }

  public getContextPlan(planId: string): ContextPlan | undefined {
    const row = this.db.prepare('SELECT raw_json FROM context_plans WHERE plan_id = ?').get(planId) as {
      raw_json: string;
    } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.raw_json);
  }

  public listContextPlans(taskId?: string, sessionId?: string): ContextPlan[] {
    let query: string;
    let params: string[];
    if (taskId && sessionId) {
      query = 'SELECT raw_json FROM context_plans WHERE task_id = ? AND session_id = ? ORDER BY created_at ASC';
      params = [taskId, sessionId];
    } else if (sessionId) {
      query = 'SELECT raw_json FROM context_plans WHERE session_id = ? ORDER BY created_at ASC';
      params = [sessionId];
    } else if (taskId) {
      query = 'SELECT raw_json FROM context_plans WHERE task_id = ? ORDER BY created_at ASC';
      params = [taskId];
    } else {
      query = 'SELECT raw_json FROM context_plans ORDER BY created_at ASC';
      params = [];
    }

    const rows = this.db.prepare(query).all(...params) as Array<{
      raw_json: string;
    }>;

    return rows.map((r) => JSON.parse(r.raw_json));
  }

  public getContextPlanByTask(taskId: string): ContextPlan | undefined {
    const plans = this.listContextPlans(taskId);
    return plans.length > 0 ? plans[plans.length - 1] : undefined;
  }

  public updatePlanActualProviderTokens(planId: string, actualTokens: number): void {
    const existing = this.getContextPlan(planId);
    if (!existing) return;
    existing.actualProviderInputTokens = actualTokens;
    const stmt = this.db.prepare('UPDATE context_plans SET raw_json = ? WHERE plan_id = ?');
    stmt.run(JSON.stringify(existing), planId);
  }

  // ==========================================
  // CandidateObservation Operations (Append-Only)
  // ==========================================

  public saveCandidateObservations(observations: CandidateObservationV2[]): void {
    if (observations.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO candidate_observations (
        observation_id, task_id, session_id, snapshot_id, context_unit_id,
        agent_environment_id, observability_level, feature_schema_version,
        policy_id, policy_version, was_exposed, exposure_resolution,
        outcome_label, rights_reference, evidence_json, raw_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const obs of observations) {
      stmt.run(
        obs.observationId,
        obs.taskId,
        obs.siftrSessionId,
        obs.workspaceSnapshotId,
        obs.contextUnitId,
        obs.agentEnvironmentId,
        obs.observabilityLevel,
        obs.featureSchemaVersion,
        obs.exposure.policyId,
        obs.exposure.policyVersion,
        isExposedV2(obs.exposure) ? 1 : 0,
        obs.exposure.resolution,
        obs.outcomeLabel,
        obs.rightsReference,
        obs.evidence ? JSON.stringify(obs.evidence) : null,
        JSON.stringify(obs),
        obs.recordedAt
      );
    }
  }

  public getCandidateObservation(observationId: string): CandidateObservationV2 | undefined {
    const row = this.db.prepare('SELECT raw_json FROM candidate_observations WHERE observation_id = ?').get(observationId) as {
      raw_json: string;
    } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.raw_json);
  }

  public listCandidateObservations(options: { taskId?: string; contextUnitId?: string; outcomeLabel?: string } = {}): CandidateObservationV2[] {
    let sql = 'SELECT raw_json FROM candidate_observations WHERE 1=1';
    const params: string[] = [];

    if (options.taskId) {
      sql += ' AND task_id = ?';
      params.push(options.taskId);
    }
    if (options.contextUnitId) {
      sql += ' AND context_unit_id = ?';
      params.push(options.contextUnitId);
    }
    if (options.outcomeLabel) {
      sql += ' AND outcome_label = ?';
      params.push(options.outcomeLabel);
    }

    sql += ' ORDER BY recorded_at ASC';
    const rows = this.db.prepare(sql).all(...params) as Array<{ raw_json: string }>;
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  // ==========================================
  // CandidateDecisionObservation Operations (Closure PR 0.4)
  // ==========================================

  public saveCandidateDecisionObservations(decisions: CandidateDecisionObservation[], rights?: DataRights): void {
    if (decisions.length === 0) return;

    const effectiveRights = rights || createDefaultDataRights({
      symbolMetadataAllowed: true,
      pathRetentionAllowed: true,
      symbolNameRetentionAllowed: true,
    });

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO candidate_decision_observations (
        decision_observation_id, task_id, session_id, snapshot_id, context_unit_id,
        candidate_rank, exposure_resolution, policy_id, policy_version,
        observability_level, features_json, raw_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const dec of decisions) {
      const sanitized = sanitizeCandidateDecisionObservation(dec, effectiveRights);
      stmt.run(
        sanitized.decisionObservationId,
        sanitized.taskId,
        sanitized.sessionId || null,
        sanitized.workspaceSnapshotId,
        sanitized.contextUnitId,
        sanitized.rank ?? null,
        sanitized.exposureDecision.resolution,
        sanitized.policyId,
        sanitized.policyVersion,
        sanitized.observabilityLevel,
        JSON.stringify(sanitized.features),
        JSON.stringify(sanitized),
        sanitized.recordedAt
      );
    }
  }

  public getCandidateDecisionObservation(id: string): CandidateDecisionObservation | undefined {
    const row = this.db.prepare('SELECT raw_json FROM candidate_decision_observations WHERE decision_observation_id = ?').get(id) as {
      raw_json: string;
    } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.raw_json);
  }

  public listCandidateDecisionObservations(options: { taskId?: string; sessionId?: string; contextUnitId?: string } = {}): CandidateDecisionObservation[] {
    let sql = 'SELECT raw_json FROM candidate_decision_observations WHERE 1=1';
    const params: string[] = [];

    if (options.taskId) {
      sql += ' AND task_id = ?';
      params.push(options.taskId);
    }
    if (options.sessionId) {
      sql += ' AND session_id = ?';
      params.push(options.sessionId);
    }
    if (options.contextUnitId) {
      sql += ' AND context_unit_id = ?';
      params.push(options.contextUnitId);
    }

    sql += ' ORDER BY recorded_at ASC';
    const rows = this.db.prepare(sql).all(...params) as Array<{ raw_json: string }>;
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  // ==========================================
  // ExposureDecision Operations (Section 25)
  // ==========================================

  public saveExposureDecisions(decisions: ExposureDecisionV2[], taskId: string = 'default'): void {
    if (decisions.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO exposure_decisions (
        decision_id, context_plan_id, task_id, context_unit_id,
        policy_id, policy_version, eligible_for_selection, selected,
        candidate_rank, final_bundle_rank, resolution, actual_token_cost,
        selection_probability, exploration_policy, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const d of decisions) {
      const decisionId = `ed_${d.contextPlanId}_${d.contextUnitId}`;
      stmt.run(
        decisionId,
        d.contextPlanId,
        taskId,
        d.contextUnitId,
        d.policyId,
        d.policyVersion,
        d.eligibleForSelection ? 1 : 0,
        d.selected ? 1 : 0,
        d.candidateRank ?? null,
        d.finalBundleRank ?? null,
        d.resolution,
        d.actualTokenCost ?? null,
        d.selectionProbability ?? null,
        d.explorationPolicy ?? null,
        d.timestamp
      );
    }
  }

  public listExposureDecisions(contextPlanId: string): ExposureDecisionV2[] {
    const rows = this.db.prepare(`
      SELECT * FROM exposure_decisions WHERE context_plan_id = ? ORDER BY candidate_rank ASC
    `).all(contextPlanId) as Array<{
      context_plan_id: string;
      context_unit_id: string;
      policy_id: string;
      policy_version: string;
      eligible_for_selection: number;
      selected: number;
      candidate_rank: number | null;
      final_bundle_rank: number | null;
      resolution: number;
      actual_token_cost: number | null;
      selection_probability: number | null;
      exploration_policy: string | null;
      timestamp: string;
    }>;

    return rows.map((r) => ({
      contextPlanId: r.context_plan_id,
      contextUnitId: r.context_unit_id,
      policyId: r.policy_id,
      policyVersion: r.policy_version,
      eligibleForSelection: Boolean(r.eligible_for_selection),
      selected: Boolean(r.selected),
      candidateRank: r.candidate_rank ?? undefined,
      finalBundleRank: r.final_bundle_rank ?? undefined,
      resolution: r.resolution,
      actualTokenCost: r.actual_token_cost ?? undefined,
      selectionProbability: r.selection_probability ?? undefined,
      explorationPolicy: r.exploration_policy ?? undefined,
      timestamp: r.timestamp,
    }));
  }

  // ==========================================
  // TrajectoryEvent Operations (Section 25)
  // ==========================================

  public saveTrajectoryEvents(events: TrajectoryEvent[], sessionId?: string, snapshotId?: string, rights?: DataRights): void {
    if (events.length === 0) return;
    if (rights && !isDataClassPermitted(rights, DataClass.TRAJECTORY)) {
      return;
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trajectory_events (
        event_id, task_id, session_id, snapshot_id, kind, payload_json, timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    for (const ev of events) {
      stmt.run(
        ev.eventId,
        ev.taskId,
        sessionId ?? null,
        snapshotId ?? null,
        ev.kind,
        JSON.stringify(ev.payload),
        ev.timestamp,
        now
      );
    }
  }

  public listTrajectoryEvents(taskId: string): TrajectoryEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM trajectory_events WHERE task_id = ? ORDER BY timestamp ASC
    `).all(taskId) as Array<{
      event_id: string;
      task_id: string;
      kind: string;
      payload_json: string;
      timestamp: number;
    }>;

    return rows.map((r) => ({
      eventId: r.event_id,
      taskId: r.task_id,
      kind: r.kind as any,
      payload: JSON.parse(r.payload_json),
      timestamp: r.timestamp,
      dataRights: undefined as any,
    }));
  }

  // ==========================================
  // OutcomeEvidence Operations (Section 25)
  // ==========================================

  public saveOutcomeEvidence(evidenceList: Array<{
    evidenceId?: string;
    taskId: string;
    sessionId?: string;
    snapshotId?: string;
    contextUnitId?: string;
    contextPlanId?: string;
    labelType: string;
    value?: number | null;
    verifiedSuccess?: boolean | null;
    confidence: number;
    strength: string;
    source: string;
    details?: Record<string, unknown>;
  }>): void {
    if (evidenceList.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO outcome_evidence (
        evidence_id, task_id, session_id, snapshot_id, label_type,
        value, confidence, strength, source, context_unit_id, details_json,
        context_plan_id, verified_success, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    for (const ev of evidenceList) {
      const id = ev.evidenceId || `ev_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
      // Closure PR F1 / Section 5: UNKNOWN must remain UNKNOWN (null !== 0). Never convert null to 0!
      const persistedVerifiedSuccess =
        ev.verifiedSuccess === null || ev.verifiedSuccess === undefined
          ? null
          : (ev.verifiedSuccess ? 1 : 0);

      const scalarValue = (ev.value !== undefined && ev.value !== null)
        ? ev.value
        : (persistedVerifiedSuccess !== null ? persistedVerifiedSuccess : 0.5);

      stmt.run(
        id,
        ev.taskId,
        ev.sessionId ?? null,
        ev.snapshotId ?? null,
        ev.labelType,
        scalarValue,
        ev.confidence,
        ev.strength,
        ev.source,
        ev.contextUnitId ?? null,
        ev.details ? JSON.stringify(ev.details) : null,
        ev.contextPlanId ?? null,
        persistedVerifiedSuccess,
        now
      );
    }
  }

  public listOutcomeEvidence(taskId?: string, sessionId?: string): Array<{
    evidenceId: string;
    taskId: string;
    sessionId?: string;
    snapshotId?: string;
    contextUnitId?: string;
    contextPlanId?: string;
    labelType: string;
    value: number;
    verifiedSuccess?: boolean | null;
    confidence: number;
    strength: string;
    source: string;
    details?: Record<string, unknown>;
    createdAt: string;
  }> {
    let query = 'SELECT * FROM outcome_evidence';
    const params: string[] = [];
    if (taskId && sessionId) {
      query += ' WHERE task_id = ? AND session_id = ?';
      params.push(taskId, sessionId);
    } else if (taskId) {
      query += ' WHERE task_id = ?';
      params.push(taskId);
    } else if (sessionId) {
      query += ' WHERE session_id = ?';
      params.push(sessionId);
    }
    query += ' ORDER BY created_at ASC';

    const rows = this.db.prepare(query).all(...params) as Array<{
      evidence_id: string;
      task_id: string;
      session_id: string | null;
      snapshot_id: string | null;
      label_type: string;
      value: number;
      confidence: number;
      strength: string;
      source: string;
      context_unit_id: string | null;
      details_json: string | null;
      context_plan_id: string | null;
      verified_success: number | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      evidenceId: r.evidence_id,
      taskId: r.task_id,
      sessionId: r.session_id ?? undefined,
      snapshotId: r.snapshot_id ?? undefined,
      contextUnitId: r.context_unit_id ?? undefined,
      contextPlanId: r.context_plan_id ?? undefined,
      labelType: r.label_type,
      value: r.value,
      verifiedSuccess: r.verified_success === null ? null : (r.verified_success === 1),
      confidence: r.confidence,
      strength: r.strength,
      source: r.source,
      details: r.details_json ? JSON.parse(r.details_json) : undefined,
      createdAt: r.created_at,
    }));
  }

  // ==========================================
  // ProviderCall Operations (Section 25)
  // ==========================================

  public saveProviderCall(record: {
    callId?: string;
    taskId?: string;
    providerName: string;
    allowed: boolean;
    reason?: string;
    blockedUnits?: string[];
    redactedSecretsCount?: number;
    timestamp?: string;
  }): void {
    const callId = record.callId || `call_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO provider_calls (
        call_id, task_id, provider_name, allowed, reason, blocked_units_json, redacted_secrets_count, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      callId,
      record.taskId ?? null,
      record.providerName,
      record.allowed ? 1 : 0,
      record.reason ?? null,
      record.blockedUnits ? JSON.stringify(record.blockedUnits) : null,
      record.redactedSecretsCount ?? 0,
      record.timestamp ?? new Date().toISOString()
    );
  }

  public listProviderCalls(taskId?: string): Array<{
    callId: string;
    taskId?: string;
    providerName: string;
    allowed: boolean;
    reason?: string;
    blockedUnits?: string[];
    redactedSecretsCount: number;
    timestamp: string;
  }> {
    const query = taskId
      ? 'SELECT * FROM provider_calls WHERE task_id = ? ORDER BY timestamp ASC'
      : 'SELECT * FROM provider_calls ORDER BY timestamp ASC';

    const rows = (taskId ? this.db.prepare(query).all(taskId) : this.db.prepare(query).all()) as Array<{
      call_id: string;
      task_id: string | null;
      provider_name: string;
      allowed: number;
      reason: string | null;
      blocked_units_json: string | null;
      redacted_secrets_count: number;
      timestamp: string;
    }>;

    return rows.map((r) => ({
      callId: r.call_id,
      taskId: r.task_id ?? undefined,
      providerName: r.provider_name,
      allowed: Boolean(r.allowed),
      reason: r.reason ?? undefined,
      blockedUnits: r.blocked_units_json ? JSON.parse(r.blocked_units_json) : undefined,
      redactedSecretsCount: r.redacted_secrets_count,
      timestamp: r.timestamp,
    }));
  }

  // ==========================================
  // Task OutcomeEvidence Operations (Section 48, 49)
  // ==========================================

  public saveTaskOutcome(outcome: OutcomeEvidence): { episodeFinalized: boolean; finalizationErrorCode?: string } {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO task_outcome_records (
        outcome_id, task_id, session_id, agent_environment_id,
        workspace_snapshot_before, workspace_snapshot_after,
        build_passed, public_tests_passed, hidden_tests_passed,
        regression_tests_passed, static_checks_passed, security_checks_passed,
        behavioral_oracle_passed, user_accepted, agent_reported_success,
        human_review, verified_success, confidence,
        policy_id, policy_version, evaluation_rationale,
        context_plan_id, raw_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      outcome.outcomeId,
      outcome.taskId,
      outcome.sessionId,
      outcome.agentEnvironmentId,
      outcome.workspaceSnapshotBefore,
      outcome.workspaceSnapshotAfter ?? null,
      outcome.buildPassed !== undefined ? (outcome.buildPassed ? 1 : 0) : null,
      outcome.publicTestsPassed !== undefined ? (outcome.publicTestsPassed ? 1 : 0) : null,
      outcome.hiddenTestsPassed !== undefined ? (outcome.hiddenTestsPassed ? 1 : 0) : null,
      outcome.regressionTestsPassed !== undefined ? (outcome.regressionTestsPassed ? 1 : 0) : null,
      outcome.staticChecksPassed !== undefined ? (outcome.staticChecksPassed ? 1 : 0) : null,
      outcome.securityChecksPassed !== undefined ? (outcome.securityChecksPassed ? 1 : 0) : null,
      outcome.behavioralOraclePassed !== undefined ? (outcome.behavioralOraclePassed ? 1 : 0) : null,
      outcome.userAccepted !== undefined ? (outcome.userAccepted ? 1 : 0) : null,
      outcome.agentReportedSuccess !== undefined ? (outcome.agentReportedSuccess ? 1 : 0) : null,
      outcome.humanReview ?? null,
      outcome.verifiedSuccess === null ? null : outcome.verifiedSuccess ? 1 : 0,
      outcome.confidence,
      outcome.policyId ?? null,
      outcome.policyVersion ?? null,
      outcome.evaluationRationale ?? null,
      outcome.contextPlanId ?? null,
      JSON.stringify(outcome),
      outcome.recordedAt
    );

    // Automatic Episode Finalization on Real Outcome Submission (Phase 20.2)
    try {
      const episode = this.finalizeEpisodeFromOutcome(outcome);
      return { episodeFinalized: episode !== null };
    } catch (err: any) {
      return {
        episodeFinalized: false,
        finalizationErrorCode: err.code || err.message || 'FINALIZATION_FAILED',
      };
    }
  }

  public getTaskOutcome(taskId: string): OutcomeEvidence | null {
    const row = this.db
      .prepare(`
      SELECT raw_json FROM task_outcome_records WHERE task_id = ? ORDER BY recorded_at DESC LIMIT 1
    `)
      .get(taskId) as { raw_json: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.raw_json) as OutcomeEvidence;
  }

  public listTaskOutcomes(limit: number = 100): OutcomeEvidence[] {
    const rows = this.db
      .prepare(`
      SELECT raw_json FROM task_outcome_records ORDER BY recorded_at DESC LIMIT ?
    `)
      .all(limit) as Array<{ raw_json: string }>;

    return rows.map((r) => JSON.parse(r.raw_json) as OutcomeEvidence);
  }

  /**
   * Validates referential integrity before storing an outcome (Final Closure Directive Section 36-37).
   */
  public validateOutcomeIntegrity(params: {
    sessionId: string;
    taskId: string;
    planId?: string;
    snapshotId?: string;
    agentEnvironmentId?: string;
  }): { valid: boolean; reason?: string } {
    const lineage = resolveOutcomeLineage({
      contextPlanId: params.planId,
      taskId: params.taskId,
      sessionId: params.sessionId,
      workspaceSnapshotId: params.snapshotId,
      agentEnvironmentId: params.agentEnvironmentId,
    }, this);
    if (!lineage.valid) {
      return { valid: false, reason: lineage.error };
    }
    return { valid: true };
  }

  // ==========================================
  // ContextExpansionEvent Operations (Closure Section 13, 45)
  // ==========================================

  public saveExpansionEvent(event: ContextExpansionEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO expansion_events (
        event_id, task_id, session_id, context_plan_id, workspace_snapshot_id,
        agent_environment_id, context_unit_id, previous_resolution,
        requested_resolution, actual_resolution, token_estimate, fallback_reason,
        reason, raw_json, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.eventId,
      event.taskId,
      event.sessionId,
      event.contextPlanId,
      event.workspaceSnapshotId,
      event.agentEnvironmentId,
      event.contextUnitId,
      event.previousResolution ?? null,
      event.requestedResolution,
      event.actualResolution,
      event.tokenEstimate,
      event.fallbackReason ?? null,
      event.reason,
      JSON.stringify(event),
      event.timestamp
    );
  }

  public listExpansionEvents(sessionIdOrTaskId: string): ContextExpansionEvent[] {
    const rows = this.db.prepare(`
      SELECT raw_json FROM expansion_events
      WHERE session_id = ? OR task_id = ?
      ORDER BY timestamp ASC
    `).all(sessionIdOrTaskId, sessionIdOrTaskId) as Array<{ raw_json: string }>;

    return rows.map((r) => JSON.parse(r.raw_json) as ContextExpansionEvent);
  }

  // ==========================================
  // FinalContextAllocation Operations (Closure Section 48)
  // ==========================================

  public saveFinalContextAllocation(allocation: FinalContextAllocation): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO final_context_allocations (
        plan_id, workspace_snapshot_id, total_estimated_tokens, budget_tokens,
        overflow, tokenizer_method, items_json, raw_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      allocation.planId,
      allocation.workspaceSnapshotId,
      allocation.totalEstimatedTokens,
      allocation.budgetTokens,
      allocation.overflow ? 1 : 0,
      allocation.tokenizerMethod,
      JSON.stringify(allocation.items),
      JSON.stringify(allocation),
      allocation.recordedAt
    );
  }

  public getFinalContextAllocation(planId: string): FinalContextAllocation | null {
    const row = this.db.prepare('SELECT raw_json FROM final_context_allocations WHERE plan_id = ?').get(planId) as {
      raw_json: string;
    } | undefined;
    if (!row) return null;
    return JSON.parse(row.raw_json) as FinalContextAllocation;
  }

  // ==========================================
  // ProviderUsageEvent Operations (Closure Section 50)
  // ==========================================

  public saveProviderUsageEvent(event: ProviderUsageEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO provider_usage_events (
        event_id, session_id, provider, model, input_tokens,
        output_tokens, cached_input_tokens, cost_usd, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.eventId,
      event.sessionId,
      event.provider,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.cachedInputTokens ?? null,
      event.costUsd ?? null,
      event.timestamp
    );
  }

  public listProviderUsageEvents(sessionId: string): ProviderUsageEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM provider_usage_events WHERE session_id = ? ORDER BY timestamp ASC
    `).all(sessionId) as Array<{
      event_id: string;
      session_id: string;
      provider: string;
      model: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_input_tokens: number | null;
      cost_usd: number | null;
      timestamp: string;
    }>;

    return rows.map((r) => ({
      eventId: r.event_id,
      sessionId: r.session_id,
      provider: r.provider,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cachedInputTokens: r.cached_input_tokens ?? undefined,
      costUsd: r.cost_usd ?? undefined,
      timestamp: r.timestamp,
    }));
  }

  // ==========================================
  // JEV Shadow Judgment Operations (Milestone PR J5)
  // ==========================================

  public saveJevShadowJudgments(signals: JevSignalV1[], rights?: DataRights): void {
    if (signals.length === 0) return;

    const allowNumeric = rights ? isDataClassPermitted(rights, DataClass.NUMERIC_FEATURE) : true;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO jev_shadow_judgments (
        signal_id, task_id, session_id, workspace_snapshot_id, agent_environment_id, context_unit_id,
        context_plan_id, provider, model, question_set_version,
        semantic_relevance_probability, implementation_needed_probability,
        likely_edit_target_probability, likely_root_cause_probability,
        latency_ms, input_tokens, request_id, redaction_applied,
        fallback_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const sig of signals) {
      const signalId = sig.requestId || `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      stmt.run(
        signalId,
        sig.taskId,
        sig.sessionId || null,
        sig.workspaceSnapshotId,
        sig.agentEnvironmentId || null,
        sig.contextUnitId,
        sig.contextPlanId || null,
        sig.provider,
        sig.model || null,
        sig.questionSetVersion,
        (allowNumeric && sig.semanticRelevanceProbability !== null) ? sig.semanticRelevanceProbability : null,
        (allowNumeric && sig.implementationNeededProbability !== null) ? sig.implementationNeededProbability : null,
        (allowNumeric && sig.likelyEditTargetProbability !== null) ? sig.likelyEditTargetProbability : null,
        (allowNumeric && sig.likelyRootCauseProbability !== null) ? sig.likelyRootCauseProbability : null,
        sig.latencyMs,
        sig.inputTokens ?? null,
        sig.requestId || null,
        sig.redactionApplied ? 1 : 0,
        sig.fallbackReason || null,
        sig.createdAt
      );
    }
  }

  public listJevShadowJudgments(taskIdOrSnapshotId: string): JevSignalV1[] {
    const rows = this.db.prepare(`
      SELECT * FROM jev_shadow_judgments 
      WHERE task_id = ? OR workspace_snapshot_id = ?
      ORDER BY created_at ASC
    `).all(taskIdOrSnapshotId, taskIdOrSnapshotId) as any[];

    return rows.map((r) => ({
      schemaVersion: 'jev-signal-v1',
      taskId: r.task_id,
      sessionId: r.session_id || undefined,
      workspaceSnapshotId: r.workspace_snapshot_id,
      agentEnvironmentId: r.agent_environment_id || undefined,
      contextUnitId: r.context_unit_id,
      contextPlanId: r.context_plan_id || undefined,
      provider: 'typesafe-jev',
      model: r.model || null,
      questionSetVersion: r.question_set_version,
      semanticRelevanceProbability: r.semantic_relevance_probability !== null ? Number(r.semantic_relevance_probability) : null,
      implementationNeededProbability: r.implementation_needed_probability !== null ? Number(r.implementation_needed_probability) : null,
      likelyEditTargetProbability: r.likely_edit_target_probability !== null ? Number(r.likely_edit_target_probability) : null,
      likelyRootCauseProbability: r.likely_root_cause_probability !== null ? Number(r.likely_root_cause_probability) : null,
      latencyMs: r.latency_ms,
      inputTokens: r.input_tokens || undefined,
      requestId: r.request_id || undefined,
      redactionApplied: Boolean(r.redaction_applied),
      fallbackReason: r.fallback_reason || undefined,
      createdAt: r.created_at,
    }));
  }

  // ==========================================
  // SourceProvenance Operations (Section 51)
  // ==========================================

  public saveSourceProvenance(provenance: SourceProvenance): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO source_provenances (
        provenance_id, origin, repository, license, training_permission,
        redistribution_permission, cutoff_date, verified, notes, raw_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      provenance.provenanceId,
      provenance.origin,
      provenance.repository,
      provenance.license,
      provenance.trainingPermission,
      provenance.redistributionPermission,
      provenance.cutoffDate,
      provenance.verified ? 1 : 0,
      provenance.notes ?? null,
      JSON.stringify(provenance),
      provenance.createdAt,
      provenance.updatedAt
    );
  }

  public getSourceProvenance(repositoryOrId: string): SourceProvenance | undefined {
    const row = this.db
      .prepare(`
        SELECT raw_json FROM source_provenances
        WHERE repository = ? OR provenance_id = ?
        LIMIT 1
      `)
      .get(repositoryOrId, repositoryOrId) as { raw_json: string } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.raw_json) as SourceProvenance;
  }

  public listSourceProvenances(): SourceProvenance[] {
    const rows = this.db
      .prepare(`SELECT raw_json FROM source_provenances ORDER BY repository ASC`)
      .all() as Array<{ raw_json: string }>;

    return rows.map((r) => JSON.parse(r.raw_json) as SourceProvenance);
  }

  // ==========================================
  // TrainingRow & Lineage Operations (Section 52)
  // ==========================================

  public saveTrainingRows(input: SanctionedTrainingExport): void {
    if (Array.isArray(input)) {
      throw new Error(
        `UNSANCTIONED_TRAINING_ROW_PERSISTENCE: Direct persistence of training row arrays is disallowed. Rows must be persisted via a sanctioned batch export from TrainingExporter.`
      );
    }

    if (!isSanctionedTrainingExport(input)) {
      throw new Error(
        `UNSANCTIONED_TRAINING_ROW_PERSISTENCE: TrainingExportResult lacks an unforgeable TrainingExporter brand. Direct persistence of un-exported or forged training rows is strictly prohibited.`
      );
    }

    const rows = input.rows;
    const batchExportId = input.exportId;
    if (!rows || rows.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO training_rows (
        row_id, dataset_version, context_unit_id, task_id, repository,
        tenant_id, source_observation_ids, labeler_version, feature_builder_version,
        label, confidence, outcome_label, rights_reference, export_id, raw_json, exported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const r of rows) {
      const effectiveExportId = r.exportId || batchExportId || null;
      const rowToPersist = effectiveExportId && !r.exportId ? { ...r, exportId: effectiveExportId } : r;
      stmt.run(
        r.rowId,
        r.datasetVersion,
        r.contextUnitId,
        r.taskId,
        r.repository,
        r.tenantId ?? null,
        JSON.stringify(r.lineage.sourceObservationIds),
        r.lineage.labelerVersion,
        r.lineage.featureBuilderVersion,
        r.label ?? null,
        r.confidence,
        r.outcomeLabel,
        r.rightsReference,
        effectiveExportId,
        JSON.stringify(rowToPersist),
        r.exportedAt
      );
    }
  }

  public getTrainingRow(rowId: string): TrainingRow | undefined {
    const row = this.db
      .prepare(`SELECT raw_json FROM training_rows WHERE row_id = ?`)
      .get(rowId) as { raw_json: string } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.raw_json) as TrainingRow;
  }

  public listTrainingRows(
    filter: { datasetVersion?: string; repository?: string; taskId?: string; exportId?: string } = {}
  ): TrainingRow[] {
    let sql = 'SELECT raw_json FROM training_rows WHERE 1=1';
    const params: string[] = [];

    if (filter.datasetVersion) {
      sql += ' AND dataset_version = ?';
      params.push(filter.datasetVersion);
    }
    if (filter.repository) {
      sql += ' AND repository = ?';
      params.push(filter.repository);
    }
    if (filter.taskId) {
      sql += ' AND task_id = ?';
      params.push(filter.taskId);
    }
    if (filter.exportId) {
      sql += ' AND export_id = ?';
      params.push(filter.exportId);
    }

    sql += ' ORDER BY exported_at ASC';
    const rows = this.db.prepare(sql).all(...params) as Array<{ raw_json: string }>;
    return rows.map((r) => JSON.parse(r.raw_json) as TrainingRow);
  }

  public deleteTrainingRowsByCriteria(criteria: {
    repository?: string;
    tenantId?: string;
    taskId?: string;
    rowIds?: string[];
  }): number {
    let count = 0;
    if (criteria.rowIds && criteria.rowIds.length > 0) {
      const placeholders = criteria.rowIds.map(() => '?').join(',');
      const res = this.db
        .prepare(`DELETE FROM training_rows WHERE row_id IN (${placeholders})`)
        .run(...criteria.rowIds);
      count += Number(res.changes);
    }
    if (criteria.repository) {
      const res = this.db
        .prepare(`DELETE FROM training_rows WHERE repository = ?`)
        .run(criteria.repository);
      count += Number(res.changes);
    }
    if (criteria.tenantId) {
      const res = this.db
        .prepare(`DELETE FROM training_rows WHERE tenant_id = ?`)
        .run(criteria.tenantId);
      count += Number(res.changes);
    }
    if (criteria.taskId) {
      const res = this.db
        .prepare(`DELETE FROM training_rows WHERE task_id = ?`)
        .run(criteria.taskId);
      count += Number(res.changes);
    }
    return count;
  }

  public deleteObservationsByCriteria(criteria: {
    taskIds?: string[];
    observationIds?: string[];
  }): number {
    let count = 0;
    if (criteria.observationIds && criteria.observationIds.length > 0) {
      const placeholders = criteria.observationIds.map(() => '?').join(',');
      const res = this.db
        .prepare(`DELETE FROM candidate_observations WHERE observation_id IN (${placeholders})`)
        .run(...criteria.observationIds);
      count += Number(res.changes);
    }
    if (criteria.taskIds && criteria.taskIds.length > 0) {
      const placeholders = criteria.taskIds.map(() => '?').join(',');
      const res = this.db
        .prepare(`DELETE FROM candidate_observations WHERE task_id IN (${placeholders})`)
        .run(...criteria.taskIds);
      count += Number(res.changes);

      this.db
        .prepare(`DELETE FROM exposure_decisions WHERE task_id IN (${placeholders})`)
        .run(...criteria.taskIds);
      this.db
        .prepare(`DELETE FROM trajectory_events WHERE task_id IN (${placeholders})`)
        .run(...criteria.taskIds);
      this.db
        .prepare(`DELETE FROM outcome_evidence WHERE task_id IN (${placeholders})`)
        .run(...criteria.taskIds);
      this.db
        .prepare(`DELETE FROM task_outcome_records WHERE task_id IN (${placeholders})`)
        .run(...criteria.taskIds);
    }
    return count;
  }

  // ==========================================
  // Deletion Audit Log (Section 52)
  // ==========================================

  public saveDeletionAuditRecord(record: DeletionAuditRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO deletion_audit_records (
        deletion_id, requested_at, executed_at, criteria_json,
        purged_observations_count, purged_training_rows_count,
        affected_datasets_json, status, details, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.deletionId,
      record.requestedAt,
      record.executedAt,
      JSON.stringify(record.criteria),
      record.purgedObservationsCount,
      record.purgedTrainingRowsCount,
      JSON.stringify(record.affectedDatasets),
      record.status,
      record.details ?? null,
      JSON.stringify(record)
    );
  }

  public listDeletionAuditRecords(): DeletionAuditRecord[] {
    const rows = this.db
      .prepare(`SELECT raw_json FROM deletion_audit_records ORDER BY executed_at DESC`)
      .all() as Array<{ raw_json: string }>;

    return rows.map((r) => JSON.parse(r.raw_json) as DeletionAuditRecord);
  }

  // ==========================================
  // TrainingEvidenceRecord Operations (Audit Section 13)
  // ==========================================

  public saveTrainingEvidenceRecords(
    input: SanctionedTrainingEvidenceExport
  ): void {
    if (Array.isArray(input)) {
      throw new Error(
        `UNSANCTIONED_TRAINING_EVIDENCE_PERSISTENCE: Direct persistence of training evidence record arrays is disallowed. Records must be persisted via a sanctioned batch export from TrainingExporter.`
      );
    }

    if (!isSanctionedTrainingEvidenceExport(input)) {
      throw new Error(
        `UNSANCTIONED_TRAINING_EVIDENCE_PERSISTENCE: TrainingEvidenceExportResult lacks an unforgeable TrainingExporter brand. Direct persistence of un-exported or forged training evidence records is strictly prohibited.`
      );
    }

    const records = input.records;
    const batchExportId = input.exportId;
    if (!records || records.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO training_evidence_records (
        evidence_id, dataset_version, task_id, context_unit_id,
        repository, tenant_id, was_read, was_edited, verified_success,
        rights_reference, export_id, raw_json, exported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const rec of records) {
      const effectiveExportId = rec.exportId || batchExportId || null;
      const recordToPersist =
        effectiveExportId && !rec.exportId ? { ...rec, exportId: effectiveExportId } : rec;

      stmt.run(
        rec.evidenceId,
        rec.datasetVersion,
        rec.taskId,
        rec.contextUnitId,
        rec.repository,
        rec.tenantId ?? null,
        rec.readEvidence.wasRead !== null && rec.readEvidence.wasRead !== undefined
          ? (rec.readEvidence.wasRead ? 1 : 0)
          : null,
        rec.editEvidence.wasEdited !== null && rec.editEvidence.wasEdited !== undefined
          ? (rec.editEvidence.wasEdited ? 1 : 0)
          : null,
        rec.verifiedOutcomeAssociation.verifiedSuccess !== null &&
          rec.verifiedOutcomeAssociation.verifiedSuccess !== undefined
          ? (rec.verifiedOutcomeAssociation.verifiedSuccess ? 1 : 0)
          : null,
        rec.rightsReference,
        effectiveExportId,
        JSON.stringify(recordToPersist),
        rec.exportedAt
      );
    }
  }

  public getTrainingEvidenceRecord(evidenceId: string): TrainingEvidenceRecord | undefined {
    const row = this.db
      .prepare('SELECT raw_json FROM training_evidence_records WHERE evidence_id = ?')
      .get(evidenceId) as { raw_json: string } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.raw_json) as TrainingEvidenceRecord;
  }

  public listTrainingEvidenceRecords(
    filter: { datasetVersion?: string; repository?: string; taskId?: string; exportId?: string } = {}
  ): TrainingEvidenceRecord[] {
    let sql = 'SELECT raw_json FROM training_evidence_records WHERE 1=1';
    const params: string[] = [];

    if (filter.datasetVersion) {
      sql += ' AND dataset_version = ?';
      params.push(filter.datasetVersion);
    }
    if (filter.repository) {
      sql += ' AND repository = ?';
      params.push(filter.repository);
    }
    if (filter.taskId) {
      sql += ' AND task_id = ?';
      params.push(filter.taskId);
    }
    if (filter.exportId) {
      sql += ' AND export_id = ?';
      params.push(filter.exportId);
    }

    sql += ' ORDER BY exported_at ASC';
    const rows = this.db.prepare(sql).all(...params) as Array<{ raw_json: string }>;
    return rows.map((r) => JSON.parse(r.raw_json) as TrainingEvidenceRecord);
  }

  // ===========================================================================
  // Learning Flywheel (Phase 20)
  // ===========================================================================

  public saveTaskEpisode(episode: TaskEpisodeV1): void {
    const verified = loadVerifiedTaskEpisode(episode);
    const verifiedSuccessInt =
      verified.outcome.verifiedSuccess === true
        ? 1
        : verified.outcome.verifiedSuccess === false
        ? 0
        : null;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO task_episodes (
        episode_id, tenant_id, repository_id, session_id, task_id,
        task_type, base_commit, context_policy_id, ranker_id, ranker_status,
        training_allowed, service_processing_allowed, redistribution_allowed,
        candidate_count, bundle_sha256, actual_rendered_tokens, token_budget,
        verified_success, verification_confidence, total_cost_usd, pricing_status,
        record_sha256, started_at, completed_at, created_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      verified.episodeId,
      verified.tenantId ?? null,
      verified.repositoryId,
      verified.sessionId,
      verified.taskId,
      verified.task.taskType ?? 'OTHER',
      verified.workspace.baseCommit,
      verified.environment.contextPolicyId,
      verified.environment.rankerId,
      verified.environment.rankerStatus,
      verified.rights.trainingAllowed ? 1 : 0,
      verified.rights.serviceProcessingAllowed ? 1 : 0,
      verified.rights.redistributionAllowed ? 1 : 0,
      verified.contextDecision.candidateCount,
      verified.contextDecision.bundleSha256,
      verified.contextDecision.actualRenderedTokens,
      verified.contextDecision.tokenBudget,
      verifiedSuccessInt,
      verified.outcome.verificationConfidence,
      verified.economics?.totalCostUSD ?? null,
      verified.economics?.pricingStatus ?? null,
      verified.integrity.recordSha256,
      verified.startedAt,
      verified.completedAt ?? null,
      verified.integrity.createdAt,
      JSON.stringify(verified)
    );

    // Persist candidates if present
    if (verified.contextDecision.candidates && verified.contextDecision.candidates.length > 0) {
      this.saveEpisodeCandidates(verified.contextDecision.candidates, verified.episodeId);
    }
  }

  public getTaskEpisode(episodeId: string): TaskEpisodeV1 | null {
    const row = this.db
      .prepare('SELECT raw_json FROM task_episodes WHERE episode_id = ?')
      .get(episodeId) as { raw_json: string } | undefined;

    if (!row) return null;
    return loadVerifiedTaskEpisode(row.raw_json);
  }

  public listTaskEpisodes(filter: EpisodeFilter = {}): TaskEpisodeV1[] {
    let sql = 'SELECT raw_json FROM task_episodes WHERE 1=1';
    const params: (string | number)[] = [];

    if (filter.excludeRevoked !== false) {
      sql += ' AND episode_id NOT IN (SELECT episode_id FROM episode_revocations)';
    }

    if (filter.repositoryId) {
      sql += ' AND repository_id = ?';
      params.push(filter.repositoryId);
    }
    if (filter.taskId) {
      sql += ' AND task_id = ?';
      params.push(filter.taskId);
    }
    if (filter.sessionId) {
      sql += ' AND session_id = ?';
      params.push(filter.sessionId);
    }
    if (filter.verifiedSuccess !== undefined) {
      if (filter.verifiedSuccess === null) {
        sql += ' AND verified_success IS NULL';
      } else {
        sql += ' AND verified_success = ?';
        params.push(filter.verifiedSuccess ? 1 : 0);
      }
    }
    if (filter.trainingAllowed !== undefined) {
      sql += ' AND training_allowed = ?';
      params.push(filter.trainingAllowed ? 1 : 0);
    }
    if (filter.taskType) {
      sql += ' AND task_type = ?';
      params.push(filter.taskType);
    }

    sql += ' ORDER BY created_at DESC';

    if (filter.limit && filter.limit > 0) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{ raw_json: string }>;
    return rows.map((r) => loadVerifiedTaskEpisode(r.raw_json));
  }

  public savePreOutcomeSnapshot(snapshot: PreOutcomeEpisodeSnapshot): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO pre_outcome_snapshots (
        snapshot_id, episode_id, task_id, repository_id, base_commit,
        feature_cutoff_commit, prompt_sha256, bundle_sha256, snapshot_sha256,
        token_budget, actual_rendered_tokens, context_policy_id, ranker_id,
        captured_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const snapshotId = `posnap_${snapshot.episodeId}`;
    stmt.run(
      snapshotId,
      snapshot.episodeId,
      snapshot.taskId,
      snapshot.repositoryId,
      snapshot.baseCommit,
      snapshot.featureCutoffCommit,
      snapshot.promptSha256,
      snapshot.bundleSha256,
      snapshot.snapshotSha256,
      snapshot.tokenBudget,
      snapshot.actualRenderedTokens,
      snapshot.contextPolicyId,
      snapshot.rankerId,
      snapshot.capturedAt,
      JSON.stringify(snapshot)
    );
  }

  public getPreOutcomeSnapshot(episodeId: string): PreOutcomeEpisodeSnapshot | null {
    const row = this.db
      .prepare('SELECT raw_json FROM pre_outcome_snapshots WHERE episode_id = ?')
      .get(episodeId) as { raw_json: string } | undefined;

    if (!row) return null;
    return loadVerifiedPreOutcomeSnapshot(row.raw_json);
  }

  public getPreOutcomeSnapshotByTaskId(taskId: string): PreOutcomeEpisodeSnapshot | null {
    const row = this.db
      .prepare('SELECT raw_json FROM pre_outcome_snapshots WHERE task_id = ? ORDER BY captured_at DESC LIMIT 1')
      .get(taskId) as { raw_json: string } | undefined;

    if (!row) return null;
    return loadVerifiedPreOutcomeSnapshot(row.raw_json);
  }

  public listPreOutcomeSnapshots(limit: number = 100): PreOutcomeEpisodeSnapshot[] {
    const rows = this.db
      .prepare('SELECT raw_json FROM pre_outcome_snapshots ORDER BY captured_at DESC LIMIT ?')
      .all(limit) as Array<{ raw_json: string }>;
    return rows.map((r) => loadVerifiedPreOutcomeSnapshot(r.raw_json));
  }

  public savePreOutcomeIntegrityAudit(audit: PreOutcomeIntegrityAudit): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO pre_outcome_integrity_audits (
        audit_id, episode_id, snapshot_sha256, recomputed_sha256,
        passed, has_leakage, has_hash_mismatch, has_provenance_error,
        audited_at, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      audit.auditId,
      audit.episodeId,
      audit.snapshotSha256,
      audit.recomputedSha256,
      audit.passed ? 1 : 0,
      audit.hasLeakage ? 1 : 0,
      audit.hasHashMismatch ? 1 : 0,
      audit.hasProvenanceError ? 1 : 0,
      audit.auditedAt,
      JSON.stringify(audit.details || {})
    );
  }

  public listPreOutcomeIntegrityAudits(episodeId?: string): PreOutcomeIntegrityAudit[] {
    let query = 'SELECT * FROM pre_outcome_integrity_audits';
    const params: any[] = [];
    if (episodeId) {
      query += ' WHERE episode_id = ?';
      params.push(episodeId);
    }
    query += ' ORDER BY audited_at DESC';
    const rows = this.db.prepare(query).all(...params) as Array<{
      audit_id: string;
      episode_id: string;
      snapshot_sha256: string;
      recomputed_sha256: string;
      passed: number;
      has_leakage: number;
      has_hash_mismatch: number;
      has_provenance_error: number;
      audited_at: string;
      details_json: string;
    }>;
    return rows.map((r) => ({
      auditId: r.audit_id,
      episodeId: r.episode_id,
      snapshotSha256: r.snapshot_sha256,
      recomputedSha256: r.recomputed_sha256,
      passed: r.passed === 1,
      hasLeakage: r.has_leakage === 1,
      hasHashMismatch: r.has_hash_mismatch === 1,
      hasProvenanceError: r.has_provenance_error === 1,
      auditedAt: r.audited_at,
      details: r.details_json ? JSON.parse(r.details_json) : undefined,
    }));
  }

  public auditPreOutcomeSnapshot(
    snapshotOrJson: PreOutcomeEpisodeSnapshot | string
  ): PreOutcomeIntegrityAudit {
    const auditedAt = new Date().toISOString();
    let snapshot: any;
    if (typeof snapshotOrJson === 'string') {
      try {
        snapshot = JSON.parse(snapshotOrJson);
      } catch (e) {
        const audit: PreOutcomeIntegrityAudit = {
          auditId: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          episodeId: 'corrupt',
          snapshotSha256: '',
          recomputedSha256: '',
          passed: false,
          hasLeakage: false,
          hasHashMismatch: true,
          hasProvenanceError: true,
          auditedAt,
          details: { error: String(e) },
        };
        this.savePreOutcomeIntegrityAudit(audit);
        return audit;
      }
    } else {
      snapshot = snapshotOrJson;
    }

    const episodeId = snapshot.episodeId || 'unknown';
    const storedSha = snapshot.snapshotSha256 || '';

    let hasLeakage = false;
    let hasHashMismatch = false;
    let hasProvenanceError = false;
    const errors: string[] = [];

    // 1. Validate leakage invariants
    try {
      validatePreOutcomeSnapshotIntegrity(snapshot);
    } catch (err: any) {
      hasLeakage = true;
      errors.push(err.message || String(err));
    }

    // 2. Validate hash integrity
    let recomputedSha = '';
    try {
      const verified = loadVerifiedPreOutcomeSnapshot(snapshot);
      recomputedSha = verified.snapshotSha256;
    } catch (err: any) {
      hasHashMismatch = true;
      errors.push(err.message || String(err));
    }

    // 3. Validate baseCommit and featureCutoffCommit
    if (!snapshot.baseCommit || (snapshot.baseCommit.length !== 40 && snapshot.baseCommit !== 'HEAD')) {
      hasProvenanceError = true;
      errors.push('baseCommit is missing or invalid');
    }
    if (!snapshot.featureCutoffCommit) {
      hasProvenanceError = true;
      errors.push('featureCutoffCommit is missing');
    }

    // 4. Validate context policy identity
    if (!snapshot.contextPolicyIdentity || snapshot.contextPolicyIdentity.featureSetVersion !== 'CONTEXT_FEATURES_V1') {
      hasProvenanceError = true;
      errors.push(`Invalid policy identity or featureSetVersion: ${snapshot.contextPolicyIdentity?.featureSetVersion}`);
    }

    const passed = !hasLeakage && !hasHashMismatch && !hasProvenanceError;

    const audit: PreOutcomeIntegrityAudit = {
      auditId: `audit_${episodeId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      episodeId,
      snapshotSha256: storedSha,
      recomputedSha256: recomputedSha || storedSha,
      passed,
      hasLeakage,
      hasHashMismatch,
      hasProvenanceError,
      auditedAt,
      details: errors.length > 0 ? { errors } : undefined,
    };

    this.savePreOutcomeIntegrityAudit(audit);
    return audit;
  }

  public saveShadowPolicyEvaluation(
    evaluation: ShadowPolicyComparison,
    crashed: boolean = false,
    errorMessage?: string,
    environment: string = 'UNKNOWN',
    isSynthetic: boolean = true
  ): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO shadow_policy_evaluations (
        evaluation_id, task_id, production_policy_id, shadow_policy_id,
        candidate_count, rank_overlap_jaccard, token_difference,
        shadow_latency_ms, crashed, error_message, evaluated_at, raw_json,
        environment, is_synthetic
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const id = `speval_${evaluation.taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    stmt.run(
      id,
      evaluation.taskId,
      evaluation.productionPolicyId,
      evaluation.shadowPolicyId,
      evaluation.candidateCount,
      evaluation.rankOverlapJaccard,
      evaluation.tokenDifference,
      evaluation.shadowLatencyMs,
      crashed ? 1 : 0,
      errorMessage ?? null,
      evaluation.evaluatedAt,
      JSON.stringify(evaluation),
      environment,
      isSynthetic ? 1 : 0
    );
  }

  public listShadowPolicyEvaluations(limit: number = 100): Array<ShadowPolicyComparison & { crashed: boolean; errorMessage?: string }> {
    const rows = this.db
      .prepare('SELECT raw_json, crashed, error_message FROM shadow_policy_evaluations ORDER BY evaluated_at DESC LIMIT ?')
      .all(limit) as Array<{ raw_json: string; crashed: number; error_message: string | null }>;
    return rows.map((r) => {
      const parsed = JSON.parse(r.raw_json);
      return {
        ...parsed,
        crashed: r.crashed === 1,
        errorMessage: r.error_message ?? undefined,
      };
    });
  }

  public finalizeEpisodeFromOutcome(outcome: OutcomeEvidence): TaskEpisodeV1 | null {
    // 1. Resolve authoritative outcome lineage strictly
    const lineage = resolveOutcomeLineage({
      contextPlanId: outcome.contextPlanId,
      taskId: outcome.taskId,
      sessionId: outcome.sessionId,
      workspaceSnapshotId: outcome.workspaceSnapshotBefore,
      agentEnvironmentId: outcome.agentEnvironmentId,
    }, this);

    if (!lineage.valid) {
      const err: any = new Error(lineage.error);
      err.code = lineage.code;
      throw err;
    }

    const plan = lineage.plan;
    const snapshot = lineage.snapshot;
    let task = this.getTaskContext(lineage.taskId);
    if (!task) {
      task = {
        taskId: lineage.taskId,
        sessionId: lineage.sessionId,
        primaryPrompt: snapshot.prompt || '',
        evidence: [],
      } as any;
    }

    // 2. Resolve authoritative outcome
    const resolvedOutcome = resolveTaskOutcomeFromEvidence(outcome, snapshot.episodeId);

    // 3. Fetch trajectory events
    let trajectoryEvents = this.getEpisodeTrajectoryEvents(snapshot.episodeId);
    if (trajectoryEvents.length === 0) {
      const legacyEvents = this.listTrajectoryEvents(outcome.taskId);
      if (legacyEvents.length > 0) {
        trajectoryEvents = legacyEvents.map((e, idx) => ({
          eventId: e.eventId,
          episodeId: snapshot.episodeId,
          timestamp: typeof e.timestamp === 'number' ? new Date(e.timestamp).toISOString() : String(e.timestamp),
          sequence: idx + 1,
          type: ((e.kind as string) === 'DIFF_APPLIED' || (e.kind as string) === 'FILE_EDIT'
            ? 'FILE_EDIT'
            : (e.kind as string) === 'FILE_READ'
            ? 'FILE_READ'
            : 'OTHER') as any,
          path: (e.payload as any)?.path,
          contextUnitId: (e.payload as any)?.contextUnitId,
          metadata: e.payload,
        }));
      }
    }

    // 4. Derive truthful exposures
    const existingExposures = this.getContextExposures(snapshot.episodeId);
    const { EpisodeAssembler } = require('../learning/episodes/episode_assembler');
    let exposures = EpisodeAssembler.deriveContextExposures({
      episodeId: snapshot.episodeId,
      candidates: snapshot.candidateUniverse,
      plan,
      trajectoryEvents,
    });

    if (existingExposures.length > 0 && trajectoryEvents.length === 0) {
      const existingMap = new Map(existingExposures.map((e: ContextUnitExposureRecord) => [e.contextUnitId, e]));
      exposures = exposures.map((exp: ContextUnitExposureRecord) => existingMap.get(exp.contextUnitId) || exp);
    }

    // 5. Compute honest economics (nullable when unmeasured, never 0)
    const economics = {
      contextInputTokens: plan.actualRenderedTokens,
      agentInputTokens: outcome.actualProviderInputTokens ?? null,
      agentOutputTokens: outcome.actualProviderOutputTokens ?? null,
      contextLatencyMs: plan.generationLatencyMs ?? null,
      taskLatencyMs: outcome.wallTimeMs ?? null,
      contextGenerationCostUSD: null,
      agentCostUSD: outcome.costUSD ?? null,
      totalCostUSD: outcome.costUSD ?? null,
      pricingStatus: (outcome.costUSD !== undefined && outcome.costUSD !== null ? 'VALID' : 'PRICING_UNAVAILABLE') as any,
    };

    // 6. Assemble final immutable TaskEpisodeV1
    const dummySnapshot: WorkspaceSnapshot = {
      workspaceSnapshotId: snapshot.workspaceSnapshotId,
      contentRootHash: 'hash',
      createdAt: snapshot.capturedAt,
      repositories: [],
    };

    const episode = EpisodeAssembler.assembleEpisode({
      episodeId: snapshot.episodeId,
      preOutcomeSnapshot: snapshot,
      plan,
      task,
      snapshot: dummySnapshot,
      outcome: resolvedOutcome,
      outcomeEvidence: outcome,
      trajectoryEvents,
      economics,
      dataRights: plan.dataRights,
    });

    // 7. Persist episode, exposures, candidates
    this.saveTaskEpisode(episode);
    this.saveContextExposures(exposures);
    this.saveEpisodeCandidates(snapshot.candidateUniverse, snapshot.episodeId);

    return episode;
  }

  public saveEpisodeCandidates(candidates: CandidateObservation[], episodeId: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO episode_candidates (
        candidate_id, episode_id, context_unit_id, path, unit_kind,
        retrieval_sources_json, pre_rank_position, final_rank, final_score,
        feature_set_version, feature_snapshot_json, estimated_tokens,
        selected, selected_resolution, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const recordedAt = new Date().toISOString();
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const candidateId = `ecand_${episodeId}_${c.contextUnitId}_${i}`;
      stmt.run(
        candidateId,
        episodeId,
        c.contextUnitId,
        c.path ?? null,
        c.unitKind,
        JSON.stringify(c.retrievalSources),
        c.preRankPosition ?? null,
        c.finalRank,
        c.finalScore,
        c.featureSetVersion,
        c.featureSnapshot ? JSON.stringify(c.featureSnapshot) : null,
        c.estimatedTokens,
        c.selected ? 1 : 0,
        c.selectedResolution ?? null,
        recordedAt
      );
    }
  }

  public getEpisodeCandidates(episodeId: string): CandidateObservation[] {
    const rows = this.db
      .prepare('SELECT * FROM episode_candidates WHERE episode_id = ? ORDER BY final_rank ASC')
      .all(episodeId) as Array<any>;

    return rows.map((r) => ({
      contextUnitId: r.context_unit_id,
      path: r.path ?? undefined,
      unitKind: r.unit_kind,
      retrievalSources: JSON.parse(r.retrieval_sources_json),
      preRankPosition: r.pre_rank_position ?? undefined,
      finalRank: r.final_rank,
      finalScore: r.final_score,
      featureSetVersion: r.feature_set_version,
      featureSnapshot: r.feature_snapshot_json ? JSON.parse(r.feature_snapshot_json) : undefined,
      estimatedTokens: r.estimated_tokens,
      selected: r.selected === 1,
      selectedResolution: r.selected_resolution ?? undefined,
    }));
  }

  public saveContextExposures(exposures: ContextUnitExposureRecord[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO context_exposures (
        exposure_id, episode_id, context_unit_id, path, unit_kind,
        state, final_rank, resolution, candidate_at, selected_at,
        materialized_at, shown_at, read_at, edited_at,
        attribution_type, read_attribution, edit_attribution
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const exp of exposures) {
      const exposureId = `cexp_${exp.episodeId}_${exp.contextUnitId}`;
      stmt.run(
        exposureId,
        exp.episodeId,
        exp.contextUnitId,
        exp.path ?? null,
        exp.unitKind,
        exp.state,
        exp.finalRank ?? null,
        exp.resolution ?? null,
        exp.candidateAt,
        exp.selectedAt ?? null,
        exp.materializedAt ?? null,
        exp.shownAt ?? null,
        exp.readAt ?? null,
        exp.editedAt ?? null,
        exp.attributionType ?? null,
        exp.readAttribution ?? null,
        exp.editAttribution ?? null
      );
    }
  }

  public getContextExposures(episodeId: string): ContextUnitExposureRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM context_exposures WHERE episode_id = ?')
      .all(episodeId) as Array<any>;

    return rows.map((r) => ({
      episodeId: r.episode_id,
      contextUnitId: r.context_unit_id,
      path: r.path ?? undefined,
      unitKind: r.unit_kind,
      state: r.state as ContextExposureState,
      attributionType: r.attribution_type ?? undefined,
      readAttribution: r.read_attribution ?? undefined,
      editAttribution: r.edit_attribution ?? undefined,
      finalRank: r.final_rank ?? undefined,
      resolution: r.resolution ?? undefined,
      candidateAt: r.candidate_at,
      selectedAt: r.selected_at ?? undefined,
      materializedAt: r.materialized_at ?? undefined,
      shownAt: r.shown_at ?? undefined,
      readAt: r.read_at ?? undefined,
      editedAt: r.edited_at ?? undefined,
    }));
  }

  public saveEpisodeTrajectoryEvents(events: AgentTrajectoryEvent[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO episode_trajectory_events (
        event_id, episode_id, sequence, type, path,
        context_unit_id, metadata_json, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const ev of events) {
      stmt.run(
        ev.eventId,
        ev.episodeId,
        ev.sequence,
        ev.type,
        ev.path ?? null,
        ev.contextUnitId ?? null,
        ev.metadata ? JSON.stringify(ev.metadata) : null,
        ev.timestamp
      );
    }
  }

  public getEpisodeTrajectoryEvents(episodeId: string): AgentTrajectoryEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM episode_trajectory_events WHERE episode_id = ? ORDER BY sequence ASC')
      .all(episodeId) as Array<any>;

    return rows.map((r) => ({
      eventId: r.event_id,
      episodeId: r.episode_id,
      sequence: r.sequence,
      type: r.type,
      path: r.path ?? undefined,
      contextUnitId: r.context_unit_id ?? undefined,
      metadata: r.metadata_json ? JSON.parse(r.metadata_json) : undefined,
      timestamp: r.timestamp,
    }));
  }

  public revokeEpisode(episodeId: string, reason: string): void {
    const revocationId = `rev_${episodeId}`;
    const revokedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO episode_revocations (revocation_id, episode_id, reason, revoked_at)
      VALUES (?, ?, ?, ?)
    `).run(revocationId, episodeId, reason, revokedAt);
  }

  public isEpisodeRevoked(episodeId: string): boolean {
    const row = this.db
      .prepare('SELECT revocation_id FROM episode_revocations WHERE episode_id = ?')
      .get(episodeId);
    return row !== undefined;
  }

  public listRevokedEpisodeIds(): string[] {
    const rows = this.db
      .prepare('SELECT episode_id FROM episode_revocations')
      .all() as Array<{ episode_id: string }>;
    return rows.map((r) => r.episode_id);
  }

  public saveDatasetV2Row(row: any): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO dataset_v2_rows (
        row_id, export_id, episode_id, context_unit_id, repository_id,
        task_type, exposure_state, was_selected, was_shown, was_read, was_edited,
        was_in_successful_task, was_in_failed_task, verified_success, outcome_confidence,
        features_json, raw_json, exported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      row.rowId || `dv2_${row.exportId}_${row.episodeId}_${row.contextUnitId}`,
      row.exportId,
      row.episodeId,
      row.contextUnitId,
      row.repositoryFamily || row.repositoryId || 'unknown',
      row.taskType || 'OTHER',
      row.exposureState,
      row.wasSelected ? 1 : 0,
      row.wasShown ? 1 : 0,
      row.wasRead ? 1 : 0,
      row.wasEdited ? 1 : 0,
      row.wasInSuccessfulTask ? 1 : 0,
      row.wasInFailedTask ? 1 : 0,
      row.verifiedSuccess === true ? 1 : row.verifiedSuccess === false ? 0 : null,
      row.outcomeConfidence,
      JSON.stringify(row.candidateFeatureVector || {}),
      JSON.stringify(row),
      row.exportedAt || new Date().toISOString()
    );
  }

  public listDatasetV2Rows(filter: { exportId?: string; episodeId?: string } = {}): any[] {
    let sql = 'SELECT raw_json FROM dataset_v2_rows WHERE 1=1';
    const params: string[] = [];
    if (filter.exportId) {
      sql += ' AND export_id = ?';
      params.push(filter.exportId);
    }
    if (filter.episodeId) {
      sql += ' AND episode_id = ?';
      params.push(filter.episodeId);
    }
    sql += ' ORDER BY exported_at ASC';
    const rows = this.db.prepare(sql).all(...params) as Array<{ raw_json: string }>;
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  public getLearningFlywheelSummary(): LearningFlywheelSummary {
    const totalRow = this.db
      .prepare('SELECT COUNT(*) as c FROM task_episodes WHERE episode_id NOT IN (SELECT episode_id FROM episode_revocations)')
      .get() as { c: number };
    const totalEpisodes = totalRow ? totalRow.c : 0;

    const verifiedOutcomeRow = this.db
      .prepare('SELECT COUNT(*) as c FROM task_episodes WHERE verified_success IS NOT NULL AND episode_id NOT IN (SELECT episode_id FROM episode_revocations)')
      .get() as { c: number };
    const verifiedOutcomeEpisodes = verifiedOutcomeRow ? verifiedOutcomeRow.c : 0;

    const unknownOutcomeEpisodes = totalEpisodes - verifiedOutcomeEpisodes;

    const successRow = this.db
      .prepare('SELECT COUNT(*) as c FROM task_episodes WHERE verified_success = 1 AND episode_id NOT IN (SELECT episode_id FROM episode_revocations)')
      .get() as { c: number };
    const successfulVerifiedEpisodes = successRow ? successRow.c : 0;

    const failedRow = this.db
      .prepare('SELECT COUNT(*) as c FROM task_episodes WHERE verified_success = 0 AND episode_id NOT IN (SELECT episode_id FROM episode_revocations)')
      .get() as { c: number };
    const failedVerifiedEpisodes = failedRow ? failedRow.c : 0;

    const trainingEligibleRow = this.db
      .prepare('SELECT COUNT(*) as c FROM task_episodes WHERE training_allowed = 1 AND episode_id NOT IN (SELECT episode_id FROM episode_revocations)')
      .get() as { c: number };
    const trainingEligibleEpisodes = trainingEligibleRow ? trainingEligibleRow.c : 0;

    const rightsBlockedEpisodes = totalEpisodes - trainingEligibleEpisodes;

    const revokedRow = this.db
      .prepare('SELECT COUNT(*) as c FROM episode_revocations')
      .get() as { c: number };
    const revokedEpisodes = revokedRow ? revokedRow.c : 0;

    // Repositories breakdown (excluding revoked)
    const repoRows = this.db
      .prepare('SELECT repository_id, COUNT(*) as c FROM task_episodes WHERE episode_id NOT IN (SELECT episode_id FROM episode_revocations) GROUP BY repository_id')
      .all() as Array<{ repository_id: string; c: number }>;
    const episodesByRepositoryFamily: Record<string, number> = {};
    for (const r of repoRows) {
      episodesByRepositoryFamily[r.repository_id] = r.c;
    }

    // Task types breakdown (excluding revoked)
    const taskTypeRows = this.db
      .prepare('SELECT task_type, COUNT(*) as c FROM task_episodes WHERE episode_id NOT IN (SELECT episode_id FROM episode_revocations) GROUP BY task_type')
      .all() as Array<{ task_type: string; c: number }>;
    const episodesByTaskType: Record<string, number> = {};
    for (const t of taskTypeRows) {
      episodesByTaskType[t.task_type || 'OTHER'] = t.c;
    }

    // Candidate count (excluding revoked)
    const candRow = this.db
      .prepare('SELECT COUNT(*) as c FROM episode_candidates WHERE episode_id NOT IN (SELECT episode_id FROM episode_revocations)')
      .get() as { c: number };
    const totalCandidateObservations = candRow ? candRow.c : 0;

    // Exposures by state (excluding revoked)
    const expRows = this.db
      .prepare('SELECT state, COUNT(*) as c FROM context_exposures WHERE episode_id NOT IN (SELECT episode_id FROM episode_revocations) GROUP BY state')
      .all() as Array<{ state: string; c: number }>;
    let shownContextUnits = 0;
    let readContextUnits = 0;
    let editedContextUnits = 0;
    for (const exp of expRows) {
      if (exp.state === 'SHOWN') shownContextUnits += exp.c;
      if (exp.state === 'READ') readContextUnits += exp.c;
      if (exp.state === 'EDITED') editedContextUnits += exp.c;
    }

    return {
      totalEpisodes,
      verifiedOutcomeEpisodes,
      unknownOutcomeEpisodes,
      successfulVerifiedEpisodes,
      failedVerifiedEpisodes,
      trainingEligibleEpisodes,
      rightsBlockedEpisodes,
      revokedEpisodes,
      episodesByRepositoryFamily,
      episodesByTaskType,
      totalCandidateObservations,
      shownContextUnits,
      readContextUnits,
      editedContextUnits,
    };
  }

  public getV32DataReadinessReport(): DataReadinessReport {
    const summary = this.getLearningFlywheelSummary();

    const targetVerifiedEpisodes = 1000;
    const targetIndependentRepositories = 25;

    const currentVerifiedEpisodes = summary.verifiedOutcomeEpisodes;
    const currentIndependentRepositories = Object.keys(summary.episodesByRepositoryFamily).length;

    const bugFixEpisodes = summary.episodesByTaskType['BUG_FIX'] || 0;
    const featureAdditionEpisodes = summary.episodesByTaskType['FEATURE_ADDITION'] || 0;
    const refactorEpisodes = summary.episodesByTaskType['REFACTOR'] || 0;
    const testFailureEpisodes = summary.episodesByTaskType['TEST_FAILURE'] || 0;

    const trainingEligibleEpisodes = summary.trainingEligibleEpisodes;
    const unknownOutcomeRate =
      summary.totalEpisodes > 0
        ? Math.round((summary.unknownOutcomeEpisodes / summary.totalEpisodes) * 1000) / 10
        : 0;

    // Evaluate canonical 7 architecture gates (docs/research/V3_2_ARCHITECTURE.md Section 4)
    // 1. Candidate logging coverage (strictly non-revoked episodes)
    const candLoggedRow = this.db
      .prepare('SELECT COUNT(DISTINCT episode_id) as c FROM episode_candidates WHERE episode_id NOT IN (SELECT episode_id FROM episode_revocations)')
      .get() as { c: number } | undefined;
    const episodesWithCandidatesLogged = candLoggedRow?.c ?? 0;

    // 2. Unpermitted in effective training pool (dataset_v2_rows exported with training_allowed = 0)
    const unpermittedInPoolRow = this.db
      .prepare('SELECT COUNT(*) as c FROM dataset_v2_rows WHERE episode_id IN (SELECT episode_id FROM task_episodes WHERE training_allowed = 0)')
      .get() as { c: number } | undefined;
    const unpermittedEpisodesInPool = unpermittedInPoolRow?.c ?? 0;

    // 3. Revoked episodes in effective training pool (dataset_v2_rows containing revoked episodes)
    const revokedInPoolRow = this.db
      .prepare('SELECT COUNT(*) as c FROM dataset_v2_rows WHERE episode_id IN (SELECT episode_id FROM episode_revocations)')
      .get() as { c: number } | undefined;
    const revokedEpisodesInPool = revokedInPoolRow?.c ?? 0;

    // 4. Real verification proof audit (measuring missing proofs instead of assumed zero)
    const verifiedRows = this.db.prepare(`
      SELECT raw_json FROM task_episodes
      WHERE verified_success IS NOT NULL
      AND episode_id NOT IN (SELECT episode_id FROM episode_revocations)
    `).all() as Array<{ raw_json: string }>;
    let verifiedEpisodesWithMissingProof = 0;
    for (const vr of verifiedRows) {
      try {
        const parsed = JSON.parse(vr.raw_json);
        const sources = parsed.outcome?.verificationSources;
        if (!Array.isArray(sources) || sources.length === 0) {
          verifiedEpisodesWithMissingProof++;
        }
      } catch {
        verifiedEpisodesWithMissingProof++;
      }
    }

    // 5. Real pre-outcome snapshot leakage audit (Phase 20.4: 100% distinct active eligible snapshots with current passing audit)
    const activeSnapshotsCountRow = this.db.prepare(`
      SELECT COUNT(DISTINCT episode_id) as c
      FROM pre_outcome_snapshots
      WHERE episode_id NOT IN (SELECT episode_id FROM episode_revocations)
    `).get() as { c: number } | undefined;
    const activeSnapshotCount = activeSnapshotsCountRow?.c ?? 0;

    const passingAuditedRow = this.db.prepare(`
      SELECT COUNT(DISTINCT a.episode_id) as c
      FROM pre_outcome_integrity_audits a
      JOIN pre_outcome_snapshots s ON a.episode_id = s.episode_id
      WHERE a.passed = 1
        AND a.snapshot_sha256 = s.snapshot_sha256
        AND s.episode_id NOT IN (SELECT episode_id FROM episode_revocations)
    `).get() as { c: number } | undefined;
    let passingAuditedSnapshots = passingAuditedRow?.c ?? 0;

    const failedActiveAuditsRow = this.db.prepare(`
      SELECT COUNT(DISTINCT a.episode_id) as c
      FROM pre_outcome_integrity_audits a
      JOIN pre_outcome_snapshots s ON a.episode_id = s.episode_id
      WHERE a.passed = 0
        AND s.episode_id NOT IN (SELECT episode_id FROM episode_revocations)
    `).get() as { c: number } | undefined;
    let failedActiveSnapshots = failedActiveAuditsRow?.c ?? 0;

    // If there are active snapshots but none have been audited yet, run the audit on the fly and persist
    if (activeSnapshotCount > 0 && passingAuditedSnapshots === 0 && failedActiveSnapshots === 0) {
      const snapshotRows = this.db.prepare(`
        SELECT raw_json FROM pre_outcome_snapshots
        WHERE episode_id NOT IN (SELECT episode_id FROM episode_revocations)
      `).all() as Array<{ raw_json: string }>;
      for (const sr of snapshotRows) {
        const audit = this.auditPreOutcomeSnapshot(sr.raw_json);
        if (audit.passed) {
          passingAuditedSnapshots++;
        } else {
          failedActiveSnapshots++;
        }
      }
    }

    // Zero-leakage audit gate requirement: 100% of distinct active eligible snapshots must have passing audits, with 0 violations
    const preOutcomeSnapshotsAudited = activeSnapshotCount > 0 ? passingAuditedSnapshots : 0;
    const leakageViolationsDetected = failedActiveSnapshots + Math.max(0, activeSnapshotCount - passingAuditedSnapshots);

    // 6. Real shadow policy runs and crashes (measuring real shadow_policy_evaluations table strictly with is_synthetic = 0 AND environment = 'PRODUCTION')
    const shadowRunsRow = this.db
      .prepare("SELECT COUNT(*) as c FROM shadow_policy_evaluations WHERE crashed = 0 AND is_synthetic = 0 AND environment = 'PRODUCTION'")
      .get() as { c: number } | undefined;
    const shadowEvaluationRuns = shadowRunsRow?.c ?? 0;

    const shadowCrashRow = this.db
      .prepare("SELECT COUNT(*) as c FROM shadow_policy_evaluations WHERE crashed = 1 AND is_synthetic = 0 AND environment = 'PRODUCTION'")
      .get() as { c: number } | undefined;
    const shadowEvaluationCrashes = shadowCrashRow?.c ?? 0;

    const canonicalEvaluation = evaluateCanonicalReadinessGates({
      totalEpisodes: summary.totalEpisodes,
      verifiedSuccesses: summary.successfulVerifiedEpisodes,
      verifiedFailures: summary.failedVerifiedEpisodes,
      unknownOutcomes: summary.unknownOutcomeEpisodes,
      episodesWithCandidatesLogged,
      unpermittedEpisodesInPool,
      revokedEpisodesInPool,
      verifiedEpisodesWithMissingProof,
      preOutcomeSnapshotsAudited,
      leakageViolationsDetected,
      shadowEvaluationRuns,
      shadowEvaluationCrashes,
    });

    const readinessScore = canonicalEvaluation.readinessScore;
    const isV32Ready = canonicalEvaluation.allGatesPassed;

    return {
      targetVerifiedEpisodes,
      currentVerifiedEpisodes,
      targetIndependentRepositories,
      currentIndependentRepositories,
      bugFixEpisodes,
      featureAdditionEpisodes,
      refactorEpisodes,
      testFailureEpisodes,
      trainingEligibleEpisodes,
      unknownOutcomeRate,
      readinessScore,
      isV32Ready,
      version: 'V3.2_READINESS_GATE_SPEC_V1',
      canonicalGates: canonicalEvaluation.gates,
      canonicalEvaluation,
    };
  }

  public getDataQualityReport(): DataQualityReport {
    const summary = this.getLearningFlywheelSummary();

    const verifiedOutcomeRate =
      summary.totalEpisodes > 0
        ? Math.round((summary.verifiedOutcomeEpisodes / summary.totalEpisodes) * 1000) / 1000
        : 0;

    const unknownOutcomeRate =
      summary.totalEpisodes > 0
        ? Math.round((summary.unknownOutcomeEpisodes / summary.totalEpisodes) * 1000) / 1000
        : 0;

    const trainingRightsRate =
      summary.totalEpisodes > 0
        ? Math.round((summary.trainingEligibleEpisodes / summary.totalEpisodes) * 1000) / 1000
        : 0;

    // Completeness of baseCommit and pricing
    const baseCommitRow = this.db
      .prepare("SELECT COUNT(*) as c FROM task_episodes WHERE base_commit IS NOT NULL AND base_commit != ''")
      .get() as { c: number };
    const baseCommitCoverageRate =
      summary.totalEpisodes > 0
        ? Math.round(((baseCommitRow?.c || 0) / summary.totalEpisodes) * 1000) / 1000
        : 0;

    const pricingRow = this.db
      .prepare("SELECT COUNT(*) as c FROM task_episodes WHERE pricing_status = 'VALID'")
      .get() as { c: number };
    const pricingCoverageRate =
      summary.totalEpisodes > 0
        ? Math.round(((pricingRow?.c || 0) / summary.totalEpisodes) * 1000) / 1000
        : 0;

    // Trajectory events check
    const trajEpisodes = this.db
      .prepare('SELECT COUNT(DISTINCT episode_id) as c FROM episode_trajectory_events')
      .get() as { c: number };
    const trajectoryCompletenessRate =
      summary.totalEpisodes > 0
        ? Math.round(((trajEpisodes?.c || 0) / summary.totalEpisodes) * 1000) / 1000
        : 0;

    // Policy and Schema distributions
    const policyRows = this.db
      .prepare('SELECT context_policy_id, COUNT(*) as c FROM task_episodes GROUP BY context_policy_id')
      .all() as Array<{ context_policy_id: string; c: number }>;
    const contextPolicyDistribution: Record<string, number> = {};
    for (const p of policyRows) {
      contextPolicyDistribution[p.context_policy_id] = p.c;
    }

    const schemaRows = this.db
      .prepare('SELECT feature_set_version, COUNT(*) as c FROM episode_candidates GROUP BY feature_set_version')
      .all() as Array<{ feature_set_version: string; c: number }>;
    const featureSchemaDistribution: Record<string, number> = {};
    for (const s of schemaRows) {
      featureSchemaDistribution[s.feature_set_version] = s.c;
    }

    return {
      verifiedOutcomeRate,
      unknownOutcomeRate,
      trainingRightsRate,
      trajectoryCompletenessRate,
      pricingCoverageRate,
      baseCommitCoverageRate,
      featureSchemaDistribution,
      contextPolicyDistribution,
    };
  }
}

/**
 * Returns default path to persistent database: `<rootDir>/.siftr/siftr.db`.
 */
export function getDefaultDatabasePath(rootDir: string = process.cwd()): string {
  return path.resolve(rootDir, '.siftr', 'siftr.db');
}

