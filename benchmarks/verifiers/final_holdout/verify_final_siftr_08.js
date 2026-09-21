const { BundleComposer } = require('./dist/context/bundle_composer');
const bc = new BundleComposer();
if (typeof bc.getMaxBundleTokens !== 'function') process.exit(1);
bc.setMaxBundleTokens(5000);
if (bc.getMaxBundleTokens() !== 5000) process.exit(1);
process.exit(0);