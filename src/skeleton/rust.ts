import { SkeletonResult } from './types';

/**
 * Rust skeletonizer: Keeps modules, uses, structs, enums, traits,
 * and function/method signatures while stripping implementation bodies.
 */
export function skeletonizeRust(code: string, filePath: string = 'file.rs'): SkeletonResult {
  const lines = code.split('\n');
  const resultLines: string[] = [];
  const symbols: string[] = [];

  let inFuncBody = false;
  let braceDepth = 0;
  let pendingFuncSig = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!inFuncBody) {
      // Check for fn declaration: (pub )?(async )?fn name(...) (-> ...)?
      const fnMatch = line.match(/^(\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:const\s+)?fn\s+([A-Za-z0-9_]+)[^{]*)(.*)$/);
      if (fnMatch) {
        const [, sig, fnName, rest] = fnMatch;
        symbols.push(fnName);

        if (rest.includes('{')) {
          resultLines.push(sig.trimEnd() + ';');
          inFuncBody = true;
          braceDepth = (rest.match(/{/g) || []).length - (rest.match(/}/g) || []).length;
          if (braceDepth <= 0) {
            inFuncBody = false;
            braceDepth = 0;
          }
          continue;
        } else {
          pendingFuncSig = sig;
          continue;
        }
      }

      if (pendingFuncSig) {
        if (line.includes('{')) {
          resultLines.push(pendingFuncSig.trimEnd() + ';');
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

      // Extract struct/enum/trait names
      const declMatch = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/);
      if (declMatch) {
        symbols.push(declMatch[1]);
      }

      resultLines.push(line);
    } else {
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
    language: 'rust',
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
