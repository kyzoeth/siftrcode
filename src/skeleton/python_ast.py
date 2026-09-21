"""
SiftrCode Python AST Skeletonizer & Symbol Parser (Closure PR 0.1)
Reads Python code from stdin.
- Default mode: emits skeletonized AST with function bodies replaced by `...`
- Symbols mode (--symbols): extracts AST-derived symbols with exact startLine, endLine, startByte, endByte,
  and safety metadata (hasDecorators, hasTopLevelCode, isModuleInit).
"""
import sys
import ast
import json

class SkeletonTransformer(ast.NodeTransformer):
    def __init__(self):
        super().__init__()
        self.symbols = []

    def visit_ClassDef(self, node):
        self.symbols.append(node.name)
        return self.generic_visit(node)

    def visit_FunctionDef(self, node):
        self.symbols.append(node.name)
        doc = ast.get_docstring(node)
        body = []
        if doc:
            body.append(ast.Expr(value=ast.Constant(value=doc)))
        body.append(ast.Expr(value=ast.Constant(value=Ellipsis)))
        node.body = body
        return node

    def visit_AsyncFunctionDef(self, node):
        return self.visit_FunctionDef(node)

def extract_symbols(raw_input, filepath="file.py"):
    lines = raw_input.splitlines(keepends=True)
    line_offsets = [0]
    for l in lines:
        line_offsets.append(line_offsets[-1] + len(l.encode('utf-8')))

    def get_byte_pos(lineno, col_offset):
        if 1 <= lineno <= len(lines):
            line_bytes = lines[lineno - 1].encode('utf-8')
            return line_offsets[lineno - 1] + len(line_bytes[:col_offset])
        return 0

    is_module_init = filepath.endswith("__init__.py") or filepath == "__init__.py"
    tree = ast.parse(raw_input)
    symbols = []
    has_top_level_code = False

    # Check top-level statements for executable code
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                continue
            has_top_level_code = True

    def extract_header(lineno):
        if 0 <= lineno - 1 < len(lines):
            cur = lineno - 1
            header_lines = []
            while cur < len(lines):
                line = lines[cur].strip()
                header_lines.append(line)
                if ":" in line:
                    break
                cur += 1
                if cur - (lineno - 1) > 10:
                    break
            return " ".join(header_lines)
        return ""

    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            start_line = node.lineno
            if node.decorator_list:
                start_line = min(d.lineno for d in node.decorator_list)
            end_line = getattr(node, 'end_lineno', node.lineno)
            start_byte = get_byte_pos(start_line, 0)
            end_byte = get_byte_pos(end_line, getattr(node, 'end_col_offset', 0))
            has_decorators = len(node.decorator_list) > 0
            sig = extract_header(node.lineno) or f"class {node.name}:"
            
            symbols.append({
                "symbolName": node.name,
                "qualifiedName": node.name,
                "symbolKind": "CLASS",
                "startByte": start_byte,
                "endByte": end_byte,
                "startLine": start_line,
                "endLine": end_line,
                "signature": sig,
                "metadata": {
                    "hasDecorators": has_decorators,
                    "hasTopLevelCode": has_top_level_code,
                    "isModuleInit": is_module_init,
                    "skeletonSafetyOverride": "UNSAFE" if has_decorators else "SAFE"
                }
            })

            # Extract methods inside class
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    m_start = item.lineno
                    if item.decorator_list:
                        m_start = min(d.lineno for d in item.decorator_list)
                    m_end = getattr(item, 'end_lineno', item.lineno)
                    m_start_byte = get_byte_pos(m_start, 0)
                    m_end_byte = get_byte_pos(m_end, getattr(item, 'end_col_offset', 0))
                    m_has_dec = len(item.decorator_list) > 0
                    qual_name = f"{node.name}.{item.name}"
                    m_sig = extract_header(item.lineno) or f"def {item.name}(...):"

                    symbols.append({
                        "symbolName": item.name,
                        "qualifiedName": qual_name,
                        "symbolKind": "METHOD",
                        "startByte": m_start_byte,
                        "endByte": m_end_byte,
                        "startLine": m_start,
                        "endLine": m_end,
                        "signature": m_sig,
                        "parentSymbol": node.name,
                        "metadata": {
                            "hasDecorators": m_has_dec,
                            "parentClass": node.name,
                            "isModuleInit": is_module_init,
                            "skeletonSafetyOverride": "UNSAFE" if m_has_dec else "SAFE"
                        }
                    })

        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            start_line = node.lineno
            if node.decorator_list:
                start_line = min(d.lineno for d in node.decorator_list)
            end_line = getattr(node, 'end_lineno', node.lineno)
            start_byte = get_byte_pos(start_line, 0)
            end_byte = get_byte_pos(end_line, getattr(node, 'end_col_offset', 0))
            has_decorators = len(node.decorator_list) > 0
            fn_sig = extract_header(node.lineno) or f"def {node.name}(...):"

            symbols.append({
                "symbolName": node.name,
                "qualifiedName": node.name,
                "symbolKind": "FUNCTION",
                "startByte": start_byte,
                "endByte": end_byte,
                "startLine": start_line,
                "endLine": end_line,
                "signature": fn_sig,
                "metadata": {
                    "hasDecorators": has_decorators,
                    "hasTopLevelCode": has_top_level_code,
                    "isModuleInit": is_module_init,
                    "skeletonSafetyOverride": "UNSAFE" if has_decorators else "SAFE"
                }
            })

    return symbols

def main():
    mode = "skeleton"
    filepath = "file.py"
    for arg in sys.argv[1:]:
        if arg in ("--symbols", "-s", "--mode=symbols"):
            mode = "symbols"
        elif arg.startswith("--path="):
            filepath = arg[7:]

    raw_input = sys.stdin.read()
    if not raw_input.strip():
        if mode == "symbols":
            print(json.dumps({"symbols": []}))
        else:
            print(json.dumps({"skeleton": "", "symbols": []}))
        return

    try:
        if mode == "symbols":
            symbols = extract_symbols(raw_input, filepath)
            print(json.dumps({"symbols": symbols}))
        else:
            tree = ast.parse(raw_input)
            transformer = SkeletonTransformer()
            new_tree = transformer.visit(tree)
            skeleton = ast.unparse(new_tree)
            output = {
                "skeleton": skeleton,
                "symbols": transformer.symbols
            }
            print(json.dumps(output))
    except Exception as e:
        # Fallback if parse error
        if mode == "symbols":
            print(json.dumps({"symbols": [], "error": str(e)}))
        else:
            print(json.dumps({"skeleton": raw_input, "symbols": [], "error": str(e)}))

if __name__ == "__main__":
    main()
