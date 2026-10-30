"""Personal finance tracker — bank transaction ingestion & analytics."""

__version__ = "0.4.3"

from . import _devenv  # before anything resolves a path: a checkout's .env.dev

_devenv.load()
