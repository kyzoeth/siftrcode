/**
 * SiftrCode V2 - Common Symbol Parser Contract (Closure PR 0.1)
 * Provides language-agnostic structural symbol interfaces with boundary spans and safety metadata.
 */

import { SymbolKind } from '../context/context_unit';

export interface SymbolSafetyMetadata {
  hasDecorators?: boolean;
  hasMacros?: boolean;
  hasTopLevelCode?: boolean;
  isModuleInit?: boolean;
  isGenerated?: boolean;
  skeletonSafetyOverride?: 'SAFE' | 'PARTIAL' | 'UNSAFE';
  parentClass?: string;
  parentSymbol?: string;
  docstring?: string;
  [key: string]: unknown;
}

export interface ParsedSymbol {
  symbolName: string;
  qualifiedName: string;
  symbolKind: SymbolKind;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  signature?: string;
  parentSymbol?: string;
  metadata: SymbolSafetyMetadata;
}

export interface LanguageSymbolParser {
  language: string;
  parseSymbols(code: string, relativePath?: string): ParsedSymbol[];
}
