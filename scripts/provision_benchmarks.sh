#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCHMARKS_DIR="${ROOT_DIR}/benchmarks"
mkdir -p "${BENCHMARKS_DIR}"

COMMANDER_REPO_DIR="${BENCHMARKS_DIR}/commander-repo"
EXPRESS_REPO_DIR="${BENCHMARKS_DIR}/express-repo"
FASTAPI_REPO_DIR="${BENCHMARKS_DIR}/fastapi-repo"
V2_WORKTREE_DIR="${ROOT_DIR}/.v2-baseline-worktree"
FROZEN_V2_SHA="1eedac03b0d83025ebf08ed2945e0ab015c46f6a"

# Provision Commander
if [ -d "${COMMANDER_REPO_DIR}/.git" ]; then
  echo "Fetching Commander repo..."
  git -C "${COMMANDER_REPO_DIR}" fetch --quiet origin 2>/dev/null || true
else
  echo "Cloning tj/commander.js..."
  git clone --quiet https://github.com/tj/commander.js.git "${COMMANDER_REPO_DIR}"
fi

# Provision Express
if [ -d "${EXPRESS_REPO_DIR}/.git" ]; then
  echo "Fetching Express repo..."
  git -C "${EXPRESS_REPO_DIR}" fetch --quiet origin 2>/dev/null || true
else
  echo "Cloning expressjs/express..."
  git clone --quiet https://github.com/expressjs/express.git "${EXPRESS_REPO_DIR}"
fi

# Provision FastAPI
if [ -d "${FASTAPI_REPO_DIR}/.git" ]; then
  echo "Fetching FastAPI repo..."
  git -C "${FASTAPI_REPO_DIR}" fetch --quiet origin 2>/dev/null || true
else
  echo "Cloning fastapi/fastapi..."
  git clone --quiet https://github.com/fastapi/fastapi.git "${FASTAPI_REPO_DIR}"
fi

# Provision .v2-baseline-worktree
if [ ! -d "${V2_WORKTREE_DIR}" ]; then
  echo "Creating .v2-baseline-worktree at ${FROZEN_V2_SHA}..."
  git worktree add -f "${V2_WORKTREE_DIR}" "${FROZEN_V2_SHA}"
fi

ACTUAL_V2_SHA="$(git -C "${V2_WORKTREE_DIR}" rev-parse HEAD)"
if [ "${ACTUAL_V2_SHA}" != "${FROZEN_V2_SHA}" ]; then
  echo "ERROR: .v2-baseline-worktree is at ${ACTUAL_V2_SHA}, expected ${FROZEN_V2_SHA}" >&2
  exit 1
fi
echo "Frozen V2 verified at: ${ACTUAL_V2_SHA}"

# Build frozen V2 inside worktree if dist is missing
if [ ! -d "${V2_WORKTREE_DIR}/dist" ]; then
  echo "Building frozen V2 in .v2-baseline-worktree..."
  (cd "${V2_WORKTREE_DIR}" && npm ci && npm run build)
fi

echo "All benchmarks and frozen V2 provisioned successfully."
