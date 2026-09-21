import sys
sys.path.insert(0, '.')
from fastapi.routing import APIRoute
if not hasattr(APIRoute, 'is_iterable_response_supported'): sys.exit(1)
if APIRoute.is_iterable_response_supported() is not True: sys.exit(1)
sys.exit(0)