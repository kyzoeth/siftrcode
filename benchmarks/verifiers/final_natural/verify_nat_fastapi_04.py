
import sys
from collections.abc import Iterable
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

app = FastAPI()

class ModelDefaults(BaseModel):
    x: str | None = None
    y: str = "default_y"

@app.get("/items", response_model_exclude_defaults=True)
def get_items() -> Iterable[ModelDefaults]:
    return [ModelDefaults(x=None, y="default_y")]

client = TestClient(app)
res = client.get("/items")
if res.json() != [{}]:
    sys.exit(1)
sys.exit(0)
