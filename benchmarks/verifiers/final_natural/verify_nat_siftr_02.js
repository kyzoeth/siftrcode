let prov;
try { prov = require('./dist/provenance/build_provenance'); } catch { process.exit(1); }
if (typeof prov.computeBuildTreeHash !== 'function') process.exit(1);
if (prov.computeBuildTreeHash('clean').length !== 64) process.exit(1);
process.exit(0);