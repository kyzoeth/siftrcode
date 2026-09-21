import { Command } from './lib/command.js';
const cmd = new Command();
if (typeof cmd.allowComboFlags !== 'function') process.exit(1);
if (cmd.allowComboFlags() !== true) process.exit(1);
process.exit(0);