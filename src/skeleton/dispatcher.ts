import * as path from 'path';
import { SkeletonResult } from './types';
import { skeletonizeTypeScript } from './typescript';
import { skeletonizePython } from './python';

export function skeletonizeFile(content: string, filePath: string): SkeletonResult {
  const ext = path.extname(filePath).toLowerCase();

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return skeletonizeTypeScript(content, filePath);
  }

  if (['.py', '.pyi'].includes(ext)) {
    return skeletonizePython(content, filePath);
  }

  // Fallback for non-AST files (json, yaml, sql, md, etc.)
  const lines = content.split('\n');
  const origTokens = Math.ceil(content.length / 4);

  return {
    filePath,
    language: 'unknown',
    originalContent: content,
    skeletonContent: content,
    originalLines: lines.length,
    skeletonLines: lines.length,
    originalTokensEstimate: origTokens,
    skeletonTokensEstimate: origTokens,
    reductionRatio: 0,
    symbols: []
  };
}
