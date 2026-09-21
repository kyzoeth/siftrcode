const snap = require('./dist/workspace/workspace_snapshot');
if (typeof snap.validateSnapshotIntegrity !== 'function') process.exit(1);
if (snap.validateSnapshotIntegrity('hash1', 'hash1') !== true) process.exit(1);
if (snap.validateSnapshotIntegrity('hash1', 'hash2') !== false) process.exit(1);
process.exit(0);