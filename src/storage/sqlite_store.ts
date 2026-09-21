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
import { TrainingExportResult, TrainingEvidenceExportResult } from '../learning/training_exporter';
import { isSanctionedTrainingExport } from '../learning/training_persistence_brand';
import { DeletionAuditRecord } from '../rights/deletion_manager';
import { DataRights, createDefaultDataRights, DataClass, isDataClassPermitted } from '../rights/data_rights';
import {
  sanitizeContextPlanForPersistence,
  sanitizeContextUnitForPersistence,
  sanitizeTaskContextForPersistence,
  sanitizeCandidateDecisionObservation,
  ContextPlanMetadataRecord,
} from './rights_aware_dto';

export {
  sanitizeContextPlanForPersistence,
  sanitizeContextUnitForPersistence,
  sanitizeTaskContextForPersistence,
  sanitizeCandidateDecisionObservation,
  ContextPlanMetadataRecord,
} from './rights_aware_dto';
export { TrainingEvidenceRecord } from '../learning/lineage';
export { SiftrSession, SiftrSessionStatus } from '../telemetry/siftr_session';
export { ContextExpansionEvent } from '../telemetry/expansion_event';
export { FinalContextAllocation } from '../token/final_allocation';
export { ProviderUsageEvent } from '../token/provider_usage';
export { JevSignalV1 } from '../providers/judgment/typesafe/jev_signal';

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
        was_edited INTEGER NOT NULL,
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
];

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

  public saveTaskOutcome(outcome: OutcomeEvidence): void {
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
    const session = this.getSession(params.sessionId);
    if (!session) {
      return {
        valid: false,
        reason: `Referential integrity failure: Session "${params.sessionId}" does not exist in store.`,
      };
    }
    if (session.taskId !== params.taskId) {
      return {
        valid: false,
        reason: `Referential integrity failure: TaskId "${params.taskId}" does not match session taskId "${session.taskId}".`,
      };
    }
    if (params.planId) {
      const plan = this.getContextPlan(params.planId);
      if (!plan) {
        return {
          valid: false,
          reason: `Referential integrity failure: ContextPlan "${params.planId}" does not exist in store.`,
        };
      }
      if (plan.taskId !== params.taskId) {
        return {
          valid: false,
          reason: `Referential integrity failure: ContextPlan "${params.planId}" belongs to taskId "${plan.taskId}", not "${params.taskId}".`,
        };
      }
      if (plan.sessionId && plan.sessionId !== params.sessionId) {
        return {
          valid: false,
          reason: `Referential integrity failure: ContextPlan "${params.planId}" belongs to session "${plan.sessionId}", not "${params.sessionId}".`,
        };
      }
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

  public saveTrainingRows(input: TrainingExportResult | TrainingRow[]): void {
    const rows = Array.isArray(input) ? input : input.rows;
    const batchExportId = Array.isArray(input) ? undefined : input.exportId;
    if (!rows || rows.length === 0) return;

    // Enforce that filtered TrainingExporter output is the only sanctioned route into persistent training rows (Section 7.3)
    if (Array.isArray(input)) {
      for (const r of rows) {
        if (!isSanctionedTrainingExport(r)) {
          throw new Error(
            `UNSANCTIONED_TRAINING_ROW_PERSISTENCE: Row '${r.rowId}' lacks an unforgeable TrainingExporter brand. Direct persistence of un-exported or forged training rows is strictly prohibited.`
          );
        }
      }
    } else {
      if (!isSanctionedTrainingExport(input)) {
        throw new Error(
          `UNSANCTIONED_TRAINING_ROW_PERSISTENCE: TrainingExportResult lacks an unforgeable TrainingExporter brand. Direct persistence of un-exported or forged training rows is strictly prohibited.`
        );
      }
    }

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
    input: TrainingEvidenceExportResult | TrainingEvidenceRecord[]
  ): void {
    const records = Array.isArray(input) ? input : input.records;
    const batchExportId = Array.isArray(input) ? undefined : input.exportId;
    if (!records || records.length === 0) return;

    // Enforce that filtered TrainingExporter output is the only sanctioned route into persistent training evidence records (Section 7.3)
    if (Array.isArray(input)) {
      for (const rec of records) {
        if (!isSanctionedTrainingExport(rec)) {
          throw new Error(
            `UNSANCTIONED_TRAINING_EVIDENCE_PERSISTENCE: Record '${rec.evidenceId}' lacks an unforgeable TrainingExporter brand. Direct persistence of un-exported or forged training evidence records is strictly prohibited.`
          );
        }
      }
    } else {
      if (!isSanctionedTrainingExport(input)) {
        throw new Error(
          `UNSANCTIONED_TRAINING_EVIDENCE_PERSISTENCE: TrainingEvidenceExportResult lacks an unforgeable TrainingExporter brand. Direct persistence of un-exported or forged training evidence records is strictly prohibited.`
        );
      }
    }

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
        rec.editEvidence.wasEdited ? 1 : 0,
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
}

/**
 * Returns default path to persistent database: `<rootDir>/.siftr/siftr.db`.
 */
export function getDefaultDatabasePath(rootDir: string = process.cwd()): string {
  return path.resolve(rootDir, '.siftr', 'siftr.db');
}

