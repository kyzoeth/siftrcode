const { DefaultContextUnitMaterializer } = require('./dist/materialization/context_unit_materializer');
const m = new DefaultContextUnitMaterializer();
if (typeof m.getTruncationMarker !== 'function') process.exit(1);
if (!m.getTruncationMarker().includes('TRUNCAT')) process.exit(1);
process.exit(0);