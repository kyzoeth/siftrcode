const express = require('./');
const app = express();
if (typeof app.getMountpaths !== 'function') process.exit(1);
app.mountpath = ['/a', '/b'];
if (app.getMountpaths().length !== 2) process.exit(1);
process.exit(0);