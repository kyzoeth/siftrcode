const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

// 1. Copy python_ast.py
const srcPython = path.join(rootDir, 'src/skeleton/python_ast.py');
const destPython = path.join(distDir, 'skeleton/python_ast.py');
if (fs.existsSync(srcPython)) {
  fs.mkdirSync(path.dirname(destPython), { recursive: true });
  fs.copyFileSync(srcPython, destPython);
}

// 2. Load build_provenance from compiled dist
const provenanceModule = path.join(distDir, 'provenance/build_provenance.js');
let computeSourceTreeHash;
let gitState;
if (fs.existsSync(provenanceModule)) {
  try {
    const prov = require(provenanceModule);
    computeSourceTreeHash = prov.computeSourceTreeHash;
    gitState = prov.gitState;
  } catch (_) {}
}

let buildCommit = 'untracked';
let dirty = null;
if (gitState) {
  const git = gitState(rootDir);
  if (git && git.commit) {
    buildCommit = git.commit;
    dirty = git.dirty;
  }
}

if (buildCommit === 'untracked') {
  buildCommit =
    process.env.GIT_COMMIT ||
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    'untracked';
  dirty = null;
}

let sourceTreeHash = 'unknown';
if (computeSourceTreeHash) {
  try {
    sourceTreeHash = computeSourceTreeHash(rootDir);
  } catch (_) {}
}

let sdkVersion = 'unknown';
try {
  sdkVersion = require('@typesafe-ai/sdk/package.json').version;
} catch (_) {}

let version = 'unknown';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  version = pkg.version || 'unknown';
} catch (_) {}

const buildInfo = {
  buildCommit,
  dirty,
  sourceTreeHash,
  sdkVersion,
  builtAt: new Date().toISOString(),
  version,
};

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, 'build_info.json'), JSON.stringify(buildInfo, null, 2) + '\n');
console.log(`✔ Build stamped with commit ${buildCommit} (dirty: ${dirty}, sdk: ${sdkVersion}, v${version})`);
