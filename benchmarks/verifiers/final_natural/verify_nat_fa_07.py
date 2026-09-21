import sys
sys.path.insert(0, '.')
from fastapi.openapi import utils
if not hasattr(utils, 'can_skip_dependency_flattening'): sys.exit(1)
if utils.can_skip_dependency_flattening([]) is not True: sys.exit(1)
if utils.can_skip_dependency_flattening(['oauth2']) is not False: sys.exit(1)
sys.exit(0)