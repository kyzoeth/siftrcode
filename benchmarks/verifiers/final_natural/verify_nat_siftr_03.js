const { RightsFilter } = require('./dist/rights/rights_filter');
const rf = new RightsFilter();
if (typeof rf.permitsLocalIndexingWithoutRemoteExport !== 'function') process.exit(1);
if (rf.permitsLocalIndexingWithoutRemoteExport() !== true) process.exit(1);
process.exit(0);