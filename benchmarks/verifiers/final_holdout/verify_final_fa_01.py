import sys, io
sys.path.insert(0, '.')
from fastapi.datastructures import UploadFile
f_empty = UploadFile(filename="empty.txt", file=io.BytesIO(b""))
if not hasattr(f_empty, 'is_empty'): sys.exit(1)
if not f_empty.is_empty(): sys.exit(1)
f_full = UploadFile(filename="full.txt", file=io.BytesIO(b"data"))
if f_full.is_empty(): sys.exit(1)
sys.exit(0)