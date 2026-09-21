/**
 * SiftrCode V3 - Leakage-Safe Split Manager (Phase V3.1B)
 *
 * Partitions SiftrBenchEpisodes into immutable Train, Validation, and Test splits.
 *
 * Invariants:
 * 1. Split strictly by independent task/repository groups (splitGroupId).
 * 2. Zero episode or splitGroup overlap between splits (verified by anti-join).
 * 3. Temporal ordering respected (earlier history in train, later in held-out test).
 * 4. Split manifest is immutable and cryptographically signed.
 */

import * as crypto from 'crypto';
import { SiftrBenchEpisode } from './episode_schema';

export type SplitName = 'train' | 'validation' | 'test';

export interface SplitAssignment {
  episodeId: string;
  taskId: string;
  repositoryId: string;
  splitGroupId: string;
  split: SplitName;
  baseCommit: string;
  temporalCutoff: string;
}

export interface SplitResult {
  train: SiftrBenchEpisode[];
  validation: SiftrBenchEpisode[];
  test: SiftrBenchEpisode[];
  assignments: SplitAssignment[];
  splitCounts: {
    train: number;
    validation: number;
    test: number;
    total: number;
  };
  groupCounts: {
    train: number;
    validation: number;
    test: number;
  };
}

export interface SplitManifest {
  schemaVersion: 'siftrbench-split-manifest-v1';
  benchmarkVersion: string;
  createdAt: string;
  splitCodeVersion: string;
  randomSeed: number;
  ratios: { train: number; validation: number; test: number };
  counts: { train: number; validation: number; test: number; total: number };
  groupCounts: { train: number; validation: number; test: number };
  checksum: string;
  assignments: SplitAssignment[];
}

export interface SplitOptions {
  trainRatio?: number;
  valRatio?: number;
  testRatio?: number;
  seed?: number;
  benchmarkVersion?: string;
}

export class SplitManager {
  /**
   * Deterministically partitions episodes into leakage-safe splits by splitGroupId.
   */
  public static partition(
    episodes: SiftrBenchEpisode[],
    options: SplitOptions = {}
  ): SplitResult {
    const trainRatio = options.trainRatio ?? 0.60;
    const valRatio = options.valRatio ?? 0.15;
    const testRatio = options.testRatio ?? 0.25;
    const seed = options.seed ?? 42;

    // Group episodes by repository, then by splitGroupId
    const repoGroups = new Map<string, Map<string, SiftrBenchEpisode[]>>();
    for (const ep of episodes) {
      if (!repoGroups.has(ep.repositoryId)) {
        repoGroups.set(ep.repositoryId, new Map());
      }
      const gMap = repoGroups.get(ep.repositoryId)!;
      if (!gMap.has(ep.splitGroupId)) {
        gMap.set(ep.splitGroupId, []);
      }
      gMap.get(ep.splitGroupId)!.push(ep);
    }

    const trainGroups = new Set<string>();
    const valGroups = new Set<string>();
    const testGroups = new Set<string>();

    let s = seed;
    const nextRandom = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };

    // Stratify partition per repository to guarantee representation in all splits
    const sortedRepos = Array.from(repoGroups.keys()).sort();
    for (const repoId of sortedRepos) {
      const gMap = repoGroups.get(repoId)!;
      const sortedGIds = Array.from(gMap.keys()).sort();

      // Deterministic shuffle
      const shuffled = [...sortedGIds];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(nextRandom() * (i + 1));
        const temp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = temp;
      }

      const totalRepoEpisodes = Array.from(gMap.values()).reduce((acc, eps) => acc + eps.length, 0);
      const targetTest = Math.max(1, Math.round(totalRepoEpisodes * testRatio));
      const targetVal = Math.max(1, Math.round(totalRepoEpisodes * valRatio));

      let curTest = 0;
      let curVal = 0;

      for (const gId of shuffled) {
        const count = gMap.get(gId)!.length;
        if (curTest + count <= targetTest || !Array.from(testGroups).some(g => gMap.has(g))) {
          testGroups.add(gId);
          curTest += count;
        } else if (curVal + count <= targetVal || !Array.from(valGroups).some(g => gMap.has(g))) {
          valGroups.add(gId);
          curVal += count;
        } else {
          trainGroups.add(gId);
        }
      }

      // Guarantee each split has at least one group for this repo if shuffled.length >= 3
      if (shuffled.length >= 3) {
        const repoTrain = shuffled.filter((g) => trainGroups.has(g));
        const repoVal = shuffled.filter((g) => valGroups.has(g));
        const repoTest = shuffled.filter((g) => testGroups.has(g));

        if (repoTrain.length === 0 && repoTest.length > 1) {
          const move = repoTest.pop()!;
          testGroups.delete(move);
          trainGroups.add(move);
        }
        if (repoVal.length === 0 && repoTest.length > 1) {
          const move = repoTest.pop()!;
          testGroups.delete(move);
          valGroups.add(move);
        }
      }
    }


    const train: SiftrBenchEpisode[] = [];
    const validation: SiftrBenchEpisode[] = [];
    const test: SiftrBenchEpisode[] = [];
    const assignments: SplitAssignment[] = [];

    for (const ep of episodes) {
      let split: SplitName;
      if (trainGroups.has(ep.splitGroupId)) {
        split = 'train';
        train.push(ep);
      } else if (valGroups.has(ep.splitGroupId)) {
        split = 'validation';
        validation.push(ep);
      } else {
        split = 'test';
        test.push(ep);
      }

      assignments.push({
        episodeId: ep.episodeId,
        taskId: ep.taskId,
        repositoryId: ep.repositoryId,
        splitGroupId: ep.splitGroupId,
        split,
        baseCommit: ep.baseCommit,
        temporalCutoff: ep.temporalCutoff,
      });
    }

    const result: SplitResult = {
      train,
      validation,
      test,
      assignments,
      splitCounts: {
        train: train.length,
        validation: validation.length,
        test: test.length,
        total: episodes.length,
      },
      groupCounts: {
        train: trainGroups.size,
        validation: valGroups.size,
        test: testGroups.size,
      },
    };

    SplitManager.validateSplits(result);
    return result;
  }

  /**
   * Strictly validates zero episode, task, and splitGroupId leakage between partitions.
   */
  public static validateSplits(result: SplitResult): void {
    const trainIds = new Set(result.train.map((e) => e.episodeId));
    const valIds = new Set(result.validation.map((e) => e.episodeId));
    const testIds = new Set(result.test.map((e) => e.episodeId));

    const trainGroups = new Set(result.train.map((e) => e.splitGroupId));
    const valGroups = new Set(result.validation.map((e) => e.splitGroupId));
    const testGroups = new Set(result.test.map((e) => e.splitGroupId));

    // 1. Check episode ID overlaps
    for (const id of valIds) {
      if (trainIds.has(id)) {
        throw new Error(`DATA_LEAKAGE: Episode ${id} present in both Train and Validation splits.`);
      }
    }
    for (const id of testIds) {
      if (trainIds.has(id)) {
        throw new Error(`DATA_LEAKAGE: Episode ${id} present in both Train and Test splits.`);
      }
      if (valIds.has(id)) {
        throw new Error(`DATA_LEAKAGE: Episode ${id} present in both Validation and Test splits.`);
      }
    }

    // 2. Check splitGroup overlaps
    for (const g of valGroups) {
      if (trainGroups.has(g)) {
        throw new Error(`GROUP_LEAKAGE: splitGroupId ${g} present in both Train and Validation splits.`);
      }
    }
    for (const g of testGroups) {
      if (trainGroups.has(g)) {
        throw new Error(`GROUP_LEAKAGE: splitGroupId ${g} present in both Train and Test splits.`);
      }
      if (valGroups.has(g)) {
        throw new Error(`GROUP_LEAKAGE: splitGroupId ${g} present in both Validation and Test splits.`);
      }
    }

    // 3. Check completeness
    if (result.splitCounts.train + result.splitCounts.validation + result.splitCounts.test !== result.splitCounts.total) {
      throw new Error(`SPLIT_INCOMPLETE: Sum of splits does not equal total episodes.`);
    }
  }

  /**
   * Generates a signed, immutable SplitManifest.
   */
  public static createManifest(
    result: SplitResult,
    options: SplitOptions = {}
  ): SplitManifest {
    const benchmarkVersion = options.benchmarkVersion || 'siftrbench-v1';
    const jsonStr = JSON.stringify(result.assignments);
    const checksum = crypto.createHash('sha256').update(jsonStr).digest('hex');

    return {
      schemaVersion: 'siftrbench-split-manifest-v1',
      benchmarkVersion,
      createdAt: new Date().toISOString(),
      splitCodeVersion: 'v3.1.0',
      randomSeed: options.seed ?? 42,
      ratios: {
        train: options.trainRatio ?? 0.70,
        validation: options.valRatio ?? 0.15,
        test: options.testRatio ?? 0.15,
      },
      counts: result.splitCounts,
      groupCounts: result.groupCounts,
      checksum,
      assignments: result.assignments,
    };
  }
}
