import { ContextUnitKind } from '../context/context_unit';

export enum EdgeKind {
  CONTAINS = 'CONTAINS',
  IMPORTS = 'IMPORTS',
  EXPORTS = 'EXPORTS',
  CALLS = 'CALLS',
  REFERENCES = 'REFERENCES',
  IMPLEMENTS = 'IMPLEMENTS',
  INHERITS = 'INHERITS',
  TYPE_USES = 'TYPE_USES',
  TESTS = 'TESTS',
  CONFIGURES = 'CONFIGURES',
  GENERATED_FROM = 'GENERATED_FROM',
  DECLARED_IN = 'DECLARED_IN',
  CO_CHANGES = 'CO_CHANGES',
  MENTIONS = 'MENTIONS',
  FAILS_IN = 'FAILS_IN',
  MODIFIES = 'MODIFIES',
}

export interface GraphNode {
  contextUnitId: string;
  kind: ContextUnitKind;
  workspaceSnapshotId: string;
  repositoryId?: string;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: number;
  source: 'compiler' | 'scip' | 'tree-sitter' | 'git' | 'runtime' | 'heuristic';
  weight?: number;
  metadata?: Record<string, unknown>;
}

export class ContextGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private outgoing: Map<string, GraphEdge[]> = new Map();
  private incoming: Map<string, GraphEdge[]> = new Map();

  public addNode(node: GraphNode): void {
    this.nodes.set(node.contextUnitId, { ...node });
    if (!this.outgoing.has(node.contextUnitId)) {
      this.outgoing.set(node.contextUnitId, []);
    }
    if (!this.incoming.has(node.contextUnitId)) {
      this.incoming.set(node.contextUnitId, []);
    }
  }

  public getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  public hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  public getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  public addEdge(edge: GraphEdge): void {
    if (!this.outgoing.has(edge.from)) {
      this.outgoing.set(edge.from, []);
    }
    if (!this.incoming.has(edge.to)) {
      this.incoming.set(edge.to, []);
    }

    // Avoid exact duplicates
    const outList = this.outgoing.get(edge.from)!;
    const exists = outList.some((e) => e.to === edge.to && e.kind === edge.kind);
    if (!exists) {
      outList.push(edge);
      this.incoming.get(edge.to)!.push(edge);
    }
  }

  public getOutgoing(fromId: string, edgeKinds?: EdgeKind[]): GraphEdge[] {
    const edges = this.outgoing.get(fromId) || [];
    if (!edgeKinds || edgeKinds.length === 0) return [...edges];
    const kindSet = new Set(edgeKinds);
    return edges.filter((e) => kindSet.has(e.kind));
  }

  public getIncoming(toId: string, edgeKinds?: EdgeKind[]): GraphEdge[] {
    const edges = this.incoming.get(toId) || [];
    if (!edgeKinds || edgeKinds.length === 0) return [...edges];
    const kindSet = new Set(edgeKinds);
    return edges.filter((e) => kindSet.has(e.kind));
  }

  public getAllEdges(): GraphEdge[] {
    const all: GraphEdge[] = [];
    for (const edgeList of this.outgoing.values()) {
      all.push(...edgeList);
    }
    return all;
  }

  /**
   * Computes the shortest graph distance (hop count) between two nodes using BFS.
   * Returns null if no path exists.
   */
  public getShortestDistance(fromId: string, toId: string, maxHops: number = 5): number | null {
    if (fromId === toId) return 0;
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;

    const visited = new Set<string>([fromId]);
    const queue: Array<{ id: string; dist: number }> = [{ id: fromId, dist: 0 }];

    while (queue.length > 0) {
      const { id, dist } = queue.shift()!;
      if (dist >= maxHops) continue;

      const outEdges = this.outgoing.get(id) || [];
      for (const edge of outEdges) {
        if (edge.to === toId) return dist + 1;
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          queue.push({ id: edge.to, dist: dist + 1 });
        }
      }
    }

    return null;
  }

  /**
   * Explores the neighborhood of a node up to maxHops.
   */
  public getNeighborhood(
    startNodeId: string,
    maxHops: number = 2,
    edgeKinds?: EdgeKind[]
  ): Array<{ nodeId: string; distance: number; path: EdgeKind[] }> {
    if (!this.nodes.has(startNodeId)) return [];

    const result: Array<{ nodeId: string; distance: number; path: EdgeKind[] }> = [];
    const visited = new Set<string>([startNodeId]);
    const queue: Array<{ id: string; dist: number; path: EdgeKind[] }> = [
      { id: startNodeId, dist: 0, path: [] },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.id !== startNodeId) {
        result.push({ nodeId: current.id, distance: current.dist, path: current.path });
      }

      if (current.dist >= maxHops) continue;

      const edges = this.getOutgoing(current.id, edgeKinds);
      for (const edge of edges) {
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          queue.push({
            id: edge.to,
            dist: current.dist + 1,
            path: [...current.path, edge.kind],
          });
        }
      }
    }

    return result;
  }
}
