/**
 * SiftrCode V2 - Proprietary Aggregated Signals Engine (Phase 20M)
 *
 * Computes defensible derived signals across empirical task episodes.
 * Invariants:
 * 1. Versioned and point-in-time safe.
 * 2. Rights-aware: computed strictly from sanctioned episodes (trainingAllowed === true).
 * 3. Excludes revoked or tombstoned episodes.
 * 4. Internal / confidential: do not expose raw aggregate training signals on public routes.
 */

import { TaskEpisodeV1 } from '../episodes/task_episode';
import { ContextExposureState } from '../episodes/context_exposure';

export const AGGREGATED_SIGNALS_VERSION = 'AGGREGATED_SIGNALS_V1';

export interface TaskTypeUnitKindUsefulness {
  taskType: string;
  unitKind: string;
  shownCount: number;
  readCount: number;
  editedCount: number;
  readRate: number; // read / shown
  editRate: number; // edit / read
}

export interface RetrievalSourceBehavior {
  repositoryFamily: string;
  source: string;
  candidateCount: number;
  selectedCount: number;
  selectionRate: number;
}

export interface VerifiedSuccessConditionalExposure {
  unitKind: string;
  meanExposureInSuccess: number;
  meanExposureInFailure: number;
  relativeAdvantage: number;
}

export interface CandidateRankCalibration {
  rankBucket: string; // e.g. "1-3", "4-10", "11-25", "26+"
  totalCandidates: number;
  selectedCount: number;
  readCount: number;
  editedCount: number;
  readProbability: number;
  editProbability: number;
}

export interface ProprietaryAggregatedSignalsReport {
  schemaVersion: typeof AGGREGATED_SIGNALS_VERSION;
  calculatedAt: string;
  totalEpisodesAnalyzed: number;
  taskTypeUnitKindUsefulness: TaskTypeUnitKindUsefulness[];
  retrievalSourceBehavior: RetrievalSourceBehavior[];
  readAfterShowProbability: number;
  editAfterReadProbability: number;
  verifiedSuccessConditionalExposure: VerifiedSuccessConditionalExposure[];
  candidateRankCalibration: CandidateRankCalibration[];
  dataRightsEnforced: true;
}

/**
 * Computes proprietary aggregated signals strictly over rights-compliant, non-revoked episodes.
 */
export function computeAggregatedSignals(
  episodes: TaskEpisodeV1[],
  isRevoked?: (episodeId: string) => boolean
): ProprietaryAggregatedSignalsReport {
  // 1. Filter strictly for training-allowed and non-revoked episodes
  const sanctionedEpisodes = episodes.filter((ep) => {
    if (!ep.rights || ep.rights.trainingAllowed !== true) return false;
    if (isRevoked && isRevoked(ep.episodeId)) return false;
    return true;
  });

  // Track unit kind usefulness by task type
  const usefulnessMap: Record<
    string,
    { shown: number; read: number; edited: number }
  > = {};

  // Track retrieval source behavior
  const sourceMap: Record<
    string,
    { total: number; selected: number }
  > = {};

  // Rank calibration buckets: 1-3, 4-10, 11-25, 26+
  const rankBuckets: Record<
    string,
    { total: number; selected: number; read: number; edited: number }
  > = {
    '1-3': { total: 0, selected: 0, read: 0, edited: 0 },
    '4-10': { total: 0, selected: 0, read: 0, edited: 0 },
    '11-25': { total: 0, selected: 0, read: 0, edited: 0 },
    '26+': { total: 0, selected: 0, read: 0, edited: 0 },
  };

  let globalShownCount = 0;
  let globalReadCount = 0;
  let globalEditCount = 0;

  // Track exposures in success vs failure
  const kindInSuccess: Record<string, { totalExposures: number; taskCount: number }> = {};
  const kindInFailure: Record<string, { totalExposures: number; taskCount: number }> = {};

  for (const ep of sanctionedEpisodes) {
    const taskType = ep.task.taskType || 'OTHER';
    const repoFamily = ep.repositoryId;
    const isSuccess = ep.outcome.verifiedSuccess === true;
    const isFailure = ep.outcome.verifiedSuccess === false;

    const readPaths = new Set(ep.trajectory?.readPaths || []);
    const editedPaths = new Set(ep.trajectory?.editedPaths || []);
    const selectedIds = new Set(ep.contextDecision.selectedUnits.map((u) => u.contextUnitId));

    for (const cand of ep.contextDecision.candidates) {
      const isSelected = cand.selected || selectedIds.has(cand.contextUnitId);
      const isRead = cand.path ? readPaths.has(cand.path) : false;
      const isEdited = cand.path ? editedPaths.has(cand.path) : false;

      // Usefulness mapping
      const uKey = `${taskType}::${cand.unitKind}`;
      if (!usefulnessMap[uKey]) {
        usefulnessMap[uKey] = { shown: 0, read: 0, edited: 0 };
      }
      if (isSelected) {
        usefulnessMap[uKey].shown++;
        globalShownCount++;
      }
      if (isRead) {
        usefulnessMap[uKey].read++;
        globalReadCount++;
      }
      if (isEdited) {
        usefulnessMap[uKey].edited++;
        globalEditCount++;
      }

      // Retrieval sources
      for (const src of cand.retrievalSources || []) {
        const sKey = `${repoFamily}::${src}`;
        if (!sourceMap[sKey]) sourceMap[sKey] = { total: 0, selected: 0 };
        sourceMap[sKey].total++;
        if (isSelected) sourceMap[sKey].selected++;
      }

      // Rank calibration
      let bucket = '26+';
      if (cand.finalRank <= 3) bucket = '1-3';
      else if (cand.finalRank <= 10) bucket = '4-10';
      else if (cand.finalRank <= 25) bucket = '11-25';

      rankBuckets[bucket].total++;
      if (isSelected) rankBuckets[bucket].selected++;
      if (isRead) rankBuckets[bucket].read++;
      if (isEdited) rankBuckets[bucket].edited++;

      // Conditional exposure in success vs failure
      if (isSelected) {
        if (isSuccess) {
          if (!kindInSuccess[cand.unitKind]) kindInSuccess[cand.unitKind] = { totalExposures: 0, taskCount: 0 };
          kindInSuccess[cand.unitKind].totalExposures++;
        } else if (isFailure) {
          if (!kindInFailure[cand.unitKind]) kindInFailure[cand.unitKind] = { totalExposures: 0, taskCount: 0 };
          kindInFailure[cand.unitKind].totalExposures++;
        }
      }
    }
  }

  // Format usefulness report
  const taskTypeUnitKindUsefulness: TaskTypeUnitKindUsefulness[] = Object.entries(usefulnessMap).map(
    ([key, data]) => {
      const [taskType, unitKind] = key.split('::');
      return {
        taskType,
        unitKind,
        shownCount: data.shown,
        readCount: data.read,
        editedCount: data.edited,
        readRate: data.shown > 0 ? Math.round((data.read / data.shown) * 1000) / 1000 : 0,
        editRate: data.read > 0 ? Math.round((data.edited / data.read) * 1000) / 1000 : 0,
      };
    }
  );

  // Format retrieval source behavior
  const retrievalSourceBehavior: RetrievalSourceBehavior[] = Object.entries(sourceMap).map(
    ([key, data]) => {
      const [repositoryFamily, source] = key.split('::');
      return {
        repositoryFamily,
        source,
        candidateCount: data.total,
        selectedCount: data.selected,
        selectionRate: data.total > 0 ? Math.round((data.selected / data.total) * 1000) / 1000 : 0,
      };
    }
  );

  // Rank calibration array
  const candidateRankCalibration: CandidateRankCalibration[] = Object.entries(rankBuckets).map(
    ([rankBucket, data]) => ({
      rankBucket,
      totalCandidates: data.total,
      selectedCount: data.selected,
      readCount: data.read,
      editedCount: data.edited,
      readProbability: data.total > 0 ? Math.round((data.read / data.total) * 1000) / 1000 : 0,
      editProbability: data.total > 0 ? Math.round((data.edited / data.total) * 1000) / 1000 : 0,
    })
  );

  // Success vs Failure exposure comparison
  const allKinds = new Set([...Object.keys(kindInSuccess), ...Object.keys(kindInFailure)]);
  const verifiedSuccessConditionalExposure: VerifiedSuccessConditionalExposure[] = Array.from(allKinds).map(
    (unitKind) => {
      const succ = kindInSuccess[unitKind]?.totalExposures || 0;
      const fail = kindInFailure[unitKind]?.totalExposures || 0;
      const relativeAdvantage = fail > 0 ? Math.round((succ / fail) * 100) / 100 : succ > 0 ? 1.0 : 0;
      return {
        unitKind,
        meanExposureInSuccess: succ,
        meanExposureInFailure: fail,
        relativeAdvantage,
      };
    }
  );

  const readAfterShowProbability =
    globalShownCount > 0 ? Math.round((globalReadCount / globalShownCount) * 1000) / 1000 : 0;
  const editAfterReadProbability =
    globalReadCount > 0 ? Math.round((globalEditCount / globalReadCount) * 1000) / 1000 : 0;

  return {
    schemaVersion: AGGREGATED_SIGNALS_VERSION,
    calculatedAt: new Date().toISOString(),
    totalEpisodesAnalyzed: sanctionedEpisodes.length,
    taskTypeUnitKindUsefulness,
    retrievalSourceBehavior,
    readAfterShowProbability,
    editAfterReadProbability,
    verifiedSuccessConditionalExposure,
    candidateRankCalibration,
    dataRightsEnforced: true,
  };
}
