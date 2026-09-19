#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { skeletonizeFile } from '../skeleton/dispatcher';
import { packRepository } from '../core/packer';
import { auditRepository, formatAuditMarkdown } from '../core/auditor';
import { runMcpServer } from '../mcp/server';
import { runInstaller } from '../core/installer';

const program = new Command();

program
  .name('siftrcode')
  .description('AST-powered codebase skeletonizer and context pruner for AI coding agents')
  .version('0.1.1');

// COMMAND: INIT
program
  .command('init')
  .description('Automatically detects and configures SiftrCode MCP in Claude Code and Cursor')
  .action(() => {
    console.log(chalk.bold.green('🚀 [SiftrCode Init]'), 'Auto-configuring AI agent MCP settings...\n');
    const result = runInstaller();

    if (result.configsUpdated.length > 0) {
      console.log(chalk.bold.white('✔ Successfully configured SiftrCode MCP in:'));
      for (const conf of result.configsUpdated) {
        console.log(chalk.green(`   • ${conf}`));
      }
    } else {
      console.log(chalk.yellow('ℹ No default agent config directories found, created workspace .cursor/mcp.json'));
    }

    if (result.rulesCreated.length > 0) {
      console.log('\n' + chalk.bold.white('✔ Created agent optimization rule:'));
      for (const rule of result.rulesCreated) {
        console.log(chalk.cyan(`   • ${rule}`));
      }
    }

    console.log(chalk.gray('\nRestart your editor (Claude Desktop, Cursor) to activate SiftrCode tools.'));
  });

// COMMAND: PACK
program
  .command('pack [directory]')
  .description('Compiles a repository into a token-pruned context pack (context.md)')
  .option('-f, --focus <task>', 'Task description or focus area (e.g., "checkout webhook race condition")')
  .option('-o, --output <file>', 'Output file path', 'siftr_context.md')
  .action(async (directory, options) => {
    console.log(chalk.bold.green('⚡ [SiftrCode v0.1.1]'), 'Scanning repository AST...');
    const dir = directory || process.cwd();
    const startTime = Date.now();

    try {
      const result = await packRepository({
        directory: dir,
        focus: options.focus,
        output: options.output
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log(chalk.gray(`├── Scanned ${result.totalFilesScanned} source files in ${elapsed}s`));
      console.log(chalk.white(`├── [Full Files]     ${chalk.cyan(result.rootCandidateFiles)} kept as root candidates`));
      console.log(chalk.white(`├── [Skeletonized]   ${chalk.green(result.skeletonizedFiles)} stripped to interface skeletons`));
      console.log(chalk.white(`└── [Pruned]         ${chalk.yellow(result.prunedFiles)} deadweight files omitted`));

      console.log('\n' + chalk.bold.green('✔ Context Pack Created: ') + chalk.underline(result.outputFile));
      console.log(
        chalk.white('   Original Volume: ') +
        chalk.red(`${result.rawTokensEstimate.toLocaleString()} tokens`) +
        chalk.white(' ➔ Packed: ') +
        chalk.green(`${result.packedTokensEstimate.toLocaleString()} tokens`) +
        chalk.bold.green(` (-${result.reductionPercentage}%)`)
      );
      console.log(chalk.gray(`   Estimated prompt savings: ~$${result.estimatedCostSavedUSD.toFixed(2)} USD`));
      console.log(chalk.gray(`\nTip: Feed this directly to your agent: claude "Review @${path.basename(result.outputFile)} and ${options.focus || 'fix the issue'}"`));
    } catch (err: any) {
      console.error(chalk.red('Error during pack:'), err.message);
      process.exit(1);
    }
  });

// COMMAND: AUDIT
program
  .command('audit [directory]')
  .description('Audits a codebase for context bloat and token waste')
  .option('--json', 'Output audit report as JSON')
  .option('--markdown', 'Output audit report as GitHub Flavored Markdown')
  .action(async (directory, options) => {
    const dir = directory || process.cwd();

    try {
      const audit = await auditRepository(dir);

      if (options.json) {
        process.stdout.write(JSON.stringify(audit, null, 2) + '\n');
        return;
      }

      if (options.markdown) {
        process.stdout.write(formatAuditMarkdown(audit) + '\n');
        return;
      }

      console.log(chalk.bold.cyan('🔍 [SiftrCode Audit]'), 'Analyzing repository token footprint...');
      console.log(chalk.gray(`├── Target Directory: ${audit.directory}`));
      console.log(chalk.white(`├── Scanned Files:    ${audit.totalFiles} code files (${audit.totalRawLines.toLocaleString()} lines)`));
      console.log(chalk.white(`├── Current Tokens:   ${chalk.red(audit.totalRawTokens.toLocaleString())} raw tokens`));
      console.log(chalk.white(`└── Skeletons Tokens: ${chalk.green(audit.potentialSkeletonTokens.toLocaleString())} tokens`));

      console.log('\n' + chalk.bold.yellow('💰 Financial Impact & Savings:'));
      console.log(
        chalk.white('   Potential Token Waste Eliminated: ') +
        chalk.bold.green(`${audit.potentialTokensSaved.toLocaleString()} tokens (-${audit.savingsPercentage}%)`)
      );
      console.log(
        chalk.white('   Solo Developer Monthly Waste:     ') +
        chalk.bold.red(`~$${audit.monthlyWasteEstimateUSD.soloDeveloper.toFixed(2)} USD`)
      );
      console.log(
        chalk.white('   Team of 10 Monthly Waste:         ') +
        chalk.bold.red(`~$${audit.monthlyWasteEstimateUSD.teamOfTen.toFixed(2)} USD`)
      );

      if (audit.topBloatedFiles.length > 0) {
        console.log('\n' + chalk.bold('Top Bloated Files (Candidates for Skeletonizing):'));
        for (const item of audit.topBloatedFiles.slice(0, 5)) {
          console.log(
            chalk.gray(` • `) +
            chalk.white(item.file) +
            chalk.gray(` (${item.rawTokens} ➔ ${item.skeletonTokens} tokens, `) +
            chalk.green(`-${item.reduction}%`) +
            chalk.gray(`)`)
          );
        }
      }

      console.log(chalk.gray(`\nRun \`siftrcode pack\` to compress this codebase for your next prompt.`));
    } catch (err: any) {
      console.error(chalk.red('Error during audit:'), err.message);
      process.exit(1);
    }
  });

// COMMAND: SKELETON (Single file)
program
  .command('skeleton <file>')
  .description('Prints the AST skeleton of a single source file to stdout')
  .action((file) => {
    const fullPath = path.resolve(file);
    if (!fs.existsSync(fullPath)) {
      console.error(chalk.red(`File not found: ${file}`));
      process.exit(1);
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const skeleton = skeletonizeFile(content, file);
    process.stdout.write(skeleton.skeletonContent);
  });

// COMMAND: MCP
program
  .command('mcp')
  .description('Starts the SiftrCode Model Context Protocol (MCP) server over stdio')
  .action(async () => {
    try {
      await runMcpServer();
    } catch (err: any) {
      console.error('MCP Server Error:', err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);
