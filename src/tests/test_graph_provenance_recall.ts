import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContextGraph, EdgeKind } from '../graph/context_graph';
import { GraphBuilder } from '../graph/graph_builder';
import { ScipIndexer, ScipIngestionPolicy } from '../graph/scip_indexer';
import { RepositoryIndexer } from '../indexing/repository_index';
import { CandidateGenerator } from '../retrieval/candidate_generator';
import { ContextUnitKind } from '../context/context_unit';
import { TaskContext, createTaskContext } from '../context/task_context';
import { TaskEvidenceKind, UserPromptEvidence } from '../context/task_evidence';
import { createAgentEnvironment } from '../agents/agent_environment';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

async function runGraphProvenanceAndRecallTests() {
  console.log('\n=== Running V2 Graph Provenance, High-Value Edges & Recall Tests (Remediation PR 9) ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-pr9-graph-'));
  const srcDir = path.join(tempDir, 'src');
  const testDir = path.join(tempDir, 'tests');

  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });

  fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name": "pr9-graph-test"}\n');
  fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), '{"compilerOptions": {}}\n');

  // 1. types.ts - Defines interfaces and types
  fs.writeFileSync(
    path.join(srcDir, 'types.ts'),
    `
export interface UserSession {
  userId: string;
  token: string;
  expiresAt: number;
}

export interface Authenticator {
  authenticate(token: string): UserSession | null;
  revoke(userId: string): void;
}
`
  );

  // 2. token_store.ts - Token storage layer
  fs.writeFileSync(
    path.join(srcDir, 'token_store.ts'),
    `
import { UserSession } from './types';

export class TokenStore {
  private cache = new Map<string, UserSession>();

  public save(session: UserSession): void {
    this.cache.set(session.token, session);
  }

  public find(token: string): UserSession | null {
    return this.cache.get(token) || null;
  }
}
`
  );

  // 3. auth_service.ts - Implements Authenticator, calls TokenStore, uses types
  fs.writeFileSync(
    path.join(srcDir, 'auth_service.ts'),
    `
import { Authenticator, UserSession } from './types';
import { TokenStore } from './token_store';

export class AuthService implements Authenticator {
  private store: TokenStore;

  constructor() {
    this.store = new TokenStore();
  }

  public validateToken(rawToken: string): boolean {
    const session = this.store.find(rawToken);
    return session !== null;
  }

  public authenticate(token: string): UserSession | null {
    const valid = this.validateToken(token);
    if (!valid) return null;
    return this.store.find(token);
  }

  public revoke(userId: string): void {
    // Revocation implementation
  }
}
`
  );

  // 4. auth_service.test.ts - Test file for auth service
  fs.writeFileSync(
    path.join(testDir, 'auth_service.test.ts'),
    `
import { AuthService } from '../src/auth_service';

describe("AuthService", () => {
  it("authenticates token", () => {
    const auth = new AuthService();
  });
});
`
  );

  // 5. python_script.py - Non-TypeScript file to verify truthful heuristic fallback
  fs.writeFileSync(
    path.join(srcDir, 'helper.py'),
    `
class PythonHelper:
    def process_data(self, data):
        return data
`
  );

  try {
    const indexer = new RepositoryIndexer();
    const indexResult = await indexer.indexRepository(tempDir, {
      repositoryId: 'pr9-repo',
      workspaceSnapshotId: 'snap_pr9_1',
    });

    // =========================================================================
    // TEST 1: Truthful Edge Source Provenance (Section 32)
    // =========================================================================
    console.log('--- 1. Truthful Edge Source Provenance (Section 32) ---');

    const builder = new GraphBuilder();
    const graph = builder.buildGraph(indexResult.units, {
      repoDir: tempDir,
      scipPolicy: ScipIngestionPolicy.DISABLED,
    });

    const allEdges = graph.getAllEdges();
    assert(allEdges.length > 0, `Graph constructed with ${allEdges.length} edges`);

    // Compiler AST edges
    const compilerEdges = allEdges.filter((e) => e.source === 'compiler');
    assert(compilerEdges.length > 0, `Extracted ${compilerEdges.length} true compiler AST edges`);

    // Heuristic edges
    const heuristicEdges = allEdges.filter((e) => e.source === 'heuristic');
    assert(heuristicEdges.length > 0, `Extracted ${heuristicEdges.length} truthful heuristic edges`);

    // Provenance Verification: No regex-derived edge should falsely claim 'tree-sitter' or 'compiler'
    const testsEdges = allEdges.filter((e) => e.kind === EdgeKind.TESTS);
    assert(testsEdges.length > 0, 'Found TESTS edges');
    for (const te of testsEdges) {
      assert(te.source === 'heuristic', `TESTS edge source must strictly be 'heuristic', got '${te.source}'`);
    }

    const configEdges = allEdges.filter((e) => e.kind === EdgeKind.CONFIGURES);
    assert(configEdges.length > 0, 'Found CONFIGURES edges');
    for (const ce of configEdges) {
      assert(ce.source === 'heuristic', `CONFIGURES edge source must strictly be 'heuristic', got '${ce.source}'`);
    }

    // Python symbol edges must be 'heuristic', never falsely 'compiler'
    const pyUnit = indexResult.units.find((u) => u.path === 'src/helper.py' && u.kind === ContextUnitKind.SOURCE_FILE);
    if (pyUnit) {
      const pyEdges = graph.getOutgoing(pyUnit.id);
      for (const pe of pyEdges) {
        assert(pe.source === 'heuristic', `Non-TS file edge source must be 'heuristic', got '${pe.source}'`);
      }
    }

    // =========================================================================
    // TEST 2: Missing High-Value Edge Types (Section 33: CALLS, TYPE_USES, REFERENCES)
    // =========================================================================
    console.log('\n--- 2. High-Value Edge Extraction (Section 33: CALLS, TYPE_USES, REFERENCES) ---');

    const callsEdges = allEdges.filter((e) => e.kind === EdgeKind.CALLS);
    assert(callsEdges.length > 0, `Extracted ${callsEdges.length} CALLS edges`);

    // Verify intra-class and cross-class calls
    const authServiceSym = indexResult.units.find((u) => u.title === 'AuthService')!;
    const authenticateMethod = indexResult.units.find((u) => u.title === 'AuthService.authenticate' || u.title === 'authenticate')!;
    const validateTokenMethod = indexResult.units.find((u) => u.title === 'AuthService.validateToken' || u.title === 'validateToken')!;
    const findMethod = indexResult.units.find((u) => u.title === 'TokenStore.find' || u.title === 'find')!;

    // authenticate calls validateToken
    const authOutgoingCalls = graph.getOutgoing(authenticateMethod.id, [EdgeKind.CALLS]);
    assert(
      authOutgoingCalls.some((e) => e.to === validateTokenMethod.id),
      'AuthService.authenticate has CALLS edge to AuthService.validateToken'
    );
    assert(
      authOutgoingCalls.some((e) => e.to === findMethod.id),
      'AuthService.authenticate has CALLS edge to TokenStore.find'
    );

    // Verify TYPE_USES edges
    const typeUsesEdges = allEdges.filter((e) => e.kind === EdgeKind.TYPE_USES);
    assert(typeUsesEdges.length > 0, `Extracted ${typeUsesEdges.length} TYPE_USES edges`);

    const authenticatorInterface = indexResult.units.find((u) => u.title === 'Authenticator')!;
    const userSessionInterface = indexResult.units.find((u) => u.title === 'UserSession')!;

    // AuthService uses Authenticator (via implements)
    const authTypeUses = graph.getOutgoing(authServiceSym.id, [EdgeKind.TYPE_USES]);
    assert(
      authTypeUses.some((e) => e.to === authenticatorInterface.id),
      'AuthService has TYPE_USES edge to Authenticator interface'
    );

    // TokenStore or AuthService uses UserSession
    const allSessionUsers = allEdges.filter((e) => e.to === userSessionInterface.id && e.kind === EdgeKind.TYPE_USES);
    assert(
      allSessionUsers.length > 0,
      'UserSession has incoming TYPE_USES edges from classes referencing it as type'
    );

    // Verify REFERENCES edges
    const referencesEdges = allEdges.filter((e) => e.kind === EdgeKind.REFERENCES);
    assert(referencesEdges.length > 0, `Extracted ${referencesEdges.length} REFERENCES edges`);

    // =========================================================================
    // TEST 3: Optional SCIP Ingestion & Policy Handling (Section 35)
    // =========================================================================
    console.log('\n--- 3. Optional SCIP Ingestion & Policy Handling (Section 35) ---');

    const scipIndexer = new ScipIndexer();

    // 3a. Policy: DISABLED -> Skips cleanly
    const disabledResult = scipIndexer.ingestScip(graph, indexResult.units, {
      repoDir: tempDir,
      policy: ScipIngestionPolicy.DISABLED,
    });
    assert(disabledResult.status === 'DISABLED', 'DISABLED policy returns status DISABLED');
    assert(disabledResult.ingestedEdgesCount === 0, 'DISABLED policy ingests 0 edges');

    // 3b. Policy: BEST_EFFORT_LOCAL when SCIP index absent -> Doesn't block, returns SKIPPED_NOT_FOUND
    const bestEffortMissing = scipIndexer.ingestScip(graph, indexResult.units, {
      repoDir: tempDir,
      policy: ScipIngestionPolicy.BEST_EFFORT_LOCAL,
    });
    assert(
      bestEffortMissing.status === 'SKIPPED_NOT_FOUND',
      'BEST_EFFORT_LOCAL without SCIP index returns SKIPPED_NOT_FOUND without throwing'
    );

    // 3c. Policy: CI_PRECISE when SCIP index absent -> Throws error
    let ciThrew = false;
    try {
      scipIndexer.ingestScip(graph, indexResult.units, {
        repoDir: tempDir,
        policy: ScipIngestionPolicy.CI_PRECISE,
      });
    } catch (err: any) {
      ciThrew = true;
      assert(err.message.includes('CI_PRECISE policy violation'), 'CI_PRECISE throws informative policy violation error');
    }
    assert(ciThrew, 'CI_PRECISE policy strictly throws when SCIP index is missing');

    // 3d. Policy: BEST_EFFORT_LOCAL when SCIP index is present -> Ingests with source: 'scip'
    const scipJsonPath = path.join(tempDir, 'scip.json');
    fs.writeFileSync(
      scipJsonPath,
      JSON.stringify({
        metadata: { version: 1 },
        documents: [
          {
            relative_path: 'src/auth_service.ts',
            occurrences: [
              {
                range: [10, 2, 10, 15],
                symbol: 'scip-typescript npm @siftr/test 1.0.0 src/token_store/TokenStore#',
                symbolRoles: 8, // Read reference
              },
            ],
            symbols: [
              {
                symbol: 'scip-typescript npm @siftr/test 1.0.0 src/auth_service/AuthService#',
                relationships: [
                  {
                    symbol: 'scip-typescript npm @siftr/test 1.0.0 src/types/Authenticator#',
                    isImplementation: true,
                  },
                ],
              },
            ],
          },
        ],
      })
    );

    const scipGraph = new ContextGraph();
    // Add nodes to scipGraph
    for (const u of indexResult.units) {
      scipGraph.addNode({
        contextUnitId: u.id,
        kind: u.kind,
        workspaceSnapshotId: u.workspaceSnapshotId,
        metadata: { path: u.path, title: u.title },
      });
    }

    const scipIngestResult = scipIndexer.ingestScip(scipGraph, indexResult.units, {
      repoDir: tempDir,
      policy: ScipIngestionPolicy.BEST_EFFORT_LOCAL,
    });
    assert(scipIngestResult.status === 'INGESTED', 'SCIP index ingested successfully');
    assert(scipIngestResult.ingestedEdgesCount > 0, `Ingested ${scipIngestResult.ingestedEdgesCount} SCIP edges`);

    const scipEdges = scipGraph.getAllEdges().filter((e) => e.source === 'scip');
    assert(scipEdges.length > 0, `Verified SCIP edges have truthful source: 'scip'`);
    assert(
      scipEdges.some((e) => e.kind === EdgeKind.IMPLEMENTS),
      'SCIP relationship mapped to IMPLEMENTS edge'
    );

    // =========================================================================
    // TEST 4: Candidate Recall Ablation Measurement (Section 34)
    // =========================================================================
    console.log('\n--- 4. Candidate Recall Ablation Measurement (Section 34) ---');

    // Simulate task: User wants to debug token expiration issue in AuthService
    const promptEvidence: UserPromptEvidence = {
      evidenceId: 'ev_prompt_1',
      kind: TaskEvidenceKind.USER_PROMPT,
      timestamp: new Date().toISOString(),
      prompt: 'Fix authentication failure when validating token in AuthService',
    };

    const task: TaskContext = createTaskContext({
      taskId: 'task_ablation_test',
      workspaceSnapshotId: 'snap_pr9_1',
      primaryPrompt: promptEvidence.prompt,
      evidence: [promptEvidence],
      agentEnvironment: createAgentEnvironment({
        agentProvider: 'anthropic',
        agentVersion: '1.0.0',
        model: 'claude-3-5-sonnet',
        harnessVersion: '2.1.0',
        availableTools: ['bash', 'glob'],
      }),
    });

    // Ground truth: The task requires modifying TokenStore, UserSession, and Authenticator
    const tokenStoreUnit = indexResult.units.find((u) => u.title === 'TokenStore')!;
    const userSessionUnit = indexResult.units.find((u) => u.title === 'UserSession')!;
    const groundTruthIds = [tokenStoreUnit.id, userSessionUnit.id];

    const generator = new CandidateGenerator();
    const ablationReport = generator.evaluateRecallAblation(task, indexResult.units, graph, groundTruthIds);

    console.log('  ➔ Candidate Recall Ablation Steps:');
    for (const step of ablationReport.steps) {
      console.log(
        `     - ${step.name.padEnd(22)}: Recall@20=${step.metrics.recallAt20.toFixed(2)}, Recall@50=${step.metrics.recallAt50.toFixed(2)}, Candidates=${step.candidateCount}`
      );
    }
    console.log(`  ➔ Recall Uplift at Recall@20: +${(ablationReport.upliftSummary.upliftAt20 * 100).toFixed(1)}%`);

    // Verify recall properties
    const lexicalStep = ablationReport.steps.find((s) => s.name === 'lexical_baseline')!;
    const fullGraphStep = ablationReport.steps.find((s) => s.name === 'plus_type_uses')!;

    assert(
      fullGraphStep.metrics.recallAt20 >= lexicalStep.metrics.recallAt20,
      'Full graph expansion maintains or improves Recall@20 over lexical baseline'
    );
    assert(
      fullGraphStep.metrics.recallAt20 === 1.0,
      'Full graph with CALLS and TYPE_USES achieves 100% recall for semantically indirect dependencies'
    );

    console.log('\n🎉 All Graph Provenance, High-Value Edges & Recall tests passed successfully!');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

runGraphProvenanceAndRecallTests().catch((err) => {
  console.error('❌ Graph Provenance & Recall test failed:', err);
  process.exit(1);
});
