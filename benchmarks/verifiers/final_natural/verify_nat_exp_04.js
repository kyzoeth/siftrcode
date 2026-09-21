const express = require('./lib/express');
const app = express();
if (typeof app.formatErrorForLogging !== 'function') process.exit(1);
const err = new Error('boom');
if (!app.formatErrorForLogging(err).includes('boom')) process.exit(1);
process.exit(0);