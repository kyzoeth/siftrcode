import sys, io
sys.path.insert(0, '.')
from fastapi.datastructures import UploadFile
f = UploadFile(filename="test.txt", file=io.BytesIO(b"12345"))
if not hasattr(f, 'get_size'): sys.exit(1)
if f.get_size() != 5: sys.exit(1)
sys.exit(0)