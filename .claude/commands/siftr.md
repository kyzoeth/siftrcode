# SiftrCode AST Context Pruning Command

When this command is invoked:
1. If an argument (file path or directory) is provided (`$ARGUMENTS`):
   - For a single file: Call the MCP tool `siftr_skeleton` with the file's content and path to extract its public interface signatures, types, and exported symbols.
   - For a directory or codebase area: Call the MCP tool `siftr_pack` with the focus parameter set to `$ARGUMENTS` to generate an AST-pruned context pack.
2. If no argument is provided:
   - Call the MCP tool `siftr_audit` to scan the repository for context bloat, dead weight, and estimate potential token savings.
3. Present the synthesized interface contract concisely to the user, highlighting key exported interfaces, methods, and types.
