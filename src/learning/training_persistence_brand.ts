/**
 * SiftrCode V2 - Unforgeable Training Persistence Brand Registry (Section 7.3)
 *
 * Guarantees that only batches/records produced by a sanctioned TrainingExporter
 * can be persisted to SqliteStore. Unauthorized callers cannot forge this brand
 * even if they construct an exportId with 'texport_' or 'texport_ev_' prefix.
 */

const sanctionedTrainingObjects = new WeakSet<object>();

/**
 * Marks an export result and all its rows/records as sanctioned by TrainingExporter.
 * Only callable by TrainingExporter.
 */
export function markSanctionedExport<T extends object>(result: T, items?: object[]): T {
  if (result && typeof result === 'object') {
    sanctionedTrainingObjects.add(result);
  }
  if (items && Array.isArray(items)) {
    for (const item of items) {
      if (item && typeof item === 'object') {
        sanctionedTrainingObjects.add(item);
      }
    }
  }
  return result;
}

/**
 * Verifies if a given object (batch or individual row/record) possesses the
 * unforgeable brand registered by TrainingExporter.
 */
export function isSanctionedTrainingExport(obj: any): boolean {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  return sanctionedTrainingObjects.has(obj);
}
