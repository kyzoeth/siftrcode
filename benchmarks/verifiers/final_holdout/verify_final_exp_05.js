const express = require('./');
const res = Object.create(express.response);
res.get = (k) => k === 'x-tag' ? 'v1' : undefined;
if (typeof res.hasHeader !== 'function') process.exit(1);
if (!res.hasHeader('x-tag') || res.hasHeader('x-none')) process.exit(1);
process.exit(0);