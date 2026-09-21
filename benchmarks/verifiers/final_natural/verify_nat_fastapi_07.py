
import sys
try:
    from fastapi.routing import iter_route_contexts
except ImportError:
    sys.exit(1)

from fastapi import APIRouter
router = APIRouter()
@router.get("/test")
def test_endpoint():
    return "ok"

contexts = list(iter_route_contexts(router.routes))
if len(contexts) != 1 or contexts[0].path != "/test":
    sys.exit(1)
sys.exit(0)
