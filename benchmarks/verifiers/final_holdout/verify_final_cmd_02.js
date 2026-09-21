import { Option } from './lib/option.js';
const opt = new Option('-o, --old', 'old option');
if (typeof opt.deprecated !== 'function' || typeof opt.isDeprecated !== 'function') process.exit(1);
opt.deprecated('Use --new instead');
if (opt.isDeprecated() !== true || opt.getDeprecatedMessage() !== 'Use --new instead') process.exit(1);
process.exit(0);