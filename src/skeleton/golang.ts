import { SkeletonResult } from './types';

function countBraces(str: string): { opens: number; closes: number } {
  // Strip raw strings (`...`), interpreted strings ("..."), and comments (//...)
  const sanitized = str
    .replace(/`[^`]*`/g, '``')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\/\/.*/g, '');
  const opens = (sanitized.match(/{/g) || []).length;
  const closes = (sanitized.match(/}/g) || []).length;
  return { opens, closes };
}

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
      // Check if line begins a function declaration: func (receiver)? funcName
      const funcStart = line.match(/^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)/);
      if (funcStart) {
        symbols.push(funcStart[1]);

        if (line.includes('{')) {
          const braceIdx = line.indexOf('{');
          resultLines.push(line.slice(0, braceIdx).trimEnd());
          inFuncBody = true;
          const { opens, closes } = countBraces(line.slice(braceIdx));
          braceDepth = opens - closes;
          if (braceDepth <= 0) {
            inFuncBody = false;
            braceDepth = 0;
          }
          continue;
        } else {
          pendingFuncSig = line;
          continue;
        }
      }

      if (pendingFuncSig) {
        if (line.includes('{')) {
          const braceIdx = line.indexOf('{');
          const sigPart = line.slice(0, braceIdx).trim();
          const fullSig = sigPart ? `${pendingFuncSig} ${sigPart}` : pendingFuncSig;
          resultLines.push(fullSig.trimEnd());
          pendingFuncSig = '';
          inFuncBody = true;
          const { opens, closes } = countBraces(line.slice(braceIdx));
          braceDepth = opens - closes;
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
      // Inside function body, count braces safely until matching close
      const { opens, closes } = countBraces(line);
      braceDepth += opens - closes;

      if (braceDepth <= 0) {
        inFuncBody = false;
        braceDepth = 0;
      }
    }
  }

  const skeletonBody = resultLines.join('\n');
  const skeletonContent = `// [SiftrCode Synthesized Interface] ${filePath}\n` + skeletonBody.trim() + '\n';

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
