const utils = require('./lib/utils');
const res = require('./lib/response');
if (typeof utils.escapeDispositionFilename !== 'function' || typeof res.hasSafeAttachmentSupport !== 'function') process.exit(1);
if (utils.escapeDispositionFilename('test') !== 'test-escaped' || res.hasSafeAttachmentSupport() !== true) process.exit(1);
process.exit(0);