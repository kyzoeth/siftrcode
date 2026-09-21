
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
    res = client.post("/missing-endpoint")
    if res.status_code != 404:
        sys.exit(1)
    sys.exit(0)
