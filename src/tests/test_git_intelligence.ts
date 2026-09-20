import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { GitGraphIntelligence } from '../graph/git_graph';
import { createFeatureCutoff } from '../learning/point_in_time_features';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

function makeCommitWithDate(repoDir: string, dateIso: string, msg: string): void {
  execSync(`git commit --allow-empty -m "${msg}"`, {
    cwd: repoDir,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: dateIso,
      GIT_COMMITTER_DATE: dateIso,
    },
  });
}

async function runGitIntelligenceTests() {
  console.log('🧪 Testing Point-in-Time Git Intelligence & Co-Change...\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-test-git-'));

  try {
    execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Git Test"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "git@test.com"', { cwd: tempDir, stdio: 'ignore' });

    // Dates for simulated commits
    const d1 = '2025-01-01T12:00:00Z'; // 1. auth.ts + user.ts
    const d2 = '2025-01-15T12:00:00Z'; // 2. auth.ts + user.ts
    const d3 = '2025-02-01T12:00:00Z'; // 3. auth.ts + user.ts (Cutoff will be set right after this)
    const d4 = '2025-03-01T12:00:00Z'; // 4. unrelated.ts
    const d5 = '2025-04-01T12:00:00Z'; // 5. auth.ts + future_feature.ts (Future leak candidate)

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });

    // Commit 1 (d1)
    fs.writeFileSync(path.join(tempDir, 'src/auth.ts'), 'export const auth = 1;\n');
    fs.writeFileSync(path.join(tempDir, 'src/user.ts'), 'export const user = 1;\n');
    execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    makeCommitWithDate(tempDir, d1, 'commit 1');

    // Commit 2 (d2)
    fs.appendFileSync(path.join(tempDir, 'src/auth.ts'), '// update 2\n');
    fs.appendFileSync(path.join(tempDir, 'src/user.ts'), '// update 2\n');
    execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    makeCommitWithDate(tempDir, d2, 'commit 2');

    // Commit 3 (d3)
    fs.appendFileSync(path.join(tempDir, 'src/auth.ts'), '// update 3\n');
    fs.appendFileSync(path.join(tempDir, 'src/user.ts'), '// update 3\n');
    execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    makeCommitWithDate(tempDir, d3, 'commit 3');

    // Commit 4 (d4)
    fs.writeFileSync(path.join(tempDir, 'src/unrelated.ts'), 'export const unrelated = 1;\n');
    execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    makeCommitWithDate(tempDir, d4, 'commit 4');

    // Commit 5 (d5) - future leak candidate
    fs.appendFileSync(path.join(tempDir, 'src/auth.ts'), '// future update\n');
    fs.writeFileSync(path.join(tempDir, 'src/future_feature.ts'), 'export const future = 1;\n');
    execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    makeCommitWithDate(tempDir, d5, 'commit 5 future');

    const gitIntel = new GitGraphIntelligence({
      repoDir: tempDir,
      minSharedCommits: 2,
      minRelationship: 0.15,
    });

    // 1. History without cutoff (sees all 5 commits)
    console.log('--- 1. Commit History Retrieval ---');
    const allCommits = gitIntel.getCommitHistory();
    assert(allCommits.length === 5, `Retrieved all 5 commits without cutoff (got ${allCommits.length})`);

    // 2. Point-in-time Cutoff Enforcement (Cutoff at 2025-02-05T00:00:00Z)
    console.log('\n--- 2. Point-in-Time Cutoff Enforcement ---');
    const cutoff = createFeatureCutoff({
      timestamp: '2025-02-05T00:00:00Z',
      workspaceSnapshotId: 'ws_snap_cutoff',
    });

    const cutoffCommits = gitIntel.getCommitHistory(cutoff);
    assert(cutoffCommits.length === 3, `Retrieved strictly 3 commits before cutoff (got ${cutoffCommits.length})`);
    assert(!cutoffCommits.some(c => c.message.includes('future')), 'Future commit 5 is excluded by cutoff');
    assert(!cutoffCommits.some(c => c.message.includes('commit 4')), 'Post-cutoff commit 4 is excluded by cutoff');

    // 3. Directional Co-change Calculation
    console.log('\n--- 3. Directional Co-Change Calculation ---');
    const coChangeAuthUser = gitIntel.calculateCoChange('src/auth.ts', 'src/user.ts', cutoff);
    assert(coChangeAuthUser === 1.0, `coChange(auth, user) at cutoff is 1.0 (got ${coChangeAuthUser})`);

    // Architectural guarantee: future file has ZERO co-change at cutoff
    const coChangeFutureAtCutoff = gitIntel.calculateCoChange('src/auth.ts', 'src/future_feature.ts', cutoff);
    assert(coChangeFutureAtCutoff === 0.0, 'Future file has 0.0 co-change at cutoff (no leakage)');

    // Without cutoff, future co-change would be non-zero
    const coChangeFutureWithoutCutoff = gitIntel.calculateCoChange('src/auth.ts', 'src/future_feature.ts');
    assert(coChangeFutureWithoutCutoff > 0.0, 'Without cutoff, future file co-change is detected');

    // 4. Change Frequency & Recent Change Frequency
    console.log('\n--- 4. Change Frequency & Windowing ---');
    const authFreqAtCutoff = gitIntel.getFileChangeFrequency('src/auth.ts', cutoff);
    assert(authFreqAtCutoff === 3, `src/auth.ts change frequency at cutoff is 3 (got ${authFreqAtCutoff})`);

    // Recent change frequency with 20 days window before cutoff (2025-02-05 - 20 days = 2025-01-16)
    // Commit 3 (2025-02-01) falls in window; Commit 2 (2025-01-15) and 1 (2025-01-01) fall outside
    const recentAuthFreq = gitIntel.getRecentChangeFrequency('src/auth.ts', 20, cutoff);
    assert(recentAuthFreq === 1, `Recent change frequency within 20 days of cutoff is 1 (got ${recentAuthFreq})`);

    // 5. Co-Change Pair Extraction
    console.log('\n--- 5. Co-Change Pair Extraction ---');
    const pairs = gitIntel.extractCoChangePairs(cutoff);
    assert(pairs.length >= 2, `Extracted co-change pairs (got ${pairs.length})`);
    const authToUser = pairs.find(p => p.fromPath === 'src/auth.ts' && p.toPath === 'src/user.ts');
    assert(authToUser !== undefined, 'Found co-change pair auth.ts -> user.ts');
    assert(authToUser!.sharedCommits === 3, 'auth.ts -> user.ts has 3 shared commits');

    console.log('\n🎉 All Point-in-Time Git Intelligence tests passed successfully!');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

runGitIntelligenceTests().catch((err) => {
  console.error('❌ Git intelligence test failed:', err);
  process.exit(1);
});
