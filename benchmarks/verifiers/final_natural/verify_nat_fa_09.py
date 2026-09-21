import sys
sys.path.insert(0, '.')
from fastapi.dependencies import utils
if not hasattr(utils, 'clear_parameter_caches'): sys.exit(1)
utils.clear_parameter_caches()
sys.exit(0)