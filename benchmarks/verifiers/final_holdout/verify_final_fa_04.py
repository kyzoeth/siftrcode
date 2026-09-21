import sys
sys.path.insert(0, '.')
from fastapi.openapi import utils
if not hasattr(utils, 'deduplicate_tags'): sys.exit(1)
res = utils.deduplicate_tags([{"name": "a"}, {"name": "a"}])
if len(res) != 1: sys.exit(1)
sys.exit(0)