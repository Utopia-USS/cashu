"""PyInstaller onedir sidecar. The output directory is copied to Resources/python.

Build from the repository root with build-packaged-python.sh. PyInstaller carries the
Python interpreter and native libraries in _internal, so the bundle can be relocated;
a copied venv cannot provide that property.
"""

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).resolve().parents[2]
datas = [
    (src, dest)
    for src, dest in collect_data_files("cashu")
    if not dest.startswith(os.path.join("cashu", "api", "webdist"))
]
datas += collect_data_files("cashu.core.migrations", include_py_files=True)

for source, target in ((ROOT / ".claude" / "skills", "skills"),):
    if not source.is_dir():
        raise SystemExit(f"Missing packaged resource: {source}")
    datas.append((str(source), target))

# The connector catalog is package data. The wheel force-includes it under this path.
hiddenimports = [
    *collect_submodules("cashu", filter=lambda name: ".migrations.versions" not in name),
    *collect_submodules("alembic", filter=lambda name: not name.startswith("alembic.testing")),
    *collect_submodules("uvicorn"),
    "logging.config",
]
try:
    hiddenimports += collect_submodules("rich._unicode_data")
except Exception:
    pass

a = Analysis(
    [str(ROOT / "apps" / "host" / "scripts" / "packaged-python-entry.py")],
    pathex=[str(ROOT / "src")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "_tkinter", "pytest", "_pytest", "ruff", "webview"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [], exclude_binaries=True, name="cashu-python", console=True,
    contents_directory="_internal",
)
coll = COLLECT(exe, a.binaries, a.datas, name="python")
