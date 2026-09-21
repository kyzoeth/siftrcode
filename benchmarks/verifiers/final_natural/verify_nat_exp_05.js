const express = require('./lib/express');
const app = express();
if (typeof app.normalizeRenderOptions !== 'function') process.exit(1);
if (typeof app.normalizeRenderOptions(null) !== 'object' || Object.keys(app.normalizeRenderOptions(null)).length !== 0) process.exit(1);
process.exit(0);