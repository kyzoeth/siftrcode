import { SkeletonResult } from './types';

/**
 * Go skeletonizer: Keeps package, imports, types, structs, interfaces,
 * and function/method signatures while stripping implementation bodies.
 */
export function skeletonizeGolang(code: string, filePath: string = 'file.go'): SkeletonResult {
  const lines = code.split('\n');
  const resultLines: string[] = [];
  const symbols: string[] = [];

  let inFuncBody = false;
  let braceDepth = 0;
  let pendingFuncSig = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Preserve comments, package declarations, imports, types
    if (!inFuncBody) {
      // Check if line declares a function: func ... { or func ...
      const funcMatch = line.match(/^(\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)[^{]*)(.*)$/);
      if (funcMatch) {
        const [, sig, funcName, rest] = funcMatch;
        symbols.push(funcName);

        if (rest.includes('{')) {
          // Function opens on same line
          resultLines.push(sig.trimEnd());
          inFuncBody = true;
          braceDepth = (rest.match(/{/g) || []).length - (rest.match(/}/g) || []).length;
          if (braceDepth <= 0) {
            inFuncBody = false;
            braceDepth = 0;
          }
          continue;
        } else {
          // Signature might span multiple lines or open brace is on next line
          pendingFuncSig = sig;
          continue;
        }
      }

      if (pendingFuncSig) {
        if (line.includes('{')) {
          resultLines.push(pendingFuncSig.trimEnd());
          pendingFuncSig = '';
          inFuncBody = true;
          braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
          if (braceDepth <= 0) {
            inFuncBody = false;
            braceDepth = 0;
          }
          continue;
        } else {
          pendingFuncSig += ' ' + trimmed;
          continue;
        }
      }

      // Extract type/interface/struct names
      const typeMatch = trimmed.match(/^type\s+([A-Za-z0-9_]+)\s+(struct|interface)/);
      if (typeMatch) {
        symbols.push(typeMatch[1]);
      }

      resultLines.push(line);
    } else {
      // Inside function body, count braces until matching close
      const opens = (line.match(/{/g) || []).length;
      const closes = (line.match(/}/g) || []).length;
      braceDepth += opens - closes;

      if (braceDepth <= 0) {
        inFuncBody = false;
        braceDepth = 0;
      }
    }
  }

  const skeletonBody = resultLines.join('\n');
  const skeletonContent = `// [SiftrCode Skeleton] ${filePath} (AST Interface)\n` + skeletonBody.trim() + '\n';

  const origTokens = Math.ceil(code.length / 4);
  const skelTokens = Math.ceil(skeletonContent.length / 4);
  const reductionRatio = origTokens > 0 ? Math.max(0, (origTokens - skelTokens) / origTokens) : 0;

  return {
    filePath,
    language: 'go',
    originalContent: code,
    skeletonContent,
    originalLines: lines.length,
    skeletonLines: skeletonContent.split('\n').length,
    originalTokensEstimate: origTokens,
    skeletonTokensEstimate: skelTokens,
    reductionRatio,
    symbols: Array.from(new Set(symbols))
  };
}
