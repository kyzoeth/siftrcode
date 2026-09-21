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
  { name: 'V2 AgentAdapter & Observability Tests', file: 'test_agent_adapter.js' },
  { name: 'V2 Versioned Features (ContextFeaturesV1) Tests', file: 'test_features.js' },
  { name: 'V2 Exposure-Aware Telemetry & Data Rights Tests', file: 'test_telemetry.js' },
  { name: 'V2 ContextRank (Transparent Candidate Ranker) Tests', file: 'test_context_rank.js' },
  { name: 'V2 BundleComposer (Submodular Synergy) Tests', file: 'test_bundle_composer.js' },
  { name: 'V2 ResolutionRank (Variable-Resolution Safety) Tests', file: 'test_resolution_rank.js' },
  { name: 'V2 BudgetSolver (Token & Cost Optimization) Tests', file: 'test_budget_solver.js' },
  { name: 'V2 ContextUnit Materialization & WorkspaceSourceReader Tests', file: 'test_materialization.js' },
  { name: 'V2 Real Token Accounting & Budget Gate Tests', file: 'test_token_accounting.js' },
  { name: 'V2 Real-Pipeline Integration Tests (On-Disk Fixture)', file: 'test_real_pipeline_integration.js' },
  { name: 'V2 Bundle/Resolution Coordination & Capabilities Tests', file: 'test_bundle_resolution_coordination.js' },
  { name: 'V2 Security Hardening & Isolation Tests', file: 'test_security_hardening.js' },
  { name: 'V2 Telemetry Schema V2 & Learning-Plane Tests', file: 'test_telemetry_v2.js' },
  { name: 'V2 ContextEngine (End-to-End Orchestration) Tests', file: 'test_context_engine.js' },
  { name: 'V2 CLI & MCP Server Integration Tests', file: 'test_v2_integration.js' }
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
