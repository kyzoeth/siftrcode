const { GraphBuilder } = require('./dist/graph/graph_builder');
const gb = new GraphBuilder();
const g = gb.buildGraph([], { repoDir: process.cwd() });
if (typeof g.hasCycles !== 'function') process.exit(1);
if (g.hasCycles() !== false) process.exit(1);
process.exit(0);