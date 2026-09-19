import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { skeletonizeFile } from '../skeleton/dispatcher';
import { JevClient } from '../jev/client';

export interface PackOptions {
  directory?: string;
  focus?: string;
  output?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export interface PackResult {
  outputFile: string;
  totalFilesScanned: number;
  rootCandidateFiles: number;
  skeletonizedFiles: number;
  prunedFiles: number;
  rawTokensEstimate: number;
  packedTokensEstimate: number;
  reductionPercentage: number;
  estimatedCostSavedUSD: number;
}

export async function packRepository(options: PackOptions = {}): Promise<PackResult> {
  const rootDir = path.resolve(options.directory || process.cwd());
  const focusPrompt = options.focus || 'general repository architecture and main workflows';
  const outputFile = options.output || 'siftr_context.md';

  const defaultExcludes = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/.venv/**',
    '**/__pycache__/**',
    '**/*.lock',
    '**/package-lock.json',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map',
    '**/*.png',
    '**/*.jpg',
    '**/*.jpeg',
    '**/*.svg',
    '**/*.ico'
  ];

  const files = await glob('**/*', {
    cwd: rootDir,
    nodir: true,
    ignore: defaultExcludes
  });

  const jev = new JevClient();
  let rawTokens = 0;
  let packedTokens = 0;

  let rootCount = 0;
  let skeletonCount = 0;
  let prunedCount = 0;

  const contentBlocks: string[] = [];
  contentBlocks.push(`# SiftrCode Context Pack\n`);
  contentBlocks.push(`**Generated:** ${new Date().toISOString()}`);
  contentBlocks.push(`**Target Focus:** ${focusPrompt}\n`);
  contentBlocks.push(`---\n`);

  const fileDecisionList: Array<{
    file: string;
    action: string;
    tokensBefore: number;
    tokensAfter: number;
  }> = [];

  for (const relPath of files) {
    const fullPath = path.join(rootDir, relPath);
    let rawContent = '';
    try {
      rawContent = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    if (!rawContent.trim()) continue;

    const fileTokens = Math.ceil(rawContent.length / 4);
    rawTokens += fileTokens;

    // 1. AST Skeletonize
    const skeleton = skeletonizeFile(rawContent, relPath);

    // 2. Jev / Heuristic Evaluation
    const decision = await jev.evaluate(relPath, skeleton.symbols, [], focusPrompt);

    if (decision.classification === 'RootCandidate') {
      rootCount++;
      packedTokens += fileTokens;
      contentBlocks.push(`## [Full File] \`${relPath}\`\n\`\`\`${skeleton.language}\n${rawContent.trim()}\n\`\`\`\n`);
      fileDecisionList.push({ file: relPath, action: 'FULL_BODY', tokensBefore: fileTokens, tokensAfter: fileTokens });
    } else if (decision.classification === 'TypeDependencyOnly') {
      skeletonCount++;
      const skelTokens = skeleton.skeletonTokensEstimate;
      packedTokens += skelTokens;
      contentBlocks.push(`## [Skeleton Interface] \`${relPath}\`\n\`\`\`${skeleton.language}\n${skeleton.skeletonContent.trim()}\n\`\`\`\n`);
      fileDecisionList.push({ file: relPath, action: 'SKELETON', tokensBefore: fileTokens, tokensAfter: skelTokens });
    } else {
      prunedCount++;
      // Dead weight: do not inject file body, only list in index
      fileDecisionList.push({ file: relPath, action: 'PRUNED', tokensBefore: fileTokens, tokensAfter: 0 });
    }
  }

  // Append index table
  contentBlocks.push(`\n## SiftrCode Ingestion Index\n`);
  contentBlocks.push(`| File | Classification | Original Tokens | Packed Tokens | Action |`);
  contentBlocks.push(`| :--- | :--- | :--- | :--- | :--- |`);
  for (const item of fileDecisionList.slice(0, 100)) {
    contentBlocks.push(`| \`${item.file}\` | ${item.action} | ${item.tokensBefore} | ${item.tokensAfter} | ${item.action === 'PRUNED' ? 'Omitted' : 'Included'} |`);
  }

  const finalOutput = contentBlocks.join('\n');
  const finalOutputPath = path.isAbsolute(outputFile) ? outputFile : path.join(rootDir, outputFile);
  fs.writeFileSync(finalOutputPath, finalOutput, 'utf-8');

  const reductionPercentage = rawTokens > 0 ? Math.max(0, (rawTokens - packedTokens) / rawTokens) * 100 : 0;
  // Estimated cost based on Claude 3.5 Sonnet ($3.00 / M tokens)
  const estimatedCostSaved = ((rawTokens - packedTokens) / 1_000_000) * 3.0;

  return {
    outputFile: finalOutputPath,
    totalFilesScanned: files.length,
    rootCandidateFiles: rootCount,
    skeletonizedFiles: skeletonCount,
    prunedFiles: prunedCount,
    rawTokensEstimate: rawTokens,
    packedTokensEstimate: packedTokens,
    reductionPercentage: Number(reductionPercentage.toFixed(1)),
    estimatedCostSavedUSD: Number(estimatedCostSaved.toFixed(4))
  };
}
