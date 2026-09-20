import * as crypto from 'crypto';
import { TrustLevel } from '../security/trust';

export enum ContextUnitKind {
  CODE_SYMBOL = 'CODE_SYMBOL',
  SOURCE_FILE = 'SOURCE_FILE',
  CONFIG = 'CONFIG',
  SCHEMA = 'SCHEMA',
  MIGRATION = 'MIGRATION',
  TEST = 'TEST',
  DOCUMENTATION = 'DOCUMENTATION',
  DIFF = 'DIFF',
  STACK_TRACE = 'STACK_TRACE',
  BUILD_ERROR = 'BUILD_ERROR',
  RUNTIME_LOG = 'RUNTIME_LOG',
  ISSUE = 'ISSUE',
  MANIFEST = 'MANIFEST',
  LOCKFILE = 'LOCKFILE',
}

export interface ContextProvenance {
  sourceType: 'file' | 'git' | 'runtime' | 'test' | 'generated' | 'synthetic';
  sourceUri?: string;
  sourceCommit?: string;
  extractedBy?: string;
  timestamp?: string;
}

export interface ContextUnit {
  id: string;
  kind: ContextUnitKind;
  workspaceSnapshotId: string;
  repositoryId?: string;
  path?: string;
  title: string;
  provenance: ContextProvenance;
  trustLevel: TrustLevel;
  metadata: Record<string, unknown>;
}

export enum SymbolKind {
  FUNCTION = 'FUNCTION',
  METHOD = 'METHOD',
  CLASS = 'CLASS',
  INTERFACE = 'INTERFACE',
  TYPE_ALIAS = 'TYPE_ALIAS',
  ENUM = 'ENUM',
  VARIABLE = 'VARIABLE',
  CONSTANT = 'CONSTANT',
  MODULE = 'MODULE',
  TRAIT = 'TRAIT',
  STRUCT = 'STRUCT',
  PROPERTY = 'PROPERTY',
}

export interface CodeSymbolUnit extends ContextUnit {
  kind: ContextUnitKind.CODE_SYMBOL;
  symbolKind: SymbolKind;
  symbolName: string;
  qualifiedName: string;
  language: string;
  startLine: number;
  endLine: number;
  signature?: string;
  contentHash: string;
}

/**
 * Derives stable identity for code symbols.
 * In accordance with Section 23:
 * Line numbers remain mutable metadata and are NOT part of the primary identity.
 */
export function generateSymbolUnitId(
  repositoryId: string,
  normalizedPath: string,
  qualifiedName: string,
  symbolKind: SymbolKind
): string {
  const normPath = normalizedPath.replace(/\\/g, '/').toLowerCase();
  const rawKey = `${repositoryId}:${normPath}:${symbolKind}:${qualifiedName}`;
  return 'sym_' + crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
}

/**
 * Derives stable identity for generic ContextUnits.
 */
export function generateContextUnitId(
  kind: ContextUnitKind,
  repositoryId: string = 'root',
  normalizedPath: string = '',
  identifier: string = ''
): string {
  const normPath = normalizedPath.replace(/\\/g, '/').toLowerCase();
  const rawKey = `${kind}:${repositoryId}:${normPath}:${identifier}`;
  return 'unit_' + crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
}

export function isCodeSymbolUnit(unit: ContextUnit): unit is CodeSymbolUnit {
  return unit.kind === ContextUnitKind.CODE_SYMBOL && 'qualifiedName' in unit;
}
