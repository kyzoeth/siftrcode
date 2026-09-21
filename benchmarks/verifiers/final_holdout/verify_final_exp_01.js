const express = require('./');
const res = Object.create(express.response);
if (typeof res.etag !== 'function') process.exit(1);
if (!res.etag('hi', { weak: true }).startsWith('W/')) process.exit(1);
process.exit(0);