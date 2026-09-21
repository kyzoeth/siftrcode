const { RightsFilter } = require('./dist/rights/rights_filter');
const rf = new RightsFilter();
if (typeof rf.isPermissiveLicense !== 'function') process.exit(1);
if (!rf.isPermissiveLicense('MIT') || rf.isPermissiveLicense('GPL-3.0')) process.exit(1);
process.exit(0);