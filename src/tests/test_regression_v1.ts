import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { packRepository } from '../core/packer';
import { auditRepository, formatAuditMarkdown } from '../core/auditor';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isV2Enabled, getFeatureFlags, setFeatureFlags, resetFeatureFlags } from '../config/flags';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

async function runRegressionTests() {
  console.log('🧪 Testing V1 Regression & Baseline Protection...\n');

  const rootDir = path.resolve(__dirname, '../..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-test-reg-'));

  try {
    // 1. Feature flag default check
    console.log('--- 1. Testing Feature Flag Defaults ---');
    assert(!isV2Enabled(), 'V2 is disabled by default');
    assert(!getFeatureFlags().enableV2, 'FeatureFlags.enableV2 is false by default');
    setFeatureFlags({ enableV2: true });
    assert(isV2Enabled(), 'Setting enableV2 overrides successfully');
    resetFeatureFlags();
    assert(!isV2Enabled(), 'resetFeatureFlags restores defaults');

    // 2. Testing packRepository API
    console.log('\n--- 2. Testing packRepository API ---');
    const packOut = path.join(tempDir, 'test_pack.md');
    const packResult = await packRepository({
      directory: rootDir,
      focus: 'authentication middleware security',
      output: packOut,
      includePatterns: ['src/skeleton/types.ts', 'src/jev/client.ts']
    });

    assert(fs.existsSync(packOut), 'Pack output file exists on disk');
    assert(packResult.totalFilesScanned >= 2, `Scanned at least 2 files (got ${packResult.totalFilesScanned})`);
    assert(packResult.rawTokensEstimate > 0, 'rawTokensEstimate is positive');
    assert(typeof packResult.reductionPercentage === 'number', 'reductionPercentage is a number');
    assert(typeof packResult.estimatedCostSavedUSD === 'number', 'estimatedCostSavedUSD is a number');
    const packContent = fs.readFileSync(packOut, 'utf-8');
    assert(packContent.includes('# SiftrCode Context Pack'), 'Pack content contains header');
    assert(packContent.includes('## SiftrCode Ingestion Index'), 'Pack content contains ingestion index');

    // 3. Testing auditRepository API
    console.log('\n--- 3. Testing auditRepository API ---');
    const auditResult = await auditRepository(rootDir);
    assert(auditResult.totalFiles > 0, `Scanned files count: ${auditResult.totalFiles}`);
    assert(auditResult.totalRawTokens > 0, 'totalRawTokens is positive');
    assert(typeof auditResult.savingsPercentage === 'number', 'savingsPercentage is a number');
    assert(Array.isArray(auditResult.topBloatedFiles), 'topBloatedFiles is an array');

    const auditMd = formatAuditMarkdown(auditResult);
    assert(auditMd.includes('## ⚡ SiftrCode Context & Token Audit Report'), 'Audit markdown contains title');
    assert(auditMd.includes('| **Raw Codebase Footprint** |'), 'Audit markdown contains summary table');

    // 4. Testing CLI commands via subprocess
    console.log('\n--- 4. Testing CLI Commands ---');
    const binScript = path.resolve(__dirname, '../bin/siftrcode.js');

    // siftrcode skeleton
    const skeletonCliOut = execSync(`node "${binScript}" skeleton "${path.join(rootDir, 'src/skeleton/types.ts')}"`, {
      encoding: 'utf-8'
    });
    assert(skeletonCliOut.includes('interface SkeletonResult'), 'CLI skeleton printed TypeScript interface');

    // siftrcode audit --json
    const auditCliJson = execSync(`node "${binScript}" audit "${path.join(rootDir, 'src/skeleton')}" --json`, {
      encoding: 'utf-8'
    });
    const parsedAudit = JSON.parse(auditCliJson);
    assert(parsedAudit.totalFiles > 0, 'CLI audit --json returned valid JSON with totalFiles > 0');

    // siftrcode pack
    const cliPackOut = path.join(tempDir, 'cli_pack.md');
    execSync(`node "${binScript}" pack "${path.join(rootDir, 'src/skeleton')}" -o "${cliPackOut}" -f "types"`, {
      encoding: 'utf-8'
    });
    assert(fs.existsSync(cliPackOut), 'CLI pack generated context pack file');

    // 5. Testing MCP Server tools (siftr_pack and siftr_audit)
    console.log('\n--- 5. Testing MCP Server pack & audit tools ---');
    const transport = new StdioClientTransport({
      command: 'node',
      args: [binScript, 'mcp']
    });
    const client = new Client({ name: 'regression-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    // Call siftr_audit
    const auditMcpCall = await client.callTool({
      name: 'siftr_audit',
      arguments: { directory: path.join(rootDir, 'src/skeleton') }
    });
    const auditMcpText = (auditMcpCall.content as any)[0].text;
    const auditMcpObj = JSON.parse(auditMcpText);
    assert(auditMcpObj.totalFiles > 0, 'MCP siftr_audit returned valid audit object');

    // Call siftr_pack
    const mcpPackOut = path.join(tempDir, 'mcp_pack.md');
    const packMcpCall = await client.callTool({
      name: 'siftr_pack',
      arguments: {
        directory: path.join(rootDir, 'src/skeleton'),
        focus: 'interfaces',
        output: mcpPackOut,
        includeContent: false
      }
    });
    const packMcpText = (packMcpCall.content as any)[0].text;
    const packMcpObj = JSON.parse(packMcpText);
    assert(packMcpObj.message === 'Repository packed successfully', 'MCP siftr_pack reported success');
    assert(fs.existsSync(mcpPackOut), 'MCP siftr_pack wrote output file to disk');

    await transport.close();
    console.log('  ✔ MCP tools siftr_audit and siftr_pack passed');

    console.log('\n🎉 All V1 regression tests passed successfully!');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

runRegressionTests().catch((err) => {
  console.error('❌ Regression tests failed:', err);
  process.exit(1);
});
