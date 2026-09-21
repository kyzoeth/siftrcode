
import sys
from typing import Annotated
from fastapi import FastAPI, Query
from fastapi.testclient import TestClient
from pydantic import Field

MaxSizedSet = Annotated[set[str], Field(max_length=3)]
app = FastAPI()

@app.get("/")
def read_root(foo: Annotated[MaxSizedSet | None, Query()] = None):
    return {"foo": sorted(list(foo)) if foo is not None else None}

client = TestClient(app)
res = client.get("/", params={"foo": ["a", "b"]})
if res.status_code != 200 or res.json() != {"foo": ["a", "b"]}:
    sys.exit(1)
sys.exit(0)
