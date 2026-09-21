const utils = require('./lib/utils');
if (typeof utils.safeTrimEnd !== 'function') process.exit(1);
if (utils.safeTrimEnd('  hello  ') !== '  hello') process.exit(1);
process.exit(0);