# SiftrCode V2 Final Frozen Baseline Archive

This directory permanently preserves the authoritative, validated SiftrCode V2 deterministic baseline.

## Baseline Guarantees & Identifiers

- **Baseline Git Commit:** `1eedac03b0d83025ebf08ed2945e0ab015c46f6a`
- **Source Tree Hash:** `915b3bda2b1a5834a8dbd037fdde3ab6b9a129ab`
- **Git Tag:** `v2-final`
- **Closure Date:** September 21, 2026
- **CI Matrix:** Passed 6/6 jobs cleanly

## Benchmark Repository Commit Pinning

- **Express (`expressjs/express`):** `9a34acf03cb818ff3f8bc40e44176e277a25cbb9`
- **FastAPI (`fastapi/fastapi`):** `50113da16fec53b66b80d75e80a89296de4fa5a5`
- **SiftrCode (`kyzoeth/siftrcode`):** `1eedac03b0d83025ebf08ed2945e0ab015c46f6a`

## Validated Live Pilot Facts

- **Tasks Completed:** 25/25 (Express: 10, FastAPI: 10, SiftrCode: 5)
- **Provider Calls:** 125 attempts, 125 successes, 0 retries, 0 terminal failures
- **Provider Signals:** 125 valid signals, 0 fallback signals
- **Decision Plan Invariance:** 100% (zero deviation under shadow mode)
- **Lineage Integrity:** Complete, 0 orphaned records across all relations
- **Returned Model:** `jev-1.13.0` via `@typesafe-ai/sdk@0.6.0`

## Canonical 25-Task Ranking Evidence

| Metric | V2 Baseline | JEV Augmented | Delta |
| :--- | :--- | :--- | :--- |
| **NDCG@5** | 0.4122 | 0.4162 | +0.0040 |
| **NDCG@10** | 0.3738 | 0.3764 | +0.0026 |
| **Recall@5** | 0.1615 | 0.1615 | +0.0000 |
| **Recall@10** | 0.2378 | 0.2378 | +0.0000 |
| **MRR** | 0.6990 | 0.7123 | +0.0133 |

## JEV Continuous Head Ground-Truth Correlations

- **Likely Root Cause:** $r = 0.5130$
- **Semantic Relevance:** $r = 0.5004$
- **Likely Edit Target:** $r = 0.1609$

> **Notice**: These numbers represent empirical V2 baseline evidence; they are NOT training targets for V3.

## Contents

- `manifest.json`: Machine-readable metadata and verification values.
- `live_smoke_report.json`: Direct byte-for-byte copy from `/tmp/live_smoke_report.json`.
- `live_pilot_report.json`: Direct byte-for-byte copy from `/tmp/live_pilot_report.json`.
- `checksums.sha256`: SHA-256 hashes verifying archival immutability.
