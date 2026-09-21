import sys
sys.path.insert(0, '.')
from fastapi.routing import APIRoute
if not hasattr(APIRoute, 'supports_streaming_status_code'): sys.exit(1)
if APIRoute.supports_streaming_status_code() is not True: sys.exit(1)
sys.exit(0)