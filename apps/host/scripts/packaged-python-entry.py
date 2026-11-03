"""Entry for the relocatable PyInstaller Python sidecar inside the Electron bundle.

S62 owns migration and admission of a Python installation. Until that work is approved,
this executable refuses every normal CLI, server and MCP command, including with an
empty data directory.
The preflight command is deliberately handled before importing the Typer CLI, whose
callback otherwise runs legacy migration.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> int:
    from cashu.core import paths

    chosen = os.environ.get("CASHU_DATA_DIR", "").strip()
    if not chosen or not Path(chosen).is_absolute():
        print("CASHU_DATA_DIR must be an explicit absolute path", file=sys.stderr)
        return 2

    resolved = paths.data_dir().resolve()
    if resolved != Path(chosen).resolve():
        print("Python resolved a different data dir", file=sys.stderr)
        return 2

    if sys.argv[1:] == ["--preflight-data-dir"]:
        print(resolved)
        return 0

    # The Python callback runs migration and opens/upgrades the DB. There is not yet
    # an authenticated admission from S62 distinguishing a new database from an old
    # installation. Refuse every normal launch so repeated starts cannot turn an
    # initially empty data dir into an ambiguous one.
    print("Python sidecar awaits S62 admission; refusing to start", file=sys.stderr)
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
