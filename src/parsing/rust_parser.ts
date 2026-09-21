/**
 * SiftrCode V2 - Rust Structural Symbol Parser (Closure PR 0.1)
 * Extracts Rust functions, impl methods, structs, enums, traits, and macros with exact boundary spans
 * and safety metadata (hasMacros, hasDecorators, skeletonSafetyOverride).
 */

import { SymbolKind } from '../context/context_unit';
import { LanguageSymbolParser, ParsedSymbol } from './symbol_types';

export class RustSymbolParser implements LanguageSymbolParser {
  public language = 'rust';

  public parseSymbols(code: string, _relativePath: string = 'file.rs'): ParsedSymbol[] {
    if (!code || !code.trim()) {
      return [];
    }

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
      return ans + 1;
    }

    let i = 0;
    const len = code.length;
    let pendingAttributesStart: number | null = null;
    let hasPendingMacroOrAttr = false;

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

      // Outer attribute #[...]
      if (code[i] === '#' && i + 1 < len && code[i + 1] === '[') {
        if (pendingAttributesStart === null) {
          pendingAttributesStart = i;
        }
        hasPendingMacroOrAttr = true;
        i += 2;
        let attrDepth = 1;
        while (i < len && attrDepth > 0) {
          if (code[i] === '[') attrDepth++;
          else if (code[i] === ']') attrDepth--;
          i++;
        }
        continue;
      }

      // Macro definition: macro_rules! my_macro { ... }
      if (code.startsWith('macro_rules!', i)) {
        const startChar = pendingAttributesStart !== null ? pendingAttributesStart : i;
        const startLine = getLineNumber(startChar);
        pendingAttributesStart = null;

        let namePos = i + 12;
        while (namePos < len && /\s/.test(code[namePos])) namePos++;
        let nameEnd = namePos;
        while (nameEnd < len && /[A-Za-z0-9_]/.test(code[nameEnd])) nameEnd++;
        const macroName = code.slice(namePos, nameEnd);

        // Find opening brace '{' or '('
        let bracePos = nameEnd;
        while (bracePos < len && code[bracePos] !== '{' && code[bracePos] !== '(') {
          bracePos++;
        }

        if (bracePos < len) {
          const closeChar = code[bracePos] === '{' ? '}' : ')';
          const bodyEnd = this.findMatchingDelimiter(code, bracePos, code[bracePos], closeChar);
          const endLine = getLineNumber(bodyEnd);
          const startByte = Buffer.byteLength(code.slice(0, startChar), 'utf-8');
          const endByte = Buffer.byteLength(code.slice(0, bodyEnd + 1), 'utf-8');

          symbols.push({
            symbolName: macroName,
            qualifiedName: macroName,
            symbolKind: SymbolKind.FUNCTION,
            startByte,
            endByte,
            startLine,
            endLine,
            signature: `macro_rules! ${macroName}`,
            metadata: {
              hasMacros: true,
              hasDecorators: true,
              skeletonSafetyOverride: 'UNSAFE',
            },
          });

          i = bodyEnd + 1;
          continue;
        }
      }

      // Impl block: impl [Trait for] Type { ... }
      if (code.startsWith('impl', i) && (i + 4 >= len || /[\s<]/.test(code[i + 4]))) {
        const startChar = pendingAttributesStart !== null ? pendingAttributesStart : i;
        const startLine = getLineNumber(startChar);
        const hasMacro = hasPendingMacroOrAttr;
        pendingAttributesStart = null;
        hasPendingMacroOrAttr = false;

        let headerEnd = i;
        while (headerEnd < len && code[headerEnd] !== '{') {
          headerEnd++;
        }

        const implHeader = code.slice(i, headerEnd).trim();
        // Extract type name from "impl Type" or "impl Trait for Type"
        let targetType = 'Impl';
        const forMatch = implHeader.match(/impl(?:<[^>]*>)?\s+.*?\s+for\s+([A-Za-z0-9_]+)/);
        const directMatch = implHeader.match(/impl(?:<[^>]*>)?\s+([A-Za-z0-9_]+)/);
        if (forMatch) targetType = forMatch[1];
        else if (directMatch) targetType = directMatch[1];

        if (headerEnd < len && code[headerEnd] === '{') {
          const bodyEnd = this.findMatchingBrace(code, headerEnd);
          const endLine = getLineNumber(bodyEnd);
          const startByte = Buffer.byteLength(code.slice(0, startChar), 'utf-8');
          const endByte = Buffer.byteLength(code.slice(0, bodyEnd + 1), 'utf-8');

          // Register impl block
          symbols.push({
            symbolName: targetType,
            qualifiedName: `impl ${targetType}`,
            symbolKind: SymbolKind.CLASS,
            startByte,
            endByte,
            startLine,
            endLine,
            signature: implHeader,
            metadata: {
              hasMacros: hasMacro,
              hasDecorators: hasMacro,
              skeletonSafetyOverride: hasMacro ? 'UNSAFE' : 'SAFE',
            },
          });

          // Parse methods inside impl block body
          const innerCode = code.slice(headerEnd + 1, bodyEnd);
          const innerMethods = this.parseImplMethods(innerCode, targetType, headerEnd + 1, code);
          symbols.push(...innerMethods);

          i = bodyEnd + 1;
          continue;
        }
      }

      // Standalone function: [pub] [async] [const] [unsafe] fn func_name(...) ... {
      const fnMatch = code.slice(i).match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+([A-Za-z0-9_]+)/);
      if (fnMatch) {
        const funcName = fnMatch[1];
        const startChar = pendingAttributesStart !== null ? pendingAttributesStart : i;
        const startLine = getLineNumber(startChar);
        const hasMacro = hasPendingMacroOrAttr;
        pendingAttributesStart = null;
        hasPendingMacroOrAttr = false;

        let headerEnd = i;
        while (headerEnd < len && code[headerEnd] !== '{' && code[headerEnd] !== ';') {
          headerEnd++;
        }

        if (headerEnd < len && code[headerEnd] === '{') {
          const bodyEnd = this.findMatchingBrace(code, headerEnd);
          const endLine = getLineNumber(bodyEnd);
          const startByte = Buffer.byteLength(code.slice(0, startChar), 'utf-8');
          const endByte = Buffer.byteLength(code.slice(0, bodyEnd + 1), 'utf-8');

          symbols.push({
            symbolName: funcName,
            qualifiedName: funcName,
            symbolKind: SymbolKind.FUNCTION,
            startByte,
            endByte,
            startLine,
            endLine,
            signature: code.slice(i, headerEnd).trim(),
            metadata: {
              hasMacros: hasMacro,
              hasDecorators: hasMacro,
              skeletonSafetyOverride: hasMacro ? 'UNSAFE' : 'SAFE',
            },
          });

          i = bodyEnd + 1;
          continue;
        }
      }

      // Struct: [pub] struct StructName { ... } or tuple struct
      const structMatch = code.slice(i).match(/^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z0-9_]+)/);
      if (structMatch) {
        const structName = structMatch[1];
        const startChar = pendingAttributesStart !== null ? pendingAttributesStart : i;
        const startLine = getLineNumber(startChar);
        const hasMacro = hasPendingMacroOrAttr;
        pendingAttributesStart = null;
        hasPendingMacroOrAttr = false;

        let headerEnd = i;
        while (headerEnd < len && code[headerEnd] !== '{' && code[headerEnd] !== ';') {
          headerEnd++;
        }

        if (headerEnd < len) {
          const bodyEnd = code[headerEnd] === '{' ? this.findMatchingBrace(code, headerEnd) : headerEnd;
          const endLine = getLineNumber(bodyEnd);
          const startByte = Buffer.byteLength(code.slice(0, startChar), 'utf-8');
          const endByte = Buffer.byteLength(code.slice(0, bodyEnd + 1), 'utf-8');

          symbols.push({
            symbolName: structName,
            qualifiedName: structName,
            symbolKind: SymbolKind.STRUCT,
            startByte,
            endByte,
            startLine,
            endLine,
            signature: code.slice(i, headerEnd).trim(),
            metadata: {
              hasMacros: hasMacro,
              hasDecorators: hasMacro,
              skeletonSafetyOverride: hasMacro ? 'UNSAFE' : 'SAFE',
            },
          });

          i = bodyEnd + 1;
          continue;
        }
      }

      // Enum or Trait: [pub] (enum|trait) Name { ... }
      const enumTraitMatch = code.slice(i).match(/^(?:pub(?:\([^)]*\))?\s+)?(enum|trait)\s+([A-Za-z0-9_]+)/);
      if (enumTraitMatch) {
        const kindStr = enumTraitMatch[1];
        const name = enumTraitMatch[2];
        const symKind = kindStr === 'enum' ? SymbolKind.ENUM : SymbolKind.TRAIT;
        const startChar = pendingAttributesStart !== null ? pendingAttributesStart : i;
        const startLine = getLineNumber(startChar);
        const hasMacro = hasPendingMacroOrAttr;
        pendingAttributesStart = null;
        hasPendingMacroOrAttr = false;

        let headerEnd = i;
        while (headerEnd < len && code[headerEnd] !== '{') {
          headerEnd++;
        }

        if (headerEnd < len && code[headerEnd] === '{') {
          const bodyEnd = this.findMatchingBrace(code, headerEnd);
          const endLine = getLineNumber(bodyEnd);
          const startByte = Buffer.byteLength(code.slice(0, startChar), 'utf-8');
          const endByte = Buffer.byteLength(code.slice(0, bodyEnd + 1), 'utf-8');

          symbols.push({
            symbolName: name,
            qualifiedName: name,
            symbolKind: symKind,
            startByte,
            endByte,
            startLine,
            endLine,
            signature: code.slice(i, headerEnd).trim(),
            metadata: {
              hasMacros: hasMacro,
              hasDecorators: hasMacro,
              skeletonSafetyOverride: hasMacro ? 'UNSAFE' : 'SAFE',
            },
          });

          i = bodyEnd + 1;
          continue;
        }
      }

      // If token wasn't consumed and we had pending attributes, reset
      if (pendingAttributesStart !== null && !code.startsWith('#', i)) {
        pendingAttributesStart = null;
        hasPendingMacroOrAttr = false;
      }

      i++;
    }

    return symbols;
  }

  /**
   * Parses methods inside an impl block body.
   */
  private parseImplMethods(
    innerCode: string,
    parentType: string,
    baseOffset: number,
    fullCode: string
  ): ParsedSymbol[] {
    const methods: ParsedSymbol[] = [];
    const len = innerCode.length;
    let i = 0;
    let pendingAttrStart: number | null = null;
    let hasAttr = false;

    while (i < len) {
      while (i < len && /\s/.test(innerCode[i])) i++;
      if (i >= len) break;

      // Skip comments
      if (innerCode[i] === '/' && i + 1 < len && innerCode[i + 1] === '/') {
        while (i < len && innerCode[i] !== '\n') i++;
        continue;
      }
      if (innerCode[i] === '/' && i + 1 < len && innerCode[i + 1] === '*') {
        i += 2;
        while (i + 1 < len && !(innerCode[i] === '*' && innerCode[i + 1] === '/')) i++;
        i += 2;
        continue;
      }

      // Attribute #[...]
      if (innerCode[i] === '#' && i + 1 < len && innerCode[i + 1] === '[') {
        if (pendingAttrStart === null) pendingAttrStart = i;
        hasAttr = true;
        i += 2;
        let depth = 1;
        while (i < len && depth > 0) {
          if (innerCode[i] === '[') depth++;
          else if (innerCode[i] === ']') depth--;
          i++;
        }
        continue;
      }

      // Method: [pub] [async] [const] [unsafe] fn method_name(...)
      const fnMatch = innerCode.slice(i).match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+([A-Za-z0-9_]+)/);
      if (fnMatch) {
        const methodName = fnMatch[1];
        const startChar = (pendingAttrStart !== null ? pendingAttrStart : i) + baseOffset;
        pendingAttrStart = null;
        const hasMacro = hasAttr;
        hasAttr = false;

        let headerEnd = i;
        while (headerEnd < len && innerCode[headerEnd] !== '{' && innerCode[headerEnd] !== ';') {
          headerEnd++;
        }

        if (headerEnd < len && innerCode[headerEnd] === '{') {
          const bodyEndInInner = this.findMatchingBrace(innerCode, headerEnd);
          const endChar = bodyEndInInner + baseOffset;

          const startLine = fullCode.slice(0, startChar).split('\n').length;
          const endLine = fullCode.slice(0, endChar + 1).split('\n').length;
          const startByte = Buffer.byteLength(fullCode.slice(0, startChar), 'utf-8');
          const endByte = Buffer.byteLength(fullCode.slice(0, endChar + 1), 'utf-8');

          methods.push({
            symbolName: methodName,
            qualifiedName: `${parentType}::${methodName}`,
            symbolKind: SymbolKind.METHOD,
            startByte,
            endByte,
            startLine,
            endLine,
            signature: innerCode.slice(i, headerEnd).trim(),
            parentSymbol: parentType,
            metadata: {
              hasMacros: hasMacro,
              hasDecorators: hasMacro,
              parentClass: parentType,
              skeletonSafetyOverride: hasMacro ? 'UNSAFE' : 'SAFE',
            },
          });

          i = bodyEndInInner + 1;
          continue;
        }
      }

      pendingAttrStart = null;
      hasAttr = false;
      i++;
    }

    return methods;
  }

  private findMatchingBrace(code: string, openBraceIndex: number): number {
    return this.findMatchingDelimiter(code, openBraceIndex, '{', '}');
  }

  private findMatchingDelimiter(code: string, openIndex: number, openChar: string, closeChar: string): number {
    let depth = 0;
    let i = openIndex;
    const len = code.length;

    while (i < len) {
      const ch = code[i];

      // Skip normal string "..."
      if (ch === '"') {
        i++;
        while (i < len && code[i] !== '"') {
          if (code[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }

      // Skip raw string r#"..."# or r"..."
      if (ch === 'r' && i + 1 < len && (code[i + 1] === '"' || code[i + 1] === '#')) {
        let hashes = 0;
        let pos = i + 1;
        while (pos < len && code[pos] === '#') {
          hashes++;
          pos++;
        }
        if (pos < len && code[pos] === '"') {
          pos++;
          const endPattern = '"' + '#'.repeat(hashes);
          while (pos < len && !code.startsWith(endPattern, pos)) {
            pos++;
          }
          i = pos + endPattern.length;
          continue;
        }
      }

      // Char literal 'c' or lifetime 'static / 'a
      if (ch === '\'') {
        let isCharLiteral = false;
        let charEnd = -1;
        if (i + 1 < len) {
          if (code[i + 1] === '\\') {
            // Escape sequence in char literal
            let escPos = i + 2;
            if (escPos < len && code[escPos] === 'u' && escPos + 1 < len && code[escPos + 1] === '{') {
              const closeBrace = code.indexOf('}', escPos + 2);
              if (closeBrace !== -1 && closeBrace + 1 < len && code[closeBrace + 1] === '\'') {
                isCharLiteral = true;
                charEnd = closeBrace + 1;
              }
            } else {
              while (escPos < len && code[escPos] !== '\'' && escPos - i < 6) {
                escPos++;
              }
              if (escPos < len && code[escPos] === '\'') {
                isCharLiteral = true;
                charEnd = escPos;
              }
            }
          } else if (i + 2 < len && code[i + 2] === '\'') {
            isCharLiteral = true;
            charEnd = i + 2;
          }
        }

        if (isCharLiteral && charEnd !== -1) {
          i = charEnd + 1;
          continue;
        } else {
          // Lifetime annotation like 'static or 'a - consume quote and identifier
          i++;
          while (i < len && /[A-Za-z0-9_]/.test(code[i])) {
            i++;
          }
          continue;
        }
      }

      // Skip comments
      if (ch === '/' && i + 1 < len && code[i + 1] === '/') {
        while (i < len && code[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && i + 1 < len && code[i + 1] === '*') {
        i += 2;
        while (i + 1 < len && !(code[i] === '*' && code[i + 1] === '/')) i++;
        i += 2;
        continue;
      }

      if (ch === openChar) {
        depth++;
      } else if (ch === closeChar) {
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
