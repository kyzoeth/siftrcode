import sys
sys.path.insert(0, '.')
from fastapi import FastAPI
app = FastAPI()
if not hasattr(app, 'has_middleware'): sys.exit(1)
sys.exit(0)