const res = require('./lib/response');
if (typeof res.canPreserveCustomEtag !== 'function') process.exit(1);
if (res.canPreserveCustomEtag('"custom-etag-123"') !== true) process.exit(1);
if (res.canPreserveCustomEtag(undefined) !== false) process.exit(1);
process.exit(0);