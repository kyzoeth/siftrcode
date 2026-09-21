import { Argument } from './lib/argument.js';
const a = new Argument('<num>');
if (typeof a.withCoercion !== 'function') process.exit(1);
a.withCoercion((v) => parseInt(v, 10));
if (a.parseArg('42') !== 42) process.exit(1);
process.exit(0);