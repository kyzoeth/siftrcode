/**
 * SiftrCode V3.1 - Gemini Live Fixture Verification Script (Phase V3.1 - Phase 10)
 *
 * Runs 3 controlled live fixture tasks with the real Gemini model:
 * 1. Single-file bug fix (math.js)
 * 2. Multi-file coordination (service.js & client.js)
 * 3. Test-driven change (validator.js with test_slug.js)
 *
 * Enforces:
 * - Real provider API calls with Google GenAI SDK.
 * - Sandboxed execution boundary and allowlisted environment.
 * - Task-specific verifiers.
 * - Accurate token accounting and official pricing calculation.
 * - Persists to experiments/v3-1-final/live_fixture_report.json.
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
    // Fixture 1: Single-File Arithmetic Bug Fix (math.js)
    // -------------------------------------------------------------------------
    console.log('▶ [Fixture 1] Single-File Arithmetic Bug Fix in math.js');
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
      'There is a bug in math.js. The add function subtracts numbers instead of adding them. Fix it so add(2, 3) returns 5 and add(-1, 1) returns 0.',
      'File: math.js contains the add function.',
      {
        taskVerifierCommand: 'node -e "const { add } = require(\'./math.js\'); if (add(2, 3) !== 5 || add(-1, 1) !== 0) process.exit(1);"',
      }
    );

    console.log(`  Turns: ${res1.turns}, Tool Calls: ${res1.toolCallsCount}`);
    console.log(`  Tokens: ${res1.totalTokens} (cost: ${res1.providerCostUSD !== null ? '$' + res1.providerCostUSD.toFixed(6) : 'null'})`);
    console.log(`  Validity: ${res1.runValidity}, Verified Success: ${res1.verifiedSuccess ? 'PASS (exit code 0)' : 'FAIL'}`);
    if (res1.error) console.log(`  Agent error: ${res1.error}`);
    console.log('');

    // -------------------------------------------------------------------------
    // Fixture 2: Multi-File Coordination (service.js & client.js)
    // -------------------------------------------------------------------------
    console.log('▶ [Fixture 2] Multi-File Coordination in service.js & client.js');
    const f2Dir = path.join(tmpDir, 'fixture_2');
    fs.mkdirSync(f2Dir, { recursive: true });
    fs.writeFileSync(
      path.join(f2Dir, 'service.js'),
      '// Tax Calculation Service\nfunction calculateTax(subtotal, rate) {\n  return Number((subtotal * rate).toFixed(2));\n}\n\nmodule.exports = { calculateTax };\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(f2Dir, 'client.js'),
      '// Client invoice generator\n// TODO: import calculateTax from ./service.js and implement formatInvoice(subtotal, rate)\nmodule.exports = {};\n',
      'utf8'
    );

    const agent2 = new GeminiCodingAgent(f2Dir, {
      configOverrides: { model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', maxTurns: 6 },
    });

    const res2 = await agent2.runTask(
      'In client.js, use CommonJS require("./service.js") to import calculateTax, and export formatInvoice(subtotal, rate) via module.exports = { formatInvoice } returning an object { subtotal, tax, total } where total = subtotal + tax.',
      'File: service.js exports calculateTax(subtotal, rate). File: client.js needs formatInvoice using CommonJS.',
      {
        taskVerifierCommand:
          'node -e "const { formatInvoice } = require(\'./client.js\'); const inv = formatInvoice(100, 0.1); if (!inv || inv.total !== 110 || inv.tax !== 10) process.exit(1);"',
      }
    );

    console.log(`  Turns: ${res2.turns}, Tool Calls: ${res2.toolCallsCount}`);
    console.log(`  Tokens: ${res2.totalTokens} (cost: ${res2.providerCostUSD !== null ? '$' + res2.providerCostUSD.toFixed(6) : 'null'})`);
    console.log(`  Validity: ${res2.runValidity}, Verified Success: ${res2.verifiedSuccess ? 'PASS (exit code 0)' : 'FAIL'}`);
    if (res2.error) console.log(`  Agent error: ${res2.error}`);
    console.log('');

    // -------------------------------------------------------------------------
    // Fixture 3: Test-Driven Change (validator.js tested by test_slug.js)
    // -------------------------------------------------------------------------
    console.log('▶ [Fixture 3] Test-Driven Implementation in validator.js');
    const f3Dir = path.join(tmpDir, 'fixture_3');
    fs.mkdirSync(f3Dir, { recursive: true });
    fs.writeFileSync(
      path.join(f3Dir, 'validator.js'),
      '// Slug Validator\nfunction isValidSlug(slug) {\n  return false;\n}\n\nmodule.exports = { isValidSlug };\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(f3Dir, 'test_slug.js'),
      `const { isValidSlug } = require('./validator.js');
const tests = [
  { slug: 'hello-world', expected: true },
  { slug: 'siftr-code-v3', expected: true },
  { slug: 'no', expected: false }, // too short (< 3)
  { slug: 'INVALID_CAPS', expected: false }, // uppercase not allowed
  { slug: 'double--hyphen', expected: false }, // consecutive hyphens not allowed
  { slug: '-leading-hyphen', expected: false }, // leading hyphen not allowed
];
for (const t of tests) {
  if (isValidSlug(t.slug) !== t.expected) {
    console.error('Failed test for slug:', t.slug, 'expected:', t.expected, 'got:', isValidSlug(t.slug));
    process.exit(1);
  }
}
process.exit(0);
`,
      'utf8'
    );

    const agent3 = new GeminiCodingAgent(f3Dir, {
      configOverrides: { model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', maxTurns: 5 },
    });

    const res3 = await agent3.runTask(
      'In validator.js, implement isValidSlug(slug). A valid slug must: consist of lowercase alphanumeric characters and single hyphens, have length between 3 and 50 chars, have no consecutive hyphens, and cannot start or end with a hyphen. Run "node test_slug.js" to verify.',
      'File: validator.js contains stub. File: test_slug.js contains test suite.',
      {
        taskVerifierCommand: 'node test_slug.js',
      }
    );

    console.log(`  Turns: ${res3.turns}, Tool Calls: ${res3.toolCallsCount}`);
    console.log(`  Tokens: ${res3.totalTokens} (cost: ${res3.providerCostUSD !== null ? '$' + res3.providerCostUSD.toFixed(6) : 'null'})`);
    console.log(`  Validity: ${res3.runValidity}, Verified Success: ${res3.verifiedSuccess ? 'PASS (exit code 0)' : 'FAIL'}`);
    if (res3.error) console.log(`  Agent error: ${res3.error}`);
    console.log('');

    const finalReportDir = path.resolve(__dirname, '../../experiments/v3-1-final');
    fs.mkdirSync(finalReportDir, { recursive: true });
    const legacyReportDir = path.resolve(__dirname, '../../experiments/results/gemini-fixtures');
    fs.mkdirSync(legacyReportDir, { recursive: true });

    const report = {
      schemaVersion: 'siftrcode-gemini-fixture-report-v1',
      timestamp: new Date().toISOString(),
      model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
      fixtures: [
        {
          name: 'Fixture 1: Single-File Arithmetic Bug Fix in math.js',
          taskType: 'BUG_FIX',
          runValidity: res1.runValidity,
          turns: res1.turns,
          toolCallsCount: res1.toolCallsCount,
          totalPromptTokens: res1.totalPromptTokens,
          totalCandidateTokens: res1.totalCandidateTokens,
          totalThoughtsTokens: res1.totalThoughtsTokens,
          totalTokens: res1.totalTokens,
          providerCostUSD: res1.providerCostUSD,
          costStatus: res1.costStatus,
          wallClockLatencyMs: res1.wallClockLatencyMs,
          verifiedSuccess: res1.verifiedSuccess,
          error: res1.error || null,
        },
        {
          name: 'Fixture 2: Multi-File Coordination in service.js & client.js',
          taskType: 'MULTI_FILE_COORDINATION',
          runValidity: res2.runValidity,
          turns: res2.turns,
          toolCallsCount: res2.toolCallsCount,
          totalPromptTokens: res2.totalPromptTokens,
          totalCandidateTokens: res2.totalCandidateTokens,
          totalThoughtsTokens: res2.totalThoughtsTokens,
          totalTokens: res2.totalTokens,
          providerCostUSD: res2.providerCostUSD,
          costStatus: res2.costStatus,
          wallClockLatencyMs: res2.wallClockLatencyMs,
          verifiedSuccess: res2.verifiedSuccess,
          error: res2.error || null,
        },
        {
          name: 'Fixture 3: Test-Driven Implementation in validator.js',
          taskType: 'TEST_DRIVEN_DEVELOPMENT',
          runValidity: res3.runValidity,
          turns: res3.turns,
          toolCallsCount: res3.toolCallsCount,
          totalPromptTokens: res3.totalPromptTokens,
          totalCandidateTokens: res3.totalCandidateTokens,
          totalThoughtsTokens: res3.totalThoughtsTokens,
          totalTokens: res3.totalTokens,
          providerCostUSD: res3.providerCostUSD,
          costStatus: res3.costStatus,
          wallClockLatencyMs: res3.wallClockLatencyMs,
          verifiedSuccess: res3.verifiedSuccess,
          error: res3.error || null,
        },
      ],
      allPassed:
        res1.verifiedSuccess === true &&
        res2.verifiedSuccess === true &&
        res3.verifiedSuccess === true,
    };

    const finalPath = path.join(finalReportDir, 'live_fixture_report.json');
    fs.writeFileSync(finalPath, JSON.stringify(report, null, 2), 'utf8');

    const legacyPath = path.join(legacyReportDir, 'fixture_validation_report.json');
    fs.writeFileSync(legacyPath, JSON.stringify(report, null, 2), 'utf8');

    console.log(`✔ Live fixture report archived to: ${finalPath}`);
    console.log(`✔ Legacy fixture report archived to: ${legacyPath}\n`);

    if (!report.allPassed) {
      throw new Error('One or more Gemini live fixtures failed verification.');
    }

    console.log('================================================================');
    console.log('🎉 GEMINI LIVE FIXTURE VALIDATION RUN COMPLETE - 3/3 PASSED');
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
