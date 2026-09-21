/**
 * Security Regression Tests for Gemini Execution Boundary & Sandboxing (Phase V3.1 - Phase 7)
 *
 * Verifies strict rejection of:
 * - read ../../outside
 * - read /etc/passwd
 * - write through symlink parent / nested symlink escape
 * - run_command("cat ../../secret")
 * - run_command("cat /etc/passwd")
 * - run_command("find $HOME")
 * - network access when disabled
 * - API keys, GitHub tokens, and AWS credentials in child environment
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeminiWorkspaceSandbox } from '../learning/evaluation/gemini/gemini_tools';

export async function runSecurityRegressionTests() {
  console.log('🔒 [Security Regression Tests] Running sandboxing & execution boundary verifications...');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_sec_test_'));
  const outsideSecretPath = path.join(tmpRoot, 'secret_outside.txt');
  fs.writeFileSync(outsideSecretPath, 'TOP_SECRET_OUTSIDE_DATA', 'utf8');

  const wsDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'app.js'), 'console.log("hello");', 'utf8');

  // Inject mock sensitive environment keys into current process
  process.env.GEMINI_API_KEY = 'mock_gemini_secret_key_12345';
  process.env.GITHUB_TOKEN = 'mock_github_token_xyz987';
  process.env.AWS_SECRET_ACCESS_KEY = 'mock_aws_secret_key_54321';
  process.env.AWS_SESSION_TOKEN = 'mock_aws_session_token_abc';

  try {
    const sandbox = new GeminiWorkspaceSandbox(wsDir, { timeoutMs: 5000 });

    // 1. Rejection of read ../../outside
    assert.throws(
      () => sandbox.readFile('../../secret_outside.txt'),
      /Path traversal denied/,
      'Must reject reading files outside workspace boundary via relative traversal'
    );

    // 2. Rejection of read /etc/passwd
    assert.throws(
      () => sandbox.readFile('/etc/passwd'),
      /Path traversal denied/,
      'Must reject reading absolute paths outside workspace boundary'
    );

    // 3. Rejection of write through symlink parent / nested symlink escape
    const escapedDirLink = path.join(wsDir, 'escaped_dir_link');
    try {
      fs.symlinkSync(tmpRoot, escapedDirLink, 'dir');
    } catch {}

    assert.throws(
      () => sandbox.writeFile('escaped_dir_link/pwned.txt', 'evil'),
      /pointing outside workspace/,
      'Must reject writing files through a symlink pointing outside the workspace'
    );

    // 4. Rejection of run_command("cat ../../secret")
    const resTraverse = sandbox.runCommand('cat ../../secret_outside.txt');
    assert.strictEqual(resTraverse.exitCode, 126, 'Must exit with 126 for prohibited traversal');
    assert.ok(resTraverse.stderr.includes('SecurityError'), 'Must return SecurityError for path traversal');

    // 5. Rejection of run_command("cat /etc/passwd")
    const resPasswd = sandbox.runCommand('cat /etc/passwd');
    assert.strictEqual(resPasswd.exitCode, 126, 'Must exit with 126 for /etc/passwd access');
    assert.ok(resPasswd.stderr.includes('SecurityError'), 'Must return SecurityError for /etc/passwd access');

    // 6. Rejection of run_command("find $HOME")
    const resHome = sandbox.runCommand('find $HOME');
    assert.strictEqual(resHome.exitCode, 126, 'Must exit with 126 for $HOME escape attempt');
    assert.ok(resHome.stderr.includes('SecurityError'), 'Must return SecurityError for $HOME escape');

    // 7. Rejection of network access commands (curl, wget, nc, etc.)
    const resCurl = sandbox.runCommand('curl https://example.com');
    assert.strictEqual(resCurl.exitCode, 126, 'Must reject curl command execution');
    assert.ok(resCurl.stderr.includes('SecurityError'), 'Must return SecurityError for curl');

    const resWget = sandbox.runCommand('wget https://example.com');
    assert.strictEqual(resWget.exitCode, 126, 'Must reject wget command execution');
    assert.ok(resWget.stderr.includes('SecurityError'), 'Must return SecurityError for wget');

    // 8. Rejection of API key, GitHub token, and AWS credentials in child environment
    const resEnv = sandbox.runCommand('node -e "console.log(JSON.stringify(process.env))"');
    assert.strictEqual(resEnv.exitCode, 0, 'node env probe should run');
    const childEnv = JSON.parse(resEnv.stdout || '{}');

    assert.strictEqual(childEnv.GEMINI_API_KEY, undefined, 'GEMINI_API_KEY must not leak to child process');
    assert.strictEqual(childEnv.GITHUB_TOKEN, undefined, 'GITHUB_TOKEN must not leak to child process');
    assert.strictEqual(childEnv.AWS_SECRET_ACCESS_KEY, undefined, 'AWS_SECRET_ACCESS_KEY must not leak to child process');
    assert.strictEqual(childEnv.AWS_SESSION_TOKEN, undefined, 'AWS_SESSION_TOKEN must not leak to child process');

    // 9. Verify HOME is scoped to workspace, not host user directory
    assert.strictEqual(childEnv.HOME, fs.realpathSync(wsDir), 'Child HOME must be isolated to workspace root');

    console.log('✔ All 9 security regression tests passed successfully.\n');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runSecurityRegressionTests().catch((err) => {
    console.error('Security regression test failed:', err);
    process.exit(1);
  });
}
