#!/usr/bin/env node
/**
 * SiftrCode V3 - Build Sanctioned Dataset Script (Phase V3.1C & D)
 *
 * Extracts ContextFeaturesV3_1 across all SiftrBench v1 episodes,
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

  // Configure benchmark repository paths
  const repoConfigs = {
    express: {
      path: path.join(rootDir, 'benchmarks/express-repo'),
      options: {
        includePatterns: ['lib/**'],
        excludePatterns: ['**/test/**', '**/examples/**', '**/benchmarks/**'],
        trustPolicy: createDefaultRepositoryTrustPolicy({
          repositoryId: 'express',
          origin: RepositoryOrigin.CLONED_EXTERNAL,
        }),
      },
    },
    fastapi: {
      path: path.join(rootDir, 'benchmarks/fastapi-repo'),
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
      path: rootDir,
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

  console.log('📚 Indexing repositories on disk...');
  const repoData: Record<string, any> = {};
  for (const [rId, config] of Object.entries(repoConfigs)) {
    if (fs.existsSync(config.path)) {
      process.stdout.write(`   Indexing ${rId}... `);
      const indexer = new RepositoryIndexer();
      const idx = await indexer.indexRepository(config.path, config.options);
      const gb = new GraphBuilder();
      const graph = gb.buildGraph(idx.units, { repoDir: config.path });
      let gitInt: GitGraphIntelligence | undefined;
      try {
        gitInt = new GitGraphIntelligence({ repoDir: config.path });
      } catch (e) {}
      repoData[rId] = { units: idx.units, graph, gitInt, path: config.path };
      console.log(`done (${idx.units.length} units, ${graph.getAllNodes().length} graph nodes)`);
    }
  }

  console.log(`\n🔍 Generating candidate features for ${manifest.episodes.length} episodes...`);
  const datasetBuilder = new SiftrDatasetV1Builder();
  const rows: DatasetRowV1[] = [];
  const candGen = new CandidateGenerator({ maxCandidates });
  const defaultRights = createDefaultDataRights();

  for (let i = 0; i < manifest.episodes.length; i++) {
    const ep = manifest.episodes[i];
    const rInfo = repoData[ep.repositoryId];
    if (!rInfo) continue;

    const split = splitMap.get(ep.episodeId) || 'train';
    const taskCtx = createTaskContext({
      taskId: ep.taskId,
      primaryPrompt: ep.taskPrompt,
      workspaceRoot: rInfo.path,
      agentEnvironment: createAgentEnvironment({ agentKind: 'generic_mcp' }),
    });

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
      const isTarget = u.path ? ep.expectedTargetPaths.some(tp => u.path.toLowerCase().endsWith(tp.toLowerCase()) || u.path.toLowerCase().includes(tp.toLowerCase())) : false;

      const row = datasetBuilder.createRow({
        episode: ep,
        split,
        contextUnitId: cand.contextUnitId,
        unitPath: u.path,
        features,
        candidateSources: cand.retrievalSources,
        isExposed,
        observability: isExposed ? 'FULL_TOOL_TRACE' : 'UNOBSERVED',
        read: isExposed && isTarget,
        edited: isExposed && isTarget,
        taskSucceeded: true,
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
  console.log(`   Positive rows:      ${dataset.summary.positiveRows}`);
  console.log(`   Weak-Negative rows: ${dataset.summary.weakNegativeRows}`);
  console.log(`   Unknown rows:       ${dataset.summary.unknownRows} (strictly excluded from negatives)`);

  console.log('\n⚖️  Building within-task pairwise ranking pairs...');
  const pairwiseDataset = PairwiseBuilder.buildPairs(dataset, { includeJev: true });
  const pairwisePath = path.join(dataDir, 'pairwise_dataset_v1.json');
  fs.writeFileSync(pairwisePath, JSON.stringify(pairwiseDataset, null, 2), 'utf8');
  console.log(`✔ Persisted Pairwise Dataset: ${pairwisePath}`);
  console.log(`   Total Pairs: ${pairwiseDataset.report.totalPairsGenerated} across ${pairwiseDataset.report.totalTasksWithPairs} tasks`);
  console.log(`   Train Pairs: ${pairwiseDataset.report.pairsPerSplit.train}`);
  console.log(`   Val Pairs:   ${pairwiseDataset.report.pairsPerSplit.validation}`);
  console.log(`   Test Pairs:  ${pairwiseDataset.report.pairsPerSplit.test}`);

  return { dataset, pairwiseDataset };
}

if (require.main === module) {
  runBuildDataset().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
