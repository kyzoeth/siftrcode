const express = require('./');
const app = express();
if (typeof app.prefix !== 'function') process.exit(1);
process.exit(0);