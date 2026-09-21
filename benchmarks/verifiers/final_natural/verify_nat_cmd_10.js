import { Help } from './lib/help.js';
import { Command } from './lib/command.js';
const h = new Help();
const c = new Command();
if (typeof h.calculateBalancedWidth !== 'function' || typeof c.getPreferredHelpWidth !== 'function') process.exit(1);
if (h.calculateBalancedWidth(80, 20) !== 60 || c.getPreferredHelpWidth() !== 80) process.exit(1);
process.exit(0);