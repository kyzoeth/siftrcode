#!/usr/bin/env node
/**
 * SiftrCode V3 - Build Sanctioned Dataset Script (Phase V3.1C & D)
 *
 * Extracts ContextFeaturesV3_1 across all SiftrBench v1 episodes,
 * guarantees point-in-time correctness via EpisodeWorkspaceResolver,
 * separates benchmark target relevance from behavioral telemetry,
 * routes through RightsFilter to enforce UNKNOWN != NEGATIVE,
 * and builds within-task pairwise ranking instances.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RepositoryIndexer } from '../../src/indexing/repository_index';
import { GraphBuilder } from '../../src/graph/graph_builder';
import { GitGraphIntelligence } from '../../src/graph/git_graph';
import { CandidateGenerator } from '../../src/retrieval/candidate_generator';
import { createTaskContext } from '../../src/context/task_context';
import { createAgentEnvironment } from '../../src/agents/agent_environment';
import { createDefaultDataRights } from '../../src/rights/data_rights';
import { FeatureBuilderV3_1 } from '../../src/learning/features/feature_builder_v3_1';
import { SiftrDatasetV1Builder, DatasetRowV1, SiftrContextDatasetV1 } from '../../src/learning/datasets/siftr_dataset_v1';
import { PairwiseBuilder, PairwiseDatasetV1 } from '../../src/learning/datasets/pairwise_builder';
import { SiftrBenchManifest } from '../../src/benchmark/siftrbench/episode_schema';
import { SplitManifest, SplitName } from '../../src/benchmark/siftrbench/split_manager';
import { EpisodeWorkspaceResolver } from '../../src/benchmark/siftrbench/episode_workspace_resolver';
import { RepositoryOrigin, createDefaultRepositoryTrustPolicy } from '../../src/security/trust';

export async function runBuildDataset(options: { maxCandidates?: number } = {}) {
  const rootDir = path.resolve(__dirname, '../..');
  const dataDir = path.join(rootDir, 'data');
  const maxCandidates = options.maxCandidates ?? 50;

  console.log('📦 [SiftrDatasetV1 Builder] Loading benchmark manifest & splits...');
  const manifestPath = path.join(dataDir, 'siftrbench_v1_manifest.json');
  const splitPath = path.join(dataDir, 'siftrbench_v1_splits.json');

  if (!fs.existsSync(manifestPath) || !fs.existsSync(splitPath)) {
    throw new Error('Benchmark manifest or splits missing. Run build_benchmark first.');
  }

  const manifest: SiftrBenchManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const splitManifest: SplitManifest = JSON.parse(fs.readFileSync(splitPath, 'utf8'));

  const splitMap = new Map<string, SplitName>();
  for (const a of splitManifest.assignments) {
    splitMap.set(a.episodeId, a.split);
  }

  // Configure benchmark repository filter options
  const repoFilterConfigs: Record<string, any> = {
    express: {
      options: {
        trustPolicy: createDefaultRepositoryTrustPolicy({
          repositoryId: 'express',
          origin: RepositoryOrigin.CLONED_EXTERNAL,
        }),
      },
    },
    fastapi: {
      options: {
        includePatterns: ['fastapi/**'],
        excludePatterns: ['**/tests/**', '**/docs/**', '**/__pycache__/**'],
        trustPolicy: createDefaultRepositoryTrustPolicy({
          repositoryId: 'fastapi',
          origin: RepositoryOrigin.CLONED_EXTERNAL,
        }),
      },
    },
    siftrcode: {
      options: {
        includePatterns: ['src/**'],
        excludePatterns: ['**/node_modules/**', '**/dist/**', '**/temp_*/**', '**/benchmarks/**'],
        trustPolicy: createDefaultRepositoryTrustPolicy({
          repositoryId: 'siftrcode',
          origin: RepositoryOrigin.LOCAL_FIRST_PARTY,
        }),
      },
    },
  };

  // Find all unique (repositoryId, baseCommit) pairs
  const uniqueRepoCommits = new Map<string, { repoId: string; baseCommit: string }>();
  for (const ep of manifest.episodes) {
    const key = `${ep.repositoryId}:${ep.baseCommit}`;
    if (!uniqueRepoCommits.has(key)) {
      uniqueRepoCommits.set(key, { repoId: ep.repositoryId, baseCommit: ep.baseCommit });
    }
  }

  console.log('📚 Resolving point-in-time workspaces and indexing repositories on disk...');
  const repoData: Record<string, any> = {};
  for (const [key, { repoId, baseCommit }] of uniqueRepoCommits.entries()) {
    const resolved = EpisodeWorkspaceResolver.resolveWorkspace(repoId, baseCommit);
    EpisodeWorkspaceResolver.assertCommit(resolved.workspacePath, baseCommit, repoId);

    process.stdout.write(`   Indexing ${repoId} @ ${baseCommit.slice(0, 8)} (${resolved.isWorktree ? 'isolated worktree' : 'source repo'})... `);
    const indexer = new RepositoryIndexer();
    const filterOptions = repoFilterConfigs[repoId]?.options;
    const idx = await indexer.indexRepository(resolved.workspacePath, filterOptions);
    const gb = new GraphBuilder();
    const graph = gb.buildGraph(idx.units, { repoDir: resolved.workspacePath });
    let gitInt: GitGraphIntelligence | undefined;
    try {
      gitInt = new GitGraphIntelligence({ repoDir: resolved.workspacePath });
      const origExtract = gitInt.extractCoChangePairs.bind(gitInt);
      const coChangeMap = new Map();
      (gitInt as any).extractCoChangePairs = (cutoff: any) => {
        const k = cutoff ? cutoff.timestamp : 'head';
        if (!coChangeMap.has(k)) {
          coChangeMap.set(k, origExtract(cutoff));
        }
        return coChangeMap.get(k);
      };

      const origFreq = gitInt.getFileChangeFrequency.bind(gitInt);
      const freqMap = new Map();
      (gitInt as any).getFileChangeFrequency = (file: string, cutoff: any) => {
        const k = `${file}|${cutoff ? cutoff.timestamp : 'head'}`;
        if (!freqMap.has(k)) {
          freqMap.set(k, origFreq(file, cutoff));
        }
        return freqMap.get(k);
      };

      const origRecent = gitInt.getRecentChangeFrequency.bind(gitInt);
      const recentMap = new Map();
      (gitInt as any).getRecentChangeFrequency = (file: string, days: number, cutoff: any) => {
        const k = `${file}|${days}|${cutoff ? cutoff.timestamp : 'head'}`;
        if (!recentMap.has(k)) {
          recentMap.set(k, origRecent(file, days, cutoff));
        }
        return recentMap.get(k);
      };
    } catch (e) {}

    repoData[key] = { units: idx.units, graph, gitInt, path: resolved.workspacePath, baseCommit };
    console.log(`done (${idx.units.length} units, ${graph.getAllNodes().length} graph nodes)`);
  }

  console.log(`\n🔍 Generating candidate features for ${manifest.episodes.length} episodes...`);
  const datasetBuilder = new SiftrDatasetV1Builder();
  const rows: DatasetRowV1[] = [];
  const candGen = new CandidateGenerator({ maxCandidates });
  const defaultRights = createDefaultDataRights({ trainingAllowed: true });

  for (let i = 0; i < manifest.episodes.length; i++) {
    const ep = manifest.episodes[i];
    const epKey = `${ep.repositoryId}:${ep.baseCommit}`;
    const rInfo = repoData[epKey];
    if (!rInfo) continue;

    if ((i + 1) % 20 === 0 || i === manifest.episodes.length - 1) {
      process.stdout.write(`   Progress: ${i + 1}/${manifest.episodes.length} episodes (${rows.length} rows extracted)...\n`);
    }

    const split = splitMap.get(ep.episodeId) || 'train';
    const taskCtx = createTaskContext({
      taskId: ep.taskId,
      primaryPrompt: ep.taskPrompt,
      workspaceRoot: rInfo.path,
      agentEnvironment: createAgentEnvironment({ agentKind: 'generic_mcp' }),
    });

    const featureCutoff = {
      timestamp: ep.temporalCutoff,
      workspaceSnapshotId: ep.workspaceSnapshotId,
    };

    const candidates = candGen.generateCandidates(taskCtx, rInfo.units, rInfo.graph, rInfo.gitInt);
    const unitsMap = new Map();
    for (const u of rInfo.units) unitsMap.set(u.id, u);

    // Extract features for all candidates
    const candidateFeatures = [];
    for (const cand of candidates) {
      const u = unitsMap.get(cand.contextUnitId);
      if (!u) continue;
      const features = FeatureBuilderV3_1.buildFeatures({
        candidate: cand,
        unit: u,
        task: taskCtx,
        graph: rInfo.graph,
        gitIntelligence: rInfo.gitInt,
        featureCutoff,
      });
      candidateFeatures.push({ cand, u, features });
    }

    // Determine actual exposed bundle under 8,000-token budget
    candidateFeatures.sort((a, b) => b.features.heuristicScore - a.features.heuristicScore || a.cand.contextUnitId.localeCompare(b.cand.contextUnitId));

    let accumulatedTokens = 0;
    const exposedUnitIds = new Set<string>();
    for (const cf of candidateFeatures) {
      const tok = cf.u.tokenEstimate || 100;
      if (accumulatedTokens + tok <= 8000) {
        exposedUnitIds.add(cf.cand.contextUnitId);
        accumulatedTokens += tok;
      }
    }

    for (const cf of candidateFeatures) {
      const { cand, u, features } = cf;
      const isExposed = exposedUnitIds.has(cand.contextUnitId);

      // Separate benchmark relevance from behavioral telemetry:
      // Do NOT invent read/edited/taskSucceeded from ground-truth membership!
      const row = datasetBuilder.createRow({
        episode: ep,
        split,
        contextUnitId: cand.contextUnitId,
        unitPath: u.path,
        features,
        candidateSources: cand.retrievalSources,
        isExposed,
        observability: isExposed ? 'LIMITED_TELEMETRY' : 'UNOBSERVED',
        dataRights: defaultRights,
      });

      if (row) {
        rows.push(row);
      }
    }
  }

  console.log(`✔ Extracted ${rows.length} candidate rows.`);
  const dataset = SiftrDatasetV1Builder.packageDataset(rows, manifest.benchmarkVersion);
  const datasetPath = path.join(dataDir, 'siftr_dataset_v1.json');
  fs.writeFileSync(datasetPath, JSON.stringify({ ...dataset, rowsByEpisode: undefined }, null, 2), 'utf8');
  console.log(`✔ Persisted Sanctioned Dataset: ${datasetPath}`);
  console.log(`   Benchmark Target Positives:    ${dataset.summary.benchmarkPositives}`);
  console.log(`   Benchmark Non-Targets:         ${dataset.summary.benchmarkNonTargets}`);
  console.log(`   Behavioral Observed Negatives: ${dataset.summary.behavioralObservedNegatives} (real telemetry)`);
  console.log(`   Behavioral Unknown:            ${dataset.summary.behavioralUnknown} (strictly preserved)`);

  console.log('\n⚖️  Building within-task pairwise ranking pairs...');
  const pairwiseDataset = PairwiseBuilder.buildPairs(dataset, { includeJev: true });
  const pairwisePath = path.join(dataDir, 'pairwise_dataset_v1.json');
  fs.writeFileSync(pairwisePath, JSON.stringify(pairwiseDataset, null, 2), 'utf8');
  console.log(`✔ Persisted Pairwise Dataset: ${pairwisePath}`);
  console.log(`   Total Pairs: ${pairwiseDataset.report.totalPairsGenerated} across ${pairwiseDataset.report.totalTasksWithPairs} tasks`);
  console.log(`   Train Pairs: ${pairwiseDataset.report.pairsPerSplit.train}`);
  console.log(`   Val Pairs:   ${pairwiseDataset.report.pairsPerSplit.validation}`);
  console.log(`   Test Pairs:  ${pairwiseDataset.report.pairsPerSplit.test}`);
  console.log(`   Benchmark Positives Used:   ${pairwiseDataset.report.benchmarkPositivesUsed}`);
  console.log(`   Benchmark Non-Targets Used: ${pairwiseDataset.report.benchmarkNonTargetsUsed}`);
  console.log(`   Unknown Rows Excluded:      ${pairwiseDataset.report.unknownRowsExcluded}`);

  return { dataset, pairwiseDataset };
}

if (require.main === module) {
  runBuildDataset().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
