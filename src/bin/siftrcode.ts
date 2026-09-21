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
import { JevClient } from '../jev/client';
import { ContextEngine } from '../engine/context_engine';
import { getResolutionName } from '../context/context_resolution';

const program = new Command();

program
  .name('siftrcode')
  .description('AST-powered codebase skeletonizer and context pruner for AI coding agents')
  .version('0.2.1');

// COMMAND: INIT
program
  .command('init')
  .description('Automatically detects and configures SiftrCode MCP in Claude Code and Cursor')
  .option('--cursor', 'Configure SiftrCode specifically for Cursor IDE (.cursor/mcp.json, .cursorrules, .cursor/rules/siftrcode.mdc)')
  .option('--claude', 'Configure SiftrCode specifically for Claude Code (.mcp.json, CLAUDE.md, .claude/commands/siftr.md)')
  .action((options) => {
    const isCursorOnly = options.cursor && !options.claude;
    const isClaudeOnly = options.claude && !options.cursor;
    const targetLabel = isCursorOnly ? 'Cursor IDE' : isClaudeOnly ? 'Claude Code' : 'Claude Code & Cursor';

    console.log(chalk.bold.green('🚀 [SiftrCode Init]'), `Configuring plugin support for ${chalk.bold.cyan(targetLabel)}...\n`);
    const result = runInstaller({ cursor: options.cursor, claude: options.claude });

    if (result.configsUpdated.length > 0) {
      console.log(chalk.bold.white('✔ Successfully configured SiftrCode MCP in:'));
      for (const conf of result.configsUpdated) {
        console.log(chalk.green(`   • ${conf}`));
      }
    } else {
      console.log(chalk.yellow('ℹ Created local workspace configurations'));
    }

    if (result.rulesCreated.length > 0) {
      console.log('\n' + chalk.bold.white('✔ Created agent optimization rules:'));
      for (const rule of result.rulesCreated) {
        console.log(chalk.cyan(`   • ${rule}`));
      }
    }

    console.log(chalk.gray(`\nRestart your editor/agent (${targetLabel}) to activate SiftrCode.`));
  });

// COMMAND: CURSOR (Alias for init --cursor)
program
  .command('cursor')
  .description('Quickstart: Configures SiftrCode MCP and rules specifically for Cursor IDE')
  .action(() => {
    console.log(chalk.bold.green('🚀 [SiftrCode Cursor]'), 'Configuring Cursor IDE plugin support...\n');
    const result = runInstaller({ cursor: true });

    if (result.configsUpdated.length > 0) {
      console.log(chalk.bold.white('✔ Configured Cursor MCP settings in:'));
      for (const conf of result.configsUpdated) {
        console.log(chalk.green(`   • ${conf}`));
      }
    }

    if (result.rulesCreated.length > 0) {
      console.log('\n' + chalk.bold.white('✔ Created Cursor agent rules:'));
      for (const rule of result.rulesCreated) {
        console.log(chalk.cyan(`   • ${rule}`));
      }
    }

    console.log(chalk.gray('\nRestart Cursor to activate SiftrCode in Composer & Chat.'));
  });

// COMMAND: CLAUDE (Alias for init --claude)
program
  .command('claude')
  .description('Quickstart: Configures SiftrCode MCP, slash command, and guidelines for Claude Code')
  .action(() => {
    console.log(chalk.bold.green('🚀 [SiftrCode Claude]'), 'Configuring Claude Code plugin support...\n');
    const result = runInstaller({ claude: true });

    if (result.configsUpdated.length > 0) {
      console.log(chalk.bold.white('✔ Configured Claude Code settings in:'));
      for (const conf of result.configsUpdated) {
        console.log(chalk.green(`   • ${conf}`));
      }
    }

    if (result.rulesCreated.length > 0) {
      console.log('\n' + chalk.bold.white('✔ Created Claude Code commands and rules:'));
      for (const rule of result.rulesCreated) {
        console.log(chalk.cyan(`   • ${rule}`));
      }
    }

    console.log(chalk.gray('\nRestart Claude Code or Claude Desktop to activate SiftrCode tools.'));
  });

// COMMAND: CONTEXT (Aliases: OPTIMIZE, PLAN) - SiftrCode V2
program
  .command('context <prompt> [directory]')
  .alias('optimize')
  .alias('plan')
  .description('Generates an outcome-aware optimized context bundle for an AI coding task (SiftrCode V2)')
  .option('-d, --dir <directory>', 'Target workspace directory (defaults to current working directory or positional directory argument)')
  .option('-m, --model <agentModel>', 'Target agent model name (e.g. claude-3-5-sonnet, gpt-4o, cursor)', 'claude-3-5-sonnet-20241022')
  .option('-a, --agent <agentKind>', 'Target agent environment adapter: claude_code, cursor, generic_mcp', 'claude_code')
  .option('-p, --profile <budgetProfile>', 'Optimization profile: LEAN, BALANCED, THOROUGH', 'BALANCED')
  .option('-b, --budget <tokens>', 'Explicit maximum token budget (e.g. 8000)', (v) => parseInt(v, 10))
  .option('-c, --cost <usd>', 'Explicit economic cost ceiling in USD (e.g. 0.05)', (v) => parseFloat(v))
  .option('-o, --output <file>', 'Save compiled agent context to disk (e.g. siftr_context.xml or siftr_context.md)')
  .option('--json', 'Output full ContextPlan JSON to stdout')
  .option('--verbose', 'Show detailed candidate ranking reasons and score breakdowns')
  .action(async (prompt, directory, options) => {
    const targetDir = path.resolve(options.dir || directory || process.cwd());
    const startTime = Date.now();

    try {
      const result = await ContextEngine.optimizeWorkspace({
        workspaceDir: targetDir,
        prompt,
        agentModel: options.model,
        agentKind: options.agent,
        budgetProfile: options.profile,
        tokenBudget: options.budget,
        maxCostUSD: options.cost,
      });

      const plan = result.plan;
      const budgetPlan = plan.budgetPlan;

      if (options.json) {
        process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
        return;
      }

      if (options.output) {
        const outPath = path.resolve(options.output);
        fs.writeFileSync(outPath, result.contextString, 'utf-8');
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      const allocatedUnits = plan.units.filter((u) => u.resolution > 0);
      const fullUnits = allocatedUnits.filter((u) => u.resolution >= 4);
      const skeletonUnits = allocatedUnits.filter((u) => u.resolution === 3);
      const signatureUnits = allocatedUnits.filter((u) => u.resolution <= 2);

      console.log(chalk.bold.green('⚡ [SiftrCode V2 ContextEngine]'), 'Context optimized for coding agent!');
      console.log(chalk.gray(`├── Target Directory: ${targetDir}`));
      console.log(chalk.gray(`├── Task Prompt:     "${chalk.cyan(prompt)}"`));
      console.log(chalk.gray(`├── Agent Model:     ${options.model} (${options.agent})`));
      console.log(chalk.gray(`├── Plan ID:         ${chalk.white(plan.planId)} (${elapsed}s)`));
      console.log(chalk.white(`├── [Full Files]     ${chalk.cyan(fullUnits.length)} edit targets preserved at 100% full implementation`));
      console.log(chalk.white(`├── [Skeletonized]   ${chalk.green(skeletonUnits.length)} dependencies compressed to AST interface skeletons`));
      console.log(chalk.white(`└── [Signatures]     ${chalk.yellow(signatureUnits.length)} shallow headers`));

      console.log('\n' + chalk.bold.yellow('📊 Token & Cost Optimization:'));
      console.log(
        chalk.white('   Original Volume:  ') +
        chalk.red(`${budgetPlan.rawTotalTokens.toLocaleString()} tokens`) +
        chalk.white(' ➔ Allocated: ') +
        chalk.green(`${budgetPlan.totalTokens.toLocaleString()} tokens`) +
        chalk.bold.green(` (-${budgetPlan.savingsPercentage.toFixed(1)}%)`)
      );

      console.log(
        chalk.white('   Estimated Cost:   ') +
        chalk.green(`$${budgetPlan.estimatedCostUSD.toFixed(4)} USD`) +
        chalk.gray(` (Saved: ~$${budgetPlan.costSavedUSD.toFixed(4)} USD per turn)`)
      );

      console.log('\n' + chalk.bold.white('📦 Allocated Context Units:'));
      for (const u of allocatedUnits) {
        const resLabel = getResolutionName(u.resolution).toUpperCase();
        const color = u.resolution >= 4 ? chalk.cyan : u.resolution === 3 ? chalk.green : chalk.yellow;
        console.log(
          chalk.gray(' • ') +
          color(`[${resLabel.padEnd(9)}] `) +
          chalk.bold(u.path || u.title) +
          chalk.gray(` (${u.tokenEstimate} tokens)`) +
          (options.verbose ? chalk.gray(` - ${u.reason}`) : '')
        );
      }

      if (options.output) {
        console.log('\n' + chalk.bold.green('✔ Context Saved: ') + chalk.underline(options.output));
        console.log(chalk.gray(`Tip: Run: claude "Review @${path.basename(options.output)} and ${prompt}"`));
      } else {
        console.log(chalk.gray('\nTip: Use `-o siftr_context.xml` to save the formatted context bundle for your agent.'));
      }
    } catch (err: any) {
      console.error(chalk.red('Error optimizing context:'), err.message);
      process.exit(1);
    }
  });

// COMMAND: PACK
program

  .command('pack [directory]')
  .description('Compiles a repository into a token-pruned context pack (context.md)')
  .option('-f, --focus <task>', 'Task description or focus area (e.g., "checkout webhook race condition")')
  .option('-o, --output <file>', 'Output file path', 'siftr_context.md')
  .action(async (directory, options) => {
    console.log(chalk.bold.green('⚡ [SiftrCode v0.2.1]'), 'Scanning repository AST...');
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

// COMMAND: TRIAGE (Alias: JEV)
program
  .command('triage <file>')
  .alias('jev')
  .description('Evaluates a source file against a developer task using Jev Relevance Gating')
  .requiredOption('-t, --task <prompt>', 'Developer task prompt (e.g. "fix JWT expiration bug in auth middleware")')
  .option('--key <apiKey>', 'Jev / TypeSafe API key (defaults to JEV_API_KEY or TYPESAFE_API_KEY env var)')
  .option('--endpoint <url>', 'Jev API endpoint URL', 'https://api.typesafe.ai/v1/decisions')
  .action(async (file, options) => {
    const fullPath = path.resolve(file);
    if (!fs.existsSync(fullPath)) {
      console.error(chalk.red(`File not found: ${file}`));
      process.exit(1);
    }

    const rawContent = fs.readFileSync(fullPath, 'utf-8');
    const skeleton = skeletonizeFile(rawContent, file);
    const jev = new JevClient(options.key, options.endpoint);

    const activeKey = options.key || process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
    const maskedKey = activeKey ? activeKey.slice(0, 4) + '...' + activeKey.slice(-4) : null;

    console.log(chalk.bold.magenta('⚡ [Jev Relevance Gate]'), 'Evaluating file causality...');
    console.log(chalk.gray(`├── Target File:    ${chalk.white(file)}`));
    console.log(chalk.gray(`├── Task Prompt:    "${chalk.cyan(options.task)}"`));
    console.log(chalk.gray(`├── Extracted AST:  ${skeleton.symbols.length} symbols [${skeleton.symbols.slice(0, 6).join(', ')}${skeleton.symbols.length > 6 ? ', ...' : ''}]`));
    console.log(chalk.gray(`├── API Credential: ${maskedKey ? chalk.green('Configured (' + maskedKey + ')') : chalk.yellow('Not set (Using deterministic local heuristic)')}`));
    console.log(chalk.gray(`└── Endpoint:       ${chalk.gray(options.endpoint)}\n`));

    const startTime = Date.now();
    const decision = await jev.evaluate(file, skeleton.symbols, [], options.task);
    const latency = Date.now() - startTime;

    const classColor = decision.classification === 'RootCandidate'
      ? chalk.bold.blue
      : decision.classification === 'TypeDependencyOnly'
        ? chalk.bold.green
        : chalk.bold.red;

    const actionText = decision.classification === 'RootCandidate'
      ? 'Retain 100% full implementation body for direct agent edits'
      : decision.classification === 'TypeDependencyOnly'
        ? 'Synthesize into AST type signature skeleton (dissolve method bodies)'
        : 'Drop completely from context (0 tokens ingested)';

    console.log(chalk.bold.white('📊 Decision Telemetry:'));
    console.log(`   • Classification: ${classColor(decision.classification)}`);
    console.log(`   • Relevance Score: ${chalk.bold.yellow(decision.score + '/10')}`);
    console.log(`   • Critical Path:   ${decision.is_critical_path ? chalk.bold.green('true') : chalk.gray('false')}`);
    console.log(`   • Engine Source:   ${decision.source === 'typesafe-api' ? chalk.green('TypeSafe Jev Cloud API') : chalk.yellow('Local Heuristic Engine')} (${latency}ms)`);
    console.log(`   • SiftrCode Action: ${chalk.white(actionText)}`);
  });

program.parse(process.argv);
