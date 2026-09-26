/**
 * SiftrCode — Phase 21A: Paired Core-Thesis Experiment Harness
 *
 * Validates the complete paired A/B experiment pipeline:
 *
 * 1. Mock agent runs (GeminiCodingAgent + MockGeminiClient) produce
 *    GeminiAgentRunResult with proper fields.
 * 2. Results are assembled into PairedTaskEvaluation records.
 * 3. VerifiedTaskEvaluator.evaluatePairedExperiment() receives the paired
 *    records and emits a canonical gate decision.
 * 4. Gate decisions are correct under each scenario:
 *    a. V3 wins enough tasks → PROMOTION_GATE_PASSED
 *    b. V3 does not beat V2 → FAILED_TO_BEAT_BASELINE
 *    c. Fewer than minTasks valid pairs → INSUFFICIENT_EVIDENCE
 *    d. CPVST reduction at equal success → PROMOTION_GATE_PASSED
 * 5. Invalid runs (VERIFIER_UNAVAILABLE, PROVIDER_FAILURE) are excluded
 *    from valid-pair counting.
 * 6. Report schema is complete and coherent.
 * 7. McNemar test is populated on valid report.
 * 8. CPVST is null when 0 successes, correct when > 0.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeminiCodingAgent } from '../learning/evaluation/gemini/gemini_agent';
import { MockGeminiClient } from '../learning/evaluation/gemini/mock_gemini_client';
import {
  VerifiedTaskEvaluator,
  PairedTaskEvaluation,
  SingleTaskVerifiedRun,
  VerifiedTaskEvaluationReport,
} from '../learning/evaluation/verified_task_evaluator';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_phase21a_'));
  // plant a minimal file so the sandbox has something to read
  fs.writeFileSync(path.join(dir, 'README.md'), '# test workspace\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  return dir;
}

function rmDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/**
 * Run a hermetic GeminiCodingAgent task using MockGeminiClient.
 * Returns the raw GeminiAgentRunResult mapped to SingleTaskVerifiedRun.
 */
async function runMockAgent(
  workspacePath: string,
  variant: 'V2_FROZEN' | 'V3_LEARNED',
  taskId: string,
  turnBehaviors: any[],
  contextTokens: number,
  verifierCommand?: string
): Promise<SingleTaskVerifiedRun> {
  const mockClient = new MockGeminiClient(turnBehaviors);
  const agent = new GeminiCodingAgent(workspacePath, { clientOverride: mockClient });

  const context = `// Synthetic context for ${taskId} (${contextTokens} tokens simulated)\n` +
    'export interface Service { id: string; name: string; }';

  const result = await agent.runTask(
    `Fix the bug in src/index.ts for task ${taskId}`,
    context,
    verifierCommand ? { taskVerifierCommand: verifierCommand } : undefined
  );

  return {
    taskId,
    variant,
    runValidity: result.runValidity,
    verifiedSuccess: result.verifiedSuccess,
    wallClockLatencyMs: result.wallClockLatencyMs,
    contextTokens,
    agentInputTokens: result.totalPromptTokens,
    agentOutputTokens: result.totalCandidateTokens,
    providerCostUSD: result.providerCostUSD,
    costStatus: result.costStatus,
    toolCalls: result.toolCallsCount,
    trajectoryLength: result.turns,
    verifierResult: result.verifierOutput ?? result.runValidity ?? '',
  };
}

/**
 * Build a PairedTaskEvaluation from two already-computed SingleTaskVerifiedRun.
 */
function buildPair(
  taskId: string,
  repo: string,
  v2: SingleTaskVerifiedRun,
  v3: SingleTaskVerifiedRun
): PairedTaskEvaluation {
  const successDelta =
    v3.verifiedSuccess === true && v2.verifiedSuccess !== true ? 1 :
    v2.verifiedSuccess === true && v3.verifiedSuccess !== true ? -1 : 0;

  return {
    taskId,
    repo,
    v2,
    v3,
    successDelta,
    tokenDelta: v3.contextTokens - v2.contextTokens,
    costDeltaUSD:
      (v3.providerCostUSD ?? 0) - (v2.providerCostUSD ?? 0),
    latencyDeltaMs: v3.wallClockLatencyMs - v2.wallClockLatencyMs,
  };
}

// Turn sequence: agent reads a file, writes a fix, says done
function successTurns(): any[] {
  return [
    {
      functionCalls: [{ name: 'read_file', args: { path: 'src/index.ts' } }],
      usage: { promptTokens: 100, outputTokens: 30 },
    },
    {
      functionCalls: [{
        name: 'write_file',
        args: { path: 'src/index.ts', content: 'export const x = 2; // fixed\n' },
      }],
      usage: { promptTokens: 120, outputTokens: 40 },
    },
    {
      text: 'I have fixed the bug. The export now uses the correct value.',
      usage: { promptTokens: 130, outputTokens: 25 },
    },
  ];
}

// Turn sequence: agent gives up without touching files
function failureTurns(): any[] {
  return [
    {
      text: 'I was unable to identify the root cause of the issue.',
      usage: { promptTokens: 80, outputTokens: 20 },
    },
  ];
}

// ─── main ────────────────────────────────────────────────────────────────────

export async function runPhase21APairedExperimentTests(): Promise<void> {
  console.log('🧪 [Test Suite: Phase 21A Paired Experiment Harness] Starting...\n');

  const tmpDir = makeTmpWorkspace();

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // 1. BASIC AGENT RUN — verify GeminiCodingAgent + MockGeminiClient returns
    //    a well-formed result with all required fields.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- 1. Basic mock agent run produces complete result ---');
    {
      const run = await runMockAgent(
        tmpDir, 'V3_LEARNED', 'task_basic', successTurns(), 1500
      );

      // verifierCommand not provided → VERIFIER_UNAVAILABLE
      assert.strictEqual(run.runValidity, 'VERIFIER_UNAVAILABLE',
        'No verifier command → runValidity must be VERIFIER_UNAVAILABLE');
      assert.strictEqual(run.verifiedSuccess, null,
        'No verifier → verifiedSuccess must be null');
      assert.ok(typeof run.wallClockLatencyMs === 'number' && run.wallClockLatencyMs >= 0,
        'wallClockLatencyMs must be a non-negative number');
      assert.ok(typeof run.agentInputTokens === 'number' && run.agentInputTokens > 0,
        'agentInputTokens must be positive');
      assert.ok(typeof run.agentOutputTokens === 'number',
        'agentOutputTokens must be a number');
      assert.strictEqual(run.toolCalls, 2,
        'Two tool calls (read + write) must be recorded');
      assert.ok(run.trajectoryLength >= 3,
        'trajectoryLength must reflect all agent turns');
      assert.strictEqual(run.contextTokens, 1500, 'contextTokens must pass through');
      console.log('  ✔ Basic mock agent run: all required fields present');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. PAIR ASSEMBLY — verify PairedTaskEvaluation is built correctly from
    //    two SingleTaskVerifiedRun objects.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 2. PairedTaskEvaluation assembly ---');
    {
      // Directly construct synthetic runs for speed (avoid double agent invoke)
      const v2Run: SingleTaskVerifiedRun = {
        taskId: 'task_pair_test',
        variant: 'V2_FROZEN',
        runValidity: 'VALID',
        verifiedSuccess: false,
        wallClockLatencyMs: 2000,
        contextTokens: 2000,
        agentInputTokens: 500,
        agentOutputTokens: 200,
        providerCostUSD: 0.0012,
        costStatus: 'VALID',
        toolCalls: 3,
        trajectoryLength: 4,
        verifierResult: 'FAILED',
      };
      const v3Run: SingleTaskVerifiedRun = {
        taskId: 'task_pair_test',
        variant: 'V3_LEARNED',
        runValidity: 'VALID',
        verifiedSuccess: true,
        wallClockLatencyMs: 1800,
        contextTokens: 1600,
        agentInputTokens: 400,
        agentOutputTokens: 180,
        providerCostUSD: 0.0010,
        costStatus: 'VALID',
        toolCalls: 2,
        trajectoryLength: 3,
        verifierResult: 'PASSED',
      };

      const pair = buildPair('task_pair_test', 'express', v2Run, v3Run);
      assert.strictEqual(pair.successDelta, 1, 'V3 won → successDelta must be +1');
      assert.strictEqual(pair.tokenDelta, -400, 'V3 used 400 fewer tokens → tokenDelta = -400');
      assert.ok(pair.costDeltaUSD < 0, 'V3 cheaper → costDeltaUSD must be negative');
      assert.ok(pair.latencyDeltaMs < 0, 'V3 faster → latencyDeltaMs must be negative');
      console.log('  ✔ PairedTaskEvaluation fields computed correctly (successDelta, tokenDelta, costDelta, latencyDelta)');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. GATE: INSUFFICIENT_EVIDENCE — fewer than minTasksForPromotion valid pairs
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. Gate: INSUFFICIENT_EVIDENCE when fewer than minTasks valid pairs ---');
    {
      const smallPairs: PairedTaskEvaluation[] = [];
      for (let i = 0; i < 5; i++) {
        const v2: SingleTaskVerifiedRun = {
          taskId: `task_sm_${i}`, variant: 'V2_FROZEN', runValidity: 'VALID',
          verifiedSuccess: false, wallClockLatencyMs: 1000, contextTokens: 1000,
          agentInputTokens: 200, agentOutputTokens: 80, providerCostUSD: 0.0005,
          costStatus: 'VALID', toolCalls: 1, trajectoryLength: 2, verifierResult: 'FAILED',
        };
        const v3: SingleTaskVerifiedRun = {
          taskId: `task_sm_${i}`, variant: 'V3_LEARNED', runValidity: 'VALID',
          verifiedSuccess: true, wallClockLatencyMs: 900, contextTokens: 800,
          agentInputTokens: 180, agentOutputTokens: 70, providerCostUSD: 0.0004,
          costStatus: 'VALID', toolCalls: 1, trajectoryLength: 2, verifierResult: 'PASSED',
        };
        smallPairs.push(buildPair(`task_sm_${i}`, 'fastapi', v2, v3));
      }

      const report = VerifiedTaskEvaluator.evaluatePairedExperiment(smallPairs, {
        minTasksForPromotion: 30,
      });

      assert.strictEqual(report.gateDecision, 'V3.1_INSUFFICIENT_EVIDENCE',
        'Only 5 valid pairs against threshold 30 → INSUFFICIENT_EVIDENCE');
      assert.ok(report.decisionRationale.includes('5') || report.decisionRationale.includes('30'),
        'Rationale must reference the pair count or threshold');
      console.log('  ✔ INSUFFICIENT_EVIDENCE correctly fired with 5 pairs vs threshold 30');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. GATE: FAILED_TO_BEAT_BASELINE — V3 success rate lower than V2
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. Gate: FAILED_TO_BEAT_BASELINE when V3 < V2 success rate ---');
    {
      const pairs: PairedTaskEvaluation[] = [];

      // 20 tasks: V2 wins
      for (let i = 0; i < 20; i++) {
        const v2: SingleTaskVerifiedRun = {
          taskId: `task_fail_${i}`, variant: 'V2_FROZEN', runValidity: 'VALID',
          verifiedSuccess: true, wallClockLatencyMs: 1000, contextTokens: 2000,
          agentInputTokens: 400, agentOutputTokens: 100, providerCostUSD: 0.001,
          costStatus: 'VALID', toolCalls: 2, trajectoryLength: 3, verifierResult: 'PASSED',
        };
        const v3: SingleTaskVerifiedRun = {
          taskId: `task_fail_${i}`, variant: 'V3_LEARNED', runValidity: 'VALID',
          verifiedSuccess: false, wallClockLatencyMs: 1200, contextTokens: 1800,
          agentInputTokens: 380, agentOutputTokens: 90, providerCostUSD: 0.0009,
          costStatus: 'VALID', toolCalls: 2, trajectoryLength: 3, verifierResult: 'FAILED',
        };
        pairs.push(buildPair(`task_fail_${i}`, 'express', v2, v3));
      }

      // 10 more tasks: tie (both fail)
      for (let i = 20; i < 30; i++) {
        const makeRun = (v: 'V2_FROZEN' | 'V3_LEARNED'): SingleTaskVerifiedRun => ({
          taskId: `task_fail_${i}`, variant: v, runValidity: 'VALID',
          verifiedSuccess: false, wallClockLatencyMs: 900, contextTokens: 1500,
          agentInputTokens: 300, agentOutputTokens: 80, providerCostUSD: 0.0008,
          costStatus: 'VALID', toolCalls: 1, trajectoryLength: 2, verifierResult: 'FAILED',
        });
        pairs.push(buildPair(`task_fail_${i}`, 'fastapi', makeRun('V2_FROZEN'), makeRun('V3_LEARNED')));
      }

      const report = VerifiedTaskEvaluator.evaluatePairedExperiment(pairs, {
        minTasksForPromotion: 30,
      });

      assert.strictEqual(report.gateDecision, 'V3.1_FAILED_TO_BEAT_BASELINE',
        'V3 lower success rate → FAILED_TO_BEAT_BASELINE');
      assert.ok(report.validPairs >= 30, 'Must have >= 30 valid pairs for gate to fire');
      assert.ok(report.v2Summary.successRate > report.v3Summary.successRate,
        'V2 success rate must be higher than V3');
      assert.ok(report.pairedDeltas.v2Wins > 0, 'V2 wins must be counted');
      assert.strictEqual(report.pairedDeltas.v3Wins, 0, 'V3 has zero wins in this scenario');
      console.log('  ✔ FAILED_TO_BEAT_BASELINE correctly fired when V3 success rate < V2');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. GATE: PROMOTION_GATE_PASSED — V3 wins enough tasks with significance
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. Gate: PROMOTION_GATE_PASSED when V3 wins sufficiently ---');
    {
      const pairs: PairedTaskEvaluation[] = [];

      // 25 tasks: V3 wins (strong lift)
      for (let i = 0; i < 25; i++) {
        const v2: SingleTaskVerifiedRun = {
          taskId: `task_pass_${i}`, variant: 'V2_FROZEN', runValidity: 'VALID',
          verifiedSuccess: false, wallClockLatencyMs: 1400, contextTokens: 2500,
          agentInputTokens: 600, agentOutputTokens: 150, providerCostUSD: 0.0015,
          costStatus: 'VALID', toolCalls: 3, trajectoryLength: 4, verifierResult: 'FAILED',
        };
        const v3: SingleTaskVerifiedRun = {
          taskId: `task_pass_${i}`, variant: 'V3_LEARNED', runValidity: 'VALID',
          verifiedSuccess: true, wallClockLatencyMs: 1100, contextTokens: 2000,
          agentInputTokens: 500, agentOutputTokens: 120, providerCostUSD: 0.0012,
          costStatus: 'VALID', toolCalls: 2, trajectoryLength: 3, verifierResult: 'PASSED',
        };
        pairs.push(buildPair(`task_pass_${i}`, 'express', v2, v3));
      }

      // 15 tasks: tie (both succeed)
      for (let i = 25; i < 40; i++) {
        const makeRun = (v: 'V2_FROZEN' | 'V3_LEARNED'): SingleTaskVerifiedRun => ({
          taskId: `task_pass_${i}`, variant: v, runValidity: 'VALID',
          verifiedSuccess: true, wallClockLatencyMs: 900, contextTokens: 1800,
          agentInputTokens: 400, agentOutputTokens: 100, providerCostUSD: 0.001,
          costStatus: 'VALID', toolCalls: 2, trajectoryLength: 3, verifierResult: 'PASSED',
        });
        pairs.push(buildPair(`task_pass_${i}`, 'siftrcode', makeRun('V2_FROZEN'), makeRun('V3_LEARNED')));
      }

      const report = VerifiedTaskEvaluator.evaluatePairedExperiment(pairs, {
        minTasksForPromotion: 30,
        minSuccessDelta: 0.0,
      });

      assert.strictEqual(report.gateDecision, 'V3.1_PROMOTION_GATE_PASSED',
        '25 V3 wins out of 40 valid pairs → PROMOTION_GATE_PASSED');
      assert.ok(report.v3Summary.successRate > report.v2Summary.successRate,
        'V3 success rate must exceed V2');
      assert.ok(report.pairedDeltas.v3Wins >= 25, 'V3 wins must be counted');
      assert.strictEqual(report.pairedDeltas.v2Wins, 0, 'V2 has zero wins in this scenario');
      assert.ok(report.pairedDeltas.mcNemar !== undefined,
        'McNemar test must be present');
      assert.ok(typeof report.pairedDeltas.mcNemar!.statistic === 'number',
        'McNemar statistic must be a number');
      assert.ok(report.pairedDeltas.mcNemar!.discordantCount >= 25,
        'Discordant count must equal V3 wins since V2 wins = 0');
      console.log('  ✔ PROMOTION_GATE_PASSED correctly fired with 25/40 V3 wins');
      console.log(`    McNemar: statistic=${report.pairedDeltas.mcNemar!.statistic.toFixed(3)}, p=${report.pairedDeltas.mcNemar!.pValue.toFixed(4)}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. CPVST — correct computation and null when no successes
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 6. CPVST calculation ---');
    {
      // All V2 fail → cpvstUSD for V2 must be null; V3 has successes
      const pairs: PairedTaskEvaluation[] = [];
      for (let i = 0; i < 30; i++) {
        const v2: SingleTaskVerifiedRun = {
          taskId: `task_cpvst_${i}`, variant: 'V2_FROZEN', runValidity: 'VALID',
          verifiedSuccess: false, wallClockLatencyMs: 1000, contextTokens: 2000,
          agentInputTokens: 400, agentOutputTokens: 100, providerCostUSD: 0.001,
          costStatus: 'VALID', toolCalls: 2, trajectoryLength: 3, verifierResult: 'FAILED',
        };
        const v3: SingleTaskVerifiedRun = {
          taskId: `task_cpvst_${i}`, variant: 'V3_LEARNED', runValidity: 'VALID',
          verifiedSuccess: true, wallClockLatencyMs: 900, contextTokens: 1800,
          agentInputTokens: 360, agentOutputTokens: 90, providerCostUSD: 0.0009,
          costStatus: 'VALID', toolCalls: 2, trajectoryLength: 3, verifierResult: 'PASSED',
        };
        pairs.push(buildPair(`task_cpvst_${i}`, 'fastapi', v2, v3));
      }

      const report = VerifiedTaskEvaluator.evaluatePairedExperiment(pairs, {
        minTasksForPromotion: 30,
      });

      assert.strictEqual(report.v2Summary.cpvstUSD, null,
        'V2 has 0 successful tasks → CPVST must be null');
      assert.ok(report.v3Summary.cpvstUSD !== null,
        'V3 has 30 successful tasks → CPVST must be non-null');
      assert.ok(report.v3Summary.cpvstUSD! > 0,
        'V3 CPVST must be positive');
      // Total V3 cost = 30 * 0.0009 = 0.027; successes = 30 → CPVST = 0.0009
      const expectedCpvst = (30 * 0.0009) / 30;
      assert.ok(
        Math.abs(report.v3Summary.cpvstUSD! - expectedCpvst) < 0.0001,
        `V3 CPVST (${report.v3Summary.cpvstUSD}) must be ≈ ${expectedCpvst.toFixed(4)}`
      );
      console.log(`  ✔ V2 CPVST = null (0 successes), V3 CPVST = $${report.v3Summary.cpvstUSD!.toFixed(4)}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. INVALID RUN EXCLUSION — runs with runValidity !== 'VALID' must not
    //    count toward the valid-pair threshold
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 7. Invalid runs excluded from valid-pair threshold ---');
    {
      const pairs: PairedTaskEvaluation[] = [];

      // 10 genuinely valid pairs (V3 wins)
      for (let i = 0; i < 10; i++) {
        const v2: SingleTaskVerifiedRun = {
          taskId: `valid_${i}`, variant: 'V2_FROZEN', runValidity: 'VALID',
          verifiedSuccess: false, wallClockLatencyMs: 1000, contextTokens: 2000,
          agentInputTokens: 400, agentOutputTokens: 100, providerCostUSD: 0.001,
          costStatus: 'VALID', toolCalls: 2, trajectoryLength: 3, verifierResult: 'FAILED',
        };
        const v3: SingleTaskVerifiedRun = {
          taskId: `valid_${i}`, variant: 'V3_LEARNED', runValidity: 'VALID',
          verifiedSuccess: true, wallClockLatencyMs: 900, contextTokens: 1800,
          agentInputTokens: 360, agentOutputTokens: 90, providerCostUSD: 0.0009,
          costStatus: 'VALID', toolCalls: 2, trajectoryLength: 3, verifierResult: 'PASSED',
        };
        pairs.push(buildPair(`valid_${i}`, 'express', v2, v3));
      }

      // 25 pairs where V3 had PROVIDER_FAILURE → these should be excluded
      for (let i = 0; i < 25; i++) {
        const v2: SingleTaskVerifiedRun = {
          taskId: `invalid_${i}`, variant: 'V2_FROZEN', runValidity: 'VALID',
          verifiedSuccess: true, wallClockLatencyMs: 1000, contextTokens: 2000,
          agentInputTokens: 400, agentOutputTokens: 100, providerCostUSD: 0.001,
          costStatus: 'VALID', toolCalls: 2, trajectoryLength: 3, verifierResult: 'PASSED',
        };
        const v3: SingleTaskVerifiedRun = {
          taskId: `invalid_${i}`, variant: 'V3_LEARNED', runValidity: 'PROVIDER_FAILURE',
          verifiedSuccess: null, wallClockLatencyMs: 0, contextTokens: 0,
          agentInputTokens: 0, agentOutputTokens: 0, providerCostUSD: null,
          costStatus: 'PRICING_UNAVAILABLE', toolCalls: 0, trajectoryLength: 0, verifierResult: '',
        };
        pairs.push(buildPair(`invalid_${i}`, 'fastapi', v2, v3));
      }

      const report = VerifiedTaskEvaluator.evaluatePairedExperiment(pairs, {
        minTasksForPromotion: 30,
      });

      // Only 10 valid pairs exist (the PROVIDER_FAILURE ones are excluded)
      assert.strictEqual(report.gateDecision, 'V3.1_INSUFFICIENT_EVIDENCE',
        'Only 10 valid pairs (25 excluded due to PROVIDER_FAILURE) → INSUFFICIENT_EVIDENCE');
      assert.ok(report.invalidPairs > 0,
        'invalidPairs must be counted');
      assert.ok(report.validPairs < 30,
        'validPairs must be below threshold');
      console.log(`  ✔ ${report.invalidPairs} invalid runs excluded; only ${report.validPairs} valid pairs counted → INSUFFICIENT_EVIDENCE`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. REPORT SCHEMA — all required top-level fields present and correctly typed
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 8. Report schema completeness ---');
    {
      const pairs: PairedTaskEvaluation[] = [];
      for (let i = 0; i < 30; i++) {
        const makeRun = (v: 'V2_FROZEN' | 'V3_LEARNED', success: boolean): SingleTaskVerifiedRun => ({
          taskId: `schema_${i}`, variant: v, runValidity: 'VALID',
          verifiedSuccess: success, wallClockLatencyMs: 1000, contextTokens: 2000,
          agentInputTokens: 400, agentOutputTokens: 100, providerCostUSD: 0.001,
          costStatus: 'VALID', toolCalls: 2, trajectoryLength: 3,
          verifierResult: success ? 'PASSED' : 'FAILED',
        });
        pairs.push(buildPair(`schema_${i}`, 'siftrcode',
          makeRun('V2_FROZEN', true), makeRun('V3_LEARNED', true)));
      }

      const report = VerifiedTaskEvaluator.evaluatePairedExperiment(pairs, {
        minTasksForPromotion: 30,
      });

      // Top-level schema fields
      assert.strictEqual(report.schemaVersion, 'siftrcode-verified-task-eval-v1');
      assert.ok(typeof report.evaluatedAt === 'string' && report.evaluatedAt.includes('T'));
      assert.ok(typeof report.totalPairedTasks === 'number');
      assert.ok(typeof report.attemptedPairs === 'number');
      assert.ok(typeof report.validPairs === 'number');
      assert.ok(typeof report.invalidPairs === 'number');
      assert.ok(typeof report.invalidByReason === 'object');
      assert.ok(report.v2Summary && typeof report.v2Summary.successRate === 'number');
      assert.ok(report.v3Summary && typeof report.v3Summary.successRate === 'number');
      assert.ok(report.pairedDeltas && typeof report.pairedDeltas.successRateDelta === 'number');
      assert.ok(typeof report.pairedDeltas.v3Wins === 'number');
      assert.ok(typeof report.pairedDeltas.v2Wins === 'number');
      assert.ok(typeof report.pairedDeltas.ties === 'number');
      assert.ok(report.pairedDeltas.v3Wins + report.pairedDeltas.v2Wins + report.pairedDeltas.ties === report.validPairs,
        'wins + losses + ties must equal validPairs');
      assert.ok(typeof report.gateDecision === 'string');
      assert.ok(typeof report.decisionRationale === 'string' && report.decisionRationale.length > 0);
      assert.ok(Array.isArray(report.pairedTasks));
      // V2Summary fields
      const v2s = report.v2Summary;
      assert.ok(v2s.evaluatedTasks === 30);
      assert.ok(v2s.successfulTasks === 30);
      assert.ok(Math.abs(v2s.successRate - 1.0) < 0.001);
      assert.ok(v2s.totalContextTokens === 30 * 2000);
      assert.ok(v2s.cpvstUSD !== null && v2s.cpvstUSD > 0,
        'V2 has 30 successes → cpvstUSD must be non-null');

      console.log('  ✔ Report schema is complete: all fields present and correctly typed');
      console.log(`    gateDecision=${report.gateDecision} (equal success, both 100%)`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 9. LIVE AGENT TURN MAPPING — verify a real MockGeminiClient agent run
    //    produces a SingleTaskVerifiedRun with correct turn count and token sums
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 9. Live mock agent run → SingleTaskVerifiedRun mapping ---');
    {
      const run = await runMockAgent(
        tmpDir,
        'V2_FROZEN',
        'task_live_mapping',
        [
          { functionCalls: [{ name: 'read_file', args: { path: 'README.md' } }], usage: { promptTokens: 80, outputTokens: 30 } },
          { functionCalls: [{ name: 'write_file', args: { path: 'src/index.ts', content: 'export const x = 42;\n' } }], usage: { promptTokens: 110, outputTokens: 40 } },
          { text: 'Task complete.', usage: { promptTokens: 120, outputTokens: 15 } },
        ],
        3200
      );

      assert.ok(run.toolCalls >= 2, 'At least 2 tool calls (read + write)');
      assert.ok(run.agentInputTokens >= 80, 'promptTokens accumulated across turns');
      assert.strictEqual(run.contextTokens, 3200, 'contextTokens passes through verbatim');
      assert.strictEqual(run.runValidity, 'VERIFIER_UNAVAILABLE',
        'No verifier command → VERIFIER_UNAVAILABLE');
      console.log(`  ✔ Live agent run: ${run.toolCalls} tool calls, ${run.agentInputTokens} input tokens, validity=${run.runValidity}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 10. CPVST GATE at equal success — V3 reduces cost → PROMOTION_GATE_PASSED
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 10. Gate: equal success + CPVST reduction → PROMOTION_GATE_PASSED ---');
    {
      const pairs: PairedTaskEvaluation[] = [];
      for (let i = 0; i < 30; i++) {
        // Both succeed, but V3 costs less
        const v2: SingleTaskVerifiedRun = {
          taskId: `cpvst_eq_${i}`, variant: 'V2_FROZEN', runValidity: 'VALID',
          verifiedSuccess: true, wallClockLatencyMs: 1200, contextTokens: 2500,
          agentInputTokens: 600, agentOutputTokens: 150, providerCostUSD: 0.0018,
          costStatus: 'VALID', toolCalls: 3, trajectoryLength: 4, verifierResult: 'PASSED',
        };
        const v3: SingleTaskVerifiedRun = {
          taskId: `cpvst_eq_${i}`, variant: 'V3_LEARNED', runValidity: 'VALID',
          verifiedSuccess: true, wallClockLatencyMs: 1000, contextTokens: 2000,
          agentInputTokens: 480, agentOutputTokens: 120, providerCostUSD: 0.0012,
          costStatus: 'VALID', toolCalls: 2, trajectoryLength: 3, verifierResult: 'PASSED',
        };
        pairs.push(buildPair(`cpvst_eq_${i}`, 'express', v2, v3));
      }

      const report = VerifiedTaskEvaluator.evaluatePairedExperiment(pairs, {
        minTasksForPromotion: 30,
        minSuccessDelta: 0.0,
      });

      // Both have 100% success rate (successDelta = 0 for all pairs → ties = 30)
      assert.strictEqual(report.pairedDeltas.ties, 30, 'All ties (both succeed on all tasks)');
      assert.ok(report.pairedDeltas.cpvstDeltaUSD !== null, 'cpvstDeltaUSD must be present');
      assert.ok(report.pairedDeltas.cpvstDeltaUSD! < 0, 'V3 CPVST lower → delta must be negative');
      // Gate: if successRateDelta === 0 and cpvstDelta < 0 → PROMOTION
      assert.strictEqual(report.gateDecision, 'V3.1_PROMOTION_GATE_PASSED',
        'Equal success + CPVST reduction → PROMOTION_GATE_PASSED');
      console.log(`  ✔ PROMOTION_GATE_PASSED via CPVST reduction: delta=$${report.pairedDeltas.cpvstDeltaUSD!.toFixed(4)}`);
    }

    console.log('\n🎉 ALL PHASE 21A PAIRED EXPERIMENT HARNESS TESTS PASSED!\n');

  } finally {
    rmDir(tmpDir);
  }
}

if (require.main === module) {
  runPhase21APairedExperimentTests().catch((err) => {
    console.error('Phase 21A test failed:', err);
    process.exit(1);
  });
}
