# SiftrCode (siftrcode.com)

> **Feed Agents Signal. Sift Out The Bloat.**  
> The AST-powered codebase skeletonizer and context pruner for AI coding agents.

[![Version](https://img.shields.io/badge/version-0.1.0-emerald.svg)](https://siftrcode.com)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)

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
# Audit token waste in your current repo
npx siftrcode audit

# Pack a repository into a token-slammed context pack (e.g. context.md)
npx siftrcode pack --focus "checkout subscription webhook" -o context.md
```

Then feed the output directly to Claude or your agent:
```bash
claude "Review @context.md and fix the webhook idempotency bug"
```

---

## 🛠️ Commands

### 1. `siftrcode pack [options] [directory]`
Scans the codebase, analyzes AST dependencies, applies Jev relevance scoring, and compiles a clean, token-pruned context pack:

```bash
siftrcode pack -f "auth middleware" -o auth_context.md
```

### 2. `siftrcode audit [directory]`
Analyzes repository token footprint and calculates how much token bloat can be eliminated:

```bash
siftrcode audit
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
* `siftr_pack`: Generates a pruned context pack for a specific task.
* `siftr_skeleton`: Returns the AST interface skeleton of any file on demand.
* `siftr_audit`: Returns a token bloat analysis of the repository.

---

## 🧠 Architecture: AST + TypeSafe Jev

```
[Raw Codebase: 250,000 tokens]
            │
            ▼
[Tree-sitter AST Parser]
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
