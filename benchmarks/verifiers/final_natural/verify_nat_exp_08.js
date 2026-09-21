const req = require('./lib/request');
if (typeof req.trimHeaderValue !== 'function') process.exit(1);
if (req.trimHeaderValue('  application/json; charset=utf-8  ') !== 'application/json; charset=utf-8') process.exit(1);
process.exit(0);