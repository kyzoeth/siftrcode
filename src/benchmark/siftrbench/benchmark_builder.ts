/**
 * SiftrCode V3 - SiftrBench v1 Benchmark Builder (Phase V3.1A)
 *
 * Assembles and validates the canonical 100+ independent task episodes
 * for SiftrBench v1 across Express, FastAPI, and SiftrCode repositories.
 *
 * Invariants:
 * 1. Independent Task Episodes (not context units) are the fundamental benchmark unit.
 * 2. Pre-task repository snapshot and base commit are strictly preserved.
 * 3. Future git history and ground truth solution diffs are isolated from features.
 */

import * as crypto from 'crypto';
import { SiftrBenchEpisode, SiftrBenchManifest, SiftrTaskType } from './episode_schema';
import { SIFTRBENCH_TASK_DEFINITIONS } from './tasks_catalog';
import { AUDITED_100_TASKS, AuditedTask } from '../../tests/study_jev_heldout_ranking';

export const SIFTRBENCH_V1_VERSION = 'siftrbench-v1';

export const REPO_PINNED_COMMITS: Record<string, string> = {
  express: '9a34acf03cb818ff3f8bc40e44176e277a25cbb9',
  fastapi: '50113da16fec53b66b80d75e80a89296de4fa5a5',
  siftrcode: '1eedac03b0d83025ebf08ed2945e0ab015c46f6a',
};

export const REPO_ORIGINS: Record<string, string> = {
  express: 'https://github.com/expressjs/express.git',
  fastapi: 'https://github.com/fastapi/fastapi.git',
  siftrcode: 'https://github.com/kyzoeth/siftrcode.git',
};

export class BenchmarkBuilder {
  /**
   * Build canonical SiftrBench v1 episodes combining audited 100 tasks with catalog extensions.
   */
  public static buildBenchmarkEpisodes(): SiftrBenchEpisode[] {
    const episodes: SiftrBenchEpisode[] = [];
    const seenTaskIds = new Set<string>();

    // 1. Process the 100 audited tasks from V2 study
    for (let i = 0; i < AUDITED_100_TASKS.length; i++) {
      const task: AuditedTask = AUDITED_100_TASKS[i];
      const repo = task.repo;
      const baseCommit = REPO_PINNED_COMMITS[repo] || '1eedac03b0d83025ebf08ed2945e0ab015c46f6a';
      const repoOrigin = REPO_ORIGINS[repo] || 'https://github.com/kyzoeth/siftrcode.git';

      // Group splitGroupId by fine-grained functional domain within repository to prevent leakage
      let domain = 'core';
      if (task.expectedTargetPaths.length > 0) {
        const p = task.expectedTargetPaths[0].toLowerCase();
        if (repo === 'express') {
          if (p.includes('router') || p.includes('route')) domain = 'router';
          else if (p.includes('middleware')) domain = 'middleware';
          else if (p.includes('response')) domain = 'response';
          else if (p.includes('request')) domain = 'request';
          else if (p.includes('view') || p.includes('template')) domain = 'view';
          else if (p.includes('utils')) domain = 'utils';
          else if (p.includes('application')) domain = 'application';
        } else if (repo === 'fastapi') {
          if (p.includes('dependenc')) domain = 'dependencies';
          else if (p.includes('openapi')) domain = 'openapi';
          else if (p.includes('security')) domain = 'security';
          else if (p.includes('routing') || p.includes('router')) domain = 'routing';
          else if (p.includes('param')) domain = 'params';
          else if (p.includes('encoder')) domain = 'encoders';
          else if (p.includes('exception')) domain = 'exceptions';
          else if (p.includes('datastructure')) domain = 'datastructures';
          else if (p.includes('application')) domain = 'app';
          else if (p.includes('utils')) domain = 'utils';
        } else if (repo === 'siftrcode') {
          if (p.includes('learning') || p.includes('dataset') || p.includes('lineage')) domain = 'learning';
          else if (p.includes('storage') || p.includes('sqlite')) domain = 'storage';
          else if (p.includes('rights')) domain = 'rights';
          else if (p.includes('graph') || p.includes('git')) domain = 'graph';
          else if (p.includes('token')) domain = 'token';
          else if (p.includes('engine')) domain = 'engine';
          else if (p.includes('ranking') || p.includes('rank')) domain = 'ranking';
          else if (p.includes('context') || p.includes('budget') || p.includes('bundle') || p.includes('resolution')) domain = 'context';
          else if (p.includes('retrieval') || p.includes('candidate')) domain = 'retrieval';
          else if (p.includes('workspace')) domain = 'workspace';
          else if (p.includes('mcp') || p.includes('cli')) domain = 'mcp';
        }
      }
      const splitGroupId = `split_${repo}_${domain}`;

      const episode: SiftrBenchEpisode = {
        schemaVersion: 'siftrbench-v1',
        episodeId: `sb1_${task.taskId}`,
        taskId: task.taskId,
        repositoryId: repo,
        repositoryOrigin: repoOrigin,
        baseCommit,
        workspaceSnapshotId: `ws_snap_${repo}_${baseCommit.slice(0, 8)}`,
        taskPrompt: task.prompt,
        taskType: (task.type as SiftrTaskType) || 'BUG_FIX',
        expectedTargetPaths: [...task.expectedTargetPaths],
        expectedRelatedPaths: task.expectedRelatedPaths ? [...task.expectedRelatedPaths] : undefined,
        verifier: {
          type: repo === 'fastapi' ? 'pytest' : 'npm_test',
          command: repo === 'fastapi' ? 'pytest' : 'npm test',
        },
        temporalCutoff: repo === 'siftrcode' ? '2026-09-21T13:41:44.000Z' : '2024-01-01T00:00:00.000Z',
        rightsReference: repo === 'siftrcode' ? 'rights_siftrcode_firstparty' : `rights_${repo}_oss`,
        provenance: {
          source: `${repo}_audited_tasks`,
          sourceVersion: 'v1.0.0',
          importedAt: '2026-09-21T14:00:00.000Z',
        },
        splitGroupId,
        metadata: {
          taskIndex: i,
          hasRelatedPaths: Boolean(task.expectedRelatedPaths?.length),
        },
      };

      seenTaskIds.add(task.taskId);
      episodes.push(episode);
    }

    // 2. Add extended tasks from catalog (ensuring multi-file, test failure, and config tasks)
    for (const def of SIFTRBENCH_TASK_DEFINITIONS) {
      if (!seenTaskIds.has(def.taskId)) {
        episodes.push({
          ...def,
          schemaVersion: 'siftrbench-v1',
        });
        seenTaskIds.add(def.taskId);
      }
    }

    // 3. Invariant validation on all episodes
    for (const ep of episodes) {
      BenchmarkBuilder.validateEpisode(ep);
    }

    return episodes;
  }

  /**
   * Validates structural and semantic invariants of a SiftrBenchEpisode.
   */
  public static validateEpisode(ep: SiftrBenchEpisode): void {
    if (ep.schemaVersion !== 'siftrbench-v1') {
      throw new Error(`INVALID_SCHEMA: Episode ${ep.episodeId} has invalid schemaVersion: ${ep.schemaVersion}`);
    }
    if (!ep.episodeId || !ep.taskId) {
      throw new Error(`MISSING_IDENTIFIER: Episode must have episodeId and taskId.`);
    }
    if (!ep.repositoryId || !ep.baseCommit || ep.baseCommit.length !== 40) {
      throw new Error(`INVALID_GIT_PROVENANCE: Episode ${ep.episodeId} must specify 40-char baseCommit.`);
    }
    if (!ep.taskPrompt || ep.taskPrompt.trim().length < 5) {
      throw new Error(`INVALID_PROMPT: Episode ${ep.episodeId} has empty or trivial prompt.`);
    }
    if (!ep.expectedTargetPaths || ep.expectedTargetPaths.length === 0) {
      throw new Error(`MISSING_TARGETS: Episode ${ep.episodeId} must specify expectedTargetPaths.`);
    }
    if (!ep.splitGroupId) {
      throw new Error(`MISSING_SPLIT_GROUP: Episode ${ep.episodeId} must declare splitGroupId.`);
    }
    if (!ep.temporalCutoff) {
      throw new Error(`MISSING_TEMPORAL_CUTOFF: Episode ${ep.episodeId} must declare temporalCutoff.`);
    }
    if (!ep.verifier || !ep.verifier.type) {
      throw new Error(`MISSING_VERIFIER: Episode ${ep.episodeId} must declare verifier.`);
    }
  }

  /**
   * Emits a versioned, cryptographically checksummed SiftrBenchManifest.
   */
  public static createManifest(episodes: SiftrBenchEpisode[]): SiftrBenchManifest {
    const repoDist: Record<string, number> = {};
    const taskDist: Record<string, number> = {};

    for (const ep of episodes) {
      repoDist[ep.repositoryId] = (repoDist[ep.repositoryId] || 0) + 1;
      taskDist[ep.taskType] = (taskDist[ep.taskType] || 0) + 1;
    }

    const jsonStr = JSON.stringify(episodes);
    const checksum = crypto.createHash('sha256').update(jsonStr).digest('hex');

    return {
      schemaVersion: 'siftrbench-manifest-v1',
      benchmarkVersion: SIFTRBENCH_V1_VERSION,
      createdAt: new Date().toISOString(),
      totalEpisodes: episodes.length,
      repositoryDistribution: repoDist,
      taskTypeDistribution: taskDist,
      checksum,
      episodes,
    };
  }
}
