const express = require('./');
const req = Object.create(express.request);
if (typeof req.isJson !== 'function') process.exit(1);
req.headers = {'content-type': 'application/json'};
if (!req.isJson()) process.exit(1);
req.headers = {'content-type': 'text/plain'};
if (req.isJson()) process.exit(1);
process.exit(0);