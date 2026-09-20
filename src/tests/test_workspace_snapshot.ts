import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { WorkspaceManager } from '../workspace/workspace_manager';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

function initGitRepo(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'ignore' });
}

async function runWorkspaceSnapshotTests() {
  console.log('🧪 Testing WorkspaceSnapshot & WorkspaceManager...\n');

  const baseTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-test-ws-'));
  const repo1Dir = path.join(baseTemp, 'repo1');
  const repo2Dir = path.join(baseTemp, 'repo2');
  const nonGitDir = path.join(baseTemp, 'nongit');

  fs.mkdirSync(repo1Dir);
  fs.mkdirSync(repo2Dir);
  fs.mkdirSync(nonGitDir);

  try {
    // Setup git repo 1
    initGitRepo(repo1Dir);
    fs.writeFileSync(path.join(repo1Dir, 'README.md'), '# Repo 1\n');
    fs.writeFileSync(path.join(repo1Dir, 'package.json'), '{"name": "repo1"}\n');
    fs.writeFileSync(path.join(repo1Dir, 'package-lock.json'), '{"lockfileVersion": 3}\n');
    execSync('git add . && git commit -m "initial commit"', { cwd: repo1Dir, stdio: 'ignore' });

    // 1. Clean Git Snapshot Capture
    console.log('--- 1. Clean Git Snapshot Capture ---');
    const mgr1 = new WorkspaceManager({ rootDir: repo1Dir });
    const snap0 = await mgr1.captureSnapshot();

    assert(snap0.workspaceSnapshotId.startsWith('ws_'), 'Snapshot ID has valid prefix');
    assert(snap0.repositories.length === 1, 'Single repository captured');
    const r0 = snap0.repositories[0];
    assert(r0.repositoryId === 'root', 'Default repositoryId is "root"');
    assert(typeof r0.baseCommitSha === 'string' && r0.baseCommitSha.length === 40, 'Captured 40-char base commit SHA');
    assert(r0.dirtyPatchHash === 'clean', 'Clean git repository reports dirtyPatchHash === "clean"');
    assert(r0.untrackedContentHash === 'none', 'No untracked files reports untrackedContentHash === "none"');
    assert(r0.dependencyLockHash !== undefined && r0.dependencyLockHash.startsWith('lock_'), 'Captured package-lock.json hash');

    // 2. Snapshot Stability (Unchanged Workspace)
    console.log('\n--- 2. Snapshot Stability (Unchanged Workspace) ---');
    const snap0Repeat = await mgr1.captureSnapshot();
    assert(snap0Repeat.contentRootHash === snap0.contentRootHash, 'Unchanged workspace produces identical contentRootHash');
    assert(snap0Repeat.workspaceSnapshotId === snap0.workspaceSnapshotId, 'Unchanged workspace produces identical snapshotId');

    // 3. Dirty Tracked Modification Lineage (W0 -> W1)
    console.log('\n--- 3. Dirty Tracked Modification (W0 -> W1) ---');
    fs.appendFileSync(path.join(repo1Dir, 'README.md'), 'Modified line for agent task\n');
    const snap1 = await mgr1.captureSnapshot({ parentSnapshotId: snap0.workspaceSnapshotId });

    assert(snap1.repositories[0].dirtyPatchHash !== 'clean', 'Dirty edit produces non-clean dirtyPatchHash');
    assert(snap1.repositories[0].dirtyPatchHash!.startsWith('diff_'), 'dirtyPatchHash has "diff_" prefix');
    assert(snap1.contentRootHash !== snap0.contentRootHash, 'Dirty edit alters contentRootHash');
    assert(snap1.workspaceSnapshotId !== snap0.workspaceSnapshotId, 'Dirty edit generates distinct snapshotId');
    assert(snap1.parentSnapshotId === snap0.workspaceSnapshotId, 'Child snapshot links parentSnapshotId');

    // 4. Staged Modification
    console.log('\n--- 4. Staged Modification ---');
    execSync('git add README.md', { cwd: repo1Dir, stdio: 'ignore' });
    const snap2 = await mgr1.captureSnapshot({ parentSnapshotId: snap1.workspaceSnapshotId });
    assert(snap2.workspaceSnapshotId !== snap0.workspaceSnapshotId, 'Staged modification produces distinct snapshot from original');

    // Commit change
    execSync('git commit -m "update readme"', { cwd: repo1Dir, stdio: 'ignore' });

    // 5. Untracked File Addition
    console.log('\n--- 5. Untracked File Addition ---');
    fs.writeFileSync(path.join(repo1Dir, 'untracked_scratch.ts'), 'export const scratch = 42;\n');
    const snap3 = await mgr1.captureSnapshot({ parentSnapshotId: snap2.workspaceSnapshotId });

    assert(snap3.repositories[0].untrackedContentHash !== 'none', 'Untracked file detected in untrackedContentHash');
    assert(snap3.repositories[0].untrackedContentHash!.startsWith('untracked_'), 'untrackedContentHash has valid prefix');
    assert(snap3.workspaceSnapshotId !== snap2.workspaceSnapshotId, 'Untracked file changes snapshot identity');

    // 6. Snapshot Lineage Chain Traversal
    console.log('\n--- 6. Snapshot Lineage Chain Traversal ---');
    const lineage = mgr1.getLineage(snap3.workspaceSnapshotId);
    assert(lineage.length === 4, `Lineage chain contains all 4 snapshots (got ${lineage.length})`);
    assert(lineage[0].workspaceSnapshotId === snap0.workspaceSnapshotId, 'Lineage starts at root snapshot snap0');
    assert(lineage[1].workspaceSnapshotId === snap1.workspaceSnapshotId, 'Lineage step 1 is snap1');
    assert(lineage[2].workspaceSnapshotId === snap2.workspaceSnapshotId, 'Lineage step 2 is snap2');
    assert(lineage[3].workspaceSnapshotId === snap3.workspaceSnapshotId, 'Lineage terminus is snap3');

    // 7. Multi-Repository Workspace
    console.log('\n--- 7. Multi-Repository Workspace ---');
    initGitRepo(repo2Dir);
    fs.writeFileSync(path.join(repo2Dir, 'service.go'), 'package main\n');
    execSync('git add . && git commit -m "init service"', { cwd: repo2Dir, stdio: 'ignore' });

    const multiMgr = new WorkspaceManager({
      repositories: [
        { repositoryId: 'frontend', path: repo1Dir },
        { repositoryId: 'backend', path: repo2Dir }
      ]
    });

    const multiSnap = await multiMgr.captureSnapshot();
    assert(multiSnap.repositories.length === 2, 'Multi-repo snapshot captures 2 repositories');
    assert(multiSnap.repositories[0].repositoryId === 'frontend', 'Repository 0 is frontend');
    assert(multiSnap.repositories[1].repositoryId === 'backend', 'Repository 1 is backend');

    // Modifying repo2 only
    fs.appendFileSync(path.join(repo2Dir, 'service.go'), '// new comment\n');
    const multiSnapChild = await multiMgr.captureSnapshot({ parentSnapshotId: multiSnap.workspaceSnapshotId });
    assert(multiSnapChild.workspaceSnapshotId !== multiSnap.workspaceSnapshotId, 'Multi-repo snapshot identity updates when backend mutates');
    const feStateBefore = multiSnap.repositories.find(r => r.repositoryId === 'frontend')!;
    const feStateAfter = multiSnapChild.repositories.find(r => r.repositoryId === 'frontend')!;
    assert(feStateBefore.dirtyPatchHash === feStateAfter.dirtyPatchHash, 'Frontend repository state remains identical when backend mutates');

    // 8. Non-Git Directory Fallback
    console.log('\n--- 8. Non-Git Directory Fallback ---');
    fs.writeFileSync(path.join(nonGitDir, 'config.json'), '{"env": "local"}\n');
    const nonGitMgr = new WorkspaceManager({ rootDir: nonGitDir });
    const nonGitSnap = await nonGitMgr.captureSnapshot();
    assert(nonGitSnap.repositories.length === 1, 'Non-git snapshot captures 1 repository state');
    assert(nonGitSnap.repositories[0].trackedTreeHash.startsWith('nongit_'), 'Non-git tree hash starts with nongit_');
    assert(nonGitSnap.repositories[0].baseCommitSha === undefined, 'Non-git baseCommitSha is undefined');

    console.log('\n🎉 All WorkspaceSnapshot & WorkspaceManager tests passed successfully!');
  } finally {
    try {
      fs.rmSync(baseTemp, { recursive: true, force: true });
    } catch {}
  }
}

runWorkspaceSnapshotTests().catch((err) => {
  console.error('❌ Workspace snapshot test failed:', err);
  process.exit(1);
});
