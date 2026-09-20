# SiftrCode (siftrcode.com)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/assets/logo-white.png">
    <source media="(prefers-color-scheme: light)" srcset="web/assets/logo-black.png">
    <img alt="SiftrCode Logo" src="web/assets/logo-black.png" width="340">
  </picture>
</p>

> **Cut agent token waste by 90%.**  
> 100% open-source (MIT), local-first AST compiler that strips function bodies before inference while preserving 100% of types and signatures.

[![Version](https://img.shields.io/badge/version-0.1.1-amber.svg)](https://siftrcode.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)
[![Open Source](https://img.shields.io/badge/Open%20Source-100%25-brightgreen.svg)](https://github.com/kyzoeth/siftrcode)
[![CI](https://github.com/kyzoeth/siftrcode/actions/workflows/ci.yml/badge.svg)](https://github.com/kyzoeth/siftrcode/actions)

---

## ⚡ The Problem: Context Bloat in AI Coding

When an AI coding agent (Claude Code, Cursor, Antigravity) investigates a task, it frequently ingests 30 to 50 entire source files (150k to 250k+ tokens) into context.

* **High Latency:** Every turn takes 30–60 seconds.
* **Lost in the Middle:** Models hallucinate and introduce regressions because 90% of the ingested text is internal implementation loops.
* **Excessive Token Costs:** Companies burn thousands of dollars per month on bloated context payloads.

**SiftrCode solves this by parsing your repository's Abstract Syntax Tree (AST) before inference, stripping function bodies down to lightweight interface skeletons, and eliminating deadweight files.**

---

## 🚀 SiftrCode V2: Outcome-Aware Context Optimization

SiftrCode V2 is a generational upgrade from simple token compaction to **outcome-aware context optimization**. Instead of flooding an LLM with either bloated full source files or naive summaries, SiftrCode computes the mathematically optimal context bundle tailored to the active coding task, protecting edit targets at 100% full implementation while safely compressing dependencies to AST skeletons.

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
│ 3. ContextRank Transparent Ranker       │ ➔ Heuristic scoring with explainable reason breakdown
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 4. BundleComposer Submodular Synergy    │ ➔ Maximizes evidence coverage, suppresses redundancy
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 5. ResolutionRank & BudgetSolver        │ ➔ Protects edit targets at FULL/BODY
│    (Variable-Resolution Optimization)   │ ➔ Degrades dependencies to AST skeletons
└──────────────────┬──────────────────────┘ ➔ Strict token budget & economic cost ceiling
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 6. Agent Adapter Context & Telemetry    │ ➔ Claude Code XML, Cursor Markdown, Generic MCP
└─────────────────────────────────────────┘ ➔ Privacy-by-default (trainingAllowed: false)
```

---

## ⚡ Quickstart

Run SiftrCode V2 instantly with zero configuration:

```bash
# 1-command auto-configuration for Claude Code and Cursor MCP
npx siftrcode init

# Generate an outcome-aware context bundle for your coding task (SiftrCode V2)
siftr context "Fix payment webhook idempotency race condition" -o context.xml

# Output as JSON for automated agent pipelines
siftr context "Refactor authentication middleware" --json

# Pack a repository into a token-pruned pack (V1 compatible)
siftr pack --focus "checkout subscription webhook" -o context.md

# Audit token bloat in your repository
siftr audit
```

Then pass the generated context directly to Claude or your agent:
```bash
claude "Review @context.xml and fix the issue"
```

---

## 🛠️ Commands

### 1. `siftr context <prompt> [directory]` (Aliases: `optimize`, `plan`)
Generates an outcome-aware context bundle optimized for a specific agent model, token budget, and economic cost ceiling:

```bash
# Standard optimization with console summary
siftr context "Fix race condition in Redis lock manager"

# Export formatted context directly to file
siftr context "Add OAuth provider" -o siftr_context.xml

# Enforce strict token and economic cost limits
siftr context "Fix memory leak" --budget 4000 --cost 0.02

# Target specific agent harnesses
siftr context "Refactor router" --agent cursor
```

### 2. `siftr audit [options] [directory]`
Audits codebase token footprint and calculates potential savings:

```bash
siftr audit
siftr audit --markdown   # GitHub PR comment format
siftr audit --json       # Machine-readable output
```

### 3. `siftr skeleton <file>`
Prints the AST interface skeleton of a source file:

```bash
siftr skeleton src/services/PaymentService.ts
```

### 4. `siftr pack [directory]`
Compiles a condensed AST context pack for a focus area.

### 5. `siftr mcp`
Starts the Model Context Protocol (MCP) server over stdio.

---

## 🤖 Add to Claude Code & Cursor (MCP)

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

### Exposed MCP Tools:
* `siftr_context`: **(V2 Primary)** Discovers candidates, ranks by evidence, protects edit targets, and materializes AST skeletons within token and cost limits.
* `siftr_optimize`: Alias for `siftr_context`.
* `siftr_rank`: Returns transparent candidate rankings with score breakdowns and primary reasons.
* `siftr_skeleton`: Returns the AST interface skeleton of any file on demand.
* `siftr_batch_skeleton`: Extracts type signatures from multiple candidate files in parallel.
* `siftr_pack`: Scans dependencies and generates a pruned context pack for a specific task.
* `siftr_audit`: Returns a token bloat analysis of the repository.

---

## 📂 100% Open-Source Implementation (MIT Licensed)

SiftrCode V2 is completely open-source, local-first, and self-contained within this repository. There are **zero proprietary binaries**, **zero remote telemetry**, and **zero closed-source backends**. Privacy defaults are strictly enforced: `trainingAllowed: false` and `remoteProcessingAllowed: false`.

| Component | Source Implementation | Description |
| :--- | :--- | :--- |
| **ContextEngine** | [`src/engine/context_engine.ts`](src/engine/context_engine.ts) | Master orchestrator coordinating discovery, features, ranking, budget solving, and materialization. |
| **Candidate Discovery** | [`src/retrieval/candidate_generator.ts`](src/retrieval/candidate_generator.ts) | Multi-channel recall (exact, BM25, stack trace, graph, and git co-change). |
| **ContextRank** | [`src/ranking/context_rank.ts`](src/ranking/context_rank.ts) | Heuristic ranker with explainable reason breakdown. |
| **BundleComposer** | [`src/context/bundle_composer.ts`](src/context/bundle_composer.ts) | Submodular synergy composer maximizing evidence coverage. |
| **BudgetSolver** | [`src/context/budget_solver.ts`](src/context/budget_solver.ts) | Dynamic token budget and economic cost ceiling solver. |
| **ResolutionRank** | [`src/context/resolution_rank.ts`](src/context/resolution_rank.ts) | Edit target protection and safe variable-resolution degradation. |
| **Agent Adapters** | [`src/agents/agent_adapter.ts`](src/agents/agent_adapter.ts) | Custom formatters for Claude Code, Cursor, and Generic MCP. |
| **MCP Server** | [`src/mcp/server.ts`](src/mcp/server.ts) | Native Model Context Protocol stdio server for Claude, Cursor & Antigravity. |
| **AST Parsers** | [`src/skeleton/`](src/skeleton/) | Multi-language AST interface extractors (TS, Python, Go, Rust). |


---

## 🧠 Architecture: AST + TypeSafe Jev

```
[Raw Codebase: 250,000 tokens]
            │
            ▼
[SiftrCode Local Synthesis Engine]
  ├── Extracts imports, types, exported classes & signatures
            │
            ▼
[TypeSafe Jev Decision Gate]
  ├── Parallel evaluation in <60ms
  ├── Choice: RootCandidate vs. TypeDependency vs. DeadWeight
            │
            ▼
[Skeleton Interface Pruner]
  ├── Keeps 100% of types & signatures
  └── Strips function/method bodies
            │
            ▼
[Pruned Context: 10,000 tokens (-96% reduction)]
```

---

## 🌐 Web Platform

The production landing page is available under `web/index.html` with an interactive live AST simulator and ROI calculator ready for `siftrcode.com`.

---

## 📄 License

MIT © SiftrCode Team (https://siftrcode.com)
