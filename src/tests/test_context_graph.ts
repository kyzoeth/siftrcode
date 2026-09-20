import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContextGraph, EdgeKind } from '../graph/context_graph';
import { GraphBuilder } from '../graph/graph_builder';
import { RepositoryIndexer } from '../indexing/repository_index';
import { ContextUnitKind } from '../context/context_unit';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

async function runGraphTests() {
  console.log('🧪 Testing Engineering Context Graph & GraphBuilder...\n');

  // 1. ContextGraph Primitive Operations & Algorithms
  console.log('--- 1. ContextGraph Primitive Operations & BFS ---');
  const graph = new ContextGraph();

  graph.addNode({ contextUnitId: 'node_a', kind: ContextUnitKind.SOURCE_FILE, workspaceSnapshotId: 'ws1', metadata: {} });
  graph.addNode({ contextUnitId: 'node_b', kind: ContextUnitKind.CODE_SYMBOL, workspaceSnapshotId: 'ws1', metadata: {} });
  graph.addNode({ contextUnitId: 'node_c', kind: ContextUnitKind.CODE_SYMBOL, workspaceSnapshotId: 'ws1', metadata: {} });
  graph.addNode({ contextUnitId: 'node_d', kind: ContextUnitKind.SOURCE_FILE, workspaceSnapshotId: 'ws1', metadata: {} });

  graph.addEdge({ from: 'node_a', to: 'node_b', kind: EdgeKind.CONTAINS, confidence: 1.0, source: 'compiler' });
  graph.addEdge({ from: 'node_b', to: 'node_c', kind: EdgeKind.CALLS, confidence: 0.9, source: 'compiler' });

  assert(graph.getAllNodes().length === 4, 'Graph contains 4 nodes');
  assert(graph.getOutgoing('node_a').length === 1, 'node_a has 1 outgoing edge');
  assert(graph.getIncoming('node_b').length === 1, 'node_b has 1 incoming edge');
  assert(graph.getOutgoing('node_a', [EdgeKind.CONTAINS]).length === 1, 'Filter outgoing by CONTAINS');
  assert(graph.getOutgoing('node_a', [EdgeKind.CALLS]).length === 0, 'Filter outgoing by CALLS returns 0');

  // BFS Shortest Distance
  assert(graph.getShortestDistance('node_a', 'node_b') === 1, 'Distance node_a -> node_b is 1');
  assert(graph.getShortestDistance('node_a', 'node_c') === 2, 'Distance node_a -> node_c is 2');
  assert(graph.getShortestDistance('node_a', 'node_d') === null, 'Distance to unreachable node_d is null');

  // Neighborhood Expansion
  const neighbors = graph.getNeighborhood('node_a', 2);
  assert(neighbors.length === 2, 'Neighborhood up to 2 hops contains 2 nodes');
  assert(neighbors.some(n => n.nodeId === 'node_b' && n.distance === 1), 'Neighborhood contains node_b at distance 1');
  assert(neighbors.some(n => n.nodeId === 'node_c' && n.distance === 2), 'Neighborhood contains node_c at distance 2');

  // 2. GraphBuilder Integration with Indexed Fixture Repository
  console.log('\n--- 2. GraphBuilder Integration with Fixture ---');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-test-graph-'));
  const srcDir = path.join(tempDir, 'src');
  const testDir = path.join(tempDir, 'tests');

  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });

  fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name": "graph-test"}\n');
  fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), '{"compilerOptions": {}}\n');

  // db.ts
  fs.writeFileSync(
    path.join(srcDir, 'db.ts'),
    `
export interface Database {
  query(sql: string): any;
}
`
  );

  // user.ts
  fs.writeFileSync(
    path.join(srcDir, 'user.ts'),
    `
import { Database } from './db';

export class UserService implements Database {
  public query(sql: string): any {
    return null;
  }

  public getUser(id: string): any {
    return this.query("SELECT *");
  }
}
`
  );

  // user.test.ts
  fs.writeFileSync(
    path.join(testDir, 'user.test.ts'),
    `
import { UserService } from '../src/user';

describe("UserService", () => {
  it("fetches user", () => {});
});
`
  );

  try {
    const indexer = new RepositoryIndexer();
    const indexResult = await indexer.indexRepository(tempDir, {
      repositoryId: 'graph-repo',
      workspaceSnapshotId: 'snap_graph_1',
    });

    const builder = new GraphBuilder();
    const fixtureGraph = builder.buildGraph(indexResult.units, { repoDir: tempDir });

    const allEdges = fixtureGraph.getAllEdges();
    assert(allEdges.length > 0, `Built graph with ${allEdges.length} edges`);

    // Verify CONTAINS edges
    const containsEdges = allEdges.filter(e => e.kind === EdgeKind.CONTAINS);
    assert(containsEdges.length >= 3, `Contains at least 3 CONTAINS edges (got ${containsEdges.length})`);

    // Verify DECLARED_IN edges
    const declaredEdges = allEdges.filter(e => e.kind === EdgeKind.DECLARED_IN);
    assert(declaredEdges.length >= 3, `Contains reciprocal DECLARED_IN edges`);

    // Verify IMPORTS edge (user.ts -> db.ts)
    const userFileUnit = indexResult.units.find(u => u.path === 'src/user.ts' && u.kind === ContextUnitKind.SOURCE_FILE)!;
    const dbFileUnit = indexResult.units.find(u => u.path === 'src/db.ts' && u.kind === ContextUnitKind.SOURCE_FILE)!;
    const userImports = fixtureGraph.getOutgoing(userFileUnit.id, [EdgeKind.IMPORTS]);
    assert(userImports.some(e => e.to === dbFileUnit.id), 'user.ts IMPORTS db.ts');

    // Verify TESTS edge (user.test.ts -> user.ts)
    const testUnit = indexResult.units.find(u => u.path === 'tests/user.test.ts' && u.kind === ContextUnitKind.TEST)!;
    const testEdges = fixtureGraph.getOutgoing(testUnit.id, [EdgeKind.TESTS]);
    assert(testEdges.some(e => e.to === userFileUnit.id), 'user.test.ts TESTS user.ts');

    // Verify IMPLEMENTS edge (UserService -> Database)
    const userServiceSym = indexResult.units.find(u => u.title === 'UserService')!;
    const dbInterfaceSym = indexResult.units.find(u => u.title === 'Database')!;
    const implEdges = fixtureGraph.getOutgoing(userServiceSym.id, [EdgeKind.IMPLEMENTS]);
    assert(implEdges.some(e => e.to === dbInterfaceSym.id), 'UserService IMPLEMENTS Database');

    // Verify CONFIGURES edges
    const tsconfigUnit = indexResult.units.find(u => u.path === 'tsconfig.json')!;
    const configEdges = fixtureGraph.getOutgoing(tsconfigUnit.id, [EdgeKind.CONFIGURES]);
    assert(configEdges.length > 0, 'tsconfig.json CONFIGURES repository files');

    console.log('\n🎉 All Engineering Context Graph tests passed successfully!');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

runGraphTests().catch((err) => {
  console.error('❌ Graph test failed:', err);
  process.exit(1);
});
