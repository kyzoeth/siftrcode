const res = require('./lib/response');
if (typeof res.shouldOmitContentLength !== 'function') process.exit(1);
if (res.shouldOmitContentLength('chunked') !== true) process.exit(1);
if (res.shouldOmitContentLength(undefined) !== false) process.exit(1);
process.exit(0);