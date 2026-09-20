import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceSnapshot } from '../workspace/workspace_snapshot';
import { ContextUnit, ContextUnitKind } from '../context/context_unit';
import { TaskContext } from '../context/task_context';

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
  state?: string;
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

    this.db = new DatabaseSync(dbPath);
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

  public saveContextUnits(units: ContextUnit[]): void {
    if (units.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO context_units (unit_id, snapshot_id, repository_id, kind, path, title, trust_level, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    for (const unit of units) {
      stmt.run(
        unit.id,
        unit.workspaceSnapshotId,
        unit.repositoryId || null,
        unit.kind,
        unit.path || null,
        unit.title,
        unit.trustLevel,
        JSON.stringify(unit),
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

  public saveTaskContext(task: TaskContext): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO task_contexts (task_id, snapshot_id, primary_prompt, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.taskId,
      task.workspaceSnapshotId,
      task.primaryPrompt,
      JSON.stringify(task),
      task.createdAt
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
  // Session Operations
  // ==========================================

  public saveSession(session: StoredSession): void {
    const now = new Date().toISOString();
    const createdAt = session.createdAt || now;
    const updatedAt = session.updatedAt || now;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (session_id, task_id, snapshot_id, state, raw_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.sessionId,
      session.taskId,
      session.snapshotId,
      session.state || null,
      JSON.stringify(session),
      createdAt,
      updatedAt
    );
  }

  public getSession(sessionId: string): StoredSession | undefined {
    const row = this.db.prepare('SELECT raw_json FROM sessions WHERE session_id = ?').get(sessionId) as {
      raw_json: string;
    } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.raw_json);
  }
}

/**
 * Returns default path to persistent database: `<rootDir>/.siftr/siftr.db`.
 */
export function getDefaultDatabasePath(rootDir: string = process.cwd()): string {
  return path.resolve(rootDir, '.siftr', 'siftr.db');
}
