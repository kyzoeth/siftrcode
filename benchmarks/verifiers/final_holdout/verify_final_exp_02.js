const express = require('./');
const req = Object.create(express.request);
req.headers = {'x-auth': '1'};
if (typeof req.hasHeader !== 'function') process.exit(1);
if (!req.hasHeader('x-auth') || req.hasHeader('x-missing')) process.exit(1);
process.exit(0);