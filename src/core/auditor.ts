import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { skeletonizeFile } from '../skeleton/dispatcher';

export interface AuditReport {
  directory: string;
  totalFiles: number;
  totalRawLines: number;
  totalRawTokens: number;
  potentialSkeletonTokens: number;
  potentialTokensSaved: number;
  savingsPercentage: number;
  monthlyWasteEstimateUSD: {
    soloDeveloper: number;
    teamOfTen: number;
  };
  topBloatedFiles: Array<{
    file: string;
    rawLines: number;
    skeletonLines: number;
    rawTokens: number;
    skeletonTokens: number;
    reduction: number;
  }>;
}

export async function auditRepository(dir: string = process.cwd()): Promise<AuditReport> {
  const rootDir = path.resolve(dir);

  const defaultExcludes = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/benchmarks/**',
    '**/.next/**',
    '**/.venv/**',
    '**/__pycache__/**',
    '**/*.lock',
    '**/package-lock.json',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map'
  ];

  const files = await glob('**/*.{ts,tsx,js,jsx,py,go,rs}', {
    cwd: rootDir,
    nodir: true,
    ignore: defaultExcludes
  });

  let totalLines = 0;
  let totalRawTokens = 0;
  let potentialSkeletonTokens = 0;

  const bloatedList: AuditReport['topBloatedFiles'] = [];

  for (const relPath of files) {
    const fullPath = path.join(rootDir, relPath);
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    if (!content.trim()) continue;

    const lines = content.split('\n').length;
    totalLines += lines;

    const skeleton = skeletonizeFile(content, relPath);
    totalRawTokens += skeleton.originalTokensEstimate;
    potentialSkeletonTokens += skeleton.skeletonTokensEstimate;

    if (skeleton.originalTokensEstimate > 500 && skeleton.reductionRatio > 0.3) {
      bloatedList.push({
        file: relPath,
        rawLines: skeleton.originalLines,
        skeletonLines: skeleton.skeletonLines,
        rawTokens: skeleton.originalTokensEstimate,
        skeletonTokens: skeleton.skeletonTokensEstimate,
        reduction: Number((skeleton.reductionRatio * 100).toFixed(1))
      });
    }
  }

  // Sort by tokens saved descending
  bloatedList.sort((a, b) => (b.rawTokens - b.skeletonTokens) - (a.rawTokens - a.skeletonTokens));

  const tokensSaved = Math.max(0, totalRawTokens - potentialSkeletonTokens);
  const savingsPercentage = totalRawTokens > 0 ? (tokensSaved / totalRawTokens) * 100 : 0;

  // Assuming an average of 40 agent interactions/week per dev, each pulling ~20 files
  const avgPromptsPerMonth = 160;
  const wastePerPromptTokens = Math.min(tokensSaved, 150_000);
  const costPerMillionTokens = 3.0; // Claude 3.5 Sonnet list price

  const monthlyWasteSolo = (wastePerPromptTokens * avgPromptsPerMonth * costPerMillionTokens) / 1_000_000;
  const monthlyWasteTeam = monthlyWasteSolo * 10;

  return {
    directory: rootDir,
    totalFiles: files.length,
    totalRawLines: totalLines,
    totalRawTokens,
    potentialSkeletonTokens,
    potentialTokensSaved: tokensSaved,
    savingsPercentage: Number(savingsPercentage.toFixed(1)),
    monthlyWasteEstimateUSD: {
      soloDeveloper: Number(monthlyWasteSolo.toFixed(2)),
      teamOfTen: Number(monthlyWasteTeam.toFixed(2))
    },
    topBloatedFiles: bloatedList.slice(0, 10)
  };
}

export function formatAuditMarkdown(audit: AuditReport): string {
  let md = `## ⚡ SiftrCode Context & Token Audit Report\n\n`;
  md += `> **Directory:** \`${path.basename(audit.directory)}\` • **Files Analyzed:** ${audit.totalFiles} • **Lines:** ${audit.totalRawLines.toLocaleString()}\n\n`;
  md += `### 📊 Token Reduction Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `| :--- | :--- |\n`;
  md += `| **Raw Codebase Footprint** | \`${audit.totalRawTokens.toLocaleString()}\` tokens |\n`;
  md += `| **SiftrCode AST Skeleton Footprint** | \`${audit.potentialSkeletonTokens.toLocaleString()}\` tokens |\n`;
  md += `| **Deadweight Tokens Eliminated** | **\`${audit.potentialTokensSaved.toLocaleString()}\` tokens (-${audit.savingsPercentage}%)** |\n`;
  md += `| **Estimated Solo Dev Monthly Waste** | ~\$${audit.monthlyWasteEstimateUSD.soloDeveloper.toFixed(2)} USD |\n`;
  md += `| **Estimated Team (10 Devs) Monthly Waste** | ~\$${audit.monthlyWasteEstimateUSD.teamOfTen.toFixed(2)} USD |\n\n`;

  if (audit.topBloatedFiles.length > 0) {
    md += `### 🎯 Top Bloat Candidates (Largest Token Reductions)\n\n`;
    md += `| File | Raw Tokens | AST Skeleton | Tokens Saved | Reduction |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: |\n`;
    for (const item of audit.topBloatedFiles.slice(0, 10)) {
      const saved = item.rawTokens - item.skeletonTokens;
      md += `| \`${item.file}\` | ${item.rawTokens.toLocaleString()} | ${item.skeletonTokens.toLocaleString()} | -${saved.toLocaleString()} | **-${item.reduction}%** |\n`;
    }
    md += `\n`;
  }

  md += `*Generated automatically by [SiftrCode](https://siftrcode.com) AST Compiler.*\n`;
  return md;
}
