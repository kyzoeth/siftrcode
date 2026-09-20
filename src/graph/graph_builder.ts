import * as fs from 'fs';
import * as path from 'path';
import { ContextUnit, ContextUnitKind, isCodeSymbolUnit, CodeSymbolUnit } from '../context/context_unit';
import { ContextGraph, EdgeKind, GraphNode, GraphEdge } from './context_graph';

export interface GraphBuilderOptions {
  repoDir?: string;
  confidenceThreshold?: number;
}

export class GraphBuilder {
  /**
   * Constructs an Engineering Context Graph from indexed ContextUnits.
   */
  public buildGraph(units: ContextUnit[], options: GraphBuilderOptions = {}): ContextGraph {
    const graph = new ContextGraph();

    // 1. Add all units as GraphNodes
    const fileUnitsByPath = new Map<string, ContextUnit>();
    const symbolsByPath = new Map<string, CodeSymbolUnit[]>();
    const symbolsByName = new Map<string, CodeSymbolUnit[]>();

    for (const unit of units) {
      const node: GraphNode = {
        contextUnitId: unit.id,
        kind: unit.kind,
        workspaceSnapshotId: unit.workspaceSnapshotId,
        repositoryId: unit.repositoryId,
        metadata: {
          path: unit.path,
          title: unit.title,
        },
      };
      graph.addNode(node);

      if (unit.path) {
        const normPath = unit.path.replace(/\\/g, '/');
        if (unit.kind === ContextUnitKind.SOURCE_FILE || unit.kind === ContextUnitKind.TEST || unit.kind === ContextUnitKind.CONFIG || unit.kind === ContextUnitKind.MANIFEST) {
          fileUnitsByPath.set(normPath, unit);
        }

        if (isCodeSymbolUnit(unit)) {
          if (!symbolsByPath.has(normPath)) {
            symbolsByPath.set(normPath, []);
          }
          symbolsByPath.get(normPath)!.push(unit);

          if (!symbolsByName.has(unit.symbolName)) {
            symbolsByName.set(unit.symbolName, []);
          }
          symbolsByName.get(unit.symbolName)!.push(unit);
        }
      }
    }

    // 2. CONTAINS & DECLARED_IN Edges (File <-> Symbol)
    for (const [filePath, symbols] of symbolsByPath.entries()) {
      const fileUnit = fileUnitsByPath.get(filePath);
      if (!fileUnit) continue;

      for (const sym of symbols) {
        graph.addEdge({
          from: fileUnit.id,
          to: sym.id,
          kind: EdgeKind.CONTAINS,
          confidence: 1.0,
          source: 'tree-sitter',
        });

        graph.addEdge({
          from: sym.id,
          to: fileUnit.id,
          kind: EdgeKind.DECLARED_IN,
          confidence: 1.0,
          source: 'tree-sitter',
        });
      }
    }

    // 3. TESTS Edges (Test -> Implementation)
    for (const unit of units) {
      if (unit.kind === ContextUnitKind.TEST && unit.path) {
        const testPath = unit.path.replace(/\\/g, '/');
        // Check matching implementation path, e.g. tests/auth.test.ts -> src/auth.ts
        const baseNameMatch = path.basename(testPath).replace(/\.(test|spec)\.[a-z]+$/, '');
        for (const [implPath, implUnit] of fileUnitsByPath.entries()) {
          if (implUnit.kind === ContextUnitKind.SOURCE_FILE) {
            const implBase = path.basename(implPath).replace(/\.[a-z]+$/, '');
            if (implBase === baseNameMatch) {
              graph.addEdge({
                from: unit.id,
                to: implUnit.id,
                kind: EdgeKind.TESTS,
                confidence: 0.95,
                source: 'heuristic',
              });

              // Also link test to symbols in that implementation file
              const implSymbols = symbolsByPath.get(implPath) || [];
              for (const sym of implSymbols) {
                graph.addEdge({
                  from: unit.id,
                  to: sym.id,
                  kind: EdgeKind.TESTS,
                  confidence: 0.9,
                  source: 'heuristic',
                });
              }
            }
          }
        }
      }
    }

    // 4. CONFIGURES Edges (Config/Manifest -> Files)
    const manifestsAndConfigs = units.filter(
      (u) => u.kind === ContextUnitKind.MANIFEST || u.kind === ContextUnitKind.CONFIG
    );
    for (const cfg of manifestsAndConfigs) {
      if (!cfg.path) continue;
      const cfgDir = path.dirname(cfg.path.replace(/\\/g, '/'));

      for (const [filePath, fileUnit] of fileUnitsByPath.entries()) {
        if (filePath === cfg.path) continue;
        if (filePath.startsWith(cfgDir === '.' ? '' : cfgDir)) {
          graph.addEdge({
            from: cfg.id,
            to: fileUnit.id,
            kind: EdgeKind.CONFIGURES,
            confidence: 0.8,
            source: 'heuristic',
          });
        }
      }
    }

    // 5. CALLS, REFERENCES, IMPORTS, IMPLEMENTS between symbols and files
    if (options.repoDir && fs.existsSync(options.repoDir)) {
      this.enrichFromSourceCode(options.repoDir, fileUnitsByPath, symbolsByPath, symbolsByName, graph);
    }

    return graph;
  }

  private enrichFromSourceCode(
    repoDir: string,
    fileUnitsByPath: Map<string, ContextUnit>,
    symbolsByPath: Map<string, CodeSymbolUnit[]>,
    symbolsByName: Map<string, CodeSymbolUnit[]>,
    graph: ContextGraph
  ): void {
    for (const [filePath, fileUnit] of fileUnitsByPath.entries()) {
      const fullPath = path.join(repoDir, filePath);
      if (!fs.existsSync(fullPath)) continue;

      let code = '';
      try {
        code = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      // Detect imports
      const importMatches = code.matchAll(/(?:import|require|from)\s+['"]([^'"]+)['"]/g);
      for (const match of importMatches) {
        const importTarget = match[1];
        if (importTarget.startsWith('.')) {
          const resolvedRel = path
            .normalize(path.join(path.dirname(filePath), importTarget))
            .replace(/\\/g, '/');

          // Match against known file paths
          for (const [targetPath, targetUnit] of fileUnitsByPath.entries()) {
            const targetNoExt = targetPath.replace(/\.[^/.]+$/, '');
            if (targetNoExt === resolvedRel || targetPath === resolvedRel) {
              graph.addEdge({
                from: fileUnit.id,
                to: targetUnit.id,
                kind: EdgeKind.IMPORTS,
                confidence: 0.95,
                source: 'tree-sitter',
              });
            }
          }
        }
      }

      // Check symbol references and calls
      const fileSymbols = symbolsByPath.get(filePath) || [];
      for (const sym of fileSymbols) {
        // If signature contains 'implements' or 'extends'
        if (sym.signature) {
          const implMatch = sym.signature.match(/implements\s+([A-Za-z0-9_,\s]+)/);
          if (implMatch) {
            const ifaceNames = implMatch[1].split(',').map((s) => s.trim());
            for (const ifaceName of ifaceNames) {
              const targets = symbolsByName.get(ifaceName) || [];
              for (const target of targets) {
                graph.addEdge({
                  from: sym.id,
                  to: target.id,
                  kind: EdgeKind.IMPLEMENTS,
                  confidence: 0.95,
                  source: 'compiler',
                });
              }
            }
          }

          const extendsMatch = sym.signature.match(/extends\s+([A-Za-z0-9_]+)/);
          if (extendsMatch) {
            const baseClass = extendsMatch[1].trim();
            const targets = symbolsByName.get(baseClass) || [];
            for (const target of targets) {
              graph.addEdge({
                from: sym.id,
                to: target.id,
                kind: EdgeKind.INHERITS,
                confidence: 0.95,
                source: 'compiler',
              });
            }
          }
        }
      }
    }
  }
}
