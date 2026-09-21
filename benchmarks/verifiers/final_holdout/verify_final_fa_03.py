import sys
sys.path.insert(0, '.')
from fastapi.routing import APIRoute
def ep():
    """First line summary."""
    pass
r = APIRoute("/x", ep)
if not hasattr(r, 'get_summary_or_doc'): sys.exit(1)
if r.get_summary_or_doc() != "First line summary.": sys.exit(1)
sys.exit(0)