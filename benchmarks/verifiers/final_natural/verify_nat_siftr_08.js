const { GraphBuilder } = require('./dist/graph/graph_builder');
const gb = new GraphBuilder();
if (typeof gb.supportsSemanticProvenanceKinds !== 'function') process.exit(1);
if (gb.supportsSemanticProvenanceKinds() !== true) process.exit(1);
process.exit(0);