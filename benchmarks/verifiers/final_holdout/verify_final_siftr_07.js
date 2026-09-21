const { DefaultContextUnitMaterializer } = require('./dist/materialization/context_unit_materializer');
const m = new DefaultContextUnitMaterializer();
if (typeof m.supportsRawFallback !== 'function') process.exit(1);
if (m.supportsRawFallback() !== true) process.exit(1);
process.exit(0);