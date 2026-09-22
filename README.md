# SiftrCode (siftrcode.com)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/assets/logo-white.png">
    <source media="(prefers-color-scheme: light)" srcset="web/assets/logo-black.png">
    <img alt="SiftrCode Logo" src="web/assets/logo-black.png" width="340">
  </picture>
</p>

> **SiftrCode — The context optimizer for coding agents.**  
> Give your coding agent focused repository context instead of dumping the whole codebase into its prompt. Local-first, zero code egress, AST typed interfaces, knapsack token budgeting, and native Model Context Protocol (MCP) support.

[![Version](https://img.shields.io/badge/version-0.3.0-amber.svg)](https://siftrcode.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)
[![Open Source](https://img.shields.io/badge/Open%20Source-100%25-brightgreen.svg)](https://github.com/kyzoeth/siftrcode)
[![CI](https://github.com/kyzoeth/siftrcode/actions/workflows/ci.yml/badge.svg)](https://github.com/kyzoeth/siftrcode/actions)

---

## 🏛️ Model Governance & Evaluation Integrity

SiftrCode operates under an **empirical promotion gate policy**: learned ranking models remain strictly in `RESEARCH` status unless they demonstrate statistically significant superiority ($\Delta\text{NDCG@10} > +0.02$, win/loss ratio $> 1.0$) over the frozen deterministic baseline across independent holdout tasks.

- **Active Production Baseline**: Deterministic `ContextRank` (`v2-final` @ `1eedac03b0d83025ebf08ed2945e0ab015c46f6a`)
- **Learned Model Candidate**: `gbdt_pairwise_v1` (Pairwise GBDT ranking model)
- **Lifecycle Status**: **`RESEARCH` (Unpromoted)**
- **Promotion Decision**: **`V3.1_FAILED_TO_BEAT_BASELINE`**
- **Canonical Artifacts**:
  - Evaluation: `experiments/v3-1-final-natural/offline_evaluation.json`
  - Status: `experiments/v3-1-final-natural/final_status.json`
  - Model Weights: `data/models/gbdt_pairwise_v1.json`

### 🔬 Authoritative Natural Holdout Benchmark (40 Tasks, 4 Repositories)

Evaluations were performed on exact point-in-time git checkouts across **Commander**, **Express**, **FastAPI**, and **SiftrCode** under equal candidate ($N=50$) and token ($\le 8,000$) budgets:

| Metric | Frozen V2 Baseline (`1eedac03...`) | Learned ContextRank V3 (`gbdt_pairwise_v1`) | Delta | Gate Threshold | Result |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **NDCG@10** | **0.8174** | 0.8008 | **-0.0166** | $> +0.0200$ | **FAIL** |
| **NDCG@5** | **0.8174** | 0.8008 | **-0.0166** | Informational | — |
| **Recall@10** | 0.9750 | 0.9750 | $+0.0000$ | $\ge 0.0000$ | **PASS** |
| **MRR** | **0.7750** | 0.7417 | **-0.0333** | Informational | — |
| **Target Coverage** | 97.5% | 97.5% | $+0.0\%$ | Parity | **PASS** |

- **Task Outcomes**: **3 V3 Wins (7.5%) / 31 Ties (77.5%) / 6 V2 Wins (15.0%)** (Win/Loss = 0.50, required $> 1.0$)
- **Bootstrap 95% Confidence Interval (NDCG@10)**: `[-0.0478, +0.0076]` (2,000 resamples)
- **Per-Repository NDCG@10 Breakdown**:
  - **Express** (10 tasks): Frozen V2 0.9082 vs Learned V3 0.8653 ($\Delta -0.0429$)
  - **Commander** (10 tasks): Frozen V2 0.7303 vs Learned V3 0.7155 ($\Delta -0.0148$)
  - **FastAPI** (10 tasks): Frozen V2 0.7709 vs Learned V3 0.7626 ($\Delta -0.0083$)
  - **SiftrCode** (10 tasks): Frozen V2 0.8601 vs Learned V3 0.8601 ($\Delta +0.0000$)

### 🔒 Architectural Invariants & Production Safety
1. **Deterministic Production Path**: Because learned ranking failed the empirical promotion gate, production workloads continue to serve deterministic ContextRank. No learned model weights are invoked in production by default.
2. **Point-in-Time Historical Accuracy**: Each benchmark episode evaluates context retrieval at `episode.baseCommit` in isolated git worktrees, preventing lookahead leakage.
3. **Budget Parity**: Both baseline and learned arms are evaluated with identical candidate budgets ($N=50$) and hard token budgets ($\le 8,000$ tokens).
4. **Zero-Egress & Data Rights**: Local CPU indexing and ranking execute hermetically with zero customer code transmission or remote retention.

---

## ⚡ The Problem: The Dual Failure Modes of Agent Context

When an AI coding agent (Claude Code, Cursor, Antigravity) investigates a task, teams encounter two opposite but equally costly failure modes:

1. **Unconstrained Context Bloat**: The agent ingests 30–50 full files (150k–250k+ tokens). Latency spikes, models lose critical instructions in giant prompts, and token burn reaches hundreds of dollars per developer per month.
2. **Naive Token Stripping**: Indiscriminately collapsing all function bodies destroys the exact code the agent needs to edit. The model hallucinates missing variables, introduces subtle regressions, or triggers expensive multi-turn re-prompting loops.

**SiftrCode solves both problems with Focused Context Optimization**: dynamically allocating full implementation bodies to causal edit targets, typed AST interface skeletons to structural dependencies, and dropping unrelated distractor bloat completely.

---


## 📊 Token Economics & Variable-Resolution Breakdown

SiftrCode optimizes marginal context utility by partitioning repository context into three variable-resolution tiers:

```
[Typical Raw Repository Payload: 85,000 Tokens]
                       │
         ┌─────────────┼─────────────┐
         ▼                           ▼                           ▼
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│  EDIT TARGETS    │        │ STRUCTURAL DEPS  │        │   DISTRACTORS    │
│  (100% Body)     │        │  (AST Skeletons) │        │     (Pruned)     │
├──────────────────┤        ├──────────────────┤        ├──────────────────┤
│ 14,000 Tokens    │        │ 4,200 Tokens     │        │ 0 Tokens Ingested│
│ 0% Fidelity Loss │        │ 88% Compressed   │        │ 66,800 Dropped   │
└──────────────────┘        └──────────────────┘        └──────────────────┘
```

### 1. V2 Budget Profiles

SiftrCode provides three purpose-built optimization profiles:

| Budget Profile | Typical Payload | Token Reduction | Cost / Turn (Sonnet 3.7) | Net Monthly Savings / Dev | Team ROI (10 Devs) | Primary Use Case |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **`balanced`** *(default)* | **18,200 tokens** | **−78.6%** | **$0.055** *(was $0.255)* | **$280 / mo** *(+$3,367/yr)* | **+$33.7k / yr** | Standard feature dev & bug fixes |
| **`aggressive`** | **10,500 tokens** | **−87.6%** | **$0.032** *(was $0.255)* | **$313 / mo** *(+$3,755/yr)* | **+$37.5k / yr** | Large repositories, fast triage, high turn limits |
| **`thorough`** | **32,000 tokens** | **−62.4%** | **$0.096** *(was $0.255)* | **$223 / mo** *(+$2,671/yr)* | **+$26.7k / yr** | Multi-file architecture & complex refactoring |

*Modeled on typical 85k-token repository payload at 50 turns/day, 28 work days/month (1,400 turns/mo per dev).*

### 2. Multi-Model Frontier Cost Matrix

| Frontier Model | Input Price / MTok | Raw Cost / Turn | SiftrCode Balanced | Per-Turn Savings |
| :--- | :---: | :---: | :---: | :---: |
| **Claude 3.7 / 3.5 Sonnet** | $3.00 | $0.255 | **$0.055** | **Save $0.20 / turn (−78.6%)** |
| **OpenAI GPT-4o** | $2.50 | $0.213 | **$0.046** | **Save $0.167 / turn (−78.6%)** |
| **Claude 3 Opus / Reasoning** | $15.00 | $1.275 | **$0.273** | **Save $1.002 / turn (−78.6%)** |

### 3. Truthful Token Accounting Semantics

SiftrCode enforces strict dual-metric token integrity:
- **`estimatedRenderedTokens`**: Calibrated pre-flight against `TokenizerRegistry` (Claude BPE ~3.7 chars/token with 1.15 margin; GPT cl100k/o200k ~3.6 chars/token with 1.15 margin; conservative fallback 1.35 upper-bound). Guarantees zero context window blowouts.
- **`actualProviderInputTokens`**: Reconciled post-turn from actual provider API usage response headers for precise billing auditability.

---

## 🔬 Empirical Pilot Benchmark & JEV Shadow Evaluation

SiftrCode V2.1 includes an empirical benchmark study across 25 audited real-world tasks on production open-source repositories (**Express**, **FastAPI**, and **SiftrCode**).

### Real-World Live Smoke Study Findings

```text
================================================================
  SIFTRCODE V2: TYPESAFE JEV REAL-WORLD PILOT STUDY (5 TASKS)   
  Mode: LIVE REMOTE (TypeSafe SystemOne)
  Tested Git Commit: ef61f2f418a97407a3a2d8363aa12e092409da16
  Clean Build Verification: PASSED (Stamped & In-Sync)
  TypeSafe key configured: true
================================================================
Tasks Evaluated:         5 (Express: 2, FastAPI: 2, SiftrCode: 1)
Decision Plan Invariance: PASSED (100% normalized decision plan SHA-256 match: units, resolutions, allocations & exposures)
Total JEV Calls:         25 (Successful: 25, Failed: 0, Fallback: 0)
Trust Denied Calls:      0
Rights Denied Calls:     0
Budget Skipped Calls:    0
Mean Calls / Task:       5
Peak Concurrency:        Measured = 4 (Configured Limit: 4)
P50 Latency:             179ms (P95: 446ms)
Sample TypeSafe Req ID:  req_01a0c49368217c7487475df9316a7709
----------------------------------------------------------------
Pipeline Configuration & Metadata:
  SDK:                   @typesafe-ai/sdk@0.6.0
  Target Model:          jev-latest
  Question Set:          jev-context-v1 (4 questions)
  Redaction Guarantees:  Raw Source: EXCLUDED | Secrets: REDACTED | Tokens: OMITTED
  Fallback Strategy:     fail_closed_zero_retries (retries: 0)
----------------------------------------------------------------
Continuous Probability Distributions:
  Semantic Relevance:    mean=0.4820, median=0.46, [0.06 - 0.80]
  Implementation Needed: mean=0.5960, median=0.63, [0.10 - 0.86]
  Likely Edit Target:    mean=0.6572, median=0.66, [0.43 - 0.89]
  Likely Root Cause:     mean=0.4440, median=0.37, [0.04 - 0.85]
----------------------------------------------------------------
Correlation with Ground Truth:
  Likely Edit Target:    r = 0.2868
  Likely Root Cause:     r = 0.5743
  Semantic Relevance:    r = 0.5115
----------------------------------------------------------------
Ranking Ablation (Baseline ContextRank vs JEV-Augmented):
  NDCG@5:     Baseline = 0.4725  | JEV = 0.4891 (+0.0166)
  NDCG@10:    Baseline = 0.4235  | JEV = 0.4342 (+0.0107)
  Recall@5:   Baseline = 0.1074  | JEV = 0.1074
  Recall@10:  Baseline = 0.2014  | JEV = 0.2014 (Delta: +0)
  MRR:        Baseline = 0.8286  | JEV = 0.8286 (Delta: +0)
================================================================
[Persistence Verification] Total JEV judgments in SQLite: 25
[Lineage Verification] 0 orphan signals, 0 mismatched snapshots, 0 mismatched agent environments.
```

#### Actual Metadata-Only Sanitized Egress Wire Shape (Call 1)
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

### Key Technical Properties:
- **Normalized Decision Plan Invariance**: Candidate judgment evaluations run fully in shadow mode. The decision plan (selected units, resolutions, token allocations, and exposures) is cryptographically identical (100% SHA-256 match across all decision fields) whether JEV shadow evaluation is active or disabled (`NormalizedPlan_without_JEV == NormalizedPlan_with_JEV_shadow`).
- **Fail-Closed Live Probability Verification**: In live smoke evaluation, SiftrCode strictly asserts valid continuous probabilities in $[0, 1]$ across all 4 heads for 100% of candidate signals, failing immediately if any call errors or falls back.
- **Authoritative Workspace Snapshots**: Every repository derivation, task context, context plan, and JEV signal is pinned to an authoritative `WorkspaceSnapshot` derived from live repository state, throwing `WORKSPACE_SNAPSHOT_MISMATCH` on any split-brain variance.
- **Clean-Build Commit Stamping**: Builds generate stamped `dist/build_info.json` recording Git commit and build timestamps, enforcing that benchmarks execute strictly against cleanly compiled binaries.
- **Strict Decision Budgeting & Honest Concurrency**: Enforces strict call caps per task (`maxCallsPerTask = 5`), zero hidden retries in smoke mode (`retry.maxRetries = 0`), and truthful reporting of measured peak concurrency vs configured limits.
- **Structured Egress Sanitization & Metadata Shape Instrumentation**: All outbound judgment payloads pass through `EnforcedEgressGateway`, redacting raw code bodies, API keys, tokens, and authorization headers, with verified metadata-only shape inspection on the first live call.

---

## 🚀 The 6-Stage Optimization Engine

```
Task Prompt / Issue / Stack Trace
               │
               ▼
┌─────────────────────────────────────────┐
│ 1. Multi-Channel Candidate Discovery     │ ➔ Exact + BM25 + Stack Trace + Graph + Git Co-Change
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 2. Point-in-Time Versioned Features      │ ➔ ContextFeaturesV1 (Strict cutoff, zero future leakage)
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 3. ContextRank Explainable Ranker       │ ➔ Heuristic scoring with transparent channel breakdown
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 4. BundleComposer Submodular Synergy    │ ➔ Maximizes evidence coverage, suppresses redundancy
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 5. ResolutionRank & BudgetSolver        │ ➔ Protects edit targets at FULL/BODY resolution
│    (Variable-Resolution Optimization)   │ ➔ Degrades dependencies to AST skeletons
└──────────────────┬──────────────────────┘ ➔ Enforces token cap & cost ceilings (--profile)
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 6. Agent Adapter Context & Telemetry    │ ➔ Claude Code XML, Cursor Markdown, Generic MCP
└─────────────────────────────────────────┘ ➔ Privacy-by-default (trainingAllowed: false)
```

1. **Multi-Channel Candidate Discovery**: Retrieves candidates across lexical search (exact symbols, BM25), execution evidence (stack traces, test outputs), graph dependencies (imports, callers, types), and historical git co-change coupling.
2. **Point-in-Time Versioned Features**: Extracts deterministic, immutable feature vectors with strict temporal cutoffs to eliminate future-data leakage.
3. **ContextRank Explainable Ranker**: Computes transparent numeric scores with human-readable rationale explanations for every candidate file.
4. **BundleComposer Submodular Synergy**: Solves submodular coverage to ensure critical interfaces and contracts are represented while eliminating duplicate noise.
5. **ResolutionRank & BudgetSolver**: Evaluates candidate utility and selectively assigns `BODY` (100% full implementation), `SKELETON` (AST interfaces & types), or `DROP` (0 tokens).
6. **Agent Adapters & Telemetry**: Formats structured XML/Markdown context bundles for Claude Code, Cursor, and Antigravity. Automatically persists local decision records to `.siftr/observations.sqlite` without network egress.

---

## ⚡ Quickstart

Run SiftrCode instantly with zero configuration:

```bash
# 1-command auto-configuration for Claude Code and Cursor MCP
npx siftrcode init

# Generate an outcome-aware context bundle for your coding task (Default: Balanced profile)
siftr context "Fix payment webhook idempotency race condition" -o context.xml

# Optimize with specific budget profile (balanced | aggressive | thorough)
siftr context "Refactor auth middleware" --profile aggressive -o context.xml

# Output as JSON for automated CI/CD or agent pipelines
siftr context "Fix memory leak in worker pool" --json

# Rank candidate files with explainable scoring breakdown
siftr rank "Fix Stripe invoice webhook handler"

# Audit token bloat in your repository
siftr audit
```

Then pass the generated context directly to Claude or your agent:
```bash
claude "Review @context.xml and fix the issue"
```

---

## 🛠️ CLI Command Reference

### 1. `siftr context <prompt> [directory]` (Aliases: `optimize`, `plan`)
Generates an outcome-aware context bundle optimized for a specific agent model, token budget, and budget profile:

```bash
# Standard optimization with console summary
siftr context "Fix race condition in Redis lock manager"

# Choose budget profile: balanced (default), aggressive, or thorough
siftr context "Optimize database query planner" --profile thorough -o context.xml

# Enforce strict token and cost caps
siftr context "Fix memory leak" --budget 16000 --cost 0.05 -o context.xml

# Target specific agent harness formats
siftr context "Refactor router" --agent cursor
```

### 2. `siftr rank <prompt> [directory]`
Returns ranked candidate files with numeric scores, channel breakdowns, and primary rationales:

```bash
siftr rank "Fix user authentication session timeout"
siftr rank "Update checkout schema" --limit 5 --json
```

### 3. `siftr audit [options] [directory]`
Audits codebase token footprint and calculates potential savings:

```bash
siftr audit
siftr audit --markdown   # GitHub PR comment format
siftr audit --json       # Machine-readable output
```

### 4. `siftr skeleton <file>`
Prints the compiler-verified AST interface skeleton of any source file:

```bash
siftr skeleton src/services/PaymentService.ts
siftr skeleton server/handlers/order.go
siftr skeleton core/engine.py
siftr skeleton src/worker.rs
```

### 5. `siftr pack [directory]`
Compiles a condensed AST context pack for a focus area (V1 compatible).

### 6. `siftr mcp`
Starts the native Model Context Protocol (MCP) server over stdio.

---

## 🤖 Add to Claude Code, Cursor & Antigravity (MCP)

Add SiftrCode to your `~/.claude/settings.json`, workspace `.mcp.json`, or Cursor MCP settings:

```json
{
  "mcpServers": {
    "siftrcode": {
      "command": "npx",
      "args": ["-y", "siftrcode", "mcp"]
    }
  }
}
```

### Exposed MCP Tools

| Tool | Mode | Description |
| :--- | :---: | :--- |
| **`siftr_context`** | **V2 Primary** | End-to-end outcome-aware context optimization returning tokens, costs, and formatted XML context blocks. |
| **`siftr_optimize`** | **V2 Alias** | Official alias for `siftr_context`. |
| **`siftr_rank`** | **V2 Ranking** | Explainable candidate ranker returning candidate scores and primary reasons. |
| **`siftr_expand`** | **Progressive Disclosure** | Dynamically expands an AST interface skeleton to its full implementation body on demand with path containment. |
| **`siftr_outcome`** | **Outcome Feedback** | Reports task execution signals (builds, tests, regressions, actual provider tokens) and evaluates verification policies. |
| **`siftr_session`** | **Session Telemetry** | Inspects active multi-turn agent session telemetry, trajectory events, and cumulative token budgets. |
| **`siftr_skeleton`** | AST Tool | Returns the AST interface skeleton of any file on demand. |
| **`siftr_batch_skeleton`** | Batch AST | Extracts type signatures from multiple candidate files in parallel. |
| **`siftr_pack`** | Bundle Tool | Scans dependencies and generates a pruned context pack for a specific task. |
| **`siftr_audit`** | Audit Tool | Returns token bloat analysis and potential savings across the codebase. |

---

## 🛡️ Enterprise Privacy, Data Rights & Lineage Invariants

SiftrCode is engineered for strict zero-egress compliance and provable data lineage:

- **Fail-Closed Remote Processing**: Remote candidate evaluation is strictly disabled by default (`remoteProcessingAllowed: false`). Evaluates remotely only when explicitly enabled via `DataRights` or the `SIFTR_JEV_REMOTE_PROCESSING=true` environment flag. In production container deployments (e.g. Railway or Docker), `SIFTR_JEV_REMOTE_PROCESSING` is omitted from the Dockerfile and must be explicitly set in Railway/deployment environment variables to grant egress consent.
- **Authoritative WorkspaceSnapshot Identity**: All context operations, indexing, and candidate judgments are bound to immutable composite SHA-256 snapshot hashes (`WorkspaceSnapshot`). Any task or unit mismatch immediately fails closed with `WORKSPACE_SNAPSHOT_MISMATCH`.
- **Zero Raw Source Retention**: Under default `DataRights`, `ContextPlanMetadataRecord` completely strips unit bodies and formatted prompt text before durable SQLite writes (`rawSourceRetentionAllowed: false`).
- **Privacy-by-Default Training Policies**: `trainingAllowed: false` by default. Datasets for local model training require explicit customer opt-in and pass through sanitized `TrainingExporter` routes with cryptographic `exportId` lineage.
- **Tri-State Outcome Evidence**: Tasks with unverified execution evidence are stored as explicit `NULL` (UNKNOWN) rather than falsified 0.0 negatives, preserving training gradient integrity.
- **Structured Egress Redaction**: `EnforcedEgressGateway` structurally scrubs API keys, bearer tokens, passwords, and private file contents before any external provider dispatch.

---

## 🧪 Verification & Test Suites

SiftrCode enforces rigorous verification across **58 test suites** including comprehensive unit tests, JEV shadow gates, acceptance integrity, and 5 dedicated V3 learned intelligence suites:

```bash
# Provision pinned benchmark repositories (Express @ 9a34acf, FastAPI @ 50113da)
bash scripts/provision_benchmarks.sh

# Build the TypeScript project, AST extractors, and stamp source-tree provenance
npm run build

# Run all 58 test suites, including V2 acceptance gates & V3 learned ranker test suites
npm test

# Run SiftrBench v1 benchmark generation and leakage-safe partitioning
node scripts/v3/build_benchmark.js

# Build sanctioned tri-state training dataset and within-task pairs
node scripts/v3/build_dataset.js

# Train GBDT and Linear Pairwise ContextRank models
node scripts/v3/train_context_rank.js

# Evaluate equal-budget held-out ranking, bootstrap CIs, and complete feature ablations
node scripts/v3/evaluate_context_rank.js

# Run paired verified coding-task evaluation (CPVST endpoint)
node scripts/v3/run_verified_task_eval.js
```

### Comprehensive Regression & V3 Verification Coverage
- **Suites 1–14**: Core token accounting, AST skeletonizers, multi-channel discovery, SQLite durable storage, and zero-egress rights filters.
- **Suite 15**: FINAL-3 remediation verification: in-process SystemOne mock, strict 4-head probability validation, counted retry policy, acceptance evaluation, and unforgeable training persistence brand.
- **Suite 16**: FINAL-3.1 acceptance integrity & experimental trustworthiness: universal acceptance invariant, partial harness execution detection, relational anti-joins across 10 relationships, and closed training persistence boundary.
- **Suite 17 (V3 Foundation)**: Frozen V2 SHA immutability (`v2-final` tag), SiftrBench v1 schema validation, multi-repo diversity, and episode replay determinism.
- **Suite 18 (V3 Leakage & Splits)**: Partition disjointness, splitGroupId anti-joins, temporal cutoffs $\le C_0$, and absence of post-outcome fields in model input matrix.
- **Suite 19 (V3 Dataset & Pairs)**: `UNKNOWN != NEGATIVE` invariant, RightsFilter rejection, ground-truth positive association, and strictly within-task pairwise rules.
- **Suite 20 (V3 Models & Fallback)**: Recursive-key checksum anti-tampering, deterministic tie-breaking, safe fallback on model exception / NaN score, and shadow mode plan invariance.
- **Suite 21 (V3 Bootstrap & Eval)**: Task-level non-parametric bootstrap resampling, equal-budget ranking metrics, CPVST zero-success handling, and promotion gate decision logic.

---

## 📂 100% Open-Source Architecture (MIT Licensed)

SiftrCode is completely open-source, local-first, and self-contained within this repository. There are **zero proprietary binaries**, **zero remote telemetry**, and **zero closed-source backends**.

| Component | Source Implementation | Description |
| :--- | :--- | :--- |
| **ContextEngine** | [`src/engine/context_engine.ts`](src/engine/context_engine.ts) | Master orchestrator coordinating discovery, features, ranking, budget solving, and materialization. |
| **TreeRanker (V3 GBDT)** | [`src/learning/models/context_rank/tree_ranker.ts`](src/learning/models/context_rank/tree_ranker.ts) | Native TypeScript Pairwise GBDT (LambdaMART-style) scoring engine with sub-millisecond inference. |
| **LinearPairwiseRanker (V3)** | [`src/learning/models/context_rank/linear_pairwise_ranker.ts`](src/learning/models/context_rank/linear_pairwise_ranker.ts) | Fast coordinate-ascent margin-based pairwise ranker. |
| **SafeFallbackRanker (V3)** | [`src/learning/models/context_rank/learned_context_ranker.ts`](src/learning/models/context_rank/learned_context_ranker.ts) | Safe fallback wrapper delegating to deterministic V2 on any model failure or non-finite output. |
| **ShadowRanker (V3)** | [`src/learning/models/context_rank/shadow_ranker.ts`](src/learning/models/context_rank/shadow_ranker.ts) | Zero-risk shadow evaluation adapter preserving 100% production plan invariance. |
| **FeatureBuilder V3.1** | [`src/learning/features/feature_builder_v3_1.ts`](src/learning/features/feature_builder_v3_1.ts) | Point-in-time 17-feature extractor with $\le C_0$ cutoff and prohibited post-outcome guard. |
| **SiftrDatasetV1Builder** | [`src/learning/datasets/siftr_dataset_v1.ts`](src/learning/datasets/siftr_dataset_v1.ts) | Sanctioned dataset builder enforcing `UNKNOWN != NEGATIVE` and `DataRights` compliance. |
| **PairwiseBuilder** | [`src/learning/datasets/pairwise_builder.ts`](src/learning/datasets/pairwise_builder.ts) | Strictly within-task pairwise ranking instance generator. |
| **SiftrBench Catalog** | [`src/benchmark/siftrbench/`](src/benchmark/siftrbench/) | Canonical 121-task benchmark episodes and leakage-safe `splitGroupId` partition manager. |
| **Verified Task Evaluator** | [`src/learning/evaluation/verified_task_evaluator.ts`](src/learning/evaluation/verified_task_evaluator.ts) | Paired A/B task evaluator measuring CPVST, token deltas, and promotion gate decisions. |
| **TokenizerRegistry** | [`src/token/tokenizer_registry.ts`](src/token/tokenizer_registry.ts) | Truthful token accounting semantics and calibrated provider margins (Claude BPE, GPT cl100k/o200k). |
| **Candidate Discovery** | [`src/retrieval/candidate_generator.ts`](src/retrieval/candidate_generator.ts) | Multi-channel recall (exact, BM25, stack trace, graph, and git co-change). |
| **ContextRank (V2)** | [`src/ranking/context_rank.ts`](src/ranking/context_rank.ts) | Explainable candidate ranker with transparent score breakdown. |
| **BundleComposer** | [`src/context/bundle_composer.ts`](src/context/bundle_composer.ts) | Submodular synergy composer maximizing evidence coverage. |
| **BudgetSolver** | [`src/context/budget_solver.ts`](src/context/budget_solver.ts) | Dynamic token budget and economic cost ceiling solver. |
| **ResolutionRank** | [`src/context/resolution_rank.ts`](src/context/resolution_rank.ts) | Edit target protection (`BODY`) and safe variable-resolution degradation (`SKELETON`). |
| **JEV Shadow Runner** | [`src/providers/judgment/typesafe/jev_shadow_runner.ts`](src/providers/judgment/typesafe/jev_shadow_runner.ts) | Zero-overhead shadow evaluation runner with bounded worker pools and budget enforcement. |
| **WorkspaceSnapshot** | [`src/workspace/workspace_snapshot.ts`](src/workspace/workspace_snapshot.ts) | Immutable repository composite hash snapshotting with snapshot mismatch protection. |
| **Rights-Aware DTOs** | [`src/storage/rights_aware_dto.ts`](src/storage/rights_aware_dto.ts) | Storage sanitization guaranteeing zero raw source retention in SQLite under default rights. |
| **Egress Gateway** | [`src/security/structured_egress.ts`](src/security/structured_egress.ts) | Structural callback sanitization and secret redaction enforcement. |
| **Learning Plane Store** | [`src/storage/sqlite_store.ts`](src/storage/sqlite_store.ts) | Local SQLite persistence for decision observations, outcome evidence, and training records. |
| **Training Lineage** | [`src/learning/lineage.ts`](src/learning/lineage.ts) | Multi-dimensional `TrainingEvidenceRecord` and label derivation algorithms. |
| **Agent Adapters** | [`src/agents/agent_adapter.ts`](src/agents/agent_adapter.ts) | Formatters for Claude Code XML, Cursor Markdown, and Generic MCP. |
| **AST Parsers** | [`src/skeleton/`](src/skeleton/) | Multi-language AST interface extractors with exact boundary tracking (TS, Python, Go, Rust). |
| **MCP Server** | [`src/mcp/server.ts`](src/mcp/server.ts) | Native Model Context Protocol stdio server for Claude Code, Cursor & Antigravity. |


---

## 🌐 Web Platform & Documentation

- **Landing Page & Live Simulator**: [siftrcode.com](https://siftrcode.com)
- **Architecture Deep Dive**: [siftrcode.com/how-it-works.html](https://siftrcode.com/how-it-works.html)
- **Claude Code Integration Guide**: [siftrcode.com/claude.html](https://siftrcode.com/claude.html)
- **About & Mission**: [siftrcode.com/about.html](https://siftrcode.com/about.html)
- **Privacy Policy & Data Rights**: [siftrcode.com/privacy.html](https://siftrcode.com/privacy.html)

---

## 📄 License

MIT © [SiftrCode Team](https://siftrcode.com)
