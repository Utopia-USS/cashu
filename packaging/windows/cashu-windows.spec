# Windows build of cashU - DOCUMENTED STUB, not built or tested yet.
#
# The code is cross-platform (data dir %APPDATA%\cashU, OS keychain via keyring, pywebview uses
# WebView2/EdgeChromium); what is missing on Windows is listed below. The macOS bundle is the
# reference: packaging/cashu.spec + scripts/build_macos.sh.
#
# Plan:
#   1. Two executables in one folder (COLLECT), because a windowed (GUI subsystem) exe has no
#      usable stdio:
#        cashU.exe      windowed  - the desktop window (Start menu / desktop shortcut)
#        cashu-cli.exe  console   - `worker run` (Task Scheduler) and `mcp --profile <slug>`
#                                     (Claude Desktop / Claude Code talk to it over stdio)
#      core/runtime.py must then return cashu-cli.exe from cli_program() when frozen on Windows
#      (today it returns sys.executable, which would be cashU.exe).
#   2. Icon: packaging/icon/cashu.ico generated from packaging/icon/cashu-1024.png at build
#      time (e.g. Pillow: Image.open(png).save(ico, sizes=[(16,16),(32,32),(48,48),(256,256)])).
#   3. WebView2 runtime: preinstalled on Windows 11 and current Windows 10; otherwise the
#      Evergreen bootstrapper. pywebview picks EdgeChromium automatically.
#   4. Background worker: core/worker/scheduler.py WindowsTaskScheduler is a stub (501); implement
#      it with `schtasks /Create /SC DAILY /ST HH:MM /TN cashu-worker /TR "<cashu-cli.exe> worker
#      run"`. Notifications: core/worker/notifier.py WindowsToastNotifier is a stub too.
#   5. Single instance: core/locks.py already uses msvcrt.locking on Windows; focusing the running
#      window (desktop/shell.py focus_process) is macOS-only, a second launch just prints a message.
#   6. Signing: signtool with an Authenticode certificate (env vars, like the macOS script);
#      unsigned builds trigger SmartScreen.
#   7. Build: on Windows, in a venv with the hash-pinned lock (like scripts/build_macos.sh):
#      `pip install --require-hashes --no-deps -r packaging/requirements-build.lock` and
#      `pip install --no-deps -e .`, after `npm ci && npm run build` in frontend/:
#      pyinstaller --noconfirm packaging/windows/cashu-windows.spec. The lock is resolved on
#      macOS: regenerate it on Windows (packaging/README.md) if a wheel is missing.
#   8. Security checks before shipping: desktop/shell.py bind_loopback never sets SO_REUSEADDR on
#      Windows (socket_options: SO_EXCLUSIVEADDRUSE, so no other process can bind the port and
#      receive the window's token header); install_navigation_guard only covers the macOS
#      backend, pin the EdgeChromium window to the app origin too; the token bridge
#      (window.pywebview.api.token) works the same on WebView2.
# ruff: noqa
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).resolve().parents[1]
SRC = ROOT / "src"
WEBDIST = Path(os.environ.get("CASHU_WEBDIST") or SRC / "cashu" / "api" / "webdist")
WEBDIST_DEST = os.path.join("cashu", "api", "webdist")
ICO = ROOT / "packaging" / "icon" / "cashu.ico"  # generated at build time (step 2)

datas = [(s, d) for s, d in collect_data_files("cashu") if not d.startswith(WEBDIST_DEST)]
datas += collect_data_files("cashu.core.migrations", include_py_files=True)
datas.append((str(WEBDIST), WEBDIST_DEST))
datas.append((str(ROOT / ".claude" / "skills"), "skills"))

hiddenimports = [
    *collect_submodules("cashu", filter=lambda n: ".migrations.versions" not in n),
    *collect_submodules("alembic", filter=lambda n: not n.startswith("alembic.testing")),
    *collect_submodules("uvicorn"),
    "logging.config",
    "webview.platforms.edgechromium",
    "csv",
    "zipfile",
    "xml.etree.ElementTree",
]

a = Analysis(
    [str(ROOT / "packaging" / "entry.py")],
    pathex=[str(SRC)],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "_tkinter", "pytest", "_pytest"],
)
pyz = PYZ(a.pure)

gui = EXE(
    pyz, a.scripts, [], exclude_binaries=True, name="cashU", console=False,
    icon=str(ICO) if ICO.exists() else None,
)
cli = EXE(
    pyz, a.scripts, [], exclude_binaries=True, name="cashu-cli", console=True,
    icon=str(ICO) if ICO.exists() else None,
)
coll = COLLECT(gui, cli, a.binaries, a.datas, name="cashU")
