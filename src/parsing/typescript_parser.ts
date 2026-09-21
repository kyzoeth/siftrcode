/**
 * SiftrCode V2 - TypeScript/JavaScript Structural Symbol Parser (Closure PR 0.1)
 * Extracts TypeScript/JavaScript functions, classes, interfaces, types, enums, and methods
 * with AST-derived line/byte boundaries and safety metadata (hasDecorators, parentClass).
 */

import * as ts from 'typescript';
import { SymbolKind } from '../context/context_unit';
import { LanguageSymbolParser, ParsedSymbol } from './symbol_types';

export class TypeScriptSymbolParser implements LanguageSymbolParser {
  public language = 'typescript';

  public parseSymbols(code: string, relativePath: string = 'file.ts'): ParsedSymbol[] {
    if (!code || !code.trim()) {
      return [];
    }

    const isJsxOrTsx = relativePath.endsWith('.tsx') || relativePath.endsWith('.jsx');
    const sourceFile = ts.createSourceFile(
      relativePath,
      code,
      ts.ScriptTarget.Latest,
      true,
      isJsxOrTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const symbols: ParsedSymbol[] = [];

    const checkHasDecorators = (node: ts.Node): boolean => {
      try {
        if (typeof (ts as any).canHaveDecorators === 'function' && typeof (ts as any).getDecorators === 'function') {
          if ((ts as any).canHaveDecorators(node)) {
            const decs = (ts as any).getDecorators(node);
            if (decs && decs.length > 0) return true;
          }
        }
      } catch {
        // ignore
      }
      if ((node as any).decorators && Array.isArray((node as any).decorators) && (node as any).decorators.length > 0) {
        return true;
      }
      return false;
    };

    const visit = (node: ts.Node, parentClass?: string) => {
      let symKind: SymbolKind | null = null;
      let symName = '';
      let qualName = '';
      let sig = '';
      const hasDecs = checkHasDecorators(node);

      if (ts.isFunctionDeclaration(node) && node.name) {
        symKind = SymbolKind.FUNCTION;
        symName = node.name.text;
        qualName = symName;
        sig = code.slice(node.getStart(sourceFile), (node.body?.getStart(sourceFile) ?? node.getEnd())).trim();
      } else if (ts.isClassDeclaration(node) && node.name) {
        symKind = SymbolKind.CLASS;
        symName = node.name.text;
        qualName = symName;
        const classFullText = code.slice(node.getStart(sourceFile), node.getEnd());
        const braceIdx = classFullText.indexOf('{');
        sig = braceIdx !== -1 ? classFullText.slice(0, braceIdx).trim() : `class ${symName}`;
      } else if (ts.isInterfaceDeclaration(node)) {
        symKind = SymbolKind.INTERFACE;
        symName = node.name.text;
        qualName = symName;
        const ifaceFullText = code.slice(node.getStart(sourceFile), node.getEnd());
        const braceIdx = ifaceFullText.indexOf('{');
        sig = braceIdx !== -1 ? ifaceFullText.slice(0, braceIdx).trim() : `interface ${symName}`;
      } else if (ts.isTypeAliasDeclaration(node)) {
        symKind = SymbolKind.TYPE_ALIAS;
        symName = node.name.text;
        qualName = symName;
        sig = `type ${symName}`;
      } else if (ts.isEnumDeclaration(node)) {
        symKind = SymbolKind.ENUM;
        symName = node.name.text;
        qualName = symName;
        sig = `enum ${symName}`;
      } else if (ts.isMethodDeclaration(node) && parentClass) {
        const nameNode = node.name;
        symName = nameNode ? nameNode.getText(sourceFile) : 'anonymous';
        symKind = SymbolKind.METHOD;
        qualName = `${parentClass}.${symName}`;
        sig = code.slice(node.getStart(sourceFile), (node.body?.getStart(sourceFile) ?? node.getEnd())).trim();
      }

      if (symKind && symName) {
        const startChar = node.getStart(sourceFile);
        const endChar = node.getEnd();
        const startPos = sourceFile.getLineAndCharacterOfPosition(startChar);
        const endPos = sourceFile.getLineAndCharacterOfPosition(endChar);
        const startLine = startPos.line + 1;
        const endLine = endPos.line + 1;

        // Convert character offset to utf-8 byte offset
        const startByte = Buffer.byteLength(code.slice(0, startChar), 'utf-8');
        const endByte = startByte + Buffer.byteLength(code.slice(startChar, endChar), 'utf-8');

        symbols.push({
          symbolName: symName,
          qualifiedName: qualName,
          symbolKind: symKind,
          startByte,
          endByte,
          startLine,
          endLine,
          signature: sig,
          parentSymbol: parentClass,
          metadata: {
            parentClass,
            hasDecorators: hasDecs,
            skeletonSafetyOverride: hasDecs ? 'UNSAFE' : 'SAFE',
          },
        });
      }

      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        for (const member of node.members) {
          visit(member, className);
        }
      } else {
        ts.forEachChild(node, (child) => visit(child, parentClass));
      }
    };

    visit(sourceFile);
    return symbols;
  }
}
