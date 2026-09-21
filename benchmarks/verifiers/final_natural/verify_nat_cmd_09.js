import { Help } from './lib/help.js';
const h = new Help();
if (typeof h.stripAnsiCodes !== 'function') process.exit(1);
if (h.stripAnsiCodes('\u001b[31mred\u001b[0m') !== 'red') process.exit(1);
process.exit(0);