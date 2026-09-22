#!/usr/bin/env node
/**
 * SiftrCode V3.1 - Verified Coding-Task Paired Evaluator (Phase 12)
 *
 * Evaluates frozen deterministic V2 vs learned ContextRank V3 on the genuinely
 * fresh natural 40-task holdout using real Gemini coding-agent execution:
 * - True end-to-end FrozenV2ContextProvider (authoritative V2 baseline @ 1eedac0, fail-closed)
 * - True end-to-end LearnedV3ContextProvider (real materializer & bundle composer)
 * - Both context bundles generated from each exact episode.baseCommit
 * - Randomize A/B ordering (V2 first vs V3 first) with recorded seed
 * - Sandboxed execution with isolated HOME/TMPDIR, disabled network, command inspection
 * - Fail-closed official Google GenAI pricing ($0.75/M prompt, $3.75/M candidate/thoughts)
 * - Tri-state verification (true | false | null)
 * - Emits experiments/v3-1-final-natural/paired_gemini_report.json
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
import { TreeRanker } from '../../src/learning/models/context_rank/tree_ranker';
import { resolveGeminiApiKey } from '../../src/learning/evaluation/gemini/gemini_config';
import { GeminiCodingAgent } from '../../src/learning/evaluation/gemini/gemini_agent';
import {
  FrozenV2ContextProvider,
  LearnedV3ContextProvider,
  ContextBundleResult,
} from '../../src/learning/evaluation/context_providers';

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
    const dotVenv = path.join(sourceDir, '.venv');
    if (fs.existsSync(dotVenv)) {
      try {
        fs.symlinkSync(dotVenv, path.join(tmp, '.venv'), 'dir');
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

function resolveVerifierCommand(repoId: string, verifierFilename: string): string {
  if (repoId === 'fastapi') {
    return `[ -f .venv/bin/python ] && .venv/bin/python "${verifierFilename}" || ./venv/bin/python "${verifierFilename}"`;
  } else if (repoId === 'siftrcode') {
    return `npm run build && node "${verifierFilename}"`;
  }
  return `node "${verifierFilename}"`;
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

  const verifierFilename = String(
    (ep as any).verifierFilename ||
    (ep.verifier?.metadata as any)?.verifierFilename ||
    ''
  );
  if (!verifierFilename) {
    throw new Error(`Verifier filename missing in episode metadata: ${ep.taskId}`);
  }

  const ws = createEphemeralWorkspace(ep.repositoryId, ep.baseCommit);

  try {
    // Copy the verifier file into the ephemeral workspace
    let verifierSrc = path.join(rootDir, 'benchmarks/verifiers/final_natural', verifierFilename);
    if (!fs.existsSync(verifierSrc)) {
      verifierSrc = path.join(rootDir, 'benchmarks/verifiers/final_holdout', verifierFilename);
    }
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
  const finalExpDir = path.join(rootDir, 'experiments/v3-1-final-natural');
  const legacyResultsDir = path.join(rootDir, 'experiments/results/v3-verified-tasks');
  fs.mkdirSync(finalExpDir, { recursive: true });
  fs.mkdirSync(legacyResultsDir, { recursive: true });

  const manifestPath = options.manifestPath || path.join(finalExpDir, 'natural_holdout_manifest.json');
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

  // Fail-closed verification and loading of frozen authoritative V2 ContextProvider (NO fallback)
  console.log('🏛️  [Verified Task Evaluator] Loading frozen authoritative V2 ContextProvider (.v2-baseline-worktree @ 1eedac0)...');
  const v2Provider = new FrozenV2ContextProvider();
  console.log('✔ Frozen authoritative V2 ContextProvider loaded successfully (fail-closed verified).');

  // Loading of real V3 ContextProvider (GBDT TreeRanker + real materializer / bundle composer)
  console.log('🌲 [Verified Task Evaluator] Loading learned V3 ContextProvider (GBDT TreeRanker adapter)...');
  const v3Provider = new LearnedV3ContextProvider(v3TreeRanker);
  console.log('✔ Learned V3 ContextProvider loaded successfully.');

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

  // Paired task evaluation loop
  const pairedResults: PairedTaskEvaluation[] = [];
  const orderSeed = options.seed ?? 42;
  console.log(`\n🎲 A/B Randomization Seed: ${orderSeed}`);
  console.log(`🔬 Executing ${episodes.length} paired tasks with GeminiCodingAgent...`);

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    console.log(`\n▶ [Task ${i + 1}/${episodes.length}] ${ep.taskId} (${ep.repositoryId})`);
    console.log(`   Base Commit: ${ep.baseCommit}`);
    console.log(`   Prompt: "${ep.taskPrompt.slice(0, 85)}..."`);

    // Generate both context bundles from each exact episode.baseCommit using real providers
    process.stdout.write('   Generating V2 & V3 context bundles from exact baseCommit... ');
    const prepWs = createEphemeralWorkspace(ep.repositoryId, ep.baseCommit);
    let v2Bundle: ContextBundleResult;
    let v3Bundle: ContextBundleResult;
    try {
      v2Bundle = await v2Provider.getContext({
        workspaceDir: prepWs.dir,
        prompt: ep.taskPrompt,
        tokenBudget: 8000,
        repoId: ep.repositoryId,
      });

      v3Bundle = await v3Provider.getContext({
        workspaceDir: prepWs.dir,
        prompt: ep.taskPrompt,
        tokenBudget: 8000,
        repoId: ep.repositoryId,
      });
      process.stdout.write(`done (V2: ${v2Bundle.tokenEstimate} tok, V3: ${v3Bundle.tokenEstimate} tok)\n`);
    } finally {
      prepWs.cleanup();
    }

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
          v2Bundle.contextString,
          v2Bundle.tokenEstimate,
          { maxTurns: options.maxTurns, executeRealAgent }
        );
        const resLabel = v2Run.verifiedSuccess === true ? 'PASS 🟢' : v2Run.verifiedSuccess === false ? 'FAIL 🔴' : 'NULL ⚪';
        console.log(`Done (${resLabel}, $${(v2Run.providerCostUSD ?? 0).toFixed(5)}, ${v2Run.wallClockLatencyMs}ms)`);
      } else {
        process.stdout.write(`   Executing ${variant}... `);
        v3Run = await runSingleVariant(
          'V3_LEARNED',
          ep,
          v3Bundle.contextString,
          v3Bundle.tokenEstimate,
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
      tokenDelta: v3Bundle.tokenEstimate - v2Bundle.tokenEstimate,
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
