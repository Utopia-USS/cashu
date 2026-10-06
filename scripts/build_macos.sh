#!/usr/bin/env bash
# Build Finanse.app (macOS): the SPA, the icon, a PyInstaller one-folder bundle, and - when the
# signing variables are set - a Developer ID signature with the hardened runtime and notarization.
#
#   scripts/build_macos.sh [--skip-frontend] [--clean] [--dmg]
#
# Output (git-ignored): build/macos/dist/Finanse.app and build/macos/Finanse-<version>-macos-<arch>.zip
# (+ .dmg with --dmg). The script never installs anything into /Applications.
#
# Environment:
#   PYTHON                    Python 3.12+ used for the build venv (default: python3). The app runs
#                             on the macOS versions this Python supports (Homebrew: the build host's
#                             macOS; python.org installers: older ones too).
#   DEVELOPER_ID_APPLICATION  signing identity, e.g. "Developer ID Application: Name (TEAMID)".
#                             Unset: the app keeps PyInstaller's ad-hoc signature (local use only).
#   NOTARY_KEYCHAIN_PROFILE   notarytool keychain profile (created once with
#                             `xcrun notarytool store-credentials <profile> ...`). Needs a signed build.
#   FINANSE_BUILD_DIR         build folder (default: build/macos)
#   FINANSE_BUILD_NUMBER      CFBundleVersion (default: the pyproject version)
#
# No secret is read from or written to the repository: the identity lives in the login keychain,
# the notary credentials in a keychain profile.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${FINANSE_BUILD_DIR:-$ROOT/build/macos}"
PYTHON="${PYTHON:-python3}"
SKIP_FRONTEND=0
CLEAN=0
DMG=0
for arg in "$@"; do
  case "$arg" in
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --clean) CLEAN=1 ;;
    --dmg) DMG=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "Finanse.app can only be built on macOS."
for tool in sips iconutil codesign ditto rsync npm; do
  command -v "$tool" >/dev/null || die "$tool not found (Xcode command line tools / Node.js needed)."
done
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 12))' || die "$PYTHON is older than 3.12."

VERSION="$("$PYTHON" -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["project"]["version"])' "$ROOT/pyproject.toml")"
ARCH="$(uname -m)"
APP="$BUILD/dist/Finanse.app"
mkdir -p "$BUILD"
if [[ $CLEAN == 1 ]]; then
  say "Cleaning $BUILD"
  rm -rf "$BUILD/dist" "$BUILD/work" "$BUILD/venv" "$BUILD/frontend" "$BUILD/src" "$BUILD/icon"
fi

# --- 1. SPA: npm ci + npm run build in a copy of frontend/ (the dev node_modules and
#        src/finanse/api/webdist stay untouched). vite's outDir is ../src/finanse/api/webdist
#        relative to the config, i.e. $BUILD/src/finanse/api/webdist for the copy.
WEBDIST="$BUILD/src/finanse/api/webdist"
if [[ $SKIP_FRONTEND == 0 ]]; then
  say "Building the dashboard (npm ci && npm run build)"
  rsync -a --delete --exclude node_modules --exclude dist "$ROOT/frontend/" "$BUILD/frontend/"
  (cd "$BUILD/frontend" && npm ci --no-audit --no-fund && npm run build)
fi
[[ -f "$WEBDIST/index.html" ]] || die "No built dashboard in $WEBDIST (run without --skip-frontend)."

# --- 2. Icon: packaging/icon/finanse-1024.png -> iconset (sips) -> .icns (iconutil).
say "Generating the icon"
ICONSET="$BUILD/icon/Finanse.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
SRC_PNG="$ROOT/packaging/icon/finanse-1024.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SRC_PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$SRC_PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD/icon/Finanse.icns"

# --- 3. Build venv from packaging/requirements-build.lock: every package (runtime deps + the
#        desktop extra, PyInstaller, the hatchling build backend, pip itself) at an exact version
#        with sha256 hashes, so a re-uploaded or compromised wheel cannot reach the signed bundle.
#        pip is pinned there too (PIP_VERSION below must match). finanse itself is installed
#        editable from src/ without dependencies and without build isolation (no unpinned
#        download at build time).
PIP_VERSION="26.2.1"
LOCK="$ROOT/packaging/requirements-build.lock"
say "Preparing the build venv ($BUILD/venv)"
[[ -x "$BUILD/venv/bin/python" ]] || "$PYTHON" -m venv "$BUILD/venv"
grep -q "^pip==$PIP_VERSION " "$LOCK" || die "PIP_VERSION $PIP_VERSION is not the pip pinned in $LOCK."
# First pip and setuptools (their hashed entries of the lock): the one sdist-only package in the
# lock is then built with this setuptools instead of an isolated, unpinned build environment.
BOOTSTRAP="$BUILD/bootstrap.lock"
awk '/^[A-Za-z]/ { keep = ($1 ~ /^(pip|setuptools)==/) } keep && !/^[[:space:]]*#/' "$LOCK" > "$BOOTSTRAP"
"$BUILD/venv/bin/python" -m pip install --quiet --disable-pip-version-check \
  --require-hashes --no-deps -r "$BOOTSTRAP"
"$BUILD/venv/bin/python" -m pip install --quiet --disable-pip-version-check \
  --require-hashes --no-deps --no-build-isolation -r "$LOCK"
"$BUILD/venv/bin/python" -m pip --version | grep -q "^pip $PIP_VERSION " \
  || die "the build venv does not run pip $PIP_VERSION"
"$BUILD/venv/bin/python" -m pip install --quiet --disable-pip-version-check \
  --no-deps --no-build-isolation -e "$ROOT"
"$BUILD/venv/bin/python" -m pip check >/dev/null || die "the build venv has inconsistent packages (pip check)."

# Minimum macOS = what the bundled Python library was built for (LC_BUILD_VERSION minos).
PYLIB="$("$BUILD/venv/bin/python" - <<'PY'
import os, sys, sysconfig
v = sysconfig.get_config_var
names = [(v("PYTHONFRAMEWORKPREFIX"), v("LDLIBRARY")), (v("LIBDIR"), v("LDLIBRARY"))]
found = [os.path.join(d, n) for d, n in names if d and n] + [os.path.realpath(sys._base_executable)]
print(next((p for p in found if os.path.isfile(p)), ""))
PY
)"
MIN_MACOS=""
if [[ -f "$PYLIB" ]]; then
  MIN_MACOS="$(otool -l "$PYLIB" | awk '/LC_BUILD_VERSION/{f=1} f && $1=="minos"{print $2; exit}')"
fi

# --- 4. PyInstaller.
say "Running PyInstaller (Finanse.app $VERSION, $ARCH${MIN_MACOS:+, macOS $MIN_MACOS+})"
(
  cd "$ROOT"
  FINANSE_WEBDIST="$WEBDIST" FINANSE_ICNS="$BUILD/icon/Finanse.icns" FINANSE_MIN_MACOS="$MIN_MACOS" \
    "$BUILD/venv/bin/pyinstaller" --noconfirm --clean --log-level WARN \
    --distpath "$BUILD/dist" --workpath "$BUILD/work" "$ROOT/packaging/finanse.spec"
)
[[ -x "$APP/Contents/MacOS/finanse" ]] || die "PyInstaller produced no $APP"
# Smoke test of the CLI path (no window, no data dir access beyond --help).
"$APP/Contents/MacOS/finanse" --help >/dev/null || die "the bundled CLI does not start"

# --- 5. Signing (Developer ID + hardened runtime), inside-out: every Mach-O file, then the app.
SIGNED=0
if [[ -n "${DEVELOPER_ID_APPLICATION:-}" ]]; then
  say "Signing with \"$DEVELOPER_ID_APPLICATION\" (hardened runtime)"
  ENT="$ROOT/packaging/entitlements.plist"
  sign() { codesign --force --timestamp --options runtime --sign "$DEVELOPER_ID_APPLICATION" "$@"; }
  # Libraries and extension modules (symlinks are skipped: PyInstaller cross-links folders).
  while IFS= read -r -d '' f; do
    if file -b "$f" | grep -q 'Mach-O'; then sign "$f"; fi
  done < <(find "$APP/Contents/Frameworks" "$APP/Contents/Resources" -type f -print0)
  # Embedded framework bundles (e.g. Python.framework), if PyInstaller kept any as bundles.
  while IFS= read -r -d '' fw; do sign "$fw"; done < <(find "$APP/Contents/Frameworks" -type d -name '*.framework' -prune -print0)
  # The executable and the bundle carry the hardened-runtime entitlements.
  sign --entitlements "$ENT" "$APP/Contents/MacOS/finanse"
  sign --entitlements "$ENT" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  SIGNED=1
else
  say "Signing skipped: DEVELOPER_ID_APPLICATION is not set."
  echo "    This build is for local use: it runs on this Mac, but Gatekeeper blocks it on other"
  echo "    Macs after a download (see README, \"Installing the macOS app\")."
fi

# --- 6. Notarization (needs a signed build).
if [[ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
  [[ $SIGNED == 1 ]] || die "NOTARY_KEYCHAIN_PROFILE is set but the app is not signed (set DEVELOPER_ID_APPLICATION)."
  say "Notarizing (profile $NOTARY_KEYCHAIN_PROFILE)"
  SUBMIT="$BUILD/Finanse-notarize.zip"
  rm -f "$SUBMIT"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$SUBMIT"
  xcrun notarytool submit "$SUBMIT" --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" --wait
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
  rm -f "$SUBMIT"
elif [[ $SIGNED == 1 ]]; then
  say "Notarization skipped: NOTARY_KEYCHAIN_PROFILE is not set (signed, not notarized)."
fi

# --- 7. Archives for distribution.
ZIP="$BUILD/Finanse-$VERSION-macos-$ARCH.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
if [[ $DMG == 1 ]]; then
  DMG_PATH="$BUILD/Finanse-$VERSION-macos-$ARCH.dmg"
  STAGE="$BUILD/dmg"
  rm -rf "$STAGE" "$DMG_PATH" && mkdir -p "$STAGE"
  ditto "$APP" "$STAGE/Finanse.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -quiet -volname "Finanse" -srcfolder "$STAGE" -ov -format UDZO "$DMG_PATH"
  rm -rf "$STAGE"
  if [[ $SIGNED == 1 ]]; then codesign --force --timestamp --sign "$DEVELOPER_ID_APPLICATION" "$DMG_PATH"; fi
fi

say "Done"
echo "    app:     $APP ($(du -sh "$APP" | cut -f1))"
echo "    archive: $ZIP ($(du -sh "$ZIP" | cut -f1))"
[[ $DMG == 1 ]] && echo "    dmg:     $DMG_PATH"
echo "    signed:  $([[ $SIGNED == 1 ]] && echo yes || echo 'no (ad-hoc)')"
