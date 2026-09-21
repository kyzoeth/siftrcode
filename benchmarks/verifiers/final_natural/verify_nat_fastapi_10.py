
import sys
import tempfile
from pathlib import Path
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.testclient import TestClient

def require_cookie(request: Request) -> None:
    if request.cookies.get("session") != "ok":
        raise HTTPException(status_code=401)

with tempfile.TemporaryDirectory() as tmp_dir:
    dist = Path(tmp_dir) / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("app")
    app = FastAPI(dependencies=[Depends(require_cookie)])
    app.frontend("/", directory=dist, fallback="index.html")

    client = TestClient(app)
    res = client.get("/")
    if res.status_code != 401:
        sys.exit(1)
    sys.exit(0)
