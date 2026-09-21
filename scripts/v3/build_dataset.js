#!/usr/bin/env node
const path = require('path');
const fs = require('fs');

const { RepositoryIndexer } = require('../../dist/indexing/repository_index');
const { GraphBuilder } = require('../../dist/graph/graph_builder');
const { GitGraphIntelligence } = require('../../dist/graph/git_graph');
const { CandidateGenerator } = require('../../dist/retrieval/candidate_generator');
const { createTaskContext } = require('../../dist/context/task_context');
const { createAgentEnvironment } = require('../../dist/agents/agent_environment');
const { createDefaultDataRights } = require('../../dist/rights/data_rights');
const { FeatureBuilderV3_1 } = require('../../dist/learning/features/feature_builder_v3_1');
const { SiftrDatasetV1Builder } = require('../../dist/learning/datasets/siftr_dataset_v1');
const { PairwiseBuilder } = require('../../dist/learning/datasets/pairwise_builder');
const { RepositoryOrigin, createDefaultRepositoryTrustPolicy } = require('../../dist/security/trust');

async function runBuildDataset(options = {}) {
  const rootDir = path.resolve(__dirname, '../..');
  const dataDir = path.join(rootDir, 'data');
  const maxCandidates = options.maxCandidates ?? 50;

  console.log('📦 [SiftrDatasetV1 Builder] Loading benchmark manifest & splits...');
  const manifestPath = path.join(dataDir, 'siftrbench_v1_manifest.json');
  const splitPath = path.join(dataDir, 'siftrbench_v1_splits.json');

  if (!fs.existsSync(manifestPath) || !fs.existsSync(splitPath)) {
    throw new Error('Benchmark manifest or splits missing. Run build_benchmark first.');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const splitManifest = JSON.parse(fs.readFileSync(splitPath, 'utf8'));

  const splitMap = new Map();
  for (const a of splitManifest.assignments) {
    splitMap.set(a.episodeId, a.split);
  }

  const repoConfigs = {
    express: {
      path: path.join(rootDir, 'benchmarks/express-repo'),
      options: {
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
  const repoData = {};
  for (const [rId, config] of Object.entries(repoConfigs)) {
    if (fs.existsSync(config.path)) {
      process.stdout.write(`   Indexing ${rId}... `);
      const indexer = new RepositoryIndexer();
      const idx = await indexer.indexRepository(config.path, config.options);
      const gb = new GraphBuilder();
      const graph = gb.buildGraph(idx.units, { repoDir: config.path });
      let gitInt;
      try {
        gitInt = new GitGraphIntelligence({ repoDir: config.path });
        const origExtract = gitInt.extractCoChangePairs.bind(gitInt);
        const coChangeMap = new Map();
        gitInt.extractCoChangePairs = (cutoff) => {
          const k = cutoff ? cutoff.timestamp : 'head';
          if (!coChangeMap.has(k)) {
            coChangeMap.set(k, origExtract(cutoff));
          }
          return coChangeMap.get(k);
        };

        const origFreq = gitInt.getFileChangeFrequency.bind(gitInt);
        const freqMap = new Map();
        gitInt.getFileChangeFrequency = (file, cutoff) => {
          const k = `${file}|${cutoff ? cutoff.timestamp : 'head'}`;
          if (!freqMap.has(k)) {
            freqMap.set(k, origFreq(file, cutoff));
          }
          return freqMap.get(k);
        };

        const origRecent = gitInt.getRecentChangeFrequency.bind(gitInt);
        const recentMap = new Map();
        gitInt.getRecentChangeFrequency = (file, days, cutoff) => {
          const k = `${file}|${days}|${cutoff ? cutoff.timestamp : 'head'}`;
          if (!recentMap.has(k)) {
            recentMap.set(k, origRecent(file, days, cutoff));
          }
          return recentMap.get(k);
        };
      } catch (e) {}
      repoData[rId] = { units: idx.units, graph, gitInt, path: config.path };
      console.log(`done (${idx.units.length} units, ${graph.getAllNodes().length} graph nodes)`);
    }
  }

  console.log(`\n🔍 Generating candidate features for ${manifest.episodes.length} episodes...`);
  const datasetBuilder = new SiftrDatasetV1Builder();
  const rows = [];
  const candGen = new CandidateGenerator({ maxCandidates });
  const defaultRights = createDefaultDataRights({ trainingAllowed: true });

  for (let i = 0; i < manifest.episodes.length; i++) {
    const ep = manifest.episodes[i];
    const rInfo = repoData[ep.repositoryId];
    if (!rInfo) continue;

    if ((i + 1) % 10 === 0 || i === manifest.episodes.length - 1) {
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
    const exposedUnitIds = new Set();
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

module.exports = { runBuildDataset };
