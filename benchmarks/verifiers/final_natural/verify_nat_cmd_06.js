import { Command } from './lib/command.js';
const cmd = new Command();
if (typeof cmd.cloneOutputConfiguration !== 'function') process.exit(1);
const orig = { writeErr: () => {} };
const cloned = cmd.cloneOutputConfiguration(orig);
if (cloned === orig || typeof cloned.writeErr !== 'function') process.exit(1);
process.exit(0);