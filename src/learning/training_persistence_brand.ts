/**
 * SiftrCode V2 - Unforgeable Training Persistence Brand Verification (Section 7.3 & FINAL-3.1)
 *
 * Exposes verification predicates for SqliteStore to verify that training batches
 * were genuinely constructed and sanctioned by TrainingExporter.
 *
 * Invariant:
 * The capability to brand an export is strictly private to TrainingExporter.
 * No marking or branding function is exported from this module or any other.
 */

export {
  isSanctionedTrainingExport,
  isSanctionedTrainingEvidenceExport,
  SanctionedTrainingExport,
  SanctionedTrainingEvidenceExport,
} from './training_exporter';
