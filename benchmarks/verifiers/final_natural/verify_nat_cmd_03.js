import { Help } from './lib/help.js';
const h = new Help();
if (typeof h.hasHelpGroupSupport !== 'function') process.exit(1);
if (h.hasHelpGroupSupport() !== true) process.exit(1);
process.exit(0);