import { Option } from './lib/option.js';
const opt = new Option('-p, --port <number>', 'port');
if (typeof opt.caseSensitive !== 'function' || typeof opt.isCaseSensitive !== 'function') process.exit(1);
opt.caseSensitive(true);
if (opt.isCaseSensitive() !== true) process.exit(1);
opt.caseSensitive(false);
if (opt.isCaseSensitive() !== false) process.exit(1);
process.exit(0);