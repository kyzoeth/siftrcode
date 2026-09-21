import sys
sys.path.insert(0, '.')
from fastapi import utils
if not hasattr(utils, 'split_sse_lines'): sys.exit(1)
if utils.split_sse_lines("line1\r\nline2") != ["line1", "line2"]: sys.exit(1)
sys.exit(0)