
let errMod;
try {
  errMod = require("./dist/workspace/workspace_errors");
} catch (e) {
  process.exit(1);
}
if (typeof errMod.WorkspaceChangedError !== "function") {
  process.exit(1);
}
const err = new errMod.WorkspaceChangedError({
  workspaceSnapshotId: "snap-1",
  filePath: "src/index.ts",
  expectedHash: "h1",
  actualHash: "h2"
});
if (!errMod.isWorkspaceChangedError(err)) {
  process.exit(1);
}
process.exit(0);
