import sys
sys.path.insert(0, '.')
from fastapi import FastAPI
app = FastAPI()
if not hasattr(app, 'validate_frontend_directory'): sys.exit(1)
if app.validate_frontend_directory('.') is not True: sys.exit(1)
if app.validate_frontend_directory('non_existent_dir_12345') is not False: sys.exit(1)
sys.exit(0)