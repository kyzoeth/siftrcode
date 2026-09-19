import { spawnSync } from 'child_process';
import * as path from 'path';

console.log('🧪 [SiftrCode Test Runner] Executing test suites...\n');

const tests = [
  { name: 'AST Skeletonizer Tests (TS, Py, Go, Rust)', file: 'test_skeleton.js' },
  { name: 'TypeSafe Jev Decision Engine Tests', file: 'test_jev.js' },
  { name: 'Model Context Protocol (MCP) Server Tests', file: 'test_mcp.js' },
  { name: 'Claude & Cursor Plugin Installer Tests', file: 'test_installer.js' }
];

let failed = false;

for (const t of tests) {
  console.log(`▶ Running ${t.name}...`);
  const fullPath = path.join(__dirname, t.file);
  const res = spawnSync('node', [fullPath], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`❌ ${t.name} failed with exit code ${res.status}`);
    failed = true;
    break;
  }
  console.log(`✔ ${t.name} passed.\n`);
}

if (failed) {
  console.error('💥 Test suite failed!');
  process.exit(1);
} else {
  console.log('🎉 All SiftrCode tests passed successfully!');
  process.exit(0);
}
