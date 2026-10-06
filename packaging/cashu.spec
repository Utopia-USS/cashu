# PyInstaller spec of cashU.app (macOS, one-folder bundle). Build it with scripts/build_macos.sh,
# which builds the SPA first, prepares the icon and the build venv, and signs / notarizes when the
# signing variables are set. Direct use (from the repo root, inside a venv with .[desktop] and
# packaging/requirements-build.txt installed):
#
#   CASHU_WEBDIST=<built SPA dir> CASHU_ICNS=<icon.icns> \
#     pyinstaller --noconfirm --distpath build/macos/dist --workpath build/macos/work packaging/cashu.spec
#
# One binary, Contents/MacOS/cashu: no arguments = the desktop window (Finder), anything else =
# the cashU CLI (`worker run`, `mcp --profile <slug>`, ...), `--notify-helper` = post one
# notification for the worker (see src/cashu/desktop/entry.py). It has no mode that runs a script;
# approved connectors (F10) run only as sandboxed child processes (core/connectors/sandbox.sb).
# The bundle registers the cashu:// URL scheme (notification clicks and links open the app on a
# view, src/cashu/desktop/notify.py).
# ruff: noqa
import os
import tomllib
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).resolve().parent
SRC = ROOT / "src"
PROJECT = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
VERSION = PROJECT["version"]
BUNDLE_ID = "io.utopiasoft.cashu"
MIN_MACOS = os.environ.get("CASHU_MIN_MACOS", "")  # build_macos.sh: the Python's own minimum

WEBDIST = Path(os.environ.get("CASHU_WEBDIST") or SRC / "cashu" / "api" / "webdist")
if not (WEBDIST / "index.html").is_file():
    raise SystemExit(f"Built SPA not found in {WEBDIST} (run `npm ci && npm run build` in frontend/)")
ICNS = Path(os.environ.get("CASHU_ICNS") or ROOT / "packaging" / "icon" / "cashU.icns")
SKILLS = ROOT / ".claude" / "skills"

WEBDIST_DEST = os.path.join("cashu", "api", "webdist")

# Package data: the SPA (from CASHU_WEBDIST, never a stale dev copy), the legacy static page,
# templates, examples, the connector sandbox profile template (core/connectors/sandbox.sb, read with
# importlib.resources for every connector run), and the Alembic scripts (env.py and versions/*.py are
# read from disk).
datas = [
    (src, dest)
    for src, dest in collect_data_files("cashu")
    if not dest.startswith(WEBDIST_DEST)
]
datas += collect_data_files("cashu.core.migrations", include_py_files=True)
datas.append((str(WEBDIST), WEBDIST_DEST))
if SKILLS.is_dir():
    datas.append((str(SKILLS), "skills"))  # core/runtime.py: skills_dir()

hiddenimports = [
    # Modules are found by id at runtime (core/modules.py), CLI and API wiring is dynamic.
    *collect_submodules("cashu", filter=lambda name: ".migrations.versions" not in name),
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
    name="cashu",
    console=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,  # scripts/build_macos.sh signs the finished bundle
    entitlements_file=None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="cashu")

info_plist = {
    "CFBundleName": "cashU",
    "CFBundleDisplayName": "cashU",
    "CFBundleShortVersionString": VERSION,
    "CFBundleVersion": os.environ.get("CASHU_BUILD_NUMBER", VERSION),
    "LSApplicationCategoryType": "public.app-category.finance",
    "NSHighResolutionCapable": True,
    "NSSupportsAutomaticGraphicsSwitching": True,
    # legacy name: the LICENSE copyright line of the original project, kept as is (attribution)
    "NSHumanReadableCopyright": "Copyright (c) 2026 finanse contributors. MIT License.",
    # The window loads http://127.0.0.1:<port>/ from the app's own server.
    "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    # cashu://signal/<profile>/<id> and friends: notification clicks and links open a view. The
    # legacy name finanse:// stays registered so notifications posted before the rename still open.
    "CFBundleURLTypes": [
        {
            "CFBundleURLName": BUNDLE_ID,
            "CFBundleURLSchemes": ["cashu", "finanse"],  # legacy name second
            "CFBundleTypeRole": "Viewer",
        }
    ],
    # The worker posts notifications through `cashu --notify-helper` only when the installed
    # app declares it (core/worker/notifier_app.py), so an older build is never asked.
    "CashuNotificationHelper": True,
}
if MIN_MACOS:
    info_plist["LSMinimumSystemVersion"] = MIN_MACOS

app = BUNDLE(
    coll,
    name="cashU.app",
    icon=str(ICNS),
    bundle_identifier=BUNDLE_ID,
    version=VERSION,
    info_plist=info_plist,
)
