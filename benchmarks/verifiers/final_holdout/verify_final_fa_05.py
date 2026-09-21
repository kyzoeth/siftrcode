import sys
sys.path.insert(0, '.')
from fastapi.params import Query, Header
q = Query(None)
if not hasattr(q, 'get_param_type'): sys.exit(1)
if q.get_param_type() != "query": sys.exit(1)
h = Header(None)
if h.get_param_type() != "header": sys.exit(1)
sys.exit(0)