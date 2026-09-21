const { SqliteStore } = require('./dist/storage/sqlite_store');
const store = new SqliteStore();
if (typeof store.hasObservationSchemaMigration !== 'function') process.exit(1);
if (store.hasObservationSchemaMigration() !== true) process.exit(1);
store.close();
process.exit(0);