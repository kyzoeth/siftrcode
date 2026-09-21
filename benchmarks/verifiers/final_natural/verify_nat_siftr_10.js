const { ContextRanker } = require('./dist/ranking/context_rank');
const ranker = new ContextRanker();
if (typeof ranker.supportsUniformArtifactSerialization !== 'function') process.exit(1);
if (ranker.supportsUniformArtifactSerialization() !== true) process.exit(1);
process.exit(0);