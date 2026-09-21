#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCHMARKS_DIR="${ROOT_DIR}/benchmarks"
mkdir -p "${BENCHMARKS_DIR}"

EXPRESS_REPO_DIR="${BENCHMARKS_DIR}/express-repo"
EXPRESS_PINNED_SHA="9a34acf03cb818ff3f8bc40e44176e277a25cbb9"

FASTAPI_REPO_DIR="${BENCHMARKS_DIR}/fastapi-repo"
FASTAPI_PINNED_SHA="50113da16fec53b66b80d75e80a89296de4fa5a5"

# Provision Express
if [ -d "${EXPRESS_REPO_DIR}/.git" ]; then
  echo "Checking out pinned SHA in existing Express repo..."
  git -C "${EXPRESS_REPO_DIR}" fetch --quiet origin "${EXPRESS_PINNED_SHA}" 2>/dev/null || git -C "${EXPRESS_REPO_DIR}" fetch --quiet origin 2>/dev/null || true
  git -C "${EXPRESS_REPO_DIR}" checkout --quiet "${EXPRESS_PINNED_SHA}"
else
  echo "Cloning expressjs/express..."
  git clone --quiet https://github.com/expressjs/express.git "${EXPRESS_REPO_DIR}"
  git -C "${EXPRESS_REPO_DIR}" checkout --quiet "${EXPRESS_PINNED_SHA}"
fi
EXPRESS_ACTUAL_SHA="$(git -C "${EXPRESS_REPO_DIR}" rev-parse HEAD)"
echo "Express pinned commit: ${EXPRESS_ACTUAL_SHA}"

# Provision FastAPI
if [ -d "${FASTAPI_REPO_DIR}/.git" ]; then
  echo "Checking out pinned SHA in existing FastAPI repo..."
  git -C "${FASTAPI_REPO_DIR}" fetch --quiet origin "${FASTAPI_PINNED_SHA}" 2>/dev/null || git -C "${FASTAPI_REPO_DIR}" fetch --quiet origin 2>/dev/null || true
  git -C "${FASTAPI_REPO_DIR}" checkout --quiet "${FASTAPI_PINNED_SHA}"
else
  echo "Cloning fastapi/fastapi..."
  git clone --quiet https://github.com/fastapi/fastapi.git "${FASTAPI_REPO_DIR}"
  git -C "${FASTAPI_REPO_DIR}" checkout --quiet "${FASTAPI_PINNED_SHA}"
fi
FASTAPI_ACTUAL_SHA="$(git -C "${FASTAPI_REPO_DIR}" rev-parse HEAD)"
echo "FastAPI pinned commit: ${FASTAPI_ACTUAL_SHA}"
