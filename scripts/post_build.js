const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

// 1. Copy python_ast.py
const srcPython = path.join(rootDir, 'src/skeleton/python_ast.py');
const destPython = path.join(distDir, 'skeleton/python_ast.py');
if (fs.existsSync(srcPython)) {
  fs.mkdirSync(path.dirname(destPython), { recursive: true });
  fs.copyFileSync(srcPython, destPython);
}

// 2. Derive build git commit
let buildCommit = 'unknown';
try {
  buildCommit = execSync('git rev-parse HEAD', { cwd: rootDir, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch (_) {
  buildCommit =
    process.env.GIT_COMMIT ||
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    'untracked';
}

// 3. Read package version
let version = 'unknown';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  version = pkg.version || 'unknown';
} catch (_) {}

// 4. Write dist/build_info.json
const buildInfo = {
  buildCommit,
  builtAt: new Date().toISOString(),
  version,
};

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, 'build_info.json'), JSON.stringify(buildInfo, null, 2) + '\n');
console.log(`✔ Build stamped with commit ${buildCommit} (v${version})`);
