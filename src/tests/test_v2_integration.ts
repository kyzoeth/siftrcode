import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

export async function runV2IntegrationTests() {
  console.log('🧪 Testing SiftrCode V2 CLI & MCP Server Integration (Phase 17)...');

  const binScript = path.resolve(__dirname, '../bin/siftrcode.js');
  const projectRoot = path.resolve(__dirname, '../..');

  // =========================================================================
  // 1. MCP Server V2 Tool Registration & Execution
  // =========================================================================
  console.log('\n--- 1. MCP Server V2 Tool Registration & Stdio Communication ---');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [binScript, 'mcp'],
  });

  const client = new Client({ name: 'test-v2-client', version: '2.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const toolsList = await client.listTools();
  const toolNames = toolsList.tools.map((t) => t.name);

  assert(toolNames.includes('siftr_context'), 'MCP lists siftr_context tool');
  assert(toolNames.includes('siftr_optimize'), 'MCP lists siftr_optimize tool');
  assert(toolNames.includes('siftr_rank'), 'MCP lists siftr_rank tool');
  assert(toolNames.includes('siftr_skeleton'), 'MCP retains V1 siftr_skeleton tool');
  assert(toolNames.includes('siftr_pack'), 'MCP retains V1 siftr_pack tool');
  assert(toolNames.includes('siftr_audit'), 'MCP retains V1 siftr_audit tool');

  // =========================================================================
  // 2. Calling siftr_context via MCP
  // =========================================================================
  console.log('\n--- 2. Calling siftr_context Tool over MCP ---');

  const contextToolResult = await client.callTool({
    name: 'siftr_context',
    arguments: {
      prompt: 'Fix token expiration race condition in JWT middleware',
      directory: projectRoot,
      tokenBudget: 10000,
    },
  });

  assert(!contextToolResult.isError, 'siftr_context tool executed without error');
  const contextText = (contextToolResult.content as any)[0].text;
  const contextData = JSON.parse(contextText);

  assert(typeof contextData.planId === 'string' && contextData.planId.startsWith('cplan_'), 'planId has valid prefix');
  assert(typeof contextData.taskId === 'string', 'taskId is present');
  assert(contextData.allocatedTokens > 0, 'allocatedTokens is positive');
  assert(typeof contextData.reductionRatio === 'string', 'reductionRatio formatted as string');
  assert(typeof contextData.estimatedCostUSD === 'string', 'estimatedCostUSD formatted');
  assert(Array.isArray(contextData.units) && contextData.units.length > 0, 'units array populated');
  assert(typeof contextData.context === 'string' && contextData.context.length > 0, 'context string returned');

  // Check unit properties
  const firstUnit = contextData.units[0];
  assert(typeof firstUnit.path === 'string', 'unit has path');
  assert(typeof firstUnit.resolutionName === 'string', 'unit has resolutionName');
  assert(typeof firstUnit.allocatedTokens === 'number', 'unit has allocatedTokens');

  // =========================================================================
  // 3. Calling siftr_optimize (Alias) via MCP
  // =========================================================================
  console.log('\n--- 3. Calling siftr_optimize Alias over MCP ---');

  const optimizeToolResult = await client.callTool({
    name: 'siftr_optimize',
    arguments: {
      prompt: 'Refactor AST dispatcher to support Swift',
      directory: projectRoot,
    },
  });

  assert(!optimizeToolResult.isError, 'siftr_optimize executed without error');
  const optimizeData = JSON.parse((optimizeToolResult.content as any)[0].text);
  assert(typeof optimizeData.planId === 'string', 'siftr_optimize produced valid planId');
  assert(optimizeData.units.length > 0, 'siftr_optimize allocated units');

  // =========================================================================
  // 4. Calling siftr_rank via MCP
  // =========================================================================
  console.log('\n--- 4. Calling siftr_rank Tool over MCP ---');

  const rankToolResult = await client.callTool({
    name: 'siftr_rank',
    arguments: {
      prompt: 'Fix AST skeletonizer TypeScript interface generation',
      directory: projectRoot,
      limit: 10,
    },
  });

  assert(!rankToolResult.isError, 'siftr_rank executed without error');
  const rankData = JSON.parse((rankToolResult.content as any)[0].text);
  assert(rankData.totalCandidates > 0, 'siftr_rank found candidates');
  assert(Array.isArray(rankData.ranked) && rankData.ranked.length > 0, 'siftr_rank returned ranked list');
  assert(rankData.ranked.length <= 10, 'siftr_rank respected limit 10');

  const topRank = rankData.ranked[0];
  assert(topRank.rank === 1, 'Top candidate has rank 1');
  assert(typeof topRank.score === 'number', 'Top candidate has numeric score');
  assert(typeof topRank.primaryReason === 'string', 'Top candidate has primaryReason');
  assert(typeof topRank.scoreBreakdown === 'object', 'Top candidate has scoreBreakdown');

  await transport.close();

  // =========================================================================
  // 5. CLI Subcommand `siftr context` Execution
  // =========================================================================
  console.log('\n--- 5. CLI Command `siftr context` & Output Modes ---');

  // Mode A: JSON output
  const jsonCmd = `node "${binScript}" context "Fix AST skeletonizer TypeScript interface generation" --dir "${projectRoot}" --json`;
  const jsonStdout = execSync(jsonCmd, { encoding: 'utf-8' });
  const parsedCliPlan = JSON.parse(jsonStdout);

  assert(typeof parsedCliPlan.planId === 'string', 'CLI --json outputs parseable ContextPlan JSON');
  assert(parsedCliPlan.budgetPlan.totalTokens > 0, 'CLI budgetPlan allocated tokens');
  assert(Array.isArray(parsedCliPlan.units), 'CLI plan contains units');

  // Mode B: File output (-o)
  const tmpOutFile = path.join(os.tmpdir(), `siftr_test_context_${Date.now()}.xml`);
  try {
    const fileCmd = `node "${binScript}" context "Refactor candidate discovery" --dir "${projectRoot}" -o "${tmpOutFile}"`;
    const fileStdout = execSync(fileCmd, { encoding: 'utf-8' });

    assert(fs.existsSync(tmpOutFile), 'CLI -o wrote context file to disk');
    const writtenContent = fs.readFileSync(tmpOutFile, 'utf-8');
    assert(writtenContent.length > 100, 'Written context file contains non-empty context');
    assert(fileStdout.includes('Context Saved'), 'CLI output logged confirmation of saved file');
  } finally {
    if (fs.existsSync(tmpOutFile)) {
      fs.unlinkSync(tmpOutFile);
    }
  }

  // Mode C: Standard console output
  const plainCmd = `node "${binScript}" context "Fix AST skeletonizer interface" --dir "${projectRoot}"`;
  const plainStdout = execSync(plainCmd, { encoding: 'utf-8' });
  assert(plainStdout.includes('Context optimized for coding agent!'), 'CLI prints success header');
  assert(plainStdout.includes('Token & Cost Optimization:'), 'CLI prints token & cost table');
  assert(plainStdout.includes('Allocated Context Units:'), 'CLI prints allocated units list');

  // Mode D: Alias `siftr plan`
  const aliasCmd = `node "${binScript}" plan "Fix AST skeletonizer interface" --dir "${projectRoot}"`;
  const aliasStdout = execSync(aliasCmd, { encoding: 'utf-8' });
  assert(aliasStdout.includes('Context optimized for coding agent!'), 'CLI alias `siftr plan` works');


  // =========================================================================
  // 6. Zero Regression on V1 CLI Commands
  // =========================================================================
  console.log('\n--- 6. Zero Regression on V1 CLI Commands ---');

  const skeletonCmd = `node "${binScript}" skeleton "${path.join(projectRoot, 'src/skeleton/types.ts')}"`;
  const skeletonStdout = execSync(skeletonCmd, { encoding: 'utf-8' });
  assert(skeletonStdout.includes('export interface SkeletonResult'), 'V1 CLI skeleton command intact');

  const auditCmd = `node "${binScript}" audit "${projectRoot}" --json`;
  const auditStdout = execSync(auditCmd, { encoding: 'utf-8' });
  const auditJson = JSON.parse(auditStdout);
  assert(auditJson.totalFiles > 0, 'V1 CLI audit --json intact');

  console.log('\n🎉 All V2 CLI & MCP Server Integration tests passed successfully!');
}

if (require.main === module) {
  runV2IntegrationTests().catch((err) => {
    console.error('V2 Integration test failed:', err);
    process.exit(1);
  });
}
