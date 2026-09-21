const dto = require('./dist/storage/rights_aware_dto');
if (typeof dto.getStorageSchemaVersion !== 'function') process.exit(1);
if (dto.getStorageSchemaVersion() !== 1) process.exit(1);
process.exit(0);