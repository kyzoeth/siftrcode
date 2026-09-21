#!/usr/bin/env node
/**
 * SiftrCode V3 - Frozen V2 Baseline Evaluator (Phase V3.0)
 *
 * Checks out a temporary, isolated git worktree at `v2-final` (commit 1eedac03b0d83025ebf08ed2945e0ab015c46f6a),
 * builds cleanly, executes the deterministic V2 ranker on the benchmark task set,
 * and emits a versioned, immutable JSON evaluation report.
 *
 * Invariant: Never copy/paste V2 ranking logic into V3 and call it "baseline".
 * Baseline metrics MUST come directly from the compiled baseline artifact.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawnSync } from 'child_process';

const FROZEN_V2_SHA = '1eedac03b0d83025ebf08ed2945e0ab015c46f6a';
const EXPECTED_TAG = 'v2-final';

export interface BaselineRunOptions {
  maxTasks?: number;
  candidateBudget?: number;
  tokenBudget?: number;
  outputDir?: string;
}

export function runFrozenV2Baseline(options: BaselineRunOptions = {}) {
  const rootDir = path.resolve(__dirname, '../..');
  const candidateBudget = options.candidateBudget ?? 50;
  const tokenBudget = options.tokenBudget ?? 8000;
  const maxTasks = options.maxTasks ?? 100;
  const outputDir = options.outputDir ?? path.join(rootDir, 'experiments/results/frozen-v2-baseline');

  console.log('🔒 [Frozen V2 Baseline Evaluator] Initializing...');
  console.log(`   Target Commit: ${FROZEN_V2_SHA} (${EXPECTED_TAG})`);
  console.log(`   Candidate Budget: ${candidateBudget} candidates`);
  console.log(`   Context Token Budget: ${tokenBudget} tokens`);
  console.log(`   Max Tasks: ${maxTasks}`);

  // 1. Verify git tag and commit
  let tagCommit = '';
  try {
    tagCommit = execSync(`git -C "${rootDir}" rev-parse ${EXPECTED_TAG}^{commit}`, { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error(`❌ Git tag ${EXPECTED_TAG} not found or invalid:`, err);
    process.exit(1);
  }

  if (tagCommit !== FROZEN_V2_SHA) {
    console.error(`❌ INVARIANT VIOLATION: ${EXPECTED_TAG} points to ${tagCommit}, expected ${FROZEN_V2_SHA}`);
    process.exit(1);
  }
  console.log(`✔ Verified ${EXPECTED_TAG} references exact commit ${FROZEN_V2_SHA}`);

  // 2. Create isolated worktree
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_v2_baseline_wt_'));
  console.log(`   Created temporary worktree location: ${tempDir}`);

  try {
    execSync(`git -C "${rootDir}" worktree add --detach "${tempDir}" ${FROZEN_V2_SHA} --quiet`);
    console.log(`✔ Checked out ${FROZEN_V2_SHA} into worktree`);

    // Link node_modules and benchmarks from root repo to avoid re-installation
    const rootNodeModules = path.join(rootDir, 'node_modules');
    const rootBenchmarks = path.join(rootDir, 'benchmarks');
    const wtNodeModules = path.join(tempDir, 'node_modules');
    const wtBenchmarks = path.join(tempDir, 'benchmarks');

    if (fs.existsSync(rootNodeModules) && !fs.existsSync(wtNodeModules)) {
      fs.symlinkSync(rootNodeModules, wtNodeModules, 'dir');
    }
    if (fs.existsSync(rootBenchmarks) && !fs.existsSync(wtBenchmarks)) {
      fs.symlinkSync(rootBenchmarks, wtBenchmarks, 'dir');
    }

    // Build the frozen V2 worktree cleanly
    console.log('   Compiling frozen V2 worktree with tsc...');
    execSync(`npx tsc`, { cwd: tempDir, stdio: 'pipe' });
    console.log('✔ Frozen V2 compiled successfully.');

    // Read and pass test episodes to the isolated baseline runner
    const splitManifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'data/siftrbench_v1_splits.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'data/siftrbench_v1_manifest.json'), 'utf8'));
    const testAssignments = splitManifest.assignments.filter((a: any) => a.split === 'test');
    let testEpisodes = manifest.episodes.filter((e: any) => testAssignments.some((a: any) => a.episodeId === e.episodeId));
    if (options.maxTasks && options.maxTasks < testEpisodes.length) {
      testEpisodes = testEpisodes.slice(0, options.maxTasks);
    }
    fs.writeFileSync(path.join(tempDir, 'test_episodes.json'), JSON.stringify(testEpisodes, null, 2), 'utf8');
    console.log(`   Loaded ${testEpisodes.length} held-out test episodes for frozen V2 baseline.`);

    // 3. Create runner script inside the worktree that executes ContextRanker directly
    const evalScriptPath = path.join(tempDir, 'run_eval.js');
    const evalScriptContent = `
const fs = require('fs');
const path = require('path');

async function main() {
  const { ContextRanker } = require('./dist/ranking/context_rank');
  const { FeatureBuilderV1 } = require('./dist/ranking/feature_builder');
  const { CandidateGenerator } = require('./dist/retrieval/candidate_generator');
  const { RepositoryIndexer } = require('./dist/indexing/repository_index');
  const { GraphBuilder } = require('./dist/graph/graph_builder');
  const { GitGraphIntelligence } = require('./dist/graph/git_graph');
  const { createTaskContext } = require('./dist/context/task_context');
  const { createAgentEnvironment } = require('./dist/agents/agent_environment');

  const rootDir = process.cwd();
  const repoPaths = {
    express: path.join(rootDir, 'benchmarks/express-repo'),
    fastapi: path.join(rootDir, 'benchmarks/fastapi-repo'),
    siftrcode: rootDir,
  };

  const testEpisodes = JSON.parse(fs.readFileSync(path.join(__dirname, 'test_episodes.json'), 'utf8'));
  console.log(\`Evaluating \${testEpisodes.length} held-out test episodes on frozen V2 baseline...\`);

  // Index repositories
  const indexes = {};
  for (const [repoKey, rPath] of Object.entries(repoPaths)) {
    if (fs.existsSync(rPath)) {
      process.stdout.write(\`  Indexing \${repoKey}... \`);
      const indexer = new RepositoryIndexer();
      const idx = await indexer.indexWorkspace({ workspaceDir: rPath });
      const gb = new GraphBuilder();
      const graph = gb.build(idx.units);
      let gitInt = undefined;
      try {
        gitInt = new GitGraphIntelligence({ workspaceDir: rPath });
      } catch (e) {}
      indexes[repoKey] = { index: idx, graph, gitInt };
      console.log(\`done (\${idx.units.length} units)\`);
    }
  }

  const taskResults = [];
  const ranker = new ContextRanker();
  const candidateLimit = ${candidateBudget};
  const tokenLimit = ${tokenBudget};

  for (let i = 0; i < testEpisodes.length; i++) {
    const task = testEpisodes[i];
    const repoKey = task.repositoryId;
    const repoData = indexes[repoKey];
    const tStart = Date.now();

    if (!repoData) {
      taskResults.push({
        episodeId: task.episodeId,
        taskId: task.taskId,
        repo: repoKey,
        taskType: task.taskType || 'BUG_FIX',
        candidateCount: 0,
        latencyMs: 0,
        contextTokens: 0,
        firstHitRank: 0,
        targetHit: false,
        metrics: {
          ndcg5: 0, ndcg10: 0, ndcg20: 0,
          recall5: 0, recall10: 0, recall20: 0, recall50: 0,
          mrr: 0
        }
      });
      continue;
    }

    const taskCtx = createTaskContext({
      primaryPrompt: task.taskPrompt,
      workspaceRoot: repoPaths[repoKey],
      agentEnvironment: createAgentEnvironment({ agentKind: 'generic_mcp' })
    });

    const candGen = new CandidateGenerator({ maxCandidates: candidateLimit });
    const candidates = candGen.generateCandidates({
      task: taskCtx,
      units: repoData.index.units,
      graph: repoData.graph
    });

    if (candidates.length === 0) {
      taskResults.push({
        episodeId: task.episodeId,
        taskId: task.taskId,
        repo: repoKey,
        taskType: task.taskType || 'BUG_FIX',
        candidateCount: 0,
        latencyMs: Date.now() - tStart,
        contextTokens: 0,
        firstHitRank: 0,
        targetHit: false,
        metrics: {
          ndcg5: 0, ndcg10: 0, ndcg20: 0,
          recall5: 0, recall10: 0, recall20: 0, recall50: 0,
          mrr: 0
        }
      });
      continue;
    }

    const featuresList = candidates.map(c => {
      const u = repoData.index.units.find(unit => unit.id === c.contextUnitId);
      return FeatureBuilderV1.buildFeatures({
        candidate: c,
        unit: u,
        task: taskCtx,
        graph: repoData.graph,
        gitIntelligence: repoData.gitInt
      });
    });

    const ranked = ranker.rank(featuresList);
    const latencyMs = Date.now() - tStart;

    // Materialize actual budgeted bundle (<= tokenLimit)
    let accumulatedTokens = 0;
    const budgetedBundle = [];
    for (const cand of ranked) {
      const unit = repoData.index.units.find(u => u.id === cand.contextUnitId);
      const tok = (unit && unit.metadata && unit.metadata.tokenEstimate) || 100;
      if (accumulatedTokens + tok <= tokenLimit) {
        budgetedBundle.push({ cand, unit, tok });
        accumulatedTokens += tok;
      }
    }

    // Canonical deduplicated ranking metrics on budgeted bundle
    const expectedPaths = (task.expectedTargetPaths || []).map(p => p.toLowerCase());
    const totalTargets = Math.max(1, expectedPaths.length);
    const discoveredTargets = new Set();
    let dcg5 = 0, dcg10 = 0, dcg20 = 0;
    let hits5 = 0, hits10 = 0, hits20 = 0, hits50 = 0;
    let firstHitRank = 0;

    for (let r = 0; r < budgetedBundle.length; r++) {
      const { unit } = budgetedBundle[r];
      const rankNum = r + 1;
      const uPath = (unit && unit.path ? unit.path.toLowerCase() : '');
      const matchedTarget = expectedPaths.find(p => uPath.endsWith(p) || uPath.includes(p));

      let rel = 0;
      if (matchedTarget && !discoveredTargets.has(matchedTarget)) {
        discoveredTargets.add(matchedTarget);
        rel = 1;
        if (firstHitRank === 0) firstHitRank = rankNum;
      }

      if (rankNum <= 5) {
        if (rel > 0) hits5++;
        dcg5 += rel / Math.log2(rankNum + 1);
      }
      if (rankNum <= 10) {
        if (rel > 0) hits10++;
        dcg10 += rel / Math.log2(rankNum + 1);
      }
      if (rankNum <= 20) {
        if (rel > 0) hits20++;
        dcg20 += rel / Math.log2(rankNum + 1);
      }
      if (rel > 0) hits50++;
    }

    let idcg5 = 0, idcg10 = 0, idcg20 = 0;
    for (let t = 1; t <= Math.min(totalTargets, 5); t++) idcg5 += 1 / Math.log2(t + 1);
    for (let t = 1; t <= Math.min(totalTargets, 10); t++) idcg10 += 1 / Math.log2(t + 1);
    for (let t = 1; t <= Math.min(totalTargets, 20); t++) idcg20 += 1 / Math.log2(t + 1);

    const ndcg5 = Math.min(1.0, Math.max(0.0, idcg5 > 0 ? dcg5 / idcg5 : 0));
    const ndcg10 = Math.min(1.0, Math.max(0.0, idcg10 > 0 ? dcg10 / idcg10 : 0));
    const ndcg20 = Math.min(1.0, Math.max(0.0, idcg20 > 0 ? dcg20 / idcg20 : 0));
    const recall5 = Math.min(1.0, Math.max(0.0, hits5 / totalTargets));
    const recall10 = Math.min(1.0, Math.max(0.0, hits10 / totalTargets));
    const recall20 = Math.min(1.0, Math.max(0.0, hits20 / totalTargets));
    const recall50 = Math.min(1.0, Math.max(0.0, hits50 / totalTargets));
    const mrr = Math.min(1.0, Math.max(0.0, firstHitRank > 0 ? 1 / firstHitRank : 0));

    taskResults.push({
      episodeId: task.episodeId,
      taskId: task.taskId,
      repo: repoKey,
      taskType: task.taskType || 'BUG_FIX',
      candidateCount: candidates.length,
      latencyMs,
      contextTokens: accumulatedTokens,
      firstHitRank,
      targetHit: hits10 > 0,
      metrics: {
        ndcg5: Number(ndcg5.toFixed(4)),
        ndcg10: Number(ndcg10.toFixed(4)),
        ndcg20: Number(ndcg20.toFixed(4)),
        recall5: Number(recall5.toFixed(4)),
        recall10: Number(recall10.toFixed(4)),
        recall20: Number(recall20.toFixed(4)),
        recall50: Number(recall50.toFixed(4)),
        mrr: Number(mrr.toFixed(4))
      }
    });
  }

  const n = taskResults.length;
  const mean = (fn) => Number((taskResults.reduce((acc, t) => acc + fn(t), 0) / n).toFixed(4));
  const hits = taskResults.filter(t => t.targetHit).length;

  const aggregate = {
    evaluatedTasks: n,
    ndcg5: mean(t => t.metrics.ndcg5),
    ndcg10: mean(t => t.metrics.ndcg10),
    ndcg20: mean(t => t.metrics.ndcg20),
    recall5: mean(t => t.metrics.recall5),
    recall10: mean(t => t.metrics.recall10),
    recall20: mean(t => t.metrics.recall20),
    recall50: mean(t => t.metrics.recall50),
    mrr: mean(t => t.metrics.mrr),
    meanLatencyMs: Number((taskResults.reduce((acc, t) => acc + t.latencyMs, 0) / n).toFixed(1)),
    meanContextTokens: Math.round(taskResults.reduce((acc, t) => acc + t.contextTokens, 0) / n),
    targetCoverage: Number((hits / n).toFixed(4)),
  };

  const report = {
    schemaVersion: 'frozen-v2-evaluation-v1',
    baselineCommit: '${FROZEN_V2_SHA}',
    gitTag: '${EXPECTED_TAG}',
    evaluatedAt: new Date().toISOString(),
    benchmarkVersion: 'siftrbench-v1',
    candidateBudget: ${candidateBudget},
    tokenBudget: ${tokenBudget},
    totalEpisodes: n,
    aggregate,
    taskResults
  };

  process.stdout.write(JSON.stringify(report));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
`;
    fs.writeFileSync(evalScriptPath, evalScriptContent, 'utf8');

    console.log('   Executing evaluation inside worktree...');
    const evalProc = spawnSync('node', [evalScriptPath], {
      cwd: tempDir,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });

    if (evalProc.status !== 0) {
      console.error('❌ Baseline evaluation failed inside worktree:', evalProc.stderr);
      throw new Error(`Worktree execution failed with exit code ${evalProc.status}`);
    }

    // Extract JSON report from stdout
    const stdoutStr = evalProc.stdout;
    const jsonStart = stdoutStr.indexOf('{"schemaVersion":"frozen-v2-evaluation-v1"');
    if (jsonStart === -1) {
      throw new Error(`Could not find JSON output in evaluator stdout:\n${stdoutStr}`);
    }
    const reportJson = JSON.parse(stdoutStr.substring(jsonStart));

    fs.mkdirSync(outputDir, { recursive: true });
    const reportPath = path.join(outputDir, 'frozen_v2_baseline_eval.json');
    fs.writeFileSync(reportPath, JSON.stringify(reportJson, null, 2), 'utf8');
    console.log(`✔ Baseline evaluation report persisted to: ${reportPath}`);
    console.log(`   Evaluated ${reportJson.aggregate.evaluatedTasks} tasks:`);
    console.log(`   NDCG@5:  ${reportJson.aggregate.ndcg5}`);
    console.log(`   NDCG@10: ${reportJson.aggregate.ndcg10}`);
    console.log(`   Recall@5:  ${reportJson.aggregate.recall5}`);
    console.log(`   Recall@10: ${reportJson.aggregate.recall10}`);
    console.log(`   MRR:     ${reportJson.aggregate.mrr}`);
    console.log(`   Mean Latency: ${reportJson.aggregate.meanLatencyMs}ms`);
    console.log(`   Mean Tokens:  ${reportJson.aggregate.meanContextTokens}`);

    return reportJson;
  } finally {
    console.log(`   Cleaning up worktree at ${tempDir}...`);
    try {
      execSync(`git -C "${rootDir}" worktree remove --force "${tempDir}"`, { stdio: 'pipe' });
    } catch (e) {
      // Force rm if worktree prune is needed
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        execSync(`git -C "${rootDir}" worktree prune`, { stdio: 'pipe' });
      } catch (err2) {}
    }
    console.log('✔ Worktree removed cleanly.');
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let maxTasks: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-tasks' && args[i + 1]) {
      maxTasks = parseInt(args[i + 1], 10);
    }
  }
  runFrozenV2Baseline({ maxTasks });
}
