# SiftrCode Production Data Flywheel & Learning Boundary

## 1. Executive Summary

SiftrCode's context optimization architecture bridges real-world agent interactions with continuous empirical learning. While production context ranking is strictly managed by our deterministic V2 ranking engine (`production-v2-deterministic-2026-09`), the **Production Data Flywheel** securely and passively captures point-in-time episodes, context exposures, agent trajectories, verified outcomes, and task economics.

This infrastructure establishes a proprietary, rights-aware, point-in-time training asset (`SIFTR_CONTEXT_DATASET_V2`) engineered to support future learned rankers (e.g. V3.2) while maintaining absolute production stability, zero-leakage safety, and enterprise data rights compliance.

---

## 2. Core Architectural Invariants

### 1. Deterministic Production Baseline
- Production context ranking uses the deterministic `ContextRanker` (`v2-final`).
- No learned ranking model runs on the critical path of production requests unless promoted under empirical gate criteria.
- Current GBDT models (`gbdt_pairwise_v1`) remain classified as `RESEARCH`.

### 2. Point-in-Time Anti-Leakage Boundary ($\le C_0$)
- A strict temporal boundary separates pre-decision state ($C_0$) from post-decision outcomes ($C_1 \dots C_T$).
- Pre-outcome snapshots record repository state, task descriptions, candidate universes, and features *before* any agent trajectory events or test executions occur.
- Any attempt to include post-outcome fields (`agent_done`, `task_outcome`, `diff_target_matches`, `tokens_consumed`, `verifier_passed`, `build_success`, etc.) in pre-outcome features is rejected with an unrecoverable validation error.

### 3. Truth in Supervision: `UNKNOWN != NEGATIVE`
- Candidates unshown to an agent are **not** negative examples; their true utility is unknown.
- Unread candidates are not automatically non-useful.
- Edited files are not the sole ground-truth root causes (reference files read by the agent are essential structural context).
- Multi-dimensional supervision labels (`candidate`, `selected`, `materialized`, `shown`, `read`, `edited`) are preserved without premature collapse into binary labels.

### 4. Enterprise Data Rights & Tombstoning
- Every episode records explicit consent flags (`trainingAllowed`, `retentionDays`, `allowTrajectoryLogging`).
- Deletion requests (GDPR / right-to-be-forgotten) purge sensitive source text, register tombstones in `episode_revocations`, and permanently exclude revoked episodes from training dataset exports.

### 5. High-Confidence Outcome Verification
- Agent self-declarations ("I've completed the task", process exit code 0) are **never** treated as verified success.
- Outcomes are resolved strictly into tri-state values: `VERIFIED_SUCCESS`, `VERIFIED_FAILURE`, or `INDETERMINATE`.
- Only independent verifiers (test suite executions, clean compiler builds, syntax validators) can yield `VERIFIED_SUCCESS`.

---

## 3. Flywheel Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│ 1. CODING TASK INITIATION                                    │
│    Task ID, Repository ID, Base Commit SHA, Timestamp C0    │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. CANDIDATE DISCOVERY & CONTEXT ENGINE                      │
│    Multi-channel candidate generation (BM25, Graph, AST)     │
│    Deterministic V2 Context Ranking                          │
│    Variable-resolution budget packing (BODY vs SKELETON)     │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. PRE-OUTCOME SNAPSHOT ISOLATION (Boundary Enforcement)    │
│    Snapshot candidates, feature matrix, and context plan     │
│    Validated against FORBIDDEN_PRE_OUTCOME_FIELDS            │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 4. AGENT TRAJECTORY RECORDING & SECRET SCRUBBING             │
│    Tool calls, file reads, terminal executions, file edits   │
│    All payloads filtered through secret scrubbing regexes    │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 5. VERIFIED OUTCOME RESOLUTION                               │
│    Tri-state classification via High-Confidence Verifiers    │
│    Test execution logs + build results + exit codes          │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 6. ECONOMIC ACCOUNTING & CPVST                               │
│    Token accounting across input/output/reasoning/cache      │
│    Cost Per Verified Success Task calculation                │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 7. RIGHTS CHECK & SIFTR_CONTEXT_DATASET_V2 EXPORT           │
│    Verify training permission & deletion tombstone check     │
│    Export uncollapsed point-in-time training episodes        │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Key Subsystems & Modules

| Subsystem | Location | Function |
| :--- | :--- | :--- |
| **TaskEpisodeV1** | [`src/learning/episodes/task_episode.ts`](file:///Users/aliyazdan/projects/siftrcode/src/learning/episodes/task_episode.ts) | Canonical data structure capturing end-to-end task episodes. |
| **PreOutcomeSnapshot** | [`src/learning/episodes/pre_outcome_snapshot.ts`](file:///Users/aliyazdan/projects/siftrcode/src/learning/episodes/pre_outcome_snapshot.ts) | Immutable pre-outcome feature capture with anti-leakage sentinels. |
| **ContextExposure** | [`src/learning/episodes/context_exposure.ts`](file:///Users/aliyazdan/projects/siftrcode/src/learning/episodes/context_exposure.ts) | Exposure state machine (`CANDIDATE` $\to$ `SELECTED` $\to$ `MATERIALIZED` $\to$ `SHOWN` $\to$ `READ` $\to$ `EDITED`). |
| **AgentTrajectory** | [`src/learning/episodes/agent_trajectory.ts`](file:///Users/aliyazdan/projects/siftrcode/src/learning/episodes/agent_trajectory.ts) | Trajectory event logging, step tracking, and trajectory summarization. |
| **SecretScrubber** | [`src/security/secret_scrubber.ts`](file:///Users/aliyazdan/projects/siftrcode/src/security/secret_scrubber.ts) | Comprehensive regex scrubber for API keys, bearer tokens, passwords, and private keys. |
| **TaskOutcome** | [`src/learning/outcome/task_outcome.ts`](file:///Users/aliyazdan/projects/siftrcode/src/learning/outcome/task_outcome.ts) | Tri-state outcome resolution and high-confidence verifier rules. |
| **TaskEconomics** | [`src/learning/economics/task_economics.ts`](file:///Users/aliyazdan/projects/siftrcode/src/learning/economics/task_economics.ts) | Full token breakdown, model pricing, and Cost Per Verified Success Task (CPVST). |
| **TrainingExporter** | [`src/learning/training_exporter.ts`](file:///Users/aliyazdan/projects/siftrcode/src/learning/training_exporter.ts) | Rights-aware dataset exporter producing `SIFTR_CONTEXT_DATASET_V2`. |
| **ShadowPolicyRunner** | [`src/ranking/shadow_policy_runner.ts`](file:///Users/aliyazdan/projects/siftrcode/src/ranking/shadow_policy_runner.ts) | Concurrent shadow evaluation framework with 100% production plan invariance. |
| **DeletionManager** | [`src/rights/deletion_manager.ts`](file:///Users/aliyazdan/projects/siftrcode/src/rights/deletion_manager.ts) | Cascading privacy deletions and durable tombstone registration. |
| **Flywheel SQLite Store** | [`src/storage/sqlite_store.ts`](file:///Users/aliyazdan/projects/siftrcode/src/storage/sqlite_store.ts) | Migration 15 tables (`task_episodes`, `pre_outcome_snapshots`, `episode_candidates`, `context_exposures`, `episode_trajectory_events`, `episode_revocations`). |

---

## 5. Shadow Policy Framework

To safely evaluate future rankers (e.g. experimental V3.1 variations or early V3.2 prototypes) without risking agent regression:

1. **Parallel Execution**: When enabled, candidate rankers execute concurrently against the same candidate set.
2. **Production Plan Invariance**: The shadow ranker produces a `shadowPlan` that is recorded in metrics and logs, but the agent **strictly** receives the production deterministic plan.
3. **Fault Isolation**: Any exception, timeout, or invalid output from a shadow ranker is caught and recorded without interrupting the production context delivery.

---

## 6. Admin Flywheel & V3.2 Readiness Dashboard

The SiftrCode Admin interface (`web/admin.html`) includes the **Learning Flywheel & V3.2 Readiness** dashboard:

- **Metrics Integrity**: All counts, readiness indicators, and distributions reflect **actual database records**. No synthetic or hardcoded metrics are displayed.
- **V3.2 Readiness Gate Progress**: Real-time progress bars for Episode Volume ($\ge 1,000$), Verified Successes ($\ge 200$), Candidate Coverage ($\ge 80\%$), Rights Clearance ($100\%$), and Zero-Leakage Checks ($100\%$).
- **Exposure Funnel Analysis**: Conversion breakdown across Candidates $\to$ Materialized $\to$ Shown $\to$ Read $\to$ Edited.
- **Episode Explorer**: Searchable and inspectable episode list with deep-dive modal showing pre-outcome metadata, trajectory event timelines, and verified outcome evidence.
- **Security & Authorization**: All `/api/admin/learning/*` endpoints require administrative bearer token authentication (`ADMIN_API_KEY`).
