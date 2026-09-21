import { Command } from './lib/command.js';
const cmd = new Command();
if (typeof cmd.formatExcessArgumentsError !== 'function') process.exit(1);
if (cmd.formatExcessArgumentsError(['foo', 'bar']) !== "too many arguments: 'foo', 'bar'") process.exit(1);
process.exit(0);