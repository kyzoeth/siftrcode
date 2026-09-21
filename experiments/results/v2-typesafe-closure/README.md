# Canonical SiftrCode V2 Experimental Evidence Archive: Live TypeSafe JEV Study

This directory contains the immutable, audited benchmark reports certifying the completion of **SiftrCode V2** against production **TypeSafe SystemOne** (`https://api.typesafe.ai`).

---

## 1. Study Overview & Certification

- **Target Milestone**: SiftrCode V2 Final Closure Pass & V3 Training Gate
- **Remote Judgment Provider**: TypeSafe SystemOne Production API (`https://api.typesafe.ai`)
- **Remote Model Returned**: `["jev-1.13.0"]`
- **Requested Model**: `jev-latest`
- **SDK Version**: `@typesafe-ai/sdk` `v0.6.0`
- **Question Set Version**: `jev-context-v1`
- **Official Recommendation**: **`PASS_TO_30_TASK_PILOT`**
- **Failed Acceptance Criteria**: **`0`** (0 failed criteria across both studies)
- **Exit Code**: **`0`**

---

## 2. Tested Git & Benchmark Provenance

### SiftrCode Target Repository
- **Tested Git Commit**: `1eedac03b0d83025ebf08ed2945e0ab015c46f6a`
- **Working Tree Cleanliness**: `dirty: false` (`isClean: true`)
- **Source Tree Hash**: `85f9c41cea38316d8c97a258ca27b594e3afb878fbd6d46e97c9b682f9eb7392`
- **Workspace Snapshot ID**: `ws_8dc93498fae1af17`

### Benchmark Repositories (Audited Real-World Tasks)
| Repository | Pinned Git Commit SHA | Snapshot ID | Tasks (Smoke) | Tasks (Pilot) |
| :--- | :--- | :--- | :--- | :--- |
| **Express** (`expressjs/express`) | `9a34acf03cb818ff3f8bc40e44176e277a25cbb9` | `ws_5f24ec44faf3ee13` | 2 | 10 |
| **FastAPI** (`fastapi/fastapi`) | `50113da16fec53b66b80d75e80a89296de4fa5a5` | `ws_bbe7ab0256387db6` | 2 | 10 |
| **SiftrCode** (`kyzoeth/siftrcode`) | `1eedac03b0d83025ebf08ed2945e0ab015c46f6a` | `ws_8dc93498fae1af17` | 1 | 5 |
| **Total** | — | — | **5** | **25** |

---

## 3. Archived Artifacts & Checksums

| Artifact | File Name | Size (Bytes) | SHA-256 Checksum | Execution Timestamp |
| :--- | :--- | :--- | :--- | :--- |
| **Smoke Report** | [`live_smoke_report.json`](./live_smoke_report.json) | 10,052 | `09d397701a2f858b643af70a6ebe31677a9304aa479a997ba8f282091cdccaeb` | `2026-09-21T18:51:49.780Z` |
| **Pilot Report** | [`live_pilot_report.json`](./live_pilot_report.json) | 15,284 | `18a610a34f9bc0e71561cc8c0b79650d137398ea324be3687dc6fff768dfae32` | `2026-09-21T19:13:31.697Z` |
| **Manifest** | [`MANIFEST.json`](./MANIFEST.json) | — | — | `2026-09-21T19:26:00.000Z` |

---

## 4. Study Configuration & Operational Metrics

| Metric | 5-Task Smoke Run | 25-Task Pilot Run | Acceptance Requirement |
| :--- | :--- | :--- | :--- |
| **Execution Mode** | `LIVE_SMOKE` | `LIVE_PILOT` | Live credentialed execution |
| **Total Tasks** | 5 | 25 | All audited tasks complete |
| **Candidates Evaluated** | 25 (5 / task) | 125 (5 / task) | Bounded candidate pool |
| **Provider Attempts** | 25 | 125 | $> 0$ |
| **Provider Successes** | 25 (100%) | 125 (100%) | 100% provider success |
| **Configured Retry Policy** | `smoke_zero_retry` (0 retries) | `pilot_two_retries_with_backoff` (2 retries) | Explicit retry policy |
| **Observed Retries** | **0** | **0** | Zero connection disruptions |
| **Total HTTP Requests** | 25 (1 req / call) | 125 (1 req / call) | Within HTTP budget |
| **Max HTTP Budget / Task** | 10 | 60 | Enforced request ceilings |
| **Terminal Failures** | **0** | **0** | 0 timeouts, 429s, or provider errors |
| **Attempt Failures** | **0** | **0** | 0 attempt-level failures |
| **Rights / Trust Denied** | **0** | **0** | Fail-closed security verified |
| **Median Latency** | **220ms** | **175ms** | Production API response time |
| **P95 Latency** | **551ms** | **294ms** | Predictable tail latency |
| **Peak Concurrency** | **4** (limit: 4) | **4** (limit: 4) | Bounded parallel connections |
| **Plan Invariance** | **100%** (5/5 match) | **100%** (25/25 match) | 100% decision plan invariance |
| **Total Decisions Tracked** | 2,000 | 9,018 | Full SQLite telemetry persistence |
| **Lineage Orphan Rows** | **0** | **0** | Zero foreign-key orphans |
| **Report Consistency Check** | **PASSED** (0 diffs) | **PASSED** (0 diffs) | Authoritative config verification |

---

## 5. Continuous Probability Distributions (25-Task Pilot)

All 4 judgment heads produced non-null continuous probability signals across the candidate pool:

- **Semantic Relevance**: Mean = $0.4676$, Median = $0.50$, Range = $[0.06 - 0.87]$
- **Implementation Needed**: Mean = $0.5662$, Median = $0.62$, Range = $[0.09 - 0.89]$
- **Likely Edit Target**: Mean = $0.6194$, Median = $0.63$, Range = $[0.26 - 0.89]$
- **Likely Root Cause**: Mean = $0.4299$, Median = $0.44$, Range = $[0.04 - 0.91]$

### Ground Truth Correlations
- **Likely Root Cause**: $r = 0.5130$ (Strong positive correlation with verified bug sites)
- **Semantic Relevance**: $r = 0.5004$ (Strong positive correlation)
- **Likely Edit Target**: $r = 0.1609$

### Ranking Ablation (Baseline ContextRank vs JEV-Augmented)
- **MRR (Mean Reciprocal Rank)**: Baseline = $0.6990$ &rarr; JEV = $0.7123$ (**$\Delta = +0.0133$**)
- **NDCG@10**: Baseline = $0.3738$ &rarr; JEV = $0.3764$ (**$\Delta = +0.0026$**)
- **NDCG@5**: Baseline = $0.4122$ &rarr; JEV = $0.4162$ (**$\Delta = +0.0040$**)

---

## 6. Zero Remote Egress Verification

Under default customer operation rights:
- **Raw Source Bodies**: `OMITTED` (0 raw file contents or syntax trees transmitted off-device)
- **Secrets & Credentials**: `OMITTED` (AWS keys, Stripe secrets, and tokens scrubbed by `EnforcedEgressGateway`)
- **Allowed Remote Data Classes**: `TASK_PROMPT`, `SYMBOL_NAME`, `SYMBOL_METADATA`, `PATH`, `NUMERIC_FEATURE`
- **Denied Remote Data Classes**: `RAW_SOURCE`, `SOURCE_SNIPPET`, `PATCH`, `TRAINING`
- **Sample Request Egress Shape**:
```json
{
  "schemaVersion": "string (12 chars)",
  "task": {
    "prompt": "string (73 chars)",
    "evidenceSummary": "string (13 chars)",
    "taskType": "string (11 chars)"
  },
  "candidate": {
    "contextUnitId": "string (21 chars)",
    "kind": "string (11 chars)",
    "title": "string (11 chars)",
    "path": "string (30 chars)"
  },
  "relationships": {},
  "history": {
    "coChange": "number (0.0000)",
    "recentChange": "number (1.0000)"
  }
}
```

---

## 7. Verification Command

To cryptographically verify the integrity of the archived reports:

```bash
shasum -a 256 experiments/results/v2-typesafe-closure/live_smoke_report.json
# Expected: 09d397701a2f858b643af70a6ebe31677a9304aa479a997ba8f282091cdccaeb

shasum -a 256 experiments/results/v2-typesafe-closure/live_pilot_report.json
# Expected: 18a610a34f9bc0e71561cc8c0b79650d137398ea324be3687dc6fff768dfae32
```
