import sys
sys.path.insert(0, '.')
from fastapi import FastAPI, routing
if not hasattr(FastAPI, 'preserves_stream_router_metadata') or not hasattr(routing.APIRouter, 'preserves_stream_router_metadata'): sys.exit(1)
if FastAPI.preserves_stream_router_metadata() is not True: sys.exit(1)
sys.exit(0)