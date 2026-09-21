/**
 * SiftrCode V3.1 - Gemini Live Fixture Verification Script
 *
 * Runs controlled local fixture tasks with the real Gemini model
 * and verifies tool execution and verifier pass/fail.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeminiCodingAgent } from '../../src/learning/evaluation/gemini/gemini_agent';
import { resolveGeminiApiKey } from '../../src/learning/evaluation/gemini/gemini_config';

async function runFixtures() {
  console.log('================================================================');
  console.log('       SIFTRCODE V3.1 - GEMINI LIVE FIXTURE VALIDATION          ');
  console.log('================================================================\n');

  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    console.log('⚠️ GEMINI_API_KEY not found. Skipping live fixture execution.');
    console.log('To run live fixtures, set GEMINI_API_KEY in your environment or .env file.');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-fixtures-'));

  try {
    // -------------------------------------------------------------------------
    // Fixture 1: Arithmetic Bug Fix
    // -------------------------------------------------------------------------
    console.log('▶ [Fixture 1] Arithmetic Bug Fix in math.js');
    const f1Dir = path.join(tmpDir, 'fixture_1');
    fs.mkdirSync(f1Dir, { recursive: true });
    fs.writeFileSync(
      path.join(f1Dir, 'math.js'),
      'function add(a, b) {\n  return a - b; // BUG: subtraction instead of addition\n}\n\nmodule.exports = { add };\n',
      'utf8'
    );

    const agent1 = new GeminiCodingAgent(f1Dir, {
      configOverrides: { model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', maxTurns: 5 },
    });

    const res1 = await agent1.runTask(
      'There is a bug in math.js. The add function subtracts numbers instead of adding them. Fix it.',
      'File: math.js contains the add function.',
      {
        taskVerifierCommand: 'node -e "const { add } = require(\'./math.js\'); if (add(2, 3) !== 5) process.exit(1);"',
      }
    );

    console.log(`  Turns: ${res1.turns}, Tool Calls: ${res1.toolCallsCount}`);
    console.log(`  Tokens: ${res1.totalTokens} (cost: $${res1.providerCostUSD.toFixed(6)})`);
    console.log(`  Verified Success: ${res1.verifiedSuccess ? 'PASS (exit code 0)' : 'FAIL'}`);
    if (res1.error) console.log(`  Agent error: ${res1.error}`);
    console.log('');

    // -------------------------------------------------------------------------
    // Fixture 2: Export Missing Function
    // -------------------------------------------------------------------------
    console.log('▶ [Fixture 2] Export Missing Function in status.js');
    const f2Dir = path.join(tmpDir, 'fixture_2');
    fs.mkdirSync(f2Dir, { recursive: true });
    fs.writeFileSync(
      path.join(f2Dir, 'status.js'),
      '// status.js\nmodule.exports = {};\n',
      'utf8'
    );

    const agent2 = new GeminiCodingAgent(f2Dir, {
      configOverrides: { model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', maxTurns: 5 },
    });

    const res2 = await agent2.runTask(
      'In status.js, implement and export formatStatus(code) returning "OK" if code is 200, else "ERROR".',
      'File: status.js is currently empty.',
      {
        taskVerifierCommand:
          'node -e "const { formatStatus } = require(\'./status.js\'); if (typeof formatStatus !== \'function\' || formatStatus(200) !== \'OK\' || formatStatus(404) !== \'ERROR\') process.exit(1);"',
      }
    );

    console.log(`  Turns: ${res2.turns}, Tool Calls: ${res2.toolCallsCount}`);
    console.log(`  Tokens: ${res2.totalTokens} (cost: $${res2.providerCostUSD.toFixed(6)})`);
    console.log(`  Verified Success: ${res2.verifiedSuccess ? 'PASS (exit code 0)' : 'FAIL'}`);
    if (res2.error) console.log(`  Agent error: ${res2.error}`);
    console.log('');

    const reportDir = path.resolve(__dirname, '../../experiments/results/gemini-fixtures');
    fs.mkdirSync(reportDir, { recursive: true });

    const report = {
      timestamp: new Date().toISOString(),
      model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
      fixtures: [
        {
          name: 'Fixture 1: Arithmetic Bug Fix in math.js',
          turns: res1.turns,
          toolCallsCount: res1.toolCallsCount,
          totalPromptTokens: res1.totalPromptTokens,
          totalCandidateTokens: res1.totalCandidateTokens,
          totalThoughtsTokens: res1.totalThoughtsTokens,
          totalTokens: res1.totalTokens,
          providerCostUSD: res1.providerCostUSD,
          wallClockLatencyMs: res1.wallClockLatencyMs,
          verifiedSuccess: res1.verifiedSuccess,
          error: res1.error || null,
        },
        {
          name: 'Fixture 2: Export Missing Function in status.js',
          turns: res2.turns,
          toolCallsCount: res2.toolCallsCount,
          totalPromptTokens: res2.totalPromptTokens,
          totalCandidateTokens: res2.totalCandidateTokens,
          totalThoughtsTokens: res2.totalThoughtsTokens,
          totalTokens: res2.totalTokens,
          providerCostUSD: res2.providerCostUSD,
          wallClockLatencyMs: res2.wallClockLatencyMs,
          verifiedSuccess: res2.verifiedSuccess,
          error: res2.error || null,
        },
      ],
      allPassed: res1.verifiedSuccess === true && res2.verifiedSuccess === true,
    };

    const reportPath = path.join(reportDir, 'fixture_validation_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`✔ Fixture report archived to: ${reportPath}\n`);

    if (!report.allPassed) {
      throw new Error('One or more Gemini fixtures failed verification.');
    }

    console.log('================================================================');
    console.log('🎉 GEMINI FIXTURE VALIDATION RUN COMPLETE - ALL FIXTURES PASSED');
    console.log('================================================================\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runFixtures().catch((err) => {
    console.error('Fixture run failed:', err);
    process.exit(1);
  });
}
