/**
 * SiftrCode V2 - Context Exposure Semantics (Phase 20C)
 *
 * Distinguishes the state progression of context units:
 * CANDIDATE -> SELECTED -> MATERIALIZED -> SHOWN -> READ -> EDITED
 *
 * Invariant:
 * 1. Not shown != shown but ignored
 * 2. Shown but ignored != read
 * 3. Read != edited
 * 4. Unexposed candidates MUST NEVER be labeled as negative.
 */

export enum ContextExposureState {
  CANDIDATE = 'CANDIDATE',
  SELECTED = 'SELECTED',
  MATERIALIZED = 'MATERIALIZED',
  SHOWN = 'SHOWN',
  READ = 'READ',
  EDITED = 'EDITED',
}

export interface ContextUnitExposureRecord {
  episodeId: string;
  contextUnitId: string;
  path?: string;
  unitKind: string;
  state: ContextExposureState;
  finalRank?: number;
  resolution?: string;
  candidateAt: string;
  selectedAt?: string;
  materializedAt?: string;
  shownAt?: string;
  readAt?: string;
  editedAt?: string;
}

/**
 * Returns the highest precedence exposure state reached by a unit.
 */
export function resolveExposureState(params: {
  wasEdited?: boolean;
  wasRead?: boolean;
  wasShown?: boolean;
  wasMaterialized?: boolean;
  wasSelected?: boolean;
}): ContextExposureState {
  if (params.wasEdited) return ContextExposureState.EDITED;
  if (params.wasRead) return ContextExposureState.READ;
  if (params.wasShown) return ContextExposureState.SHOWN;
  if (params.wasMaterialized) return ContextExposureState.MATERIALIZED;
  if (params.wasSelected) return ContextExposureState.SELECTED;
  return ContextExposureState.CANDIDATE;
}
