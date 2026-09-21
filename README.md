# SiftrCode (siftrcode.com)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/assets/logo-white.png">
    <source media="(prefers-color-scheme: light)" srcset="web/assets/logo-black.png">
    <img alt="SiftrCode Logo" src="web/assets/logo-black.png" width="340">
  </picture>
</p>

> **Outcome-Aware Context Optimization for Coding Agents.**  
> Cut agent context bloat by 60%–88% while preserving 100% full implementation fidelity on causal edit targets. Local-first, zero egress, sub-100ms AST compilation, and truthful token accounting.

[![Version](https://img.shields.io/badge/version-0.2.0-amber.svg)](https://siftrcode.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)
[![Open Source](https://img.shields.io/badge/Open%20Source-100%25-brightgreen.svg)](https://github.com/kyzoeth/siftrcode)
[![CI](https://github.com/kyzoeth/siftrcode/actions/workflows/ci.yml/badge.svg)](https://github.com/kyzoeth/siftrcode/actions)

---

## ⚡ The Problem: The Dual Failure Modes of Agent Context

When an AI coding agent (Claude Code, Cursor, Antigravity) investigates a task, teams encounter two opposite but equally costly failure modes:

1. **Unconstrained Context Bloat**: The agent ingests 30–50 full files (150k–250k+ tokens). Latency spikes to 30–60s per turn, models lose critical instructions in the middle of giant prompts, and token burn reaches hundreds of dollars per developer per month.
2. **Naive Token Stripping**: Indiscriminately collapsing all function bodies destroys the exact code the agent needs to edit. The model hallucinates missing variables, introduces subtle regressions, or triggers expensive $2–$5 multi-turn re-prompting loops.

**SiftrCode V2 solves both problems with Outcome-Aware Context Optimization**: dynamically allocating full implementation bodies to causal edit targets, compiler-verified AST interface skeletons to structural dependencies, and dropping unrelated distractor bloat completely.

---

## 📊 Token Economics & Variable-Resolution Breakdown

SiftrCode V2 optimizes marginal context utility $\Delta_{i,r}(S, x)$ by partitioning repository context into three variable-resolution tiers:

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

SiftrCode V2 provides three purpose-built optimization profiles:

| Budget Profile | Typical Payload | Token Reduction | Cost / Turn (Sonnet 3.7) | Net Monthly Savings / Dev | Team ROI (10 Devs) | Primary Use Case |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **`balanced`** *(default)* | **18,200 tokens** | **−78.6%** | **$0.055** *(was $0.255)* | **$280 / mo** *(+$3,367/yr)* | **+$33.7k / yr** | Standard feature dev & bug fixes |
| **`aggressive`** | **10,500 tokens** | **−87.6%** | **$0.032** *(was $0.255)* | **$313 / mo** *(+$3,755/yr)* | **+$37.5k / yr** | Large repositories, fast triage, high turn limits |
| **`thorough`** | **32,000 tokens** | **−62.4%** | **$0.096** *(was $0.255)* | **$223 / mo** *(+$2,671/yr)* | **+$26.7k / yr** | Multi-file architecture & complex refactoring |

*Modeled on typical 85k-token repository payload at 50 turns/day, 28 work days/month (1,400 turns/mo per dev).*

### 2. Multi-Model Frontier Cost Matrix

| Frontier Model | Input Price / MTok | Raw Cost / Turn | SiftrCode V2 Balanced | Per-Turn Savings |
| :--- | :---: | :---: | :---: | :---: |
| **Claude 3.7 / 3.5 Sonnet** | $3.00 | $0.255 | **$0.055** | **Save $0.20 / turn (−78.6%)** |
| **OpenAI GPT-4o** | $2.50 | $0.213 | **$0.046** | **Save $0.167 / turn (−78.6%)** |
| **Claude 3 Opus / Reasoning** | $15.00 | $1.275 | **$0.273** | **Save $1.002 / turn (−78.6%)** |

### 3. Truthful Token Accounting Semantics

SiftrCode V2 enforces strict dual-metric token integrity:
- **`estimatedRenderedTokens`**: Calibrated pre-flight against `TokenizerRegistry` (Claude BPE ~3.7 chars/token with 1.15 margin; GPT cl100k/o200k ~3.6 chars/token with 1.15 margin; conservative fallback 1.35 upper-bound). Guarantees zero context window blowouts.
- **`actualProviderInputTokens`**: Reconciled post-turn from actual provider API usage response headers for precise billing auditability.

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
| **`siftr_skeleton`** | AST Tool | Returns the AST interface skeleton of any file on demand. |
| **`siftr_batch_skeleton`** | Batch AST | Extracts type signatures from multiple candidate files in parallel. |
| **`siftr_pack`** | Bundle Tool | Scans dependencies and generates a pruned context pack for a specific task. |
| **`siftr_audit`** | Audit Tool | Returns token bloat analysis and potential savings across the codebase. |

---

## 🛡️ Privacy & Zero-Egress Technical Guarantees

SiftrCode is designed from the ground up for strict enterprise security compliance:

- **`trainingAllowed: false`**: Customer code is never ingested into LLM training corpuses.
- **`rawSourceRetentionAllowed: false`**: Zero persistence or caching of raw source code.
- **`remoteProcessingAllowed: false`**: 100% local compilation and optimization on developer hardware.
- **`SIFTR_CALLS_ONLY Observability`**: Conservative default tracing capturing only Siftr tool invocations.
- **Local SQLite Store**: Candidate decisions and observation logs are stored entirely in local `.siftr/observations.sqlite` without telemetry calls.

---

## 📂 100% Open-Source Architecture (MIT Licensed)

SiftrCode V2 is completely open-source, local-first, and self-contained within this repository. There are **zero proprietary binaries**, **zero remote telemetry**, and **zero closed-source backends**.

| Component | Source Implementation | Description |
| :--- | :--- | :--- |
| **ContextEngine** | [`src/engine/context_engine.ts`](src/engine/context_engine.ts) | Master orchestrator coordinating discovery, features, ranking, budget solving, and materialization. |
| **TokenizerRegistry** | [`src/tokens/tokenizer_registry.ts`](src/tokens/tokenizer_registry.ts) | Truthful token accounting semantics and calibrated provider margins (Claude BPE, GPT cl100k/o200k). |
| **Candidate Discovery** | [`src/retrieval/candidate_generator.ts`](src/retrieval/candidate_generator.ts) | Multi-channel recall (exact, BM25, stack trace, graph, and git co-change). |
| **ContextRank** | [`src/ranking/context_rank.ts`](src/ranking/context_rank.ts) | Explainable candidate ranker with transparent score breakdown. |
| **BundleComposer** | [`src/context/bundle_composer.ts`](src/context/bundle_composer.ts) | Submodular synergy composer maximizing evidence coverage. |
| **BudgetSolver** | [`src/context/budget_solver.ts`](src/context/budget_solver.ts) | Dynamic token budget and economic cost ceiling solver. |
| **ResolutionRank** | [`src/context/resolution_rank.ts`](src/context/resolution_rank.ts) | Edit target protection (`BODY`) and safe variable-resolution degradation (`SKELETON`). |
| **Learning Plane Store** | [`src/storage/sqlite_store.ts`](src/storage/sqlite_store.ts) | Local SQLite persistence for decision observations and audit logging (`.siftr/observations.sqlite`). |
| **WorkspaceSnapshot** | [`src/workspace/workspace_manager.ts`](src/workspace/workspace_manager.ts) | Immutable snapshot tracking with `WorkspaceChangedError` structured replanning guards. |
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
