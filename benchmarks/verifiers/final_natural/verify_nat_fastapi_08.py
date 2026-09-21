
import sys
import tempfile
from pathlib import Path
from fastapi import FastAPI
from fastapi.testclient import TestClient

with tempfile.TemporaryDirectory() as tmp_dir:
    dist = Path(tmp_dir) / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("app shell")
    app = FastAPI()
    app.frontend("/", directory=dist, fallback="index.html")

    client = TestClient(app)
    res = client.get("/users/jane.doe", headers={"accept": "text/html"})
    if res.status_code != 200 or res.text != "app shell":
        sys.exit(1)
    sys.exit(0)
