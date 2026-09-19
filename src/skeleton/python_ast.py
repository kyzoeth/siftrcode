"""
SiftrCode Python AST Skeletonizer
Reads Python code from stdin and emits skeletonized AST with function bodies replaced by `...`
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

def main():
    raw_input = sys.stdin.read()
    if not raw_input.strip():
        print(json.dumps({"skeleton": "", "symbols": []}))
        return

    try:
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
        # Fallback to original if parse error
        print(json.dumps({"skeleton": raw_input, "symbols": [], "error": str(e)}))

if __name__ == "__main__":
    main()
