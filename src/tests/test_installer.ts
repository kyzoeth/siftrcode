import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runInstaller } from '../core/installer';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

async function runTests() {
  console.log('🧪 Testing SiftrCode Installer (Cursor & Claude plugin setup)...');

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-test-installer-'));

  try {
    // 1. Test Cursor Plugin Install
    console.log('\n--- 1. Testing Cursor Plugin Mode (`--cursor`) ---');
    const cursorResult = runInstaller({ cursor: true, targetDir: testDir });
    assert(cursorResult.targetAgents.includes('cursor'), 'Target agents includes cursor');
    assert(!cursorResult.targetAgents.includes('claude'), 'Target agents does not include claude');

    const cursorMcp = path.join(testDir, '.cursor', 'mcp.json');
    assert(fs.existsSync(cursorMcp), 'Created .cursor/mcp.json');
    const cursorMcpData = JSON.parse(fs.readFileSync(cursorMcp, 'utf-8'));
    assert(!!cursorMcpData.mcpServers?.siftrcode, '.cursor/mcp.json contains siftrcode config');

    const cursorRules = path.join(testDir, '.cursorrules');
    assert(fs.existsSync(cursorRules), 'Created .cursorrules');

    const cursorMdc = path.join(testDir, '.cursor', 'rules', 'siftrcode.mdc');
    assert(fs.existsSync(cursorMdc), 'Created modern .cursor/rules/siftrcode.mdc');

    // Ensure Claude files were not created in cursor-only mode
    const claudeMcp = path.join(testDir, '.mcp.json');
    assert(!fs.existsSync(claudeMcp), 'Did not create Claude .mcp.json in cursor-only mode');

    // 2. Test Claude Code Plugin Install
    console.log('\n--- 2. Testing Claude Code Plugin Mode (`--claude`) ---');
    const claudeResult = runInstaller({ claude: true, targetDir: testDir });
    assert(claudeResult.targetAgents.includes('claude'), 'Target agents includes claude');

    assert(fs.existsSync(claudeMcp), 'Created .mcp.json for Claude Code');
    const claudeMcpData = JSON.parse(fs.readFileSync(claudeMcp, 'utf-8'));
    assert(!!claudeMcpData.mcpServers?.siftrcode, '.mcp.json contains siftrcode config');

    const claudeMd = path.join(testDir, 'CLAUDE.md');
    assert(fs.existsSync(claudeMd), 'Created CLAUDE.md context instructions');

    const claudeSiftrCmd = path.join(testDir, '.claude', 'commands', 'siftr.md');
    assert(fs.existsSync(claudeSiftrCmd), 'Created .claude/commands/siftr.md slash command');

    console.log('\n🎉 SiftrCode Installer tests passed successfully!');
  } finally {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

runTests().catch((err) => {
  console.error('Installer test failed:', err);
  process.exit(1);
});
