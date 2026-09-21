import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

function collectRegularFiles(dirPath: string, rootDir: string, out: string[]): void {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectRegularFiles(full, rootDir, out);
    } else if (entry.isFile()) {
      out.push(path.relative(rootDir, full).split(path.sep).join('/'));
    }
  }
}

/**
 * Computes deterministic SHA-256 over sorted relative paths + contents of:
 * src/, scripts/, package.json, package-lock.json, tsconfig.json.
 */
export function computeSourceTreeHash(root: string): string {
  const relativePaths: string[] = [];
  collectRegularFiles(path.join(root, 'src'), root, relativePaths);
  collectRegularFiles(path.join(root, 'scripts'), root, relativePaths);

  for (const fixedFile of ['package.json', 'package-lock.json', 'tsconfig.json']) {
    const full = path.join(root, fixedFile);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      relativePaths.push(fixedFile);
    }
  }

  relativePaths.sort();

  const hash = crypto.createHash('sha256');
  for (const relPath of relativePaths) {
    hash.update(relPath + '\n');
    hash.update(fs.readFileSync(path.join(root, relPath)));
  }

  return hash.digest('hex');
}

/**
 * Returns git commit and dirty state for the hashed provenance inputs.
 */
export function gitState(root: string): { commit: string | null; dirty: boolean | null } {
  let commit: string | null = null;
  let dirty: boolean | null = null;

  try {
    const head = execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (/^[0-9a-f]{40}$/i.test(head)) {
      commit = head;
    }
    const status = execSync(
      'git status --porcelain -- src scripts package.json package-lock.json tsconfig.json',
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .toString()
      .trim();
    dirty = status.length > 0;
  } catch (_) {
    commit = null;
    dirty = null;
  }

  return { commit, dirty };
}

export interface CleanBuildResult {
  buildCommit: string;
  currentGitCommit: string | null;
  dirty: boolean | null;
  sourceTreeHash: string;
  isClean: boolean;
}

/**
 * Validates that the compiled distribution matches the source tree and git repository state.
 * When mandatory is true (e.g. for live runs), throws with a typed .code property.
 */
export function verifyCleanBuild(
  rootDir: string,
  options: { mandatory?: boolean } = {}
): CleanBuildResult {
  const mandatory = options.mandatory ?? false;
  const buildInfoPath = path.join(rootDir, 'dist/build_info.json');

  let buildInfo: any = null;
  if (fs.existsSync(buildInfoPath)) {
    try {
      buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
    } catch (_) {}
  }

  const buildCommit = buildInfo?.buildCommit;
  const git = gitState(rootDir);
  const currentGitCommit = git.commit;

  // 1. UNPROVEN_BUILD: buildCommit is not a 40-char hex SHA, or no git metadata at run time.
  const is40CharHex = typeof buildCommit === 'string' && /^[0-9a-f]{40}$/i.test(buildCommit);
  if (!is40CharHex || !currentGitCommit) {
    if (mandatory) {
      const err = new Error(
        `UNPROVEN_BUILD: ${!is40CharHex ? `stamped buildCommit is invalid (${buildCommit})` : 'no git metadata at run time'}`
      );
      (err as any).code = 'UNPROVEN_BUILD';
      throw err;
    }
    return {
      buildCommit: buildCommit || 'unknown',
      currentGitCommit,
      dirty: buildInfo?.dirty ?? null,
      sourceTreeHash: buildInfo?.sourceTreeHash || 'unknown',
      isClean: false,
    };
  }

  // 2. DIRTY_BUILD: stamped dirty !== false.
  if (buildInfo?.dirty !== false) {
    if (mandatory) {
      const err = new Error(`DIRTY_BUILD: dist/build_info.json has dirty=${buildInfo?.dirty}, expected false`);
      (err as any).code = 'DIRTY_BUILD';
      throw err;
    }
    return {
      buildCommit,
      currentGitCommit,
      dirty: buildInfo?.dirty ?? null,
      sourceTreeHash: buildInfo?.sourceTreeHash || 'unknown',
      isClean: false,
    };
  }

  // 3. DIRTY_WORKTREE: current tree has uncommitted changes to the hashed inputs.
  if (git.dirty === true) {
    if (mandatory) {
      const err = new Error('DIRTY_WORKTREE: current worktree has uncommitted changes to tracked inputs');
      (err as any).code = 'DIRTY_WORKTREE';
      throw err;
    }
    return {
      buildCommit,
      currentGitCommit,
      dirty: true,
      sourceTreeHash: buildInfo?.sourceTreeHash || 'unknown',
      isClean: false,
    };
  }

  // 4. STALE_BUILD_ERROR: HEAD != buildCommit, or recomputed source hash != stamped hash.
  if (currentGitCommit !== buildCommit) {
    if (mandatory) {
      const err = new Error(
        `STALE_BUILD_ERROR: current git HEAD (${currentGitCommit}) does not match buildCommit (${buildCommit})`
      );
      (err as any).code = 'STALE_BUILD_ERROR';
      throw err;
    }
    return {
      buildCommit,
      currentGitCommit,
      dirty: git.dirty,
      sourceTreeHash: buildInfo?.sourceTreeHash || 'unknown',
      isClean: false,
    };
  }

  const currentSourceHash = computeSourceTreeHash(rootDir);
  if (!buildInfo?.sourceTreeHash || currentSourceHash !== buildInfo.sourceTreeHash) {
    if (mandatory) {
      const err = new Error(
        `STALE_BUILD_ERROR: recomputed source tree hash (${currentSourceHash}) does not match stamped hash (${buildInfo?.sourceTreeHash})`
      );
      (err as any).code = 'STALE_BUILD_ERROR';
      throw err;
    }
    return {
      buildCommit,
      currentGitCommit,
      dirty: git.dirty,
      sourceTreeHash: buildInfo?.sourceTreeHash || 'unknown',
      isClean: false,
    };
  }

  return {
    buildCommit,
    currentGitCommit,
    dirty: false,
    sourceTreeHash: buildInfo.sourceTreeHash,
    isClean: true,
  };
}
