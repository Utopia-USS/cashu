# PyInstaller spec of Finanse.app (macOS, one-folder bundle). Build it with scripts/build_macos.sh,
# which builds the SPA first, prepares the icon and the build venv, and signs / notarizes when the
# signing variables are set. Direct use (from the repo root, inside a venv with .[desktop] and
# packaging/requirements-build.txt installed):
#
#   FINANSE_WEBDIST=<built SPA dir> FINANSE_ICNS=<icon.icns> \
#     pyinstaller --noconfirm --distpath build/macos/dist --workpath build/macos/work packaging/finanse.spec
#
# One binary, Contents/MacOS/finanse: no arguments = the desktop window (Finder), anything else =
# the finanse CLI (`worker run`, `mcp --profile <slug>`, ...), `--notify-helper` = post one
# notification for the worker (see src/finanse/desktop/entry.py). It never runs scripts.
# The bundle registers the finanse:// URL scheme (notification clicks and links open the app on a
# view, src/finanse/desktop/notify.py).
# ruff: noqa
import os
import tomllib
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).resolve().parent
SRC = ROOT / "src"
PROJECT = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
VERSION = PROJECT["version"]
BUNDLE_ID = "io.github.synszakala.finanse"  # upstream repo github.com/SynSzakala/finanse
MIN_MACOS = os.environ.get("FINANSE_MIN_MACOS", "")  # build_macos.sh: the Python's own minimum

WEBDIST = Path(os.environ.get("FINANSE_WEBDIST") or SRC / "finanse" / "api" / "webdist")
if not (WEBDIST / "index.html").is_file():
    raise SystemExit(f"Built SPA not found in {WEBDIST} (run `npm ci && npm run build` in frontend/)")
ICNS = Path(os.environ.get("FINANSE_ICNS") or ROOT / "packaging" / "icon" / "Finanse.icns")
SKILLS = ROOT / ".claude" / "skills"

WEBDIST_DEST = os.path.join("finanse", "api", "webdist")

# Package data: the SPA (from FINANSE_WEBDIST, never a stale dev copy), the legacy static page,
# templates, examples, and the Alembic scripts (env.py and versions/*.py are read from disk).
datas = [
    (src, dest)
    for src, dest in collect_data_files("finanse")
    if not dest.startswith(WEBDIST_DEST)
]
datas += collect_data_files("finanse.core.migrations", include_py_files=True)
datas.append((str(WEBDIST), WEBDIST_DEST))
if SKILLS.is_dir():
    datas.append((str(SKILLS), "skills"))  # core/runtime.py: skills_dir()

hiddenimports = [
    # Modules are found by id at runtime (core/modules.py), CLI and API wiring is dynamic.
    *collect_submodules("finanse", filter=lambda name: ".migrations.versions" not in name),
    # Alembic runs env.py / versions from files: what they import must be in the archive.
    *collect_submodules("alembic", filter=lambda name: not name.startswith("alembic.testing")),
    "logging.config",
    *collect_submodules("uvicorn"),
    "webview.platforms.cocoa",
    # Native notifications (desktop/notify.py imports it lazily, inside the helper and the shell).
    *collect_submodules("UserNotifications"),
]
try:
    hiddenimports += collect_submodules("rich._unicode_data")  # loaded by name at runtime
except Exception:
    pass

a = Analysis(
    [str(ROOT / "packaging" / "entry.py")],
    pathex=[str(SRC)],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "_tkinter", "pytest", "_pytest", "ruff", "IPython", "matplotlib"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="finanse",
    console=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,  # scripts/build_macos.sh signs the finished bundle
    entitlements_file=None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="finanse")

info_plist = {
    "CFBundleName": "Finanse",
    "CFBundleDisplayName": "Finanse",
    "CFBundleShortVersionString": VERSION,
    "CFBundleVersion": os.environ.get("FINANSE_BUILD_NUMBER", VERSION),
    "LSApplicationCategoryType": "public.app-category.finance",
    "NSHighResolutionCapable": True,
    "NSSupportsAutomaticGraphicsSwitching": True,
    "NSHumanReadableCopyright": "Copyright (c) 2026 finanse contributors. MIT License.",
    # The window loads http://127.0.0.1:<port>/ from the app's own server.
    "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    # finanse://signal/<profile>/<id> and friends: notification clicks and links open a view.
    "CFBundleURLTypes": [
        {
            "CFBundleURLName": BUNDLE_ID,
            "CFBundleURLSchemes": ["finanse"],
            "CFBundleTypeRole": "Viewer",
        }
    ],
    # The worker posts notifications through `finanse --notify-helper` only when the installed
    # app declares it (core/worker/notifier_app.py), so an older build is never asked.
    "FinanseNotificationHelper": True,
}
if MIN_MACOS:
    info_plist["LSMinimumSystemVersion"] = MIN_MACOS

app = BUNDLE(
    coll,
    name="Finanse.app",
    icon=str(ICNS),
    bundle_identifier=BUNDLE_ID,
    version=VERSION,
    info_plist=info_plist,
)
