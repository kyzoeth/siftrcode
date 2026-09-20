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

## 🚀 Quickstart

Run SiftrCode instantly in any repository with zero configuration:

```bash
# 1-command auto-configuration for Claude Code and Cursor MCP
npx siftrcode init

# Audit token waste in your current repo
npx siftrcode audit

# Pack a repository into a token-pruned context pack (e.g. siftr_context.md)
npx siftrcode pack --focus "checkout subscription webhook" -o context.md
```

Then feed the output directly to Claude or your agent:
```bash
claude "Review @context.md and fix the webhook idempotency bug"
```

---

## 🔄 GitHub Action (Automated PR Token Auditing)

Track token mass reductions directly in your Pull Requests:

```yaml
name: SiftrCode PR Context Audit
on: [pull_request]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kyzoeth/siftrcode@v0.1.0
        with:
          output_summary: 'true'
```

---

## 🛠️ Commands

### 1. `siftrcode audit [options] [directory]`
Analyzes repository token footprint and calculates how much token bloat can be eliminated:

```bash
# Human-readable terminal output
siftrcode audit

# GitHub Flavored Markdown (great for PR comments & CI step summaries)
siftrcode audit --markdown

# Programmatic JSON output
siftrcode audit --json
```

### 3. `siftrcode skeleton <file>`
Prints the AST interface skeleton of a single source file to stdout:

```bash
siftrcode skeleton src/services/PaymentService.ts
```

### 4. `siftrcode mcp`
Starts the Model Context Protocol (MCP) server over stdio for Claude Code, Cursor, and Antigravity.

---

## 🤖 Add to Claude Code & Cursor (MCP)

Add SiftrCode to your `~/.claude/settings.json` or Cursor MCP settings:

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
* `siftr_skeleton`: Returns the AST interface skeleton of any file on demand.
* `siftr_batch_skeleton`: Extracts type signatures from multiple candidate files in parallel.
* `siftr_pack`: Scans dependencies and generates a pruned context pack for a specific task.
* `siftr_audit`: Returns a token bloat analysis of the repository.

---

## 📂 100% Open-Source Implementation (MIT Licensed)

SiftrCode is completely open-source, local-first, and self-contained within this repository. There are **zero proprietary binaries**, **zero remote telemetry**, and **zero closed-source backends**.

Every component runs entirely on your local machine:

| Component | Source Implementation | Description |
| :--- | :--- | :--- |
| **MCP Server** | [`src/mcp/server.ts`](src/mcp/server.ts) | Native Model Context Protocol stdio server for Claude, Cursor & Antigravity. |
| **TypeScript / JS AST** | [`src/skeleton/typescript.ts`](src/skeleton/typescript.ts) | Local AST compiler using the official TypeScript Compiler API. |
| **Python AST** | [`src/skeleton/python_ast.py`](src/skeleton/python_ast.py) | Native Python AST parser stripping method bodies into ellipses (`...`). |
| **Go Parser** | [`src/skeleton/go.ts`](src/skeleton/go.ts) | Native Go AST parser extracting structs, interfaces, and function headers. |
| **Rust Parser** | [`src/skeleton/rust.ts`](src/skeleton/rust.ts) | Native Rust parser extracting traits, impl blocks, and public signatures. |
| **Relevance Gate** | [`src/jev/client.ts`](src/jev/client.ts) | 100% offline, deterministic heuristic classifier (zero network latency). |
| **Context Compiler** | [`src/core/packer.ts`](src/core/packer.ts) | Ingestion compiler and markdown context pack generator. |
| **Token Auditor** | [`src/core/auditor.ts`](src/core/auditor.ts) | Codebase token bloat scanner and financial waste calculator. |

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
