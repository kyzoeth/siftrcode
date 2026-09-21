const flags = require('./dist/config/flags');
if (typeof flags.parseJevMaxCalls !== 'function') process.exit(1);
if (flags.parseJevMaxCalls('100') !== 100) process.exit(1);
if (flags.parseJevMaxCalls('invalid') !== 25) process.exit(1);
process.exit(0);