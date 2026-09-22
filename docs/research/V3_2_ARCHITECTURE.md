# SiftrCode V3.2 Architecture & Research Strategy

## Status & Governance Context

SiftrCode V3.1 is **scientifically closed** with status `V3.1_FAILED_TO_BEAT_BASELINE`.
The deterministic V2 context-ranking system remains active in production (`production-v2-deterministic-2026-09`).
The V3.1 GBDT ranking model (`gbdt_pairwise_v1`) remains strictly classified as `RESEARCH`.

This document defines the research strategy and target architecture for **SiftrCode V3.2**, designed to overcome the structural failure modes of V3.1 by leveraging the production data flywheel (`SIFTR_CONTEXT_DATASET_V2`).

---

## 1. Post-Mortem: Why V3.1 Failed to Beat the Baseline

In natural holdout evaluations (40 tasks, 4 repositories), learned ContextRank V3.1 scored **NDCG@10 = 0.5034** versus the frozen V2 baseline **NDCG@10 = 0.5200** ($\Delta = -0.0166$, Win/Loss = 0.50) and **Recall@10 = 0.5625** versus frozen V2 **Recall@10 = 0.6500** ($\Delta = -0.0875$).

Three primary root causes were identified:

1. **Unconstrained Ranking of Critical Heuristic Anchors**:
   In V3.1, the learned GBDT scored all candidates uniformly in a single unconstrained pairwise list. In several cases, strong deterministic signals (e.g., exact symbol matches in a failing test or stack trace) received slightly lower learned scores than broad lexical matches with high co-change frequency, causing subtle rank inversions in the top 3 slots.

2. **Supervision Collapse in Training Data**:
   Early training regimes treated binary git diff edits as absolute ground truth. In reality:
   - Not all edited files were known at retrieval time.
   - Essential reference files (read but not edited) were penalized as negative distractors.
   - High-quality candidate units unshown to the agent were treated as negatives (`UNKNOWN == NEGATIVE` fallacy).

3. **Insufficient Real-World Trajectory Diversity**:
   Synthetic benchmark episodes generated with fixed agent scripts lacked the multi-turn exploration patterns, tool call iterations, and verifier feedback cycles present in production agent workflows.

---

## 2. V3.2 Core Architectural Paradigm

V3.2 moves away from monolithic single-stage ranking to a **Constrained Multi-Stage Cascade with Protected Candidate Sets**:

```
[Candidate Discovery Channels]
 (BM25, Graph, Co-Change, Stack Trace, Dirty Diff)
                  │
                  ▼
┌──────────────────────────────────────────────────┐
│ STAGE 1: Protected Candidate Set Identification   │
│  - Exact Symbol Matches                          │
│  - Active Stack Trace Locations                  │
│  - Failing Test File References                  │
│  - Compiler Error Locations                      │
│  - Dirty Diff / Working Tree Touches             │
└──────────────────────────────────────────────────┘
                  │
                  ├──► [Protected Set: Hard Top-K Allocation Floor]
                  │
                  ▼
┌──────────────────────────────────────────────────┐
│ STAGE 2: Constrained Learned Reranking            │
│  - Rank remaining ambiguous candidates           │
│  - Objective: maximize marginal utility within    │
│    remaining token budget                        │
│  - Strict Recall Preservation Constraint         │
└──────────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────┐
│ STAGE 3: Variable-Resolution Knapsack Packing     │
│  - Edit Targets: BODY (100% fidelity)            │
│  - Structural Deps: SKELETON (AST interface)     │
│  - Distractors: PRUNED                           │
└──────────────────────────────────────────────────┘
```

### Key Principles

1. **Protected Candidate Sets (Non-Negotiable Anchor Preservation)**:
   High-precision deterministic signals (exact identifier matches from stack traces, active test errors, compiler diagnostics, and dirty working tree files) are partitioned into a **Protected Candidate Set**.
   - Protected candidates are guaranteed top tier priority.
   - The learned model cannot downgrade a protected candidate below an ambiguous exploratory candidate.

2. **Recall Preservation Constraints**:
   A candidate ranker must never degrade recall on known critical targets compared to baseline heuristic retrieval. Learned reranking operates within candidate equivalence classes and prioritizes structural relevance among ambiguous candidates.

3. **Multi-Resolution Token Budgeting**:
   Reranking determines not only candidate ordering, but optimal resolution assignment (`BODY` vs `SKELETON`). High-confidence edit targets receive full bodies; broad dependency context receives compact AST skeletons.

---

## 3. Model Exploration Directions

The V3.2 research program will investigate three primary model families:

### Direction A: Constrained Pairwise & Listwise GBDT (LambdaMART V2)
- **Architecture**: Extended Gradient Boosted Decision Trees trained on pairwise preferences with group-aware lambda gradients.
- **Advancement over V3.1**:
  - Group-level ranking constraints enforcing protected candidate pinning.
  - Multi-dimensional supervision loss: separate weights for `EDITED` (+1.0), `READ` (+0.5), `SHOWN_UNREAD` (0.0), `UNSHOWN` (neutral/masked), and `EXPLICIT_REJECT` (-1.0).
  - Explicit token cost penalty incorporated into tree split objectives.

### Direction B: Lightweight Local Cross-Encoders
- **Architecture**: Compact, highly quantized 6-layer BERT/MiniLM cross-encoder running locally on CPU.
- **Advancement**:
  - Captures complex semantic alignments between task intent (issue description + error snippet) and code candidate headers/AST summaries.
  - Runs strictly in Stage 2 reranking over the top 20–30 ambiguous candidates, keeping inference latency under 15ms.

### Direction C: Hybrid Cascade / Ensemble
- **Architecture**: Linear blending of calibrated deterministic scores (BM25 + symbol proximity + graph centrality) with learned non-linear GBDT interaction terms.
- **Advancement**:
  - Guaranteed monotonic fallback: when learned model confidence is low or feature vectors fall out of distribution, weights smoothly decay to the proven V2 deterministic score.

---

## 4. Measurable V3.2 Readiness Gates

No model candidate will be evaluated for production promotion until the learning flywheel satisfies **all** of the following empirical criteria:

| Gate | Target Requirement | Rationale |
| :--- | :--- | :--- |
| **Total Production Episodes** | $\ge 1,000$ unique episodes | Ensures statistical significance across varied codebases and task types. |
| **Verified Outcomes** | $\ge 200$ Verified Successes AND $\ge 100$ Verified Failures | Eliminates class imbalance and ensures strong negative contrast signals. |
| **Candidate Logging Coverage** | $\ge 80\%$ of episodes with full candidate universes logged | Prevents selection bias where only materialized candidates are known. |
| **Rights Clearance** | $100\%$ zero unpermitted or revoked episodes in training pool | Strict compliance with data rights, retention limits, and deletion requests. |
| **Supervision Diversity** | Tri-state outcome distribution with documented resolution proofs | Prevents model training on unverified heuristic proxies (e.g. agent self-report). |
| **Zero-Leakage Audit** | $100\%$ pass on pre-outcome snapshot boundary checks | All features strictly $\le C_0$; zero post-outcome fields present in input matrix. |
| **Shadow Policy Parity** | Minimum 100 shadow evaluation runs with zero execution crashes | Confirms production safety and operational stability with zero execution crashes. |

---

## 5. Promotion Gate Protocol for V3.2

When readiness gates are satisfied and a V3.2 candidate model is trained:

1. **Natural Holdout Benchmark**: Must achieve $\Delta\text{NDCG@10} > +0.02$ with bootstrap $95\%$ CI lower bound $> 0.0$ across independent holdout tasks.
2. **Win/Loss Ratio**: Must exceed $1.5$ against the frozen V2 baseline.
3. **Paired CPVST Evaluation**: Cost Per Verified Success Task (CPVST) must decrease by $\ge 10\%$ without increasing test failure rates.
4. **Recall Floor**: Target recall@10 must match or exceed the frozen V2 baseline ($0.6500$).

Any model failing these criteria remains classified as `RESEARCH`.
