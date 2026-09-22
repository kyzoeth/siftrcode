/**
 * SiftrCode V3.1 - Gemini Agent Harness & Sandboxing Tests
 *
 * Verifies that:
 * 1. Filesystem operations are strictly sandboxed within the workspace.
 * 2. Secrets are completely stripped before executing child processes.
 * 3. Token usage and pricing calculations are exact.
 * 4. Multi-turn tool execution and verifier integration function correctly.
 * 5. Hermetic tests pass cleanly without network or live credentials.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeminiWorkspaceSandbox } from '../learning/evaluation/gemini/gemini_tools';
import { calculateModelCostUSD } from '../learning/evaluation/provider_pricing';
import { MockGeminiClient } from '../learning/evaluation/gemini/mock_gemini_client';
import { GeminiCodingAgent } from '../learning/evaluation/gemini/gemini_agent';

export async function runGeminiHarnessTests(): Promise<void> {
  console.log('🧪 [Test Suite: Gemini Agent Harness & Sandboxing] Starting...');

  // Setup temporary test workspace
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-sandbox-test-'));
  fs.writeFileSync(path.join(tmpWorkspace, 'sample.txt'), 'line 1\nline 2\nline 3\nline 4\n', 'utf8');
  fs.mkdirSync(path.join(tmpWorkspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpWorkspace, 'src', 'index.ts'), 'export const answer = 42;\n', 'utf8');

  try {
    // -------------------------------------------------------------------------
    // 1. Workspace Sandboxing & Traversal Prevention
    // -------------------------------------------------------------------------
    console.log('\n--- 1. Workspace Sandboxing & Traversal Prevention ---');
    const sandbox = new GeminiWorkspaceSandbox(tmpWorkspace);

    // Valid reads & writes
    const readRes = sandbox.readFile('sample.txt');
    assert.strictEqual(readRes.lines, 5);
    assert.ok(readRes.content.includes('line 1'));

    const rangeRes = sandbox.readFileRange('sample.txt', 2, 3);
    assert.strictEqual(rangeRes.content, 'line 2\nline 3');

    const writeRes = sandbox.writeFile('src/output.txt', 'hello world');
    assert.strictEqual(writeRes.success, true);
    assert.strictEqual(fs.readFileSync(path.join(tmpWorkspace, 'src', 'output.txt'), 'utf8'), 'hello world');

    const listRes = sandbox.listFiles('src');
    assert.ok(listRes.files.some((f) => f.includes('index.ts')));
    assert.ok(listRes.files.some((f) => f.includes('output.txt')));

    // Search text
    const searchRes = sandbox.searchText('answer');
    assert.strictEqual(searchRes.matches.length, 1);
    assert.strictEqual(searchRes.matches[0].file, 'src/index.ts');

    // Attempt traversal outside workspace
    assert.throws(
      () => sandbox.readFile('../../etc/passwd'),
      /Path traversal denied/,
      'Must deny reading outside workspace boundary'
    );
    assert.throws(
      () => sandbox.writeFile('../escaped.txt', 'danger'),
      /Path traversal denied/,
      'Must deny writing outside workspace boundary'
    );
    assert.throws(
      () => sandbox.listFiles('../'),
      /Path traversal denied/,
      'Must deny listing outside workspace boundary'
    );

    console.log('  ✔ Workspace boundary strictly enforced; path traversal attempts rejected');

    // -------------------------------------------------------------------------
    // 2. Secret Scrubbing in Command Execution
    // -------------------------------------------------------------------------
    console.log('\n--- 2. Secret Scrubbing in Command Execution ---');
    process.env.GEMINI_API_KEY = 'test-secret-gemini-key-12345';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-aws-key-67890';

    const envCheck = sandbox.runCommand('echo "KEY=$GEMINI_API_KEY AWS=$AWS_SECRET_ACCESS_KEY"');
    assert.strictEqual(envCheck.exitCode, 0);
    assert.strictEqual(envCheck.stdout.trim(), 'KEY= AWS=');
    assert.ok(!envCheck.stdout.includes('test-secret-gemini-key-12345'));
    assert.ok(!envCheck.stdout.includes('test-secret-aws-key-67890'));

    delete process.env.GEMINI_API_KEY;
    delete process.env.AWS_SECRET_ACCESS_KEY;

    console.log('  ✔ Sensitive environment variables successfully scrubbed from child process execution');

    // -------------------------------------------------------------------------
    // 3. Provider Pricing Calculations
    // -------------------------------------------------------------------------
    console.log('\n--- 3. Provider Pricing Calculations ---');
    const cost = calculateModelCostUSD('gemini-3.6-flash', 1_000_000, 1_000_000, 0, 'standard');
    // 1M input ($0.75) + 1M output ($3.75) = $4.50
    assert.strictEqual(cost.costStatus, 'VALID');
    assert.strictEqual(cost.providerCostUSD, 4.50);

    const costSmall = calculateModelCostUSD('gemini-3.6-flash', 10_000, 2_000, 0, 'standard');
    // 10K / 1M * 0.75 = 0.0075 + 2K / 1M * 3.75 = 0.0075 = 0.0150
    assert.strictEqual(costSmall.costStatus, 'VALID');
    assert.strictEqual(costSmall.providerCostUSD, 0.0150);

    // Fail-closed test on unknown billing tier
    const unknownTierCost = calculateModelCostUSD('gemini-3.6-flash', 10_000, 2_000, 0, 'unknown');
    assert.strictEqual(unknownTierCost.costStatus, 'PRICING_UNAVAILABLE');
    assert.strictEqual(unknownTierCost.providerCostUSD, null);

    // Fail-closed test on unknown model
    const unknownCost = calculateModelCostUSD('non-existent-model', 1000, 1000, 0, 'standard');
    assert.strictEqual(unknownCost.costStatus, 'PRICING_UNAVAILABLE');
    assert.strictEqual(unknownCost.providerCostUSD, null);

    console.log('  ✔ Model pricing formulas and fail-closed behavior validated exactly');

    // -------------------------------------------------------------------------
    // 4. Multi-Turn Coding Agent Execution with Verifier
    // -------------------------------------------------------------------------
    console.log('\n--- 4. Multi-Turn Coding Agent Execution with Verifier ---');
    const mockClient = new MockGeminiClient([
      // Turn 1: Call list_files
      {
        functionCalls: [{ name: 'list_files', args: { dirPath: 'src' }, id: 'call_1' }],
        usage: { promptTokens: 150, outputTokens: 30, thoughtsTokens: 10 },
      },
      // Turn 2: Call write_file to solve the bug
      {
        functionCalls: [
          {
            name: 'write_file',
            args: { filePath: 'src/solution.js', content: 'module.exports = { solved: true };\n' },
            id: 'call_2',
          },
        ],
        usage: { promptTokens: 200, outputTokens: 40, thoughtsTokens: 15 },
      },
      // Turn 3: Final completion text
      {
        text: 'The fix has been implemented and verified.',
        usage: { promptTokens: 250, outputTokens: 20, thoughtsTokens: 5 },
      },
    ]);

    const agent = new GeminiCodingAgent(tmpWorkspace, {
      configOverrides: { apiKey: 'mock-key', model: 'gemini-3.6-flash', billingTier: 'standard' },
      clientOverride: mockClient,
    });

    const result = await agent.runTask(
      'Fix the issue by creating src/solution.js',
      'Initial context details...',
      {
        taskVerifierCommand: 'node -e "const s = require(\'./src/solution.js\'); if (!s.solved) process.exit(1);"',
      }
    );

    assert.strictEqual(result.completed, true);
    assert.strictEqual(result.turns, 3);
    assert.strictEqual(result.toolCallsCount, 2);
    assert.strictEqual(result.verifiedSuccess, true);
    assert.strictEqual(result.totalPromptTokens, 600);
    assert.strictEqual(result.totalCandidateTokens, 90);
    assert.strictEqual(result.totalThoughtsTokens, 30);
    assert.strictEqual(result.totalTokens, 720);
    assert.strictEqual(result.costStatus, 'VALID');
    assert.ok(result.providerCostUSD !== null && result.providerCostUSD > 0);
    assert.strictEqual(
      fs.readFileSync(path.join(tmpWorkspace, 'src', 'solution.js'), 'utf8'),
      'module.exports = { solved: true };\n'
    );

    console.log('  ✔ Agent multi-turn tool execution, state accumulation, and verifier integration verified');

    // -------------------------------------------------------------------------
    // 5. Verifier Failure Detection
    // -------------------------------------------------------------------------
    console.log('\n--- 5. Verifier Failure Detection ---');
    const failingMockClient = new MockGeminiClient([
      {
        text: 'I finished without doing anything.',
        usage: { promptTokens: 100, outputTokens: 20 },
      },
    ]);

    const failingAgent = new GeminiCodingAgent(tmpWorkspace, {
      configOverrides: { apiKey: 'mock-key', model: 'gemini-3.6-flash' },
      clientOverride: failingMockClient,
    });

    const failResult = await failingAgent.runTask('Task', '', {
      taskVerifierCommand: 'node -e "process.exit(1);"',
    });

    assert.strictEqual(failResult.verifiedSuccess, false);
    assert.strictEqual(failResult.completed, true);

    console.log('  ✔ Verifier failure correctly captured as verifiedSuccess = false');

    // -------------------------------------------------------------------------
    // 6. Resilience on Missing Credentials
    // -------------------------------------------------------------------------
    console.log('\n--- 6. Resilience on Missing Credentials ---');
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    assert.throws(
      () => new GeminiCodingAgent(tmpWorkspace, { configOverrides: { apiKey: '' } }),
      /Missing GEMINI_API_KEY/,
      'Must throw clear error when API key is unsupplied'
    );

    console.log('  ✔ Missing credentials handled cleanly without secret leakage');
  } finally {
    // Cleanup temporary workspace
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }

  console.log('\n🎉 ALL GEMINI AGENT HARNESS TESTS PASSED CLEANLY!\n');
}

if (require.main === module) {
  runGeminiHarnessTests().catch((err) => {
    console.error('❌ Gemini harness tests failed:', err);
    process.exit(1);
  });
}
