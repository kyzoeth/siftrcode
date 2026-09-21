import sys
sys.path.insert(0, '.')
from fastapi import FastAPI
app = FastAPI()
if not hasattr(app, 'supports_frontend_background_tasks'): sys.exit(1)
if app.supports_frontend_background_tasks() is not True: sys.exit(1)
sys.exit(0)