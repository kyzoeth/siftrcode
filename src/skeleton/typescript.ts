import * as ts from 'typescript';
import { SkeletonResult } from './types';

/**
 * Strips implementation bodies from TypeScript/JavaScript files while
 * preserving 100% of exported interfaces, type signatures, docstrings,
 * class structures, and function headers.
 */
export function skeletonizeTypeScript(code: string, filePath: string = 'file.ts'): SkeletonResult {
  const sourceFile = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );

  const symbols: string[] = [];

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    return (rootNode) => {
      function visit(node: ts.Node): ts.Node {
        // Collect exported or declared symbols
        if (ts.isFunctionDeclaration(node) && node.name) {
          symbols.push(node.name.text);
        } else if (ts.isClassDeclaration(node) && node.name) {
          symbols.push(node.name.text);
        } else if (ts.isInterfaceDeclaration(node)) {
          symbols.push(node.name.text);
        } else if (ts.isTypeAliasDeclaration(node)) {
          symbols.push(node.name.text);
        }

        // 1. Strip function declaration body
        if (ts.isFunctionDeclaration(node)) {
          if (node.body) {
            return ts.factory.updateFunctionDeclaration(
              node,
              node.modifiers,
              node.asteriskToken,
              node.name,
              node.typeParameters,
              node.parameters,
              node.type,
              undefined // Strip body -> becomes declaration signature
            );
          }
        }

        // 2. Strip method declaration body
        if (ts.isMethodDeclaration(node)) {
          if (node.body) {
            return ts.factory.updateMethodDeclaration(
              node,
              node.modifiers,
              node.asteriskToken,
              node.name,
              node.questionToken,
              node.typeParameters,
              node.parameters,
              node.type,
              undefined // Strip body
            );
          }
        }

        // 3. Strip constructor body
        if (ts.isConstructorDeclaration(node)) {
          if (node.body) {
            return ts.factory.updateConstructorDeclaration(
              node,
              node.modifiers,
              node.parameters,
              undefined // Strip body
            );
          }
        }

        // 4. Strip getter/setter body -> convert to property signature or declaration
        if (ts.isGetAccessor(node)) {
          if (node.body) {
            return ts.factory.updateGetAccessorDeclaration(
              node,
              node.modifiers,
              node.name,
              node.parameters,
              node.type,
              undefined
            );
          }
        }
        if (ts.isSetAccessor(node)) {
          if (node.body) {
            return ts.factory.updateSetAccessorDeclaration(
              node,
              node.modifiers,
              node.name,
              node.parameters,
              undefined
            );
          }
        }

        // 5. Arrow functions assigned to variables:
        // const add = (a: number, b: number): number => { ... } -> const add: (a: number, b: number) => number;
        if (ts.isVariableDeclaration(node) && node.initializer) {
          if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
            const fn = node.initializer;
            if (node.name && ts.isIdentifier(node.name)) {
              symbols.push(node.name.text);
            }
            // If type annotation exists or can be constructed, strip body
            const functionType = ts.factory.createFunctionTypeNode(
              fn.typeParameters,
              fn.parameters,
              fn.type || ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)
            );
            return ts.factory.updateVariableDeclaration(
              node,
              node.name,
              node.exclamationToken,
              node.type || functionType,
              undefined // Strip initializer body
            );
          }
        }

        return ts.visitEachChild(node, visit, context);
      }

      return ts.visitNode(rootNode, visit) as ts.SourceFile;
    };
  };

  const transformedResult = ts.transform(sourceFile, [transformer]);
  const transformedSourceFile = transformedResult.transformed[0];

  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false // Retain all JSDoc & type comments!
  });

  const rawSkeleton = printer.printFile(transformedSourceFile);
  transformedResult.dispose();

  // Clean up formatting
  const skeletonContent = `// [SiftrCode Skeleton] ${filePath} (AST Interface)\n` + rawSkeleton.trim() + '\n';

  const origLines = code.split('\n').length;
  const skelLines = skeletonContent.split('\n').length;

  // Rough estimation: ~4 chars per token
  const origTokens = Math.ceil(code.length / 4);
  const skelTokens = Math.ceil(skeletonContent.length / 4);
  const reductionRatio = origTokens > 0 ? Math.max(0, (origTokens - skelTokens) / origTokens) : 0;

  return {
    filePath,
    language: 'typescript',
    originalContent: code,
    skeletonContent,
    originalLines: origLines,
    skeletonLines: skelLines,
    originalTokensEstimate: origTokens,
    skeletonTokensEstimate: skelTokens,
    reductionRatio,
    symbols: Array.from(new Set(symbols))
  };
}
