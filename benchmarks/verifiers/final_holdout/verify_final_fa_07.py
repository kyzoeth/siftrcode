import sys
sys.path.insert(0, '.')
from fastapi import encoders
if not hasattr(encoders, 'encode_set_deterministic'): sys.exit(1)
if encoders.encode_set_deterministic({"c", "a", "b"}) != ["a", "b", "c"]: sys.exit(1)
sys.exit(0)