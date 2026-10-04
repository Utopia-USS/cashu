"""Compatibility alias: the database layer lives in ``finanse.core.db``.

``import finanse.db`` returns the very same module object, so existing imports
and test fixtures that patch ``finanse.db.engine`` keep working.
"""

import sys

from .core import db as _core_db

sys.modules[__name__] = _core_db
