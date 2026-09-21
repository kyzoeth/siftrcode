import * as fs from 'fs';
import * as path from 'path';
import { ContextGraph, EdgeKind } from './context_graph';
import { ContextUnit, ContextUnitKind } from '../context/context_unit';

export enum ScipIngestionPolicy {
  BEST_EFFORT_LOCAL = 'BEST_EFFORT_LOCAL',
  CI_PRECISE = 'CI_PRECISE',
  DISABLED = 'DISABLED',
}

export interface ScipSymbolRelationship {
  symbol: string;
  isImplementation?: boolean;
  isReference?: boolean;
  isTypeDefinition?: boolean;
}

export interface ScipOccurrence {
  range: [number, number, number, number]; // [startLine, startCol, endLine, endCol]
  symbol: string;
  symbolRoles: number; // 1 = Definition, 2 = Import, 8 = Read/Reference
  syntaxKind?: number;
  overrideDocumentation?: string[];
}

export interface ScipDocument {
  relative_path: string;
  language?: string;
  occurrences: ScipOccurrence[];
  symbols?: Array<{
    symbol: string;
    relationships?: ScipSymbolRelationship[];
  }>;
}

export interface ScipIndexData {
  metadata?: {
    version?: number;
    tool_info?: { name: string; version: string };
    project_root?: string;
  };
  documents: ScipDocument[];
}

export interface ScipIngestResult {
  status: 'INGESTED' | 'SKIPPED_NOT_FOUND' | 'DISABLED';
  ingestedEdgesCount: number;
  documentsCount: number;
  indexPath?: string;
}

export class ScipIndexer {
  /**
   * Ingests SCIP data into the ContextGraph adhering strictly to Section 35 policy:
   * - DISABLED: skips cleanly
   * - BEST_EFFORT_LOCAL: ingests if found, silently skips if missing without blocking local execution
   * - CI_PRECISE: strictly enforces SCIP index presence; throws error if absent
   */
  public ingestScip(
    graph: ContextGraph,
    units: ContextUnit[],
    options: {
      repoDir?: string;
      policy?: ScipIngestionPolicy;
      scipPath?: string;
    } = {}
  ): ScipIngestResult {
    const policy = options.policy ?? ScipIngestionPolicy.BEST_EFFORT_LOCAL;

    if (policy === ScipIngestionPolicy.DISABLED) {
      return {
        status: 'DISABLED',
        ingestedEdgesCount: 0,
        documentsCount: 0,
      };
    }

    const resolvedPath = this.locateScipIndex(options.repoDir, options.scipPath);

    if (!resolvedPath) {
      if (policy === ScipIngestionPolicy.CI_PRECISE) {
        throw new Error(
          `[SCIP] CI_PRECISE policy violation: SCIP index file required but not found in ${options.repoDir || process.cwd()}`
        );
      }
      return {
        status: 'SKIPPED_NOT_FOUND',
        ingestedEdgesCount: 0,
        documentsCount: 0,
      };
    }

    try {
      const rawContent = fs.readFileSync(resolvedPath, 'utf-8');
      const scipData: ScipIndexData = JSON.parse(rawContent);

      if (!scipData.documents || !Array.isArray(scipData.documents)) {
        return {
          status: 'INGESTED',
          ingestedEdgesCount: 0,
          documentsCount: 0,
          indexPath: resolvedPath,
        };
      }

      let edgeCount = 0;
      const fileUnitsByPath = new Map<string, ContextUnit>();
      const symbolUnitsByName = new Map<string, ContextUnit[]>();

      for (const unit of units) {
        if (unit.path) {
          const norm = unit.path.replace(/\\/g, '/');
          fileUnitsByPath.set(norm, unit);
        }
        if (unit.title) {
          if (!symbolUnitsByName.has(unit.title)) {
            symbolUnitsByName.set(unit.title, []);
          }
          symbolUnitsByName.get(unit.title)!.push(unit);
        }
      }

      for (const doc of scipData.documents) {
        const normDocPath = doc.relative_path.replace(/\\/g, '/');
        const docFileUnit = fileUnitsByPath.get(normDocPath);

        // Process explicit symbol relationships in document metadata
        if (doc.symbols) {
          for (const symInfo of doc.symbols) {
            const symName = this.extractBaseSymbolName(symInfo.symbol);
            const sourceUnits = symbolUnitsByName.get(symName) || [];

            for (const rel of symInfo.relationships || []) {
              const targetName = this.extractBaseSymbolName(rel.symbol);
              const targetUnits = symbolUnitsByName.get(targetName) || [];

              for (const sUnit of sourceUnits) {
                for (const tUnit of targetUnits) {
                  let kind: EdgeKind = EdgeKind.REFERENCES;
                  if (rel.isImplementation) {
                    kind = EdgeKind.IMPLEMENTS;
                  } else if (rel.isTypeDefinition) {
                    kind = EdgeKind.TYPE_USES;
                  }

                  graph.addEdge({
                    from: sUnit.id,
                    to: tUnit.id,
                    kind,
                    confidence: 1.0,
                    source: 'scip',
                    metadata: { scipSymbol: symInfo.symbol, targetScipSymbol: rel.symbol },
                  });
                  edgeCount++;
                }
              }
            }
          }
        }

        // Process occurrences (definition vs reference vs call)
        for (const occ of doc.occurrences || []) {
          const symName = this.extractBaseSymbolName(occ.symbol);
          const targetUnits = symbolUnitsByName.get(symName) || [];

          // If this is a reference occurrence from the document to an external or internal symbol
          if (docFileUnit && targetUnits.length > 0) {
            const isDef = (occ.symbolRoles & 1) !== 0;
            if (!isDef) {
              for (const targetUnit of targetUnits) {
                if (targetUnit.id === docFileUnit.id) continue;

                graph.addEdge({
                  from: docFileUnit.id,
                  to: targetUnit.id,
                  kind: EdgeKind.REFERENCES,
                  confidence: 0.98,
                  source: 'scip',
                  metadata: { scipSymbol: occ.symbol },
                });
                edgeCount++;
              }
            }
          }
        }
      }

      return {
        status: 'INGESTED',
        ingestedEdgesCount: edgeCount,
        documentsCount: scipData.documents.length,
        indexPath: resolvedPath,
      };
    } catch (err: any) {
      if (policy === ScipIngestionPolicy.CI_PRECISE) {
        throw new Error(`[SCIP] Failed to parse SCIP index under CI_PRECISE: ${err.message}`);
      }
      return {
        status: 'SKIPPED_NOT_FOUND',
        ingestedEdgesCount: 0,
        documentsCount: 0,
        indexPath: resolvedPath,
      };
    }
  }

  /**
   * Helper to locate an on-disk SCIP index in common locations.
   */
  private locateScipIndex(repoDir?: string, customPath?: string): string | null {
    if (customPath && fs.existsSync(customPath)) {
      return customPath;
    }

    if (!repoDir) return null;

    const candidatePaths = [
      path.join(repoDir, 'index.scip'),
      path.join(repoDir, 'scip.json'),
      path.join(repoDir, '.scip', 'index.scip'),
      path.join(repoDir, '.scip', 'index.json'),
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  /**
   * Extracts clean human-readable symbol identifier from SCIP symbol URI.
   * Example: 'scip-typescript npm @siftr/core 1.0.0 src/auth/User#' -> 'User'
   */
  private extractBaseSymbolName(scipSymbol: string): string {
    const lastPart = scipSymbol.split(/[\s/#]+/).filter(Boolean).pop() || '';
    return lastPart.replace(/[#()]/g, '');
  }
}
