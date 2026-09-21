import sys
sys.path.insert(0, '.')
from fastapi.exceptions import HTTPException
exc = HTTPException(status_code=404, detail="Not Found")
if not hasattr(exc, 'get_status_code'): sys.exit(1)
if exc.get_status_code() != 404: sys.exit(1)
sys.exit(0)