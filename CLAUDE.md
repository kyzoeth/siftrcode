# Claude Code Guidelines for SiftrCode

## Context Optimization Rules
When exploring, refactoring, or navigating code in this repository:
- **Use SiftrCode MCP Tools**: Before loading large, full-text implementation files into the context window, call `siftr_skeleton` or `siftr_pack`.
- **AST Interface First**: SiftrCode strips internal method bodies and imperative logic while preserving 100% of interfaces, types, and exported signatures. This preserves reasoning depth and prevents context window exhaustion.
- **Commands**:
  - `/siftr <file>`: Prunes a single file down to its type signatures.
  - `/siftr <dir>`: Packs a directory into an AST interface bundle.
  - `siftr_audit`: Evaluates repository bloat and potential token savings.

## Build & Test Commands
- Build: `npm run build`
- Test: `npm test`
- Serve Web/API: `npm run serve`
