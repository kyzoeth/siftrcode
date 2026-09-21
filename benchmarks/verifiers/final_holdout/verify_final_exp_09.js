const express = require('./');
if (typeof express.getVersion !== 'function') process.exit(1);
if (express.getVersion() !== '5.0.0-alpha') process.exit(1);
process.exit(0);