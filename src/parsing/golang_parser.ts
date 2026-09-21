/**
 * SiftrCode V2 - Go Structural Symbol Parser (Closure PR 0.1)
 * Extracts Go functions, methods, structs, and interfaces with exact brace-matching boundary spans
 * and safety metadata (isGenerated, receiver parentage).
 */

import { SymbolKind } from '../context/context_unit';
import { LanguageSymbolParser, ParsedSymbol } from './symbol_types';

export class GolangSymbolParser implements LanguageSymbolParser {
  public language = 'go';

  public parseSymbols(code: string, _relativePath: string = 'file.go'): ParsedSymbol[] {
    if (!code || !code.trim()) {
      return [];
    }

    const isGenerated = /Code generated .* DO NOT EDIT/i.test(code);
    const symbols: ParsedSymbol[] = [];

    // Compute line start byte offsets
    const lineByteOffsets: number[] = [0];
    let currentByte = 0;
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '\n') {
        lineByteOffsets.push(currentByte + 1);
      }
      currentByte += Buffer.byteLength(code[i], 'utf-8');
    }

    function getLineNumber(charIndex: number): number {
      let low = 0;
      let high = lineByteOffsets.length - 1;
      let ans = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (lineByteOffsets[mid] <= charIndex) {
          ans = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return ans + 1; // 1-based line number
    }

    // Lexical scanning state machine
    let i = 0;
    const len = code.length;

    while (i < len) {
      // Skip whitespace
      while (i < len && /\s/.test(code[i])) {
        i++;
      }
      if (i >= len) break;

      // Skip line comment //
      if (code[i] === '/' && i + 1 < len && code[i + 1] === '/') {
        while (i < len && code[i] !== '\n') {
          i++;
        }
        continue;
      }

      // Skip block comment /* ... */
      if (code[i] === '/' && i + 1 < len && code[i + 1] === '*') {
        i += 2;
        while (i + 1 < len && !(code[i] === '*' && code[i + 1] === '/')) {
          i++;
        }
        i += 2;
        continue;
      }

      // Check for 'func' declaration
      if (code.startsWith('func', i) && (i + 4 >= len || /[\s(]/.test(code[i + 4]))) {
        const startChar = i;
        const startLine = getLineNumber(startChar);

        // Find signature up to '{'
        let headerEnd = i;
        let inSigParen = 0;
        while (headerEnd < len && (code[headerEnd] !== '{' || inSigParen > 0)) {
          if (code[headerEnd] === '(') inSigParen++;
          else if (code[headerEnd] === ')') inSigParen = Math.max(0, inSigParen - 1);
          headerEnd++;
        }

        const declHeader = code.slice(startChar, headerEnd).trim();

        // Check if method: func (r *Receiver) MethodName(...)
        const methodMatch = declHeader.match(/^func\s*\(\s*[^)]*?\*?([A-Za-z0-9_]+)\s*\)\s*([A-Za-z0-9_]+)/);
        const funcMatch = declHeader.match(/^func\s+([A-Za-z0-9_]+)/);

        if (methodMatch || funcMatch) {
          const isMethod = !!methodMatch;
          const receiver = methodMatch ? methodMatch[1] : undefined;
          const funcName = methodMatch ? methodMatch[2] : funcMatch![1];
          const qualName = isMethod ? `${receiver}.${funcName}` : funcName;
          const symKind = isMethod ? SymbolKind.METHOD : SymbolKind.FUNCTION;

          // Now find matching closing brace '}'
          if (headerEnd < len && code[headerEnd] === '{') {
            const bodyEnd = this.findMatchingBrace(code, headerEnd);
            const endLine = getLineNumber(bodyEnd);
            const startByte = Buffer.byteLength(code.slice(0, startChar), 'utf-8');
            const endByte = Buffer.byteLength(code.slice(0, bodyEnd + 1), 'utf-8');

            symbols.push({
              symbolName: funcName,
              qualifiedName: qualName,
              symbolKind: symKind,
              startByte,
              endByte,
              startLine,
              endLine,
              signature: declHeader,
              parentSymbol: receiver,
              metadata: {
                isGenerated,
                parentSymbol: receiver,
                skeletonSafetyOverride: 'SAFE',
              },
            });

            i = bodyEnd + 1;
            continue;
          }
        }
      }

      // Check for 'type Name struct' or 'type Name interface'
      if (code.startsWith('type', i) && (i + 4 >= len || /\s/.test(code[i + 4]))) {
        const startChar = i;
        const startLine = getLineNumber(startChar);

        let headerEnd = i;
        while (headerEnd < len && code[headerEnd] !== '{' && code[headerEnd] !== '\n') {
          headerEnd++;
        }

        const typeLine = code.slice(startChar, headerEnd).trim();
        const structMatch = typeLine.match(/^type\s+([A-Za-z0-9_]+)\s+struct/);
        const ifaceMatch = typeLine.match(/^type\s+([A-Za-z0-9_]+)\s+interface/);

        if (structMatch || ifaceMatch) {
          const typeName = structMatch ? structMatch[1] : ifaceMatch![1];
          const symKind = structMatch ? SymbolKind.STRUCT : SymbolKind.INTERFACE;

          // Find opening brace '{'
          let bracePos = headerEnd;
          while (bracePos < len && code[bracePos] !== '{' && code[bracePos] !== ';') {
            bracePos++;
          }

          if (bracePos < len && code[bracePos] === '{') {
            const bodyEnd = this.findMatchingBrace(code, bracePos);
            const endLine = getLineNumber(bodyEnd);
            const startByte = Buffer.byteLength(code.slice(0, startChar), 'utf-8');
            const endByte = Buffer.byteLength(code.slice(0, bodyEnd + 1), 'utf-8');

            symbols.push({
              symbolName: typeName,
              qualifiedName: typeName,
              symbolKind: symKind,
              startByte,
              endByte,
              startLine,
              endLine,
              signature: typeLine,
              metadata: {
                isGenerated,
                skeletonSafetyOverride: 'SAFE',
              },
            });

            i = bodyEnd + 1;
            continue;
          }
        }
      }

      i++;
    }

    return symbols;
  }

  /**
   * Scans forward from openBraceIndex (which must point to '{') and finds
   * the index of the matching '}', ignoring strings, comments, and runes.
   */
  private findMatchingBrace(code: string, openBraceIndex: number): number {
    let depth = 0;
    let i = openBraceIndex;
    const len = code.length;

    while (i < len) {
      const ch = code[i];

      // Skip double-quoted string
      if (ch === '"') {
        i++;
        while (i < len && code[i] !== '"') {
          if (code[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }

      // Skip raw string `...`
      if (ch === '`') {
        i++;
        while (i < len && code[i] !== '`') {
          i++;
        }
        i++;
        continue;
      }

      // Skip rune literal '...'
      if (ch === '\'') {
        i++;
        while (i < len && code[i] !== '\'') {
          if (code[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }

      // Skip line comment //
      if (ch === '/' && i + 1 < len && code[i + 1] === '/') {
        while (i < len && code[i] !== '\n') {
          i++;
        }
        continue;
      }

      // Skip block comment /* ... */
      if (ch === '/' && i + 1 < len && code[i + 1] === '*') {
        i += 2;
        while (i + 1 < len && !(code[i] === '*' && code[i + 1] === '/')) {
          i++;
        }
        i += 2;
        continue;
      }

      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return i;
        }
      }

      i++;
    }

    return len - 1;
  }
}
