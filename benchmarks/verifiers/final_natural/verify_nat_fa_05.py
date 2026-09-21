import sys
sys.path.insert(0, '.')
from fastapi import encoders
if not hasattr(encoders, 'supports_recursive_dict_exclusions'): sys.exit(1)
if encoders.supports_recursive_dict_exclusions() is not True: sys.exit(1)
sys.exit(0)