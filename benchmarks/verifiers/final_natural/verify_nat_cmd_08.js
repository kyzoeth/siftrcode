import { Option } from './lib/option.js';
const opt = new Option('--dry-run, --dryrun', 'run in dry mode');
if (typeof opt.hasAlternativeLongOption !== 'function') process.exit(1);
if (opt.hasAlternativeLongOption() !== true) process.exit(1);
process.exit(0);