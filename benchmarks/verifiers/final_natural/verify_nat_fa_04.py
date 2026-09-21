import sys
sys.path.insert(0, '.')
from fastapi.dependencies import utils
if not hasattr(utils, 'supports_annotated_sequence_params'): sys.exit(1)
if utils.supports_annotated_sequence_params() is not True: sys.exit(1)
sys.exit(0)