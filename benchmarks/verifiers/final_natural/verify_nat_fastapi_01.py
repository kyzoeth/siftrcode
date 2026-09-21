
import sys
from fastapi.sse import format_sse_event

event = format_sse_event(data_str="hello\n")
if b"data: hello\ndata: \n\n" not in event:
    sys.exit(1)
sys.exit(0)
