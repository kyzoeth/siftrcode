import { spawnSync } from 'child_process';
import * as path from 'path';

console.log('🧪 [SiftrCode Test Runner] Executing test suites...\n');

const tests = [
  { name: 'AST Skeletonizer Tests (TS, Py, Go, Rust)', file: 'test_skeleton.js' },
  { name: 'TypeSafe Jev Decision Engine Tests', file: 'test_jev.js' },
  { name: 'Model Context Protocol (MCP) Server Tests', file: 'test_mcp.js' },
  { name: 'Claude & Cursor Plugin Installer Tests', file: 'test_installer.js' },
  { name: 'V1 Regression & Baseline Protection Tests', file: 'test_regression_v1.js' },
  { name: 'V2 Foundational Domain Contracts Tests', file: 'test_foundational_contracts.js' },
  { name: 'V2 WorkspaceSnapshot & WorkspaceManager Tests', file: 'test_workspace_snapshot.js' },
  { name: 'V2 SQLite Persistent Storage & Migrations Tests', file: 'test_storage.js' },
  { name: 'V2 Heterogeneous ContextUnit Indexing Tests', file: 'test_indexing.js' },
  { name: 'V2 Engineering Context Graph & GraphBuilder Tests', file: 'test_context_graph.js' },
  { name: 'V2 Point-in-Time Git Intelligence & Co-Change Tests', file: 'test_git_intelligence.js' },
  { name: 'V2 Security & Trust Plane Tests', file: 'test_security_plane.js' },
  { name: 'V2 Multi-Channel Candidate Discovery & Recall Tests', file: 'test_candidate_discovery.js' },
  { name: 'V2 AgentAdapter & Observability Tests', file: 'test_agent_adapter.js' }
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
