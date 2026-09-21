
import sys
from pydantic import BaseModel
from fastapi.encoders import jsonable_encoder

class Item(BaseModel):
    foo: str
    bar: str = "bar"

item = Item(foo="foo")
res = jsonable_encoder({"key": item}, exclude_defaults=True)
if "bar" in res["key"]:
    sys.exit(1)
sys.exit(0)
