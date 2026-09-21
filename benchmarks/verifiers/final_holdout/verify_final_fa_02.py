import sys
sys.path.insert(0, '.')
from fastapi.security.api_key import APIKeyQuery
q = APIKeyQuery(name="k", scheme_name="MyAuth")
if not hasattr(q, 'get_scheme_name'): sys.exit(1)
if q.get_scheme_name() != "MyAuth": sys.exit(1)
sys.exit(0)