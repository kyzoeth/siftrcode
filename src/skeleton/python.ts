import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { SkeletonResult } from './types';

export function skeletonizePython(code: string, filePath: string = 'file.py'): SkeletonResult {
  const localDist = path.join(__dirname, 'python_ast.py');
  const srcFallback = path.join(__dirname, '..', '..', 'src', 'skeleton', 'python_ast.py');
  const scriptPath = fs.existsSync(localDist) ? localDist : srcFallback;

  const proc = spawnSync('python3', [scriptPath], {
    input: code,
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024, // 50MB
    timeout: 5000,
  });

  let skeletonBody = code;
  let symbols: string[] = [];

  if (proc.status === 0 && proc.stdout) {
    try {
      const parsed = JSON.parse(proc.stdout);
      if (parsed.skeleton) {
        skeletonBody = parsed.skeleton;
        symbols = parsed.symbols || [];
      }
    } catch {
      // Use raw code fallback if json parsing failed
    }
  }

  const skeletonContent = `# [SiftrCode Synthesized Interface] ${filePath}\n` + skeletonBody.trim() + '\n';

  const origLines = code.split('\n').length;
  const skelLines = skeletonContent.split('\n').length;

  const origTokens = Math.ceil(code.length / 4);
  const skelTokens = Math.ceil(skeletonContent.length / 4);
  const reductionRatio = origTokens > 0 ? Math.max(0, (origTokens - skelTokens) / origTokens) : 0;

  return {
    filePath,
    language: 'python',
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
