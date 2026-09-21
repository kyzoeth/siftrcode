
import sys
from typing import AsyncIterable
from fastapi import APIRouter, FastAPI
from fastapi.responses import EventSourceResponse
from fastapi.testclient import TestClient
from pydantic import BaseModel

class Item(BaseModel):
    name: str

router = APIRouter()

@router.get("/events-typed", response_class=EventSourceResponse)
async def stream_events_typed() -> AsyncIterable[Item]:
    yield Item(name="foo")

app = FastAPI()
app.include_router(router, prefix="/api")
client = TestClient(app)

res = client.get("/openapi.json")
paths = res.json()["paths"]
content = paths["/api/events-typed"]["get"]["responses"]["200"]["content"]
schema = content.get("text/event-stream", {}).get("itemSchema", {}).get("properties", {}).get("data", {})
if "contentSchema" not in schema:
    sys.exit(1)
sys.exit(0)
