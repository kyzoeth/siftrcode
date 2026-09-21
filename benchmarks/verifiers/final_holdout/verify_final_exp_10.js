const express = require('./');
const app = express();
if (typeof app.getEnv !== 'function') process.exit(1);
app.set('env', 'staging');
if (app.getEnv() !== 'staging') process.exit(1);
process.exit(0);