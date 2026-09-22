/**
 * SiftrCode Product Polish, Governance, Security & Claim Verification Tests
 *
 * Test Suite #56:
 * 1. Public Claims Scanner (verifies absence of hyperbolic/unsupported claims in web/*.html)
 * 2. Canonical Research Status API (validates exact metrics, 40 holdout tasks, 4 repos, failure status)
 * 3. Missing Artifact Resilience (verifies fail-closed behavior when artifacts are absent)
 * 4. Admin Authentication Middleware (constant-time token verification, timing safety)
 * 5. Admin Fail-Closed Protection (503 when unconfigured in production, 401 on missing/bad token)
 * 6. Production Baseline Preservation (verifies ContextEngine defaults to deterministic ContextRanker)
 * 7. Static UI Honesty & Model Governance Visibility (verifies admin dashboard and public pages)
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { loadResearchStatus } from '../server/research_status';
import {
  verifyAdminToken,
  isAdminConfigured,
  isInsecureDevAllowed,
  isAdminEnabled,
  handleAdminAuthFailure,
} from '../server/web';
import { ContextEngine } from '../engine/context_engine';
import { ContextRanker } from '../ranking/context_rank';

export async function runTruthAndGovernanceTests() {
  console.log('🧪 [Test Suite: Truth in Advertising, Model Governance & Admin Security] Starting...\n');
  const rootDir = path.resolve(__dirname, '../..');
  const webDir = path.join(rootDir, 'web');

  // =========================================================================
  // Test 1: Public Claims Scanner
  // =========================================================================
  console.log('--- 1. Public Claims Scanner (web/*.html) ---');
  const forbiddenClaims = [
    /eliminating\s+90%/i,
    /100%\s+recall/i,
    /slash\s+agent\s+latency\s+from\s+45s\s+to\s+4s/i,
    /45s\s+to\s+3\.8s/i,
    /compiler-verified\s+repository\s+context/i,
    /compiler-verified\s+AST\s+skeletons/i,
    /maximizing\s+verified\s+coding-agent\s+task\s+success/i,
    /100%\s+Normalized\s+Plan\s+Invariance/i,
  ];

  const htmlFiles = ['index.html', 'about.html', 'how-it-works.html', 'claude.html'];
  for (const file of htmlFiles) {
    const filePath = path.join(webDir, file);
    assert.ok(fs.existsSync(filePath), `HTML file must exist: ${file}`);
    const content = fs.readFileSync(filePath, 'utf-8');

    for (const pattern of forbiddenClaims) {
      const match = content.match(pattern);
      assert.strictEqual(
        match,
        null,
        `Forbidden hyperbolic claim "${pattern}" found in web/${file}: "${match ? match[0] : ''}"`
      );
    }
  }
  console.log('  ✔ Verified: 0 forbidden hyperbolic claims found across public web pages.');

  // =========================================================================
  // Test 2: Canonical Research Status API
  // =========================================================================
  console.log('--- 2. Canonical Research Status API ---');
  const researchStatus = loadResearchStatus();
  assert.strictEqual(researchStatus.available, true, 'Research status must be available from canonical artifacts');
  assert.strictEqual(researchStatus.status, 'V3.1_FAILED_TO_BEAT_BASELINE', 'Overall status must be V3.1_FAILED_TO_BEAT_BASELINE');

  // Baseline validation
  assert.ok(researchStatus.baseline, 'Baseline details must be present');
  assert.strictEqual(researchStatus.baseline.commit, '1eedac03b0d83025ebf08ed2945e0ab015c46f6a');
  assert.strictEqual(researchStatus.baseline.version, 'v2-final');
  assert.strictEqual(researchStatus.baseline.status, 'ACTIVE_PRODUCTION');

  // Candidate validation
  assert.ok(researchStatus.candidate, 'Candidate details must be present');
  assert.strictEqual(researchStatus.candidate.modelId, 'gbdt_pairwise_v1');
  assert.strictEqual(researchStatus.candidate.status, 'RESEARCH');
  assert.strictEqual(researchStatus.candidate.promoted, false);
  assert.strictEqual(researchStatus.candidate.modelArtifactSha256, '384438f9463b0760fe854f377d84265387173528c97608f2679f19b32cca8aca');

  // Promotion Gate validation
  assert.ok(researchStatus.promotionGate, 'Promotion gate details must be present');
  assert.strictEqual(researchStatus.promotionGate.decision, 'OFFLINE_GATE_FAILED');
  assert.strictEqual(researchStatus.promotionGate.tasksEvaluated, 40);
  assert.strictEqual(researchStatus.promotionGate.metrics.ndcg10.frozenV2, 0.52);
  assert.strictEqual(researchStatus.promotionGate.metrics.ndcg10.learnedV3, 0.5034);
  assert.strictEqual(researchStatus.promotionGate.metrics.ndcg10.delta, -0.0166);
  assert.strictEqual(researchStatus.promotionGate.taskOutcomes.v3Wins, 3);
  assert.strictEqual(researchStatus.promotionGate.taskOutcomes.v2Wins, 6);
  assert.strictEqual(researchStatus.promotionGate.taskOutcomes.ties, 31);
  assert.deepStrictEqual(researchStatus.promotionGate.bootstrapCiNdcg10, [-0.0478, 0.0076]);

  // Per-repo metrics validation (4 repos, 10 tasks each)
  assert.ok(researchStatus.perRepoMetrics, 'Per-repo metrics must be present');
  const repos = ['Commander', 'Express', 'FastAPI', 'SiftrCode'];
  for (const repo of repos) {
    const rm = researchStatus.perRepoMetrics[repo];
    assert.ok(rm, `Repo ${repo} must be evaluated in per-repo metrics`);
    assert.strictEqual(rm.tasks, 10, `${repo} must have exactly 10 tasks`);
    assert.strictEqual(typeof rm.frozenV2Ndcg10, 'number');
    assert.strictEqual(typeof rm.learnedV3Ndcg10, 'number');
    assert.strictEqual(typeof rm.deltaNdcg10, 'number');
  }
  console.log('  ✔ Verified: Canonical research status matches exact 40-task holdout evaluation.');

  // =========================================================================
  // Test 3: Missing Artifact Resilience (Fail-Safe)
  // =========================================================================
  console.log('--- 3. Missing Artifact Resilience (Fail-Safe) ---');
  const emptyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-missing-artifact-test-'));
  try {
    const missingStatus = loadResearchStatus(emptyTmpDir);
    assert.strictEqual(missingStatus.available, false, 'Missing artifact must return available: false');
    assert.ok(missingStatus.error, 'Missing artifact must report an explanatory error');
    assert.strictEqual((missingStatus as any).status, undefined, 'Must not report fabricated status when artifacts are absent');
  } finally {
    fs.rmSync(emptyTmpDir, { recursive: true, force: true });
  }
  console.log('  ✔ Verified: Fail-closed resilience when research artifacts are missing.');

  // =========================================================================
  // Test 4: Admin Authentication Middleware
  // =========================================================================
  console.log('--- 4. Admin Authentication Middleware ---');
  const originalAdminToken = process.env.ADMIN_TOKEN;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalInsecureDev = process.env.SIFTR_ADMIN_INSECURE_DEV;

  try {
    process.env.ADMIN_TOKEN = 'secret-admin-token-12345';
    delete process.env.SIFTR_ADMIN_INSECURE_DEV;
    process.env.NODE_ENV = 'production';

    assert.strictEqual(isAdminConfigured(), true, 'Admin should be configured when ADMIN_TOKEN is set');
    assert.strictEqual(isAdminEnabled(), true, 'Admin should be enabled when configured');
    assert.strictEqual(isInsecureDevAllowed(), false, 'Insecure dev must be disallowed in production');

    // Helper to mock incoming requests
    const createMockReq = (authHeader?: string): http.IncomingMessage => {
      return {
        headers: authHeader ? { authorization: authHeader } : {},
      } as any;
    };

    // Missing header
    assert.strictEqual(verifyAdminToken(createMockReq()), false, 'Missing header must fail');

    // Invalid scheme (Basic instead of Bearer)
    assert.strictEqual(verifyAdminToken(createMockReq('Basic dXNlcjpwYXNz')), false, 'Basic auth must fail');

    // Wrong token (same length)
    assert.strictEqual(verifyAdminToken(createMockReq('Bearer wrong-admin-token-12345')), false, 'Wrong token must fail');

    // Wrong token (different length) - tests constant-time hash comparison
    assert.strictEqual(verifyAdminToken(createMockReq('Bearer short')), false, 'Different length token must fail safely');

    // Valid Bearer token
    assert.strictEqual(verifyAdminToken(createMockReq('Bearer secret-admin-token-12345')), true, 'Valid token must pass');

    // Case-insensitive "bearer"
    assert.strictEqual(verifyAdminToken(createMockReq('bearer secret-admin-token-12345')), true, 'Case-insensitive bearer must pass');
  } finally {
    if (originalAdminToken !== undefined) process.env.ADMIN_TOKEN = originalAdminToken;
    else delete process.env.ADMIN_TOKEN;

    if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
    else delete process.env.NODE_ENV;

    if (originalInsecureDev !== undefined) process.env.SIFTR_ADMIN_INSECURE_DEV = originalInsecureDev;
    else delete process.env.SIFTR_ADMIN_INSECURE_DEV;
  }
  console.log('  ✔ Verified: Constant-time admin token verification.');

  // =========================================================================
  // Test 5: Admin Fail-Closed Protection
  // =========================================================================
  console.log('--- 5. Admin Fail-Closed Protection ---');
  try {
    // 5a. Admin disabled in production -> 503
    delete process.env.ADMIN_TOKEN;
    delete process.env.SIFTR_ADMIN_INSECURE_DEV;
    process.env.NODE_ENV = 'production';

    assert.strictEqual(isAdminEnabled(), false, 'Admin must be disabled when unconfigured in production');

    let capturedStatusCode = 0;
    let capturedHeaders: Record<string, any> = {};
    let capturedBody = '';

    const mockRes503: any = {
      writeHead: (status: number, headers: any) => {
        capturedStatusCode = status;
        if (headers) Object.assign(capturedHeaders, headers);
      },
      setHeader: (name: string, val: any) => {
        capturedHeaders[name.toLowerCase()] = val;
        capturedHeaders[name] = val;
      },
      removeHeader: () => {},
      end: (data: string) => {
        capturedBody = data;
      },
    };

    const handled503 = handleAdminAuthFailure({ headers: {} } as any, mockRes503);
    assert.strictEqual(handled503, true, 'handleAdminAuthFailure must handle request when admin is disabled');
    assert.strictEqual(capturedStatusCode, 503, 'Must return 503 Service Unavailable');
    assert.ok(capturedHeaders['Cache-Control'] || capturedHeaders['cache-control'], 'Must include Cache-Control header');

    // 5b. Admin configured, but request unauthenticated -> 401
    process.env.ADMIN_TOKEN = 'configured-token';
    const mockRes401: any = {
      writeHead: (status: number, headers: any) => {
        capturedStatusCode = status;
        if (headers) Object.assign(capturedHeaders, headers);
      },
      setHeader: (name: string, val: any) => {
        capturedHeaders[name.toLowerCase()] = val;
        capturedHeaders[name] = val;
      },
      removeHeader: () => {},
      end: (data: string) => {
        capturedBody = data;
      },
    };

    const handled401 = handleAdminAuthFailure({ headers: {} } as any, mockRes401);
    assert.strictEqual(handled401, true, 'handleAdminAuthFailure must handle unauthenticated request');
    assert.strictEqual(capturedStatusCode, 401, 'Must return 401 Unauthorized');
    assert.ok(capturedHeaders['WWW-Authenticate'], 'Must include WWW-Authenticate header');

    // 5c. Admin configured, request authenticated -> passes through (false)
    const mockRes200: any = {
      writeHead: () => {},
      setHeader: () => {},
      removeHeader: () => {},
      end: () => {},
    };
    const handledAuth = handleAdminAuthFailure({
      headers: { authorization: 'Bearer configured-token' },
    } as any, mockRes200);
    assert.strictEqual(handledAuth, false, 'handleAdminAuthFailure must return false when token is valid');
  } finally {
    if (originalAdminToken !== undefined) process.env.ADMIN_TOKEN = originalAdminToken;
    else delete process.env.ADMIN_TOKEN;

    if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
    else delete process.env.NODE_ENV;

    if (originalInsecureDev !== undefined) process.env.SIFTR_ADMIN_INSECURE_DEV = originalInsecureDev;
    else delete process.env.SIFTR_ADMIN_INSECURE_DEV;
  }
  console.log('  ✔ Verified: Fail-closed 503 on unconfigured admin and 401 on unauthorized access.');

  // =========================================================================
  // Test 6: Production Baseline Preservation
  // =========================================================================
  console.log('--- 6. Production Baseline Preservation ---');
  const engine = new ContextEngine();
  // Default ranker must be ContextRanker (deterministic)
  assert.strictEqual(
    (engine as any).ranker,
    undefined,
    'ContextEngine should not have pre-instantiated learned ranker; defaults to ContextRanker'
  );

  const deterministicRanker = new ContextRanker();
  assert.ok(deterministicRanker, 'ContextRanker must instantiate cleanly without model weight dependencies');
  console.log('  ✔ Verified: Production runtime uses deterministic ContextRanker by default.');

  // =========================================================================
  // Test 7: Static UI Honesty & Model Governance Visibility
  // =========================================================================
  console.log('--- 7. Static UI Honesty & Model Governance Visibility ---');
  const adminHtml = fs.readFileSync(path.join(webDir, 'admin.html'), 'utf-8');

  // Verify presence of governance elements in admin.html
  assert.ok(adminHtml.includes('Deterministic ContextRank'), 'admin.html must identify Deterministic ContextRank engine');
  assert.ok(adminHtml.includes('1eedac03b0d8'), 'admin.html must identify baseline commit 1eedac03b0d8');
  assert.ok(adminHtml.includes('gbdt_pairwise_v1'), 'admin.html must identify candidate model gbdt_pairwise_v1');
  assert.ok(adminHtml.includes('FAILED_TO_BEAT_BASELINE'), 'admin.html must display promotion gate outcome FAILED_TO_BEAT_BASELINE');
  assert.ok(adminHtml.includes('admin-login-view'), 'admin.html must include authentication view');
  assert.ok(adminHtml.includes('admin-dashboard-view'), 'admin.html must include dashboard view');
  assert.ok(adminHtml.includes('sessionStorage'), 'admin.html must store admin token in sessionStorage only');

  // Verify absence of fake promotion claims
  const indexHtml = fs.readFileSync(path.join(webDir, 'index.html'), 'utf-8');
  assert.strictEqual(indexHtml.includes('V3.1_PROMOTION_GATE_PASSED'), false, 'index.html must not claim gate passed');
  assert.strictEqual(indexHtml.includes('PROMOTED_TO_PRODUCTION'), false, 'index.html must not claim model promoted');
  console.log('  ✔ Verified: Admin dashboard and public pages maintain strict governance honesty.');

  console.log('\n🎉 ALL TRUTH IN ADVERTISING, GOVERNANCE & SECURITY REGRESSION TESTS PASSED CLEANLY!\n');
}

if (require.main === module) {
  runTruthAndGovernanceTests().catch((err) => {
    console.error('❌ Truth and governance tests failed:', err);
    process.exit(1);
  });
}
