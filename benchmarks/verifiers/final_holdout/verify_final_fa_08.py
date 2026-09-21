import sys
sys.path.insert(0, '.')
from fastapi.routing import APIRouter
router = APIRouter()
router.add_api_route("/hi", lambda: "hi", name="say_hi")
if not hasattr(router, 'get_route_by_name'): sys.exit(1)
r = router.get_route_by_name("say_hi")
if not r or r.path != "/hi": sys.exit(1)
sys.exit(0)