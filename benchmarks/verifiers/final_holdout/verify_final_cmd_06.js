import { suggestSimilar } from './lib/suggestSimilar.js';
const res = suggestSimilar('compil', ['compile'], 0.95);
if (res !== '') process.exit(1);
const resLow = suggestSimilar('compil', ['compile'], 0.5);
if (!resLow.includes('compile')) process.exit(1);
process.exit(0);