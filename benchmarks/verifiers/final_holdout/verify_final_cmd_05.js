import { Argument } from './lib/argument.js';
const arg = new Argument('<legacy>');
if (typeof arg.deprecated !== 'function' || typeof arg.isDeprecated !== 'function') process.exit(1);
arg.deprecated('Legacy positional argument');
if (arg.isDeprecated() !== true) process.exit(1);
process.exit(0);