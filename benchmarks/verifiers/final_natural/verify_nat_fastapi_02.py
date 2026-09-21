
import sys
from collections.abc import AsyncIterable
from fastapi import FastAPI
from fastapi.responses import EventSourceResponse
from fastapi.testclient import TestClient

app = FastAPI()

@app.post("/sse", response_class=EventSourceResponse, status_code=201)
async def sse() -> AsyncIterable[dict[str, str]]:
    yield {"message": "created"}

client = TestClient(app)
res = client.post("/sse")
if res.status_code != 201:
    sys.exit(1)
sys.exit(0)
