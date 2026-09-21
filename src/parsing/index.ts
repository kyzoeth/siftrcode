/**
 * SiftrCode V2 - Multi-Language Parsing Registry (Closure PR 0.1)
 * Central access point for structural AST parsers across TypeScript, Python, Go, and Rust.
 */

import { LanguageSymbolParser } from './symbol_types';
import { TypeScriptSymbolParser } from './typescript_parser';
import { PythonSymbolParser } from './python_parser';
import { GolangSymbolParser } from './golang_parser';
import { RustSymbolParser } from './rust_parser';

export * from './symbol_types';
export * from './typescript_parser';
export * from './python_parser';
export * from './golang_parser';
export * from './rust_parser';

const tsParser = new TypeScriptSymbolParser();
const pyParser = new PythonSymbolParser();
const goParser = new GolangSymbolParser();
const rsParser = new RustSymbolParser();

/**
 * Returns the appropriate LanguageSymbolParser for a given language identifier or file extension.
 * Returns null if no parser is registered for the specified language.
 */
export function getSymbolParserForLanguage(langOrExt: string): LanguageSymbolParser | null {
  if (!langOrExt) return null;

  const normalized = langOrExt.trim().toLowerCase().replace(/^\./, '');

  switch (normalized) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'typescript':
    case 'javascript':
      return tsParser;

    case 'py':
    case 'python':
      return pyParser;

    case 'go':
    case 'golang':
      return goParser;

    case 'rs':
    case 'rust':
      return rsParser;

    default:
      return null;
  }
}
