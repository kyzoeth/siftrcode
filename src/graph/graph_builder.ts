import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ContextUnit, ContextUnitKind, isCodeSymbolUnit, CodeSymbolUnit } from '../context/context_unit';
import { ContextGraph, EdgeKind, GraphNode, GraphEdge } from './context_graph';
import { ScipIndexer, ScipIngestionPolicy } from './scip_indexer';
import { WorkspaceSourceReader } from '../workspace/workspace_source_reader';
import { WorkspaceSnapshot } from '../workspace/workspace_snapshot';

export interface GraphBuilderOptions {
  repoDir?: string;
  confidenceThreshold?: number;
  scipPolicy?: ScipIngestionPolicy;
  scipIndexPath?: string;
  sourceReader?: WorkspaceSourceReader;
  snapshot?: WorkspaceSnapshot;
}

export class GraphBuilder {
  private scipIndexer = new ScipIndexer();

  /**
   * Constructs an Engineering Context Graph from indexed ContextUnits.
   * Adheres strictly to Section 32 (Truthful Edge Provenance), Section 33 (CALLS,
   * REFERENCES, TYPE_USES), and Section 35 (Optional SCIP Ingestion Policy).
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
        if (
          unit.kind === ContextUnitKind.SOURCE_FILE ||
          unit.kind === ContextUnitKind.TEST ||
          unit.kind === ContextUnitKind.CONFIG ||
          unit.kind === ContextUnitKind.MANIFEST
        ) {
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
    // Truthful provenance: compiler if from TS AST, tree-sitter if tree-sitter, else heuristic
    for (const [filePath, symbols] of symbolsByPath.entries()) {
      const fileUnit = fileUnitsByPath.get(filePath);
      if (!fileUnit) continue;

      for (const sym of symbols) {
        const source: 'compiler' | 'tree-sitter' | 'heuristic' =
          sym.provenance?.extractedBy === 'typescript-ast'
            ? 'compiler'
            : sym.provenance?.extractedBy === 'tree-sitter'
            ? 'tree-sitter'
            : 'heuristic';

        graph.addEdge({
          from: fileUnit.id,
          to: sym.id,
          kind: EdgeKind.CONTAINS,
          confidence: 1.0,
          source,
        });

        graph.addEdge({
          from: sym.id,
          to: fileUnit.id,
          kind: EdgeKind.DECLARED_IN,
          confidence: 1.0,
          source,
        });
      }
    }

    // 3. TESTS Edges (Test -> Implementation)
    // Truthful provenance: heuristic (file naming conventions & path heuristics)
    for (const unit of units) {
      if (unit.kind === ContextUnitKind.TEST && unit.path) {
        const testPath = unit.path.replace(/\\/g, '/');
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
    // Truthful provenance: heuristic
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

    // 5. CALLS, REFERENCES, TYPE_USES, IMPORTS, IMPLEMENTS, INHERITS from source code
    if ((options.repoDir && fs.existsSync(options.repoDir)) || (options.sourceReader && options.snapshot)) {
      this.enrichFromSourceCode(options.repoDir || '', fileUnitsByPath, symbolsByPath, symbolsByName, graph, options);
    }

    // 6. Optional SCIP Ingestion (Section 35)
    this.scipIndexer.ingestScip(graph, units, {
      repoDir: options.repoDir,
      policy: options.scipPolicy,
      scipPath: options.scipIndexPath,
    });

    return graph;
  }

  private enrichFromSourceCode(
    repoDir: string,
    fileUnitsByPath: Map<string, ContextUnit>,
    symbolsByPath: Map<string, CodeSymbolUnit[]>,
    symbolsByName: Map<string, CodeSymbolUnit[]>,
    graph: ContextGraph,
    options: GraphBuilderOptions = {}
  ): void {
    for (const [filePath, fileUnit] of fileUnitsByPath.entries()) {
      let code = '';

      if (options.sourceReader && options.snapshot) {
        try {
          const res = options.sourceReader.readFileSync(options.snapshot, fileUnit.repositoryId || 'root', filePath);
          if (res.status === 'OK') {
            code = res.content;
          }
        } catch {}
      }

      if (!code && repoDir) {
        const fullPath = path.join(repoDir, filePath);
        if (fs.existsSync(fullPath)) {
          try {
            code = fs.readFileSync(fullPath, 'utf-8');
          } catch {}
        }
      }

      if (!code) continue;

      const ext = path.extname(filePath).toLowerCase();
      const isTsOrJs = ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx';

      if (isTsOrJs) {
        this.enrichTypeScriptFile(
          code,
          filePath,
          fileUnit,
          fileUnitsByPath,
          symbolsByPath,
          symbolsByName,
          graph
        );
      } else {
        this.enrichHeuristicFallback(
          code,
          filePath,
          fileUnit,
          fileUnitsByPath,
          symbolsByPath,
          symbolsByName,
          graph
        );
      }
    }
  }

  /**
   * Precise AST-based extraction for TypeScript/JavaScript using the TypeScript compiler AST.
   * Extracts IMPORTS, IMPLEMENTS, INHERITS, CALLS, TYPE_USES, and REFERENCES with source: 'compiler'.
   */
  private enrichTypeScriptFile(
    code: string,
    filePath: string,
    fileUnit: ContextUnit,
    fileUnitsByPath: Map<string, ContextUnit>,
    symbolsByPath: Map<string, CodeSymbolUnit[]>,
    symbolsByName: Map<string, CodeSymbolUnit[]>,
    graph: ContextGraph
  ): void {
    const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
    const sourceFile = ts.createSourceFile(
      filePath,
      code,
      ts.ScriptTarget.Latest,
      true,
      isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const fileSymbols = symbolsByPath.get(filePath) || [];

    // Map symbol line ranges to CodeSymbolUnits for enclosing symbol resolution (prefer innermost/narrowest span)
    const findEnclosingSymbol = (pos: number): CodeSymbolUnit | undefined => {
      const line = sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
      const matching = fileSymbols.filter((s) => s.startLine <= line && s.endLine >= line);
      if (matching.length === 0) return undefined;
      matching.sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
      return matching[0];
    };

    const visit = (node: ts.Node) => {
      // 1. IMPORTS & REFERENCES via import/export declarations
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const importTarget = node.moduleSpecifier.text;
          if (importTarget.startsWith('.')) {
            const resolvedRel = path
              .normalize(path.join(path.dirname(filePath), importTarget))
              .replace(/\\/g, '/');

            for (const [targetPath, targetUnit] of fileUnitsByPath.entries()) {
              const targetNoExt = targetPath.replace(/\.[^/.]+$/, '');
              if (targetNoExt === resolvedRel || targetPath === resolvedRel) {
                graph.addEdge({
                  from: fileUnit.id,
                  to: targetUnit.id,
                  kind: EdgeKind.IMPORTS,
                  confidence: 0.90,
                  source: 'typescript_ast',
                });
              }
            }
          }
        }
      }

      // 2. IMPLEMENTS, INHERITS, and TYPE_USES via Heritage Clauses
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
        const className = node.name?.text;
        const classSymbol = fileSymbols.find((s) => s.symbolName === className);

        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            const isImplements = clause.token === ts.SyntaxKind.ImplementsKeyword;
            const isExtends = clause.token === ts.SyntaxKind.ExtendsKeyword;

            for (const typeNode of clause.types) {
              const typeName = typeNode.expression.getText(sourceFile);
              const targets = symbolsByName.get(typeName) || [];

              for (const target of targets) {
                const sourceId = classSymbol ? classSymbol.id : fileUnit.id;
                if (isImplements) {
                  graph.addEdge({
                    from: sourceId,
                    to: target.id,
                    kind: EdgeKind.IMPLEMENTS,
                    confidence: 0.85,
                    source: 'typescript_ast',
                  });
                } else if (isExtends) {
                  graph.addEdge({
                    from: sourceId,
                    to: target.id,
                    kind: EdgeKind.INHERITS,
                    confidence: 0.85,
                    source: 'typescript_ast',
                  });
                }
                // Heritage also constitutes explicit TYPE_USES
                graph.addEdge({
                  from: sourceId,
                  to: target.id,
                  kind: EdgeKind.TYPE_USES,
                  confidence: 0.85,
                  source: 'typescript_ast',
                });
              }
            }
          }
        }
      }

      // 3. CALLS (Section 33: High-Value Edge)
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        let calledName = '';
        if (ts.isIdentifier(node.expression)) {
          calledName = node.expression.text;
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          calledName = node.expression.name.text;
        }

        if (calledName) {
          const enclosing = findEnclosingSymbol(node.getStart(sourceFile));
          const callerId = enclosing ? enclosing.id : fileUnit.id;

          // Look for matching symbol targets
          // Prefer method in same class, then file symbols, then global symbol table
          let matchingTargets: CodeSymbolUnit[] = [];
          if (enclosing?.metadata?.parentClass) {
            matchingTargets = fileSymbols.filter(
              (s) => s.metadata?.parentClass === enclosing.metadata?.parentClass && s.symbolName === calledName
            );
          }
          if (matchingTargets.length === 0) {
            matchingTargets = fileSymbols.filter((s) => s.symbolName === calledName);
          }
          if (matchingTargets.length === 0) {
            matchingTargets = symbolsByName.get(calledName) || [];
          }

          for (const target of matchingTargets) {
            if (target.id !== callerId) {
              graph.addEdge({
                from: callerId,
                to: target.id,
                kind: EdgeKind.CALLS,
                confidence: 0.70,
                source: 'typescript_ast',
              });
            }
          }
        }
      }

      // 4. TYPE_USES (Section 33: High-Value Edge)
      if (ts.isTypeReferenceNode(node)) {
        const typeName = node.typeName.getText(sourceFile);
        const targets = symbolsByName.get(typeName) || [];
        const enclosing = findEnclosingSymbol(node.getStart(sourceFile));
        const sourceId = enclosing ? enclosing.id : fileUnit.id;

        for (const target of targets) {
          if (target.id !== sourceId) {
            graph.addEdge({
              from: sourceId,
              to: target.id,
              kind: EdgeKind.TYPE_USES,
              confidence: 0.80,
              source: 'typescript_ast',
            });
          }
        }
      }

      // 5. REFERENCES (Section 33: High-Value Edge)
      if (ts.isIdentifier(node) && !ts.isTypeReferenceNode(node.parent) && !ts.isCallExpression(node.parent)) {
        const idName = node.text;
        const targets = symbolsByName.get(idName) || [];
        const enclosing = findEnclosingSymbol(node.getStart(sourceFile));
        const sourceId = enclosing ? enclosing.id : fileUnit.id;

        for (const target of targets) {
          if (target.id !== sourceId && target.symbolName !== enclosing?.symbolName) {
            graph.addEdge({
              from: sourceId,
              to: target.id,
              kind: EdgeKind.REFERENCES,
              confidence: 0.70,
              source: 'typescript_ast',
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  /**
   * Heuristic fallback for non-TypeScript files (e.g. Python, Go, Rust) or unparseable files.
   * Truthful provenance: all edges strictly set source: 'heuristic'.
   */
  private enrichHeuristicFallback(
    code: string,
    filePath: string,
    fileUnit: ContextUnit,
    fileUnitsByPath: Map<string, ContextUnit>,
    symbolsByPath: Map<string, CodeSymbolUnit[]>,
    symbolsByName: Map<string, CodeSymbolUnit[]>,
    graph: ContextGraph
  ): void {
    // 1. Detect imports via regex (heuristic)
    const importMatches = code.matchAll(/(?:import|require|from)\s+['"]([^'"]+)['"]/g);
    for (const match of importMatches) {
      const importTarget = match[1];
      if (importTarget.startsWith('.')) {
        const resolvedRel = path
          .normalize(path.join(path.dirname(filePath), importTarget))
          .replace(/\\/g, '/');

        for (const [targetPath, targetUnit] of fileUnitsByPath.entries()) {
          const targetNoExt = targetPath.replace(/\.[^/.]+$/, '');
          if (targetNoExt === resolvedRel || targetPath === resolvedRel) {
            graph.addEdge({
              from: fileUnit.id,
              to: targetUnit.id,
              kind: EdgeKind.IMPORTS,
              confidence: 0.85,
              source: 'heuristic',
            });
          }
        }
      }
    }

    // 2. Check symbol references and calls via signature regex (heuristic)
    const fileSymbols = symbolsByPath.get(filePath) || [];
    for (const sym of fileSymbols) {
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
                confidence: 0.85,
                source: 'heuristic',
              });
              graph.addEdge({
                from: sym.id,
                to: target.id,
                kind: EdgeKind.TYPE_USES,
                confidence: 0.85,
                source: 'heuristic',
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
              confidence: 0.85,
              source: 'heuristic',
            });
            graph.addEdge({
              from: sym.id,
              to: target.id,
              kind: EdgeKind.TYPE_USES,
              confidence: 0.85,
              source: 'heuristic',
            });
          }
        }
      }
    }
  }
}
