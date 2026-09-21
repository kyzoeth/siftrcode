import { Command } from './lib/command.js';
const cmd = new Command('mycli');
if (typeof cmd.helpHeader !== 'function') process.exit(1);
cmd.helpHeader('=== CLI BANNER ===');
const info = cmd.helpInformation();
if (!info.startsWith('=== CLI BANNER ===\n')) process.exit(1);
process.exit(0);