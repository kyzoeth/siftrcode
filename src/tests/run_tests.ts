import { spawnSync } from 'child_process';
import * as path from 'path';
import { scrubJevTestEnvironment } from '../testing/test_env_scrubber';

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
  { name: 'V2 Durable Observation Store Tests', file: 'test_durable_store.js' },
  { name: 'V2 Agent Observability Truth Tests', file: 'test_agent_observability_truth.js' },
  { name: 'V2 Graph Provenance & Recall Tests', file: 'test_graph_provenance_recall.js' },
  { name: 'V2 JEV JudgmentProvider & Resilience Tests', file: 'test_jev_v2_provider.js' },
  { name: 'V2 OutcomeEvidence Pipeline Tests', file: 'test_outcome_evidence_pipeline.js' },
  { name: 'V2 Rights / Lineage Enforcement Tests', file: 'test_rights_lineage_enforcement.js' },
  { name: 'V2 ContextEngine (End-to-End Orchestration) Tests', file: 'test_context_engine.js' },
  { name: 'V2 CLI & MCP Server Integration Tests', file: 'test_v2_integration.js' },
  { name: 'V2 Multi-Language Symbol Correctness & Spans (PR 0.1) Tests', file: 'test_multi_language_symbols.js' },
  { name: 'V2 WorkspaceSnapshot Immutability & Replanning (PR 0.2) Tests', file: 'test_workspace_immutability.js' },
  { name: 'V2 Observability & AgentEnvironment Truth (PR 0.3) Tests', file: 'test_agent_environment_truth.js' },
  { name: 'V2 Learning Plane Runtime & Decision Observations (PR 0.4) Tests', file: 'test_learning_plane_runtime.js' },
  { name: 'V2 Token Accounting Semantics & Closure Gate (PR 0.5) Tests', file: 'test_token_accounting_semantics.js' },
  { name: 'V2 Audit Remediation Closure (PR 0.6) Tests', file: 'test_audit_remediation_closure.js' },
  { name: 'V2 MCP Learning Loop & Lineage Integrity E2E (PR F7) Tests', file: 'test_mcp_learning_loop_e2e.js' },
  { name: 'V2 JEV Shadow Integration & Learning-Loop Closure (PR J6) Tests', file: 'test_jev_shadow_closure.js' },
  { name: 'V2 Rights, Evidence Tri-State, Telemetry & Study Integrity Regression Tests', file: 'test_rights_evidence_telemetry_regression.js' },
  { name: 'V2 FINAL-3 Remediation Verification Tests', file: 'test_final3_remediation.js' },
  { name: 'V2 FINAL-3.1 Acceptance Integrity & Trustworthiness Tests', file: 'test_final3_1_acceptance.js' },
  { name: 'V2 FINAL-3 Closure & Adversarial Verification E2E Tests', file: 'test_final3_closure_e2e.js' },
  { name: 'V3 Foundation & Baseline Immutability Tests', file: 'test_v3_foundation.js' },
  { name: 'V3 Leakage-Safe Splits & Point-in-Time Safety Tests', file: 'test_v3_leakage_and_splits.js' },
  { name: 'V3 Sanctioned Dataset & Pairwise Ranking Tests', file: 'test_v3_dataset_and_pairs.js' },
  { name: 'V3 Learned ContextRank Models, Fallback & Shadow Tests', file: 'test_v3_models_and_fallback.js' },
  { name: 'V3 Bootstrap Resampling & Verified Outcome Evaluation Tests', file: 'test_v3_bootstrap_and_eval.js' },
  { name: 'V3.1 Experimental Integrity Regressions Tests', file: 'test_v3_experimental_integrity_regressions.js' },
  { name: 'V3.1 Gemini Agent Harness & Sandboxing Tests', file: 'test_gemini_harness.js' }
];


let failed = false;

const isIntegration = process.env.INTEGRATION_TEST === 'true' || process.env.SIFTR_INTEGRATION_TEST === 'true';
const hermeticEnv = { ...process.env };
if (!isIntegration) {
  scrubJevTestEnvironment(hermeticEnv);
}

for (const t of tests) {
  console.log(`▶ Running ${t.name}...`);
  const fullPath = path.join(__dirname, t.file);
  const res = spawnSync('node', [fullPath], { stdio: 'inherit', env: hermeticEnv });
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
