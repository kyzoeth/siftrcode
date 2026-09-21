#!/usr/bin/env node
/**
 * SiftrCode V3.1 - Verified Coding-Task Paired Evaluator (Phase 12)
 *
 * Evaluates frozen deterministic V2 vs learned ContextRank V3 on the genuinely
 * fresh, untouched 34-task holdout using real Gemini coding-agent execution:
 * - Real code context materialized (not just filenames) without target labels
 * - Randomize A/B ordering (V2 first vs V3 first) with recorded seed
 * - Sandboxed execution with isolated HOME/TMPDIR, disabled network, command inspection
 * - Fail-closed official Google GenAI pricing ($0.10/M prompt, $0.40/M candidate/thoughts)
 * - Tri-state verification (true | false | null)
 * - Emits experiments/v3-1-final/paired_gemini_report.json
 *
 * Gate Decision:
 * - V3.1_PROMOTION_GATE_PASSED
 * - V3.1_FAILED_TO_BEAT_BASELINE
 * - V3.1_INSUFFICIENT_EVIDENCE
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  VerifiedTaskEvaluator,
  PairedTaskEvaluation,
  SingleTaskVerifiedRun,
} from '../../src/learning/evaluation/verified_task_evaluator';
import { SiftrBenchManifest, SiftrBenchEpisode } from '../../src/benchmark/siftrbench/episode_schema';
import { RepositoryIndexer } from '../../src/indexing/repository_index';
import { GraphBuilder } from '../../src/graph/graph_builder';
import { GitGraphIntelligence } from '../../src/graph/git_graph';
import { CandidateGenerator } from '../../src/retrieval/candidate_generator';
import { createTaskContext } from '../../src/context/task_context';
import { createAgentEnvironment } from '../../src/agents/agent_environment';
import { FeatureBuilderV3_1 } from '../../src/learning/features/feature_builder_v3_1';
import { ContextFeaturesV3_1, featuresToVector } from '../../src/learning/features/feature_set_v3_1';
import { ContextFeaturesV1 } from '../../src/ranking/feature_schema';
import { ContextRanker } from '../../src/ranking/context_rank';
import { TreeRanker } from '../../src/learning/models/context_rank/tree_ranker';
import { ContextUnit } from '../../src/context/context_unit';
import { resolveGeminiApiKey } from '../../src/learning/evaluation/gemini/gemini_config';
import { GeminiCodingAgent } from '../../src/learning/evaluation/gemini/gemini_agent';

export interface VerifiedEvalOptions {
  minTasks?: number;
  maxTasks?: number;
  taskFilter?: string;
  useRealAgent?: boolean;
  maxTurns?: number;
  seed?: number;
  manifestPath?: string;
}

function createEphemeralWorkspace(repoId: string, baseCommit: string): { dir: string; cleanup: () => void } {
  const rootDir = path.resolve(__dirname, '../..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `siftr_eval_${repoId}_${Date.now()}_`));

  let sourceDir = rootDir;
  if (repoId === 'express') {
    sourceDir = path.join(rootDir, 'benchmarks/express-repo');
  } else if (repoId === 'fastapi') {
    sourceDir = path.join(rootDir, 'benchmarks/fastapi-repo');
  } else if (repoId === 'commander') {
    sourceDir = path.join(rootDir, 'benchmarks/commander-repo');
  }

  try {
    execSync(`git -C "${sourceDir}" worktree add --detach "${tmp}" ${baseCommit} --quiet`);
  } catch (err) {
    throw new Error(`Failed to create worktree for ${repoId} at ${baseCommit}: ${err}`);
  }

  // Symlink dependencies to enable local test runners & modules
  if (repoId === 'express' || repoId === 'commander') {
    const nm = path.join(sourceDir, 'node_modules');
    if (fs.existsSync(nm)) {
      try {
        fs.symlinkSync(nm, path.join(tmp, 'node_modules'), 'dir');
      } catch {}
    }
  } else if (repoId === 'fastapi') {
    const venv = path.join(sourceDir, 'venv');
    if (fs.existsSync(venv)) {
      try {
        fs.symlinkSync(venv, path.join(tmp, 'venv'), 'dir');
      } catch {}
    }
  } else if (repoId === 'siftrcode') {
    const nm = path.join(rootDir, 'node_modules');
    if (fs.existsSync(nm)) {
      try {
        fs.symlinkSync(nm, path.join(tmp, 'node_modules'), 'dir');
      } catch {}
    }
    const dist = path.join(rootDir, 'dist');
    if (fs.existsSync(dist)) {
      try {
        execSync(`cp -r "${dist}" "${path.join(tmp, 'dist')}"`);
      } catch {}
    }
  }

  return {
    dir: tmp,
    cleanup: () => {
      try {
        execSync(`git -C "${sourceDir}" worktree remove --force "${tmp}" --quiet`, { stdio: 'pipe' });
      } catch {}
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    },
  };
}

/**
 * Materializes real code context from repository units up to token budget.
 * Invariant: Never contains ground-truth target annotations or relevance labels.
 */
function formatMaterializedContext(
  repoRoot: string,
  units: Array<{ path?: string }>,
  maxTokens: number = 8000
): string {
  if (units.length === 0) return '(No initial context retrieved)';
  const parts: string[] = [];
  let tokenSum = 0;

  for (const u of units) {
    if (!u.path) continue;
    const fullPath = path.join(repoRoot, u.path);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      let truncated = content;
      if (lines.length > 400) {
        truncated = lines.slice(0, 400).join('\n') + '\n// ... [truncated for context budget]';
      }
      const approxTokens = Math.ceil(truncated.length / 4);
      if (tokenSum + approxTokens > maxTokens && parts.length > 0) {
        break;
      }
      parts.push(`--- File: ${u.path} ---\n${truncated}`);
      tokenSum += approxTokens;
    } catch {}
  }

  return parts.join('\n\n');
}

function resolveVerifierCommand(repoId: string, verifierFilename: string): string {
  if (repoId === 'fastapi') {
    return `./venv/bin/python ${verifierFilename}`;
  } else if (repoId === 'siftrcode') {
    return `npx tsc --skipLibCheck && node ${verifierFilename}`;
  }
  return `node ${verifierFilename}`;
}

async function runSingleVariant(
  variant: 'V2_FROZEN' | 'V3_LEARNED',
  ep: SiftrBenchEpisode,
  materializedContext: string,
  contextTokens: number,
  options: { maxTurns?: number; executeRealAgent: boolean }
): Promise<SingleTaskVerifiedRun> {
  const rootDir = path.resolve(__dirname, '../..');

  if (!options.executeRealAgent) {
    return {
      taskId: ep.taskId,
      variant,
      runValidity: 'VERIFIER_UNAVAILABLE',
      verifiedSuccess: null,
      wallClockLatencyMs: 0,
      contextTokens,
      agentInputTokens: 0,
      agentOutputTokens: 0,
      providerCostUSD: 0,
      costStatus: 'VALID',
      toolCalls: 0,
      trajectoryLength: 0,
      verifierResult: 'UNAVAILABLE (missing credentials)',
    };
  }

  const verifierFilename = String((ep.verifier?.metadata as any)?.verifierFilename || '');
  if (!verifierFilename) {
    throw new Error(`Verifier filename missing in episode metadata: ${ep.taskId}`);
  }

  const ws = createEphemeralWorkspace(ep.repositoryId, ep.baseCommit);

  try {
    // Copy the verifier file into the ephemeral workspace
    const verifierSrc = path.join(rootDir, 'benchmarks/verifiers/final_holdout', verifierFilename);
    const verifierDst = path.join(ws.dir, verifierFilename);
    if (!fs.existsSync(verifierSrc)) {
      throw new Error(`Verifier file missing at ${verifierSrc}`);
    }
    fs.copyFileSync(verifierSrc, verifierDst);

    const verifierCmd = resolveVerifierCommand(ep.repositoryId, verifierFilename);

    const agent = new GeminiCodingAgent(ws.dir, {
      configOverrides: { model: 'gemini-3.6-flash', maxTurns: options.maxTurns ?? 5 },
    });

    const agentRes = await agent.runTask(ep.taskPrompt, materializedContext, {
      taskVerifierCommand: verifierCmd,
    });

    return {
      taskId: ep.taskId,
      variant,
      runValidity: agentRes.runValidity,
      verifiedSuccess: agentRes.verifiedSuccess,
      wallClockLatencyMs: agentRes.wallClockLatencyMs,
      contextTokens,
      agentInputTokens: agentRes.totalPromptTokens,
      agentOutputTokens: agentRes.totalCandidateTokens + agentRes.totalThoughtsTokens,
      providerCostUSD: agentRes.providerCostUSD,
      costStatus: agentRes.costStatus,
      toolCalls: agentRes.toolCallsCount,
      trajectoryLength: agentRes.turns,
      verifierResult: agentRes.verifierOutput?.slice(0, 500) || (agentRes.verifiedSuccess ? 'PASS' : 'FAIL'),
    };
  } finally {
    ws.cleanup();
  }
}

export async function runVerifiedTaskEval(options: VerifiedEvalOptions = {}) {
  const rootDir = path.resolve(__dirname, '../..');
  const dataDir = path.join(rootDir, 'data');
  const finalExpDir = path.join(rootDir, 'experiments/v3-1-final');
  const legacyResultsDir = path.join(rootDir, 'experiments/results/v3-verified-tasks');
  fs.mkdirSync(finalExpDir, { recursive: true });
  fs.mkdirSync(legacyResultsDir, { recursive: true });

  const manifestPath = options.manifestPath || path.join(dataDir, 'siftrbench_v3_1_final_holdout.json');
  const gbdtArtifactPath = path.join(dataDir, 'models/gbdt_pairwise_v1.json');

  console.log('⚖️  [Verified Task Evaluator] Initializing Paired A/B Evaluation (V2 vs V3)...');
  console.log(`   Manifest: ${path.basename(manifestPath)}`);
  console.log(`   Model:    gemini-3.6-flash`);

  if (!fs.existsSync(manifestPath) || !fs.existsSync(gbdtArtifactPath)) {
    throw new Error('Required holdout manifest or model artifacts missing.');
  }

  const manifest: SiftrBenchManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const gbdtArtifact = JSON.parse(fs.readFileSync(gbdtArtifactPath, 'utf8'));
  const v3TreeRanker = TreeRanker.fromArtifact(gbdtArtifact);
  const v2DeterministicRanker = new ContextRanker();

  let episodes = manifest.episodes;
  if (options.taskFilter) {
    episodes = episodes.filter(
      (e) =>
        e.episodeId.includes(options.taskFilter!) ||
        e.repositoryId.includes(options.taskFilter!) ||
        e.taskId.includes(options.taskFilter!)
    );
  }

  if (options.maxTasks && options.maxTasks > 0) {
    episodes = episodes.slice(0, options.maxTasks);
  }

  const geminiApiKey = resolveGeminiApiKey();
  const hasCredentials = !!geminiApiKey;
  const executeRealAgent = options.useRealAgent ?? hasCredentials;

  if (!hasCredentials) {
    console.log('\n⚠️  [Verified Task Evaluator] LLM agent credentials not found.');
    console.log('   INVARIANT ENFORCED: Real coding-agent executions and verifier runs cannot be simulated.');
    console.log('   Deriving verifiedSuccess from proxy target-presence or fabricating token/cost counts is strictly prohibited.');
    console.log('   Emitting honest gate status: V3.1_INSUFFICIENT_EVIDENCE (REAL_AGENT_EVALUATION_BLOCKED).\n');
  } else {
    console.log(`✔ Real coding-agent credentials active (Provider: Google Gemini / gemini-3.6-flash).`);
  }

  // 1. Index repositories for candidate retrieval and feature extraction
  console.log('\n📚 Indexing benchmark repositories...');
  const repoPaths: Record<string, string> = {
    express: path.join(rootDir, 'benchmarks/express-repo'),
    fastapi: path.join(rootDir, 'benchmarks/fastapi-repo'),
    commander: path.join(rootDir, 'benchmarks/commander-repo'),
    siftrcode: rootDir,
  };

  const repoFilters: Record<string, any> = {
    express: {},
    fastapi: { includePatterns: ['fastapi/**'], excludePatterns: ['**/tests/**', '**/docs/**'] },
    commander: { includePatterns: ['lib/**'], excludePatterns: ['**/tests/**'] },
    siftrcode: { includePatterns: ['src/**'], excludePatterns: ['**/node_modules/**', '**/dist/**', '**/benchmarks/**'] },
  };

  const indexes: Record<string, { units: ContextUnit[]; graph: any; gitInt?: GitGraphIntelligence }> = {};
  for (const [repoKey, rPath] of Object.entries(repoPaths)) {
    if (fs.existsSync(rPath)) {
      process.stdout.write(`   Indexing ${repoKey}... `);
      const indexer = new RepositoryIndexer();
      const idx = await indexer.indexRepository(rPath, repoFilters[repoKey]);
      const gb = new GraphBuilder();
      const graph = gb.buildGraph(idx.units, { repoDir: rPath });
      let gitInt: GitGraphIntelligence | undefined;
      try {
        gitInt = new GitGraphIntelligence({ repoDir: rPath });
      } catch {}
      indexes[repoKey] = { units: idx.units, graph, gitInt };
      console.log(`done (${idx.units.length} units)`);
    }
  }

  // 2. Evaluate all paired tasks
  const candGen = new CandidateGenerator();
  const pairedResults: PairedTaskEvaluation[] = [];
  const orderSeed = options.seed ?? 42;
  console.log(`\n🎲 A/B Randomization Seed: ${orderSeed}`);
  console.log(`🔬 Executing ${episodes.length} paired tasks with GeminiCodingAgent...`);

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const repoKey = ep.repositoryId;
    const repoData = indexes[repoKey];
    if (!repoData) {
      throw new Error(`Repository index not available for: ${repoKey}`);
    }

    console.log(`\n▶ [Task ${i + 1}/${episodes.length}] ${ep.taskId} (${ep.repositoryId})`);
    console.log(`   Prompt: "${ep.taskPrompt.slice(0, 85)}..."`);

    // A. Generate Candidates & Features
    const taskCtx = createTaskContext({
      taskId: ep.taskId,
      primaryPrompt: ep.taskPrompt,
      workspaceSnapshotId: ep.workspaceSnapshotId,
      agentEnvironment: createAgentEnvironment({
        agentProvider: 'google',
        model: 'gemini-3.6-flash',
        harnessVersion: 'v3.1.0',
      }),
    });

    const candidates = candGen.generateCandidates(
      taskCtx,
      repoData.units,
      repoData.graph,
      repoData.gitInt,
      { maxCandidates: 50 }
    );

    const unitMap = new Map<string, ContextUnit>();
    for (const u of repoData.units) unitMap.set(u.id, u);

    const validCandidatePairs: Array<{ cand: any; unit: ContextUnit; features: ContextFeaturesV3_1 }> = [];
    for (const c of candidates) {
      const u = unitMap.get(c.contextUnitId);
      if (!u) continue;
      const f = FeatureBuilderV3_1.buildFeatures({
        candidate: c,
        unit: u,
        task: taskCtx,
        graph: repoData.graph,
        gitIntelligence: repoData.gitInt,
      });
      validCandidatePairs.push({ cand: c, unit: u, features: f });
    }

    // B. V2 Frozen Deterministic Ranking
    const v1Features: ContextFeaturesV1[] = validCandidatePairs.map(({ features: f }) => ({
      schemaVersion: 'v1',
      contextUnitId: f.contextUnitId,
      unitKind: f.unitKind,
      tokenEstimate: f.tokenEstimate,
      isTest: f.isTest,
      isConfig: f.isConfig,
      isDocumentation: f.isDocumentation,
      isSchema: f.isSchema,
      isExported: f.isExported,
      exactSymbolMatch: f.exactSymbolMatch,
      exactPathMatch: f.exactPathMatch,
      bm25Score: f.bm25Score,
      tokenOverlapRatio: f.tokenOverlapRatio,
      graphDegree: f.graphDegree,
      minDistanceToSeed: f.minDistanceToSeed,
      minDistanceToErrorFrame: f.minDistanceToErrorFrame,
      isDirectDependency: f.isDirectDependency,
      isDirectDependent: f.isDirectDependent,
      changeFrequency: f.changeFrequency,
      recentChangeFrequency: f.recentChangeFrequency,
      maxCoChangeWithSeeds: f.maxCoChangeWithSeeds,
      inStackTrace: f.inStackTrace,
      isFailingTestTarget: f.isFailingTestTarget,
      inCompilerError: f.inCompilerError,
      inDirtyDiff: f.inDirtyDiff,
      heuristicScore: f.heuristicScore,
    }));

    const v2Ranked = v2DeterministicRanker.rank(v1Features);
    const v2Units: ContextUnit[] = [];
    let v2Tokens = 0;
    for (const r of v2Ranked) {
      const pair = validCandidatePairs.find((p) => p.cand.contextUnitId === r.contextUnitId);
      if (!pair) continue;
      const tok = r.features.tokenEstimate || 100;
      if (v2Tokens + tok <= 8000) {
        v2Units.push(pair.unit);
        v2Tokens += tok;
      }
    }

    // C. V3 Learned GBDT Ranking
    const v3Scored = validCandidatePairs.map(({ cand, unit, features: f }) => {
      const vec = featuresToVector(f, true);
      const rawScore = v3TreeRanker.scoreVector(vec);
      const score = rawScore * 10.0 + f.heuristicScore * 0.1;
      return {
        unit,
        score,
        tokenEstimate: f.tokenEstimate || 100,
      };
    });

    v3Scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.unit.id.localeCompare(b.unit.id);
    });

    const v3Units: ContextUnit[] = [];
    let v3Tokens = 0;
    for (const s of v3Scored) {
      if (v3Tokens + s.tokenEstimate <= 8000) {
        v3Units.push(s.unit);
        v3Tokens += s.tokenEstimate;
      }
    }

    // Materialize real code content without target labels
    const repoDir = repoPaths[repoKey];
    const v2Context = formatMaterializedContext(repoDir, v2Units, 8000);
    const v3Context = formatMaterializedContext(repoDir, v3Units, 8000);

    // Randomize A/B order
    const runV2First = ((orderSeed * 37 + i * 17 + 101) % 2 === 0);
    const order: Array<'V2_FROZEN' | 'V3_LEARNED'> = runV2First
      ? ['V2_FROZEN', 'V3_LEARNED']
      : ['V3_LEARNED', 'V2_FROZEN'];

    console.log(`   Order: [ ${order.join(' -> ')} ]`);

    let v2Run: SingleTaskVerifiedRun | null = null;
    let v3Run: SingleTaskVerifiedRun | null = null;

    for (const variant of order) {
      if (variant === 'V2_FROZEN') {
        process.stdout.write(`   Executing ${variant}... `);
        v2Run = await runSingleVariant(
          'V2_FROZEN',
          ep,
          v2Context,
          v2Tokens,
          { maxTurns: options.maxTurns, executeRealAgent }
        );
        const resLabel = v2Run.verifiedSuccess === true ? 'PASS 🟢' : v2Run.verifiedSuccess === false ? 'FAIL 🔴' : 'NULL ⚪';
        console.log(`Done (${resLabel}, $${(v2Run.providerCostUSD ?? 0).toFixed(5)}, ${v2Run.wallClockLatencyMs}ms)`);
      } else {
        process.stdout.write(`   Executing ${variant}... `);
        v3Run = await runSingleVariant(
          'V3_LEARNED',
          ep,
          v3Context,
          v3Tokens,
          { maxTurns: options.maxTurns, executeRealAgent }
        );
        const resLabel = v3Run.verifiedSuccess === true ? 'PASS 🟢' : v3Run.verifiedSuccess === false ? 'FAIL 🔴' : 'NULL ⚪';
        console.log(`Done (${resLabel}, $${(v3Run.providerCostUSD ?? 0).toFixed(5)}, ${v3Run.wallClockLatencyMs}ms)`);
      }
    }

    if (!v2Run || !v3Run) {
      throw new Error(`Variant run failure for task: ${ep.taskId}`);
    }

    let successDelta = 0;
    if (v3Run.verifiedSuccess === true && v2Run.verifiedSuccess !== true) successDelta = 1;
    else if (v2Run.verifiedSuccess === true && v3Run.verifiedSuccess !== true) successDelta = -1;

    pairedResults.push({
      taskId: ep.taskId,
      repo: ep.repositoryId,
      v2: v2Run,
      v3: v3Run,
      successDelta,
      tokenDelta: v3Tokens - v2Tokens,
      costDeltaUSD: Number(((v3Run.providerCostUSD || 0) - (v2Run.providerCostUSD || 0)).toFixed(5)),
      latencyDeltaMs: v3Run.wallClockLatencyMs - v2Run.wallClockLatencyMs,
    });
  }

  // 3. Final Report & Decision
  const report = VerifiedTaskEvaluator.evaluatePairedExperiment(pairedResults, {
    minTasksForPromotion: options.minTasks ?? 30,
    minSuccessDelta: 0.0,
    blockedReason: !hasCredentials
      ? 'REAL_AGENT_EVALUATION_BLOCKED: Missing real agent credentials (GEMINI_API_KEY).'
      : undefined,
    missingDependencies: !hasCredentials ? ['GEMINI_API_KEY'] : undefined,
  });

  const fullReport = {
    ...report,
    meta: {
      model: 'gemini-3.6-flash',
      randomizationSeed: orderSeed,
      totalHoldoutTasks: episodes.length,
      evaluatedAt: new Date().toISOString(),
    },
  };

  const finalPath = path.join(finalExpDir, 'paired_gemini_report.json');
  const legacyPath = path.join(legacyResultsDir, 'paired_verified_eval_report.json');

  fs.writeFileSync(finalPath, JSON.stringify(fullReport, null, 2), 'utf8');
  fs.writeFileSync(legacyPath, JSON.stringify(fullReport, null, 2), 'utf8');

  console.log('\n🏁 ================= FINAL PAIRED GEMINI EVALUATION REPORT =================');
  console.log(`   Gate Decision:            [ ${report.gateDecision} ]`);
  console.log(`   Decision Rationale:       ${report.decisionRationale}`);
  if (report.blockReason) {
    console.log(`   Blocked Reason:           ${report.blockReason}`);
  }
  console.log('   -------------------------------------------------------------------------');
  console.log(`   Metric                    Frozen V2          Learned V3          Delta`);
  console.log(`   Verified Success Rate:    ${(report.v2Summary.successRate * 100).toFixed(1)}% (${report.v2Summary.successfulTasks}/${report.v2Summary.evaluatedTasks})       ${(report.v3Summary.successRate * 100).toFixed(1)}% (${report.v3Summary.successfulTasks}/${report.v3Summary.evaluatedTasks})       ${report.pairedDeltas.successRateDelta >= 0 ? '+' : ''}${(report.pairedDeltas.successRateDelta * 100).toFixed(1)}%`);
  console.log(`   Mean Context Tokens:      ${report.v2Summary.meanContextTokensPerTask}              ${report.v3Summary.meanContextTokensPerTask}              ${report.pairedDeltas.meanTokenDelta >= 0 ? '+' : ''}${report.pairedDeltas.meanTokenDelta}`);
  console.log(`   Total Provider Cost:      $${report.v2Summary.totalCostUSD.toFixed(4)}            $${report.v3Summary.totalCostUSD.toFixed(4)}            ${report.pairedDeltas.meanCostDeltaUSD >= 0 ? '+' : ''}$${(report.v3Summary.totalCostUSD - report.v2Summary.totalCostUSD).toFixed(4)}`);
  console.log(`   CPVST:                    ${report.v2Summary.cpvstUSD ? '$' + report.v2Summary.cpvstUSD.toFixed(4) : 'null'}            ${report.v3Summary.cpvstUSD ? '$' + report.v3Summary.cpvstUSD.toFixed(4) : 'null'}            ${report.pairedDeltas.cpvstDeltaUSD !== null ? (report.pairedDeltas.cpvstDeltaUSD >= 0 ? '+' : '') + '$' + report.pairedDeltas.cpvstDeltaUSD.toFixed(4) : 'N/A'}`);
  console.log('   -------------------------------------------------------------------------');
  console.log(`   Task Outcomes:            ${report.pairedDeltas.v3Wins} V3 wins, ${report.pairedDeltas.ties} ties, ${report.pairedDeltas.v2Wins} V2 wins`);
  if (report.pairedDeltas.mcNemar) {
    console.log(`   McNemar Exact Test:       ${report.pairedDeltas.mcNemar.summary}`);
  }
  console.log('   =========================================================================');
  console.log(`✔ Report persisted to: ${finalPath}`);

  return fullReport;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts: VerifiedEvalOptions = {};
  for (const a of args) {
    if (a.startsWith('--limit=')) opts.maxTasks = parseInt(a.split('=')[1], 10);
    if (a.startsWith('--filter=')) opts.taskFilter = a.split('=')[1];
    if (a.startsWith('--min-tasks=')) opts.minTasks = parseInt(a.split('=')[1], 10);
    if (a.startsWith('--max-turns=')) opts.maxTurns = parseInt(a.split('=')[1], 10);
    if (a.startsWith('--seed=')) opts.seed = parseInt(a.split('=')[1], 10);
    if (a.startsWith('--manifest=')) opts.manifestPath = a.split('=')[1];
  }
  runVerifiedTaskEval(opts).catch((err) => {
    console.error('Fatal error during verified task eval:', err);
    process.exit(1);
  });
}
