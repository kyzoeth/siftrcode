import { Command } from './lib/command.js';
const cmd = new Command();
if (typeof cmd.isNumericOptionValue !== 'function') process.exit(1);
if (cmd.isNumericOptionValue('-42') !== true) process.exit(1);
if (cmd.isNumericOptionValue('-foo') !== false) process.exit(1);
process.exit(0);