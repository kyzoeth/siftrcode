#!/usr/bin/env node
/**
 * SiftrCode V3 - Verified Coding-Task Paired Evaluator (Phase V3.1G)
 *
 * Runs paired A/B evaluation (V2 vs V3) on actual coding tasks with verification.
 * Primary Endpoint: Cost Per Verified Successful Task (CPVST).
 *
 * Emits final V3.1 Promotion Decision:
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
import { SiftrBenchManifest } from '../../src/benchmark/siftrbench/episode_schema';
import { SplitManifest } from '../../src/benchmark/siftrbench/split_manager';
import { TreeRanker } from '../../src/learning/models/context_rank/tree_ranker';
import { SiftrContextDatasetV1, DatasetRowV1 } from '../../src/learning/datasets/siftr_dataset_v1';
import { resolveGeminiApiKey } from '../../src/learning/evaluation/gemini/gemini_config';
import { GeminiCodingAgent } from '../../src/learning/evaluation/gemini/gemini_agent';

export interface VerifiedEvalOptions {
  minTasks?: number;
  maxTasks?: number;
  taskFilter?: string;
  useRealAgent?: boolean;
  maxTurns?: number;
}

function createEphemeralWorkspace(repoId: string, baseCommit: string): { dir: string; cleanup: () => void } {
  const rootDir = path.resolve(__dirname, '../..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `siftr_eval_${repoId}_${Date.now()}_`));

  let sourceDir = rootDir;
  if (repoId === 'express') {
    sourceDir = path.join(rootDir, 'benchmarks/express-repo');
  } else if (repoId === 'fastapi') {
    sourceDir = path.join(rootDir, 'benchmarks/fastapi-repo');
  }

  try {
    execSync(`git -C "${sourceDir}" worktree add --detach "${tmp}" ${baseCommit} --quiet`);
  } catch (err) {
    throw new Error(`Failed to create worktree for ${repoId} at ${baseCommit}: ${err}`);
  }

  // Symlink dependencies to enable local test runners
  if (repoId === 'express') {
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

function formatInitialContext(bundle: DatasetRowV1[]): string {
  if (bundle.length === 0) return '(No candidate context units retrieved)';
  return bundle
    .map((c, idx) => {
      const p = c.unitPath || c.contextUnitId;
      const tok = c.features?.tokenEstimate || 100;
      return `[Candidate ${idx + 1}] File: ${p} | Unit: ${c.contextUnitId} (~${tok} tokens)\nHeuristic Score: ${c.preRankingScore}`;
    })
    .join('\n\n');
}

function resolveVerifierCommand(repoId: string, wsDir: string, ep: any): string {
  if (repoId === 'express') {
    const mochaBin = path.join(wsDir, 'node_modules/.bin/mocha');
    if (fs.existsSync(mochaBin)) {
      const candidates = (ep.expectedTargetPaths || [])
        .map((tp: string) => {
          const base = path.basename(tp, path.extname(tp));
          return path.join('test', `${base}.js`);
        })
        .filter((p: string) => fs.existsSync(path.join(wsDir, p)));
      if (candidates.length > 0) {
        return `./node_modules/.bin/mocha ${candidates.join(' ')}`;
      }
    }
    return 'npm test';
  } else if (repoId === 'fastapi') {
    const pytestBin = path.join(wsDir, 'venv/bin/pytest');
    if (fs.existsSync(pytestBin)) {
      const candidates = (ep.expectedTargetPaths || [])
        .map((tp: string) => {
          const base = path.basename(tp, path.extname(tp));
          return path.join('tests', `test_${base}.py`);
        })
        .filter((p: string) => fs.existsSync(path.join(wsDir, p)));
      if (candidates.length > 0) {
        return `./venv/bin/pytest -W ignore ${candidates.join(' ')}`;
      }
      return './venv/bin/pytest -W ignore';
    }
    return 'pytest';
  } else if (repoId === 'siftrcode') {
    return 'npm test';
  }
  return ep.verifier?.command || 'npm test';
}

export async function runVerifiedTaskEval(options: VerifiedEvalOptions = {}) {
  const rootDir = path.resolve(__dirname, '../..');
  const dataDir = path.join(rootDir, 'data');
  const resultsDir = path.join(rootDir, 'experiments/results/v3-verified-tasks');
  fs.mkdirSync(resultsDir, { recursive: true });

  console.log('⚖️  [Verified Task Evaluator] Initializing Paired A/B Evaluation...');
  const splitPath = path.join(dataDir, 'siftrbench_v1_splits.json');
  const manifestPath = path.join(dataDir, 'siftrbench_v1_manifest.json');
  const datasetPath = path.join(dataDir, 'siftr_dataset_v1.json');
  const gbdtArtifactPath = path.join(dataDir, 'models/gbdt_pairwise_v1.json');

  if (
    !fs.existsSync(splitPath) ||
    !fs.existsSync(manifestPath) ||
    !fs.existsSync(gbdtArtifactPath) ||
    !fs.existsSync(datasetPath)
  ) {
    throw new Error('Required manifests, datasets, or model artifacts missing.');
  }

  const manifest: SiftrBenchManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const splitManifest: SplitManifest = JSON.parse(fs.readFileSync(splitPath, 'utf8'));
  const dataset: SiftrContextDatasetV1 = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const gbdtArtifact = JSON.parse(fs.readFileSync(gbdtArtifactPath, 'utf8'));
  const ranker = TreeRanker.fromArtifact(gbdtArtifact);

  const testAssignments = splitManifest.assignments.filter((a) => a.split === 'test');
  let testEpisodes = manifest.episodes.filter((e) =>
    testAssignments.some((a) => a.episodeId === e.episodeId)
  );

  if (options.taskFilter) {
    testEpisodes = testEpisodes.filter(
      (e) =>
        e.episodeId.includes(options.taskFilter!) ||
        e.repositoryId.includes(options.taskFilter!) ||
        e.taskId.includes(options.taskFilter!)
    );
  }

  if (options.maxTasks && options.maxTasks > 0) {
    testEpisodes = testEpisodes.slice(0, options.maxTasks);
  }

  const rowsByEpisode = new Map<string, DatasetRowV1[]>();
  for (const r of dataset.rows) {
    if (!rowsByEpisode.has(r.episodeId)) rowsByEpisode.set(r.episodeId, []);
    rowsByEpisode.get(r.episodeId)!.push(r);
  }

  console.log(`   Evaluating ${testEpisodes.length} paired held-out tasks across repositories...`);

  const geminiApiKey = resolveGeminiApiKey();
  const hasAnthropicOrOpenAI = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  const hasCredentials = hasAnthropicOrOpenAI || !!geminiApiKey;
  const executeRealAgent = options.useRealAgent ?? hasCredentials;

  if (!hasCredentials) {
    console.log('\n⚠️  [Verified Task Evaluator] LLM agent credentials not found.');
    console.log('   INVARIANT ENFORCED: Real coding-agent executions and verifier runs cannot be simulated.');
    console.log('   Deriving verifiedSuccess from proxy target-presence or fabricating token/cost counts is strictly prohibited.');
    console.log('   Emitting honest gate status: V3.1_INSUFFICIENT_EVIDENCE (REAL_AGENT_EVALUATION_BLOCKED).\n');
  } else {
    console.log(`✔ Real coding-agent credentials active (Provider: Google Gemini / gemini-3.6-flash).`);
  }

  const pairedResults: PairedTaskEvaluation[] = [];
  let v2TargetCoveredCount = 0;
  let v3TargetCoveredCount = 0;

  for (let i = 0; i < testEpisodes.length; i++) {
    const ep = testEpisodes[i];
    const rows = rowsByEpisode.get(ep.episodeId) || [];
    const expectedTargetPaths = ep.expectedTargetPaths || [];
    console.log(`\n▶ [Task ${i + 1}/${testEpisodes.length}] ${ep.episodeId} (${ep.repositoryId})`);
    console.log(`   Prompt: "${ep.taskPrompt.slice(0, 80)}..."`);

    // --- V2 Frozen Deterministic Run ---
    const t0 = Date.now();
    const v2Candidates = rows.slice().sort((a, b) => {
      if (b.preRankingScore !== a.preRankingScore) return b.preRankingScore - a.preRankingScore;
      return a.contextUnitId.localeCompare(b.contextUnitId);
    });

    // Assemble V2 context bundle under 8,000 token limit
    let v2Tokens = 0;
    const v2Bundle: DatasetRowV1[] = [];
    for (const c of v2Candidates) {
      const tok = c.features.tokenEstimate || 100;
      if (v2Tokens + tok <= 8000) {
        v2Bundle.push(c);
        v2Tokens += tok;
      }
    }
    const v2Latency = Date.now() - t0;

    // Diagnostic Offline Metric: Target bundle presence
    const v2TargetFound =
      expectedTargetPaths.length > 0 &&
      expectedTargetPaths.every((tp) =>
        v2Bundle.some((c) => {
          const p = (c.unitPath || '').toLowerCase();
          return p.endsWith(tp.toLowerCase()) || p.includes(tp.toLowerCase());
        })
      );
    if (v2TargetFound) v2TargetCoveredCount++;

    // --- V3 Learned ContextRank Run ---
    const t1 = Date.now();
    const v3Candidates = rows.slice().map((r) => {
      const score = ranker.scoreVector(r.featureVector) * 10 + r.preRankingScore * 0.1;
      return { row: r, score };
    });
    v3Candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.row.contextUnitId.localeCompare(b.row.contextUnitId);
    });

    let v3Tokens = 0;
    const v3Bundle: DatasetRowV1[] = [];
    for (const c of v3Candidates) {
      const tok = c.row.features.tokenEstimate || 100;
      if (v3Tokens + tok <= 8000) {
        v3Bundle.push(c.row);
        v3Tokens += tok;
      }
    }
    const v3Latency = Date.now() - t1;

    // Diagnostic Offline Metric: Target bundle presence
    const v3TargetFound =
      expectedTargetPaths.length > 0 &&
      expectedTargetPaths.every((tp) =>
        v3Bundle.some((c) => {
          const p = (c.unitPath || '').toLowerCase();
          return p.endsWith(tp.toLowerCase()) || p.includes(tp.toLowerCase());
        })
      );
    if (v3TargetFound) v3TargetCoveredCount++;

    let v2Run: SingleTaskVerifiedRun;
    let v3Run: SingleTaskVerifiedRun;

    if (executeRealAgent) {
      const v2InitialContext = formatInitialContext(v2Bundle);
      const v3InitialContext = formatInitialContext(v3Bundle);

      // 1. Execute V2 Variant
      process.stdout.write('   Executing Variant V2_FROZEN...');
      const v2Ws = createEphemeralWorkspace(ep.repositoryId, ep.baseCommit);
      const v2VerifierCmd = resolveVerifierCommand(ep.repositoryId, v2Ws.dir, ep);
      let v2AgentRes: any;
      try {
        const agentV2 = new GeminiCodingAgent(v2Ws.dir, {
          configOverrides: { model: 'gemini-3.6-flash', maxTurns: options.maxTurns ?? 5 },
        });
        v2AgentRes = await agentV2.runTask(ep.taskPrompt, v2InitialContext, {
          taskVerifierCommand: v2VerifierCmd,
        });
      } finally {
        v2Ws.cleanup();
      }
      process.stdout.write(` Done (${v2AgentRes.verifiedSuccess ? 'PASS' : 'FAIL'}, $${v2AgentRes.providerCostUSD.toFixed(5)})\n`);

      v2Run = {
        taskId: ep.taskId,
        variant: 'V2_FROZEN',
        verifiedSuccess: v2AgentRes.verifiedSuccess,
        wallClockLatencyMs: v2AgentRes.wallClockLatencyMs,
        contextTokens: v2Tokens,
        agentInputTokens: v2AgentRes.totalPromptTokens,
        agentOutputTokens: v2AgentRes.totalCandidateTokens + v2AgentRes.totalThoughtsTokens,
        providerCostUSD: v2AgentRes.providerCostUSD,
        toolCalls: v2AgentRes.toolCallsCount,
        trajectoryLength: v2AgentRes.turns,
        verifierResult: v2AgentRes.verifierOutput?.slice(0, 500) || (v2AgentRes.verifiedSuccess ? 'PASS' : 'FAIL'),
      };

      // 2. Execute V3 Variant
      process.stdout.write('   Executing Variant V3_LEARNED...');
      const v3Ws = createEphemeralWorkspace(ep.repositoryId, ep.baseCommit);
      const v3VerifierCmd = resolveVerifierCommand(ep.repositoryId, v3Ws.dir, ep);
      let v3AgentRes: any;
      try {
        const agentV3 = new GeminiCodingAgent(v3Ws.dir, {
          configOverrides: { model: 'gemini-3.6-flash', maxTurns: options.maxTurns ?? 5 },
        });
        v3AgentRes = await agentV3.runTask(ep.taskPrompt, v3InitialContext, {
          taskVerifierCommand: v3VerifierCmd,
        });
      } finally {
        v3Ws.cleanup();
      }
      process.stdout.write(` Done (${v3AgentRes.verifiedSuccess ? 'PASS' : 'FAIL'}, $${v3AgentRes.providerCostUSD.toFixed(5)})\n`);

      v3Run = {
        taskId: ep.taskId,
        variant: 'V3_LEARNED',
        verifiedSuccess: v3AgentRes.verifiedSuccess,
        wallClockLatencyMs: v3AgentRes.wallClockLatencyMs,
        contextTokens: v3Tokens,
        agentInputTokens: v3AgentRes.totalPromptTokens,
        agentOutputTokens: v3AgentRes.totalCandidateTokens + v3AgentRes.totalThoughtsTokens,
        providerCostUSD: v3AgentRes.providerCostUSD,
        toolCalls: v3AgentRes.toolCallsCount,
        trajectoryLength: v3AgentRes.turns,
        verifierResult: v3AgentRes.verifierOutput?.slice(0, 500) || (v3AgentRes.verifiedSuccess ? 'PASS' : 'FAIL'),
      };
    } else {
      v2Run = {
        taskId: ep.taskId,
        variant: 'V2_FROZEN',
        verifiedSuccess: null,
        wallClockLatencyMs: v2Latency,
        contextTokens: v2Tokens,
        agentInputTokens: 0,
        agentOutputTokens: 0,
        providerCostUSD: 0,
        toolCalls: 0,
        trajectoryLength: 0,
        verifierResult: 'UNAVAILABLE (missing credentials)',
      };

      v3Run = {
        taskId: ep.taskId,
        variant: 'V3_LEARNED',
        verifiedSuccess: null,
        wallClockLatencyMs: v3Latency,
        contextTokens: v3Tokens,
        agentInputTokens: 0,
        agentOutputTokens: 0,
        providerCostUSD: 0,
        toolCalls: 0,
        trajectoryLength: 0,
        verifierResult: 'UNAVAILABLE (missing credentials)',
      };
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
      costDeltaUSD: Number((v3Run.providerCostUSD - v2Run.providerCostUSD).toFixed(5)),
      latencyDeltaMs: v3Run.wallClockLatencyMs - v2Run.wallClockLatencyMs,
    });
  }

  const v2CoverageRate = Number((v2TargetCoveredCount / testEpisodes.length).toFixed(4));
  const v3CoverageRate = Number((v3TargetCoveredCount / testEpisodes.length).toFixed(4));

  const proxyOfflineMetrics = {
    totalTasks: testEpisodes.length,
    v2TargetBundleSuccessRate: v2CoverageRate,
    v3TargetBundleSuccessRate: v3CoverageRate,
    delta: Number((v3CoverageRate - v2CoverageRate).toFixed(4)),
    modeledCostPerTargetCoveredTaskV2USD: Number((v2CoverageRate > 0 ? 0.035 / v2CoverageRate : 0).toFixed(4)),
    modeledCostPerTargetCoveredTaskV3USD: Number((v3CoverageRate > 0 ? 0.032 / v3CoverageRate : 0).toFixed(4)),
  };

  const report = VerifiedTaskEvaluator.evaluatePairedExperiment(pairedResults, {
    minTasksForPromotion: options.minTasks ?? 30,
    minSuccessDelta: 0.0,
    blockedReason: !hasCredentials
      ? 'REAL_AGENT_EVALUATION_BLOCKED: Missing real agent credentials (GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY).'
      : undefined,
    missingDependencies: !hasCredentials ? ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] : undefined,
    proxyOfflineMetrics,
  });

  console.log('\n🏁 Paired Verified Coding-Task Evaluation Report:');
  console.log(`   Gate Decision:            [ ${report.gateDecision} ]`);
  console.log(`   Decision Rationale:       ${report.decisionRationale}`);
  if (report.blockReason) {
    console.log(`   Blocked Reason:           ${report.blockReason}`);
  }
  console.log(`   V2 Verified Success Rate: ${(report.v2Summary.successRate * 100).toFixed(1)}% (${report.v2Summary.successfulTasks}/${report.v2Summary.evaluatedTasks})`);
  console.log(`   V3 Verified Success Rate: ${(report.v3Summary.successRate * 100).toFixed(1)}% (${report.v3Summary.successfulTasks}/${report.v3Summary.evaluatedTasks})`);
  console.log(`   V2 Mean Context Tokens:   ${report.v2Summary.meanContextTokensPerTask}`);
  console.log(`   V3 Mean Context Tokens:   ${report.v3Summary.meanContextTokensPerTask}`);
  console.log(`   V2 Total Provider Cost:   $${report.v2Summary.totalCostUSD.toFixed(4)}`);
  console.log(`   V3 Total Provider Cost:   $${report.v3Summary.totalCostUSD.toFixed(4)}`);
  console.log(`   V2 CPVST:                 ${report.v2Summary.cpvstUSD ? '$' + report.v2Summary.cpvstUSD.toFixed(4) : 'null'}`);
  console.log(`   V3 CPVST:                 ${report.v3Summary.cpvstUSD ? '$' + report.v3Summary.cpvstUSD.toFixed(4) : 'null'}`);

  console.log('\n📈 Diagnostic Offline Target-Bundle Metrics:');
  console.log(`   V2 Target Bundle Coverage: ${(proxyOfflineMetrics.v2TargetBundleSuccessRate * 100).toFixed(1)}% (${v2TargetCoveredCount}/${testEpisodes.length})`);
  console.log(`   V3 Target Bundle Coverage: ${(proxyOfflineMetrics.v3TargetBundleSuccessRate * 100).toFixed(1)}% (${v3TargetCoveredCount}/${testEpisodes.length})`);
  console.log(`   Target Bundle Delta:       ${proxyOfflineMetrics.delta >= 0 ? '+' : ''}${(proxyOfflineMetrics.delta * 100).toFixed(1)}%`);

  const reportPath = path.join(resultsDir, 'paired_verified_eval_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n✔ Report persisted to: ${reportPath}`);

  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts: VerifiedEvalOptions = {};
  for (const a of args) {
    if (a.startsWith('--limit=')) opts.maxTasks = parseInt(a.split('=')[1], 10);
    if (a.startsWith('--filter=')) opts.taskFilter = a.split('=')[1];
    if (a.startsWith('--min-tasks=')) opts.minTasks = parseInt(a.split('=')[1], 10);
    if (a.startsWith('--max-turns=')) opts.maxTurns = parseInt(a.split('=')[1], 10);
  }
  runVerifiedTaskEval(opts).catch((err) => {
    console.error('Fatal error during verified task eval:', err);
    process.exit(1);
  });
}
