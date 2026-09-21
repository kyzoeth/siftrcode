import { Help } from './lib/help.js';
const h = new Help();
if (typeof h.cleanDescriptionExtra !== 'function') process.exit(1);
if (h.cleanDescriptionExtra('  (default: 10)  \n') !== '(default: 10)') process.exit(1);
process.exit(0);