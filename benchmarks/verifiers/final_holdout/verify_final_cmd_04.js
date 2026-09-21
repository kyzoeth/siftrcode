import { Command } from './lib/command.js';
const cmd = new Command('mycli');
if (typeof cmd.helpFooter !== 'function') process.exit(1);
cmd.helpFooter('=== CLI FOOTER ===');
const info = cmd.helpInformation();
if (!info.trim().endsWith('=== CLI FOOTER ===')) process.exit(1);
process.exit(0);