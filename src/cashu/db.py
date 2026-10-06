"""Compatibility alias: the database layer lives in ``cashu.core.db``.

``import cashu.db`` returns the very same module object, so existing imports
and test fixtures that patch ``cashu.db.engine`` keep working.
"""

import sys

from .core import db as _core_db

sys.modules[__name__] = _core_db
