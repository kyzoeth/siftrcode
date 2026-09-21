/**
 * SiftrCode V2 - Deletion Traceability & Right-to-be-Forgotten Manager (Section 52)
 *
 * Requirements:
 * 1. Trace derived training data back to source observations and repository.
 * 2. Purge raw observations, exposure decisions, and downstream training rows upon deletion request.
 * 3. Preserve immutable DeletionAuditRecord for compliance and dataset rebuild verification.
 */

import { SqliteStore } from '../storage/sqlite_store';
import { TrainingRow } from '../learning/lineage';

export interface DeletionCriteria {
  repository?: string;
  tenantId?: string;
  taskId?: string;
  observationIds?: string[];
  reason?: string;
}

export interface LineageTraceReport {
  criteria: DeletionCriteria;
  matchedObservationIds: string[];
  matchedTaskIds: string[];
  matchedTrainingRowIds: string[];
  affectedDatasetVersions: string[];
}

export interface DeletionAuditRecord {
  deletionId: string;
  requestedAt: string;
  executedAt: string;
  criteria: DeletionCriteria;
  purgedObservationsCount: number;
  purgedTrainingRowsCount: number;
  affectedDatasets: string[];
  status: 'COMPLETED' | 'FAILED';
  details?: string;
}

export class DeletionManager {
  private store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  /**
   * Traces all derived training rows and observations originating from the deletion criteria.
   */
  public traceLineage(criteria: DeletionCriteria): LineageTraceReport {
    // 1. Gather all training rows from store
    const trainingRows = this.store.listTrainingRows({
      repository: criteria.repository,
      taskId: criteria.taskId,
    });

    const matchedTrainingRowIds: string[] = [];
    const affectedDatasetsSet = new Set<string>();
    const matchedObsIdsSet = new Set<string>(criteria.observationIds || []);
    const matchedTaskIdsSet = new Set<string>();

    if (criteria.taskId) {
      matchedTaskIdsSet.add(criteria.taskId);
    }

    // Filter training rows by criteria
    for (const row of trainingRows) {
      let match = false;
      if (criteria.repository && row.repository === criteria.repository) {
        match = true;
      }
      if (criteria.tenantId && row.tenantId === criteria.tenantId) {
        match = true;
      }
      if (criteria.taskId && row.taskId === criteria.taskId) {
        match = true;
      }
      if (criteria.observationIds && criteria.observationIds.length > 0) {
        const hasObs = row.lineage.sourceObservationIds.some((id) =>
          criteria.observationIds!.includes(id)
        );
        if (hasObs) match = true;
      }

      if (match) {
        matchedTrainingRowIds.push(row.rowId);
        affectedDatasetsSet.add(row.datasetVersion);
        matchedTaskIdsSet.add(row.taskId);
        for (const obsId of row.lineage.sourceObservationIds) {
          matchedObsIdsSet.add(obsId);
        }
      }
    }

    // Also look up candidate observations directly
    if (criteria.taskId) {
      const taskObs = this.store.listCandidateObservations({ taskId: criteria.taskId });
      for (const o of taskObs) {
        matchedObsIdsSet.add(o.observationId);
      }
    }

    return {
      criteria,
      matchedObservationIds: Array.from(matchedObsIdsSet),
      matchedTaskIds: Array.from(matchedTaskIdsSet),
      matchedTrainingRowIds,
      affectedDatasetVersions: Array.from(affectedDatasetsSet),
    };
  }

  /**
   * Executes traceable purge across raw observation store and downstream training rows.
   */
  public executePurge(criteria: DeletionCriteria): DeletionAuditRecord {
    const requestedAt = new Date().toISOString();
    const trace = this.traceLineage(criteria);

    const deletionId = `del_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;

    try {
      // 1. Purge matching training rows
      const purgedTrainingRowsCount = this.store.deleteTrainingRowsByCriteria({
        repository: criteria.repository,
        tenantId: criteria.tenantId,
        taskId: criteria.taskId,
        rowIds: trace.matchedTrainingRowIds,
      });

      // 2. Purge matching candidate observations
      const purgedObservationsCount = this.store.deleteObservationsByCriteria({
        taskIds: trace.matchedTaskIds.length > 0 ? trace.matchedTaskIds : undefined,
        observationIds: trace.matchedObservationIds.length > 0 ? trace.matchedObservationIds : undefined,
      });

      const auditRecord: DeletionAuditRecord = {
        deletionId,
        requestedAt,
        executedAt: new Date().toISOString(),
        criteria,
        purgedObservationsCount,
        purgedTrainingRowsCount,
        affectedDatasets: trace.affectedDatasetVersions,
        status: 'COMPLETED',
      };

      this.store.saveDeletionAuditRecord(auditRecord);
      return auditRecord;
    } catch (err: any) {
      const failedAudit: DeletionAuditRecord = {
        deletionId,
        requestedAt,
        executedAt: new Date().toISOString(),
        criteria,
        purgedObservationsCount: 0,
        purgedTrainingRowsCount: 0,
        affectedDatasets: trace.affectedDatasetVersions,
        status: 'FAILED',
        details: err?.message || String(err),
      };
      this.store.saveDeletionAuditRecord(failedAudit);
      throw err;
    }
  }
}
