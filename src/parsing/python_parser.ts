/**
 * SiftrCode V2 - Python Structural Symbol Parser (Closure PR 0.1)
 * Extracts Python classes, methods, and functions with exact AST-derived line/byte boundaries
 * and safety metadata (hasDecorators, hasTopLevelCode, isModuleInit).
 */

import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { SymbolKind } from '../context/context_unit';
import { LanguageSymbolParser, ParsedSymbol } from './symbol_types';

export class PythonSymbolParser implements LanguageSymbolParser {
  public language = 'python';

  public parseSymbols(code: string, relativePath: string = 'file.py'): ParsedSymbol[] {
    if (!code || !code.trim()) {
      return [];
    }

    // 1. Try AST-backed parser via python3
    const astSymbols = this.parseWithPythonAst(code, relativePath);
    if (astSymbols && astSymbols.length > 0) {
      return astSymbols;
    }

    // 2. Fallback to pure TypeScript indentation-aware structural parser
    return this.parseStructuralFallback(code, relativePath);
  }

  private parseWithPythonAst(code: string, relativePath: string): ParsedSymbol[] | null {
    try {
      const localDist = path.join(__dirname, '..', 'skeleton', 'python_ast.py');
      const srcFallback = path.join(__dirname, '..', '..', 'src', 'skeleton', 'python_ast.py');
      const scriptPath = fs.existsSync(localDist) ? localDist : srcFallback;

      if (!fs.existsSync(scriptPath)) {
        return null;
      }

      const proc = spawnSync('python3', [scriptPath, '--symbols', `--path=${relativePath}`], {
        input: code,
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
      });

      if (proc.status === 0 && proc.stdout) {
        const parsed = JSON.parse(proc.stdout);
        if (Array.isArray(parsed.symbols)) {
          return parsed.symbols.map((s: any) => ({
            symbolName: s.symbolName,
            qualifiedName: s.qualifiedName,
            symbolKind: s.symbolKind as SymbolKind,
            startByte: s.startByte ?? 0,
            endByte: s.endByte ?? 0,
            startLine: s.startLine,
            endLine: s.endLine,
            signature: s.signature,
            parentSymbol: s.parentSymbol,
            metadata: {
              ...s.metadata,
              hasDecorators: s.metadata?.hasDecorators ?? false,
              skeletonSafetyOverride: s.metadata?.hasDecorators ? 'UNSAFE' : 'SAFE',
            },
          }));
        }
      }
    } catch {
      // Fallback
    }
    return null;
  }

  /**
   * Pure TypeScript structural parser using indentation analysis.
   */
  public parseStructuralFallback(code: string, relativePath: string = 'file.py'): ParsedSymbol[] {
    const lines = code.split('\n');
    const symbols: ParsedSymbol[] = [];
    const isModuleInit = relativePath.endsWith('__init__.py') || relativePath === '__init__.py';

    // Compute cumulative byte offsets for line positions
    const lineByteOffsets: number[] = [0];
    for (let i = 0; i < lines.length; i++) {
      lineByteOffsets.push(lineByteOffsets[i] + Buffer.byteLength(lines[i], 'utf-8') + 1); // +1 for \n
    }

    interface PendingItem {
      name: string;
      kind: SymbolKind;
      startLine: number; // 1-based
      indent: number;
      signature: string;
      parentSymbol?: string;
      hasDecorators: boolean;
    }

    const classStack: { name: string; indent: number; startLine: number }[] = [];
    let pendingDecorators: number[] = []; // decorator line numbers

    let hasTopLevelCode = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip blank lines and comments for indentation tracking
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const indent = line.search(/\S/);

      // Track top-level code (not import, class, def, or decorator)
      if (indent === 0 && !trimmed.startsWith('def ') && !trimmed.startsWith('async def ') &&
          !trimmed.startsWith('class ') && !trimmed.startsWith('@') && !trimmed.startsWith('import ') &&
          !trimmed.startsWith('from ')) {
        hasTopLevelCode = true;
      }

      // Track decorators
      if (trimmed.startsWith('@')) {
        pendingDecorators.push(i + 1);
        continue;
      }

      // Check if class indentation closed
      while (classStack.length > 0 && indent <= classStack[classStack.length - 1].indent) {
        classStack.pop();
      }

      // Class definition: class ClassName(...)
      const classMatch = line.match(/^(\s*)class\s+([A-Za-z0-9_]+)/);
      if (classMatch) {
        const className = classMatch[2];
        const classIndent = indent;
        const startLine = pendingDecorators.length > 0 ? pendingDecorators[0] : i + 1;
        const hasDec = pendingDecorators.length > 0;
        pendingDecorators = [];

        // Find end line of class: scan until non-empty line with indent <= classIndent
        let endLine = lines.length;
        for (let j = i + 1; j < lines.length; j++) {
          const nextTrim = lines[j].trim();
          if (nextTrim && !nextTrim.startsWith('#')) {
            const nextIndent = lines[j].search(/\S/);
            if (nextIndent <= classIndent) {
              endLine = j; // 1-based line before j + 1
              break;
            }
          }
        }

        const startByte = lineByteOffsets[startLine - 1] || 0;
        const endByte = lineByteOffsets[endLine] || code.length;

        symbols.push({
          symbolName: className,
          qualifiedName: className,
          symbolKind: SymbolKind.CLASS,
          startByte,
          endByte,
          startLine,
          endLine,
          signature: trimmed,
          metadata: {
            hasDecorators: hasDec,
            hasTopLevelCode,
            isModuleInit,
            skeletonSafetyOverride: hasDec ? 'UNSAFE' : 'SAFE',
          },
        });

        classStack.push({ name: className, indent: classIndent, startLine });
        continue;
      }

      // Function or method definition: [async] def func_name(...)
      const defMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)/);
      if (defMatch) {
        const funcName = defMatch[2];
        const funcIndent = indent;
        const startLine = pendingDecorators.length > 0 ? pendingDecorators[0] : i + 1;
        const hasDec = pendingDecorators.length > 0;
        pendingDecorators = [];

        const isMethod = classStack.length > 0 && funcIndent > classStack[classStack.length - 1].indent;
        const parentClass = isMethod ? classStack[classStack.length - 1].name : undefined;
        const qualName = parentClass ? `${parentClass}.${funcName}` : funcName;
        const symKind = isMethod ? SymbolKind.METHOD : SymbolKind.FUNCTION;

        // Find end line of function: scan until non-empty line with indent <= funcIndent
        let endLine = lines.length;
        for (let j = i + 1; j < lines.length; j++) {
          const nextTrim = lines[j].trim();
          if (nextTrim && !nextTrim.startsWith('#')) {
            const nextIndent = lines[j].search(/\S/);
            if (nextIndent <= funcIndent) {
              endLine = j;
              break;
            }
          }
        }

        const startByte = lineByteOffsets[startLine - 1] || 0;
        const endByte = lineByteOffsets[endLine] || code.length;

        symbols.push({
          symbolName: funcName,
          qualifiedName: qualName,
          symbolKind: symKind,
          startByte,
          endByte,
          startLine,
          endLine,
          signature: trimmed,
          parentSymbol: parentClass,
          metadata: {
            hasDecorators: hasDec,
            parentClass,
            hasTopLevelCode,
            isModuleInit,
            skeletonSafetyOverride: hasDec ? 'UNSAFE' : 'SAFE',
          },
        });
        continue;
      }

      // If we saw decorators but line wasn't def or class, reset decorators
      if (pendingDecorators.length > 0) {
        pendingDecorators = [];
      }
    }

    return symbols;
  }
}
