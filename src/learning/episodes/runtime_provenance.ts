/**
 * SiftrCode V2 - Runtime Build & Configuration Provenance (Phase 20.3)
 *
 * Truthful runtime build provenance and real configuration hashing.
 * Invariants:
 * 1. Never fabricate historical git SHAs (e.g. ba6d13dd...) or versions.
 * 2. If git SHA or version is unavailable, report null / UNKNOWN.
 * 3. Never hash fake constants like "tools_v2" or "system_v2".
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { canonicalJsonSerialize } from './pre_outcome_snapshot';

export interface RuntimeBuildProvenance {
  siftrVersion: string | null;
  siftrGitSha: string | null;
  source: 'BUILD_METADATA' | 'GIT' | 'ENVIRONMENT' | 'UNKNOWN';
}

/**
 * Derives truthful runtime version and Git SHA from actual environment, build metadata, or repository.
 */
export function getRuntimeBuildProvenance(customRootDir?: string): RuntimeBuildProvenance {
  // 1. Explicit environment variable overrides
  if (process.env.SIFTR_GIT_SHA) {
    return {
      siftrVersion: process.env.SIFTR_VERSION || null,
      siftrGitSha: process.env.SIFTR_GIT_SHA,
      source: 'ENVIRONMENT',
    };
  }

  const rootDir = customRootDir || path.resolve(__dirname, '../../..');

  // 2. Read package.json
  let siftrVersion: string | null = null;
  try {
    const pkgPath = path.join(rootDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      siftrVersion = pkg.version || null;
    }
  } catch {}

  // 3. Check build metadata stamp if available
  try {
    const buildMetaPath = path.join(rootDir, 'dist/build_metadata.json');
    if (fs.existsSync(buildMetaPath)) {
      const meta = JSON.parse(fs.readFileSync(buildMetaPath, 'utf8'));
      if (meta.commit && typeof meta.commit === 'string' && meta.commit.length === 40) {
        return {
          siftrVersion: siftrVersion || meta.version || null,
          siftrGitSha: meta.commit,
          source: 'BUILD_METADATA',
        };
      }
    }
  } catch {}

  // 4. Git rev-parse HEAD
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (sha && sha.length === 40) {
      return {
        siftrVersion,
        siftrGitSha: sha,
        source: 'GIT',
      };
    }
  } catch {}

  return {
    siftrVersion,
    siftrGitSha: null,
    source: 'UNKNOWN',
  };
}

/**
 * Computes deterministic SHA-256 hash of real tool configuration, or null if unconfigured.
 */
export function computeToolConfigurationHash(config?: Record<string, unknown> | null): string | null {
  if (!config || Object.keys(config).length === 0) {
    return null;
  }
  const serialized = canonicalJsonSerialize(config);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}
