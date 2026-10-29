#!/usr/bin/env bash
# Build cashU.app (macOS): the SPA, the icon, a PyInstaller one-folder bundle, and - when the
# signing variables are set - a Developer ID signature with the hardened runtime and notarization.
#
#   scripts/build_macos.sh [--skip-frontend] [--clean] [--dmg] [--skip-deno]
#
# The app bundles the Deno runtime for deno connectors: the official release archive pinned below
# (DENO_VERSION + sha256 per architecture) is downloaded once into the build folder, checked against
# the pinned sha256 before it is unpacked, and signed with its own entitlements
# (packaging/deno-entitlements.plist: allow-jit only). While the sha256 is not pinned the app is
# built without Deno and a loud warning is printed (pinning: packaging/README.md). --skip-deno builds
# without it on purpose. Without Deno, deno connectors need a deno on the search path.
#
# Output (git-ignored): build/macos/dist/cashU.app and build/macos/cashU-<version>-macos-<arch>.zip
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
#   CASHU_BUILD_DIR           build folder (default: build/macos)
#   CASHU_BUILD_NUMBER        CFBundleVersion (default: the pyproject version)
#   SPARKLE_PUBLIC_ED_KEY     the public half of the update signing key (base64, from Sparkle's
#                             generate_keys). Set: the app ships Sparkle and checks the update feed
#                             (packaging/README.md, "Auto-update"). Unset: no updater.
#   CASHU_UPDATE_REPO         GitHub repo whose latest release holds the update feed
#                             (default: Utopia-USS/cashu)
#   CASHU_UPDATE_FEED_URL     the feed URL itself (default: that repo's
#                             releases/latest/download/appcast-macos-<arch>.xml)
#
# No secret is read from or written to the repository: the identity lives in the login keychain,
# the notary credentials in a keychain profile, the update signing key in the login keychain
# (scripts/make_appcast.py signs with it after the build).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${CASHU_BUILD_DIR:-$ROOT/build/macos}"
PYTHON="${PYTHON:-python3}"
SKIP_FRONTEND=0
CLEAN=0
DMG=0
SKIP_DENO=0
for arg in "$@"; do
  case "$arg" in
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --clean) CLEAN=1 ;;
    --dmg) DMG=1 ;;
    --skip-deno) SKIP_DENO=1 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "cashU.app can only be built on macOS."
for tool in sips iconutil codesign ditto rsync npm curl shasum; do
  command -v "$tool" >/dev/null || die "$tool not found (Xcode command line tools / Node.js needed)."
done
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 12))' || die "$PYTHON is older than 3.12."

VERSION="$("$PYTHON" -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["project"]["version"])' "$ROOT/pyproject.toml")"
ARCH="$(uname -m)"
APP="$BUILD/dist/cashU.app"
mkdir -p "$BUILD"
if [[ $CLEAN == 1 ]]; then
  say "Cleaning $BUILD"
  rm -rf "$BUILD/dist" "$BUILD/work" "$BUILD/venv" "$BUILD/frontend" "$BUILD/src" "$BUILD/icon"
fi

# --- 1. SPA: npm ci + npm run build in a copy of frontend/ (the dev node_modules and
#        src/cashu/api/webdist stay untouched). vite's outDir is ../src/cashu/api/webdist
#        relative to the config, i.e. $BUILD/src/cashu/api/webdist for the copy.
WEBDIST="$BUILD/src/cashu/api/webdist"
if [[ $SKIP_FRONTEND == 0 ]]; then
  say "Building the dashboard (npm ci && npm run build)"
  rsync -a --delete --exclude node_modules --exclude dist "$ROOT/frontend/" "$BUILD/frontend/"
  (cd "$BUILD/frontend" && npm ci --no-audit --no-fund && npm run build)
fi
[[ -f "$WEBDIST/index.html" ]] || die "No built dashboard in $WEBDIST (run without --skip-frontend)."

# --- 2. Icon: packaging/icon/cashu-1024.png -> iconset (sips) -> .icns (iconutil).
say "Generating the icon"
ICONSET="$BUILD/icon/cashU.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
SRC_PNG="$ROOT/packaging/icon/cashu-1024.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SRC_PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$SRC_PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD/icon/cashU.icns"

# --- 3. Build venv from packaging/requirements-build.lock: every package (runtime deps + the
#        desktop extra, PyInstaller, the hatchling build backend, pip itself) at an exact version
#        with sha256 hashes, so a re-uploaded or compromised wheel cannot reach the signed bundle.
#        pip is pinned there too (PIP_VERSION below must match). cashU itself is installed
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

# --- 3b. Deno runtime for deno connectors: the official release archive for this architecture,
#         pinned by version and sha256. Update all three together: the sha256 values come from the
#         release's <archive>.sha256sum files on github.com/denoland/deno/releases, cross-checked
#         against a download on a second machine. The archive is checked before it is unpacked; a
#         cached archive is checked again on every build.
DENO_VERSION="2.9.1"
DENO_SHA256_AARCH64="ee3473502118eab301eca93aa6b31d6b0b6c1602d0f59e4cb89d4a262b12f6e7"  # deno-aarch64-apple-darwin.zip
DENO_SHA256_X86_64="89cbc8c974247772d9200724741b4e692ef49fe470b2ff555da905817c3daa11"   # deno-x86_64-apple-darwin.zip
DENO_BIN=""
DENO_UNPINNED=0
warn_deno() {
  printf '\n%s\n' "!!! WARNING: building cashU.app WITHOUT the Deno runtime." >&2
  printf '%s\n' "!!! The sha256 of the Deno $DENO_VERSION release is not pinned in scripts/build_macos.sh" >&2
  printf '%s\n' "!!! (DENO_SHA256_AARCH64 / DENO_SHA256_X86_64). Deno connectors in this build fail with" >&2
  printf '%s\n' "!!! \"deno was not found\" unless the Mac has its own deno. Pin it: packaging/README.md." >&2
}
if [[ $SKIP_DENO == 0 ]]; then
  case "$ARCH" in
    arm64) DENO_TARGET="aarch64-apple-darwin"; DENO_SHA256="$DENO_SHA256_AARCH64" ;;
    x86_64) DENO_TARGET="x86_64-apple-darwin"; DENO_SHA256="$DENO_SHA256_X86_64" ;;
    *) die "no Deno release for $ARCH" ;;
  esac
  if [[ -z "$DENO_SHA256" ]]; then
    # Not pinned yet (packaging/README.md, "Pinning the Deno release"): the app is built WITHOUT Deno
    # instead of blocking the build; deno connectors then report their interpreter as missing.
    DENO_UNPINNED=1
    SKIP_DENO=1
    warn_deno
  elif ! [[ "$DENO_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    die "DENO_SHA256_* for $DENO_TARGET is not a sha256 (64 lower-case hex characters)"
  fi
fi
if [[ $SKIP_DENO == 0 ]]; then
  DENO_DIR_BUILD="$BUILD/deno/$DENO_VERSION-$DENO_TARGET"
  DENO_ZIP="$BUILD/deno/deno-$DENO_VERSION-$DENO_TARGET.zip"
  mkdir -p "$BUILD/deno"
  if [[ ! -f "$DENO_ZIP" ]]; then
    say "Downloading Deno $DENO_VERSION ($DENO_TARGET)"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --output "$DENO_ZIP.part" \
      "https://github.com/denoland/deno/releases/download/v$DENO_VERSION/deno-$DENO_TARGET.zip"
    mv "$DENO_ZIP.part" "$DENO_ZIP"
  fi
  GOT="$(shasum -a 256 "$DENO_ZIP" | cut -d' ' -f1)"
  if [[ "$GOT" != "$DENO_SHA256" ]]; then
    rm -f "$DENO_ZIP"
    die "deno-$DENO_TARGET.zip does not match the pinned sha256 (got $GOT); the archive was deleted"
  fi
  rm -rf "$DENO_DIR_BUILD" && mkdir -p "$DENO_DIR_BUILD"
  ditto -x -k "$DENO_ZIP" "$DENO_DIR_BUILD"
  DENO_BIN="$DENO_DIR_BUILD/deno"
  [[ -x "$DENO_BIN" ]] || die "the Deno archive has no deno binary"
  "$DENO_BIN" --version | head -1 | grep -q "^deno $DENO_VERSION " \
    || die "the unpacked deno is not version $DENO_VERSION"
fi

# Auto-update (Sparkle, pinned in scripts/fetch_sparkle.sh): only with an update key. Sparkle 2.10 needs
# macOS 12+.
SPARKLE=0
FEED_URL=""
if [[ -n "${SPARKLE_PUBLIC_ED_KEY:-}" ]]; then
  SPARKLE=1
  FEED_URL="${CASHU_UPDATE_FEED_URL:-https://github.com/${CASHU_UPDATE_REPO:-Utopia-USS/cashu}/releases/latest/download/appcast-macos-$ARCH.xml}"
  if [[ -z "$MIN_MACOS" || "$(printf '%s\n' "$MIN_MACOS" 12.0 | sort -V | head -1)" != "12.0" ]]; then
    MIN_MACOS="12.0"
  fi
fi

# --- 4. PyInstaller.
say "Running PyInstaller (cashU.app $VERSION, $ARCH${MIN_MACOS:+, macOS $MIN_MACOS+})"
(
  cd "$ROOT"
  CASHU_WEBDIST="$WEBDIST" CASHU_ICNS="$BUILD/icon/cashU.icns" CASHU_MIN_MACOS="$MIN_MACOS" \
    CASHU_DENO="$DENO_BIN" \
    CASHU_SPARKLE_FEED_URL="$FEED_URL" CASHU_SPARKLE_PUBLIC_KEY="${SPARKLE_PUBLIC_ED_KEY:-}" \
    "$BUILD/venv/bin/pyinstaller" --noconfirm --clean --log-level WARN \
    --distpath "$BUILD/dist" --workpath "$BUILD/work" "$ROOT/packaging/cashu.spec"
)
[[ -x "$APP/Contents/MacOS/cashu" ]] || die "PyInstaller produced no $APP"
# Smoke test of the CLI path (no window, no data dir access beyond --help).
"$APP/Contents/MacOS/cashu" --help >/dev/null || die "the bundled CLI does not start"
# The bundled deno (core/connectors/manifest.py bundled_interpreter looks in Frameworks/deno/ and
# Resources/deno/ of the app).
APP_DENO=""
if [[ $SKIP_DENO == 0 ]]; then
  for candidate in "$APP/Contents/Frameworks/deno/deno" "$APP/Contents/Resources/deno/deno"; do
    if [[ -f "$candidate" && ! -L "$candidate" ]]; then APP_DENO="$candidate"; break; fi
  done
  [[ -n "$APP_DENO" ]] || die "the bundle has no deno/deno"
  "$APP_DENO" --version | head -1 | grep -q "^deno $DENO_VERSION " || die "the bundled deno does not start"
fi

# --- 4b. Sparkle.framework (auto-update), fetched into the build folder by scripts/fetch_sparkle.sh (its
#         bin/ tools sign the update archive later, scripts/make_appcast.py). The XPC services are only for
#         sandboxed apps and are left out.
SPARKLE_FW="$APP/Contents/Frameworks/Sparkle.framework"
if [[ $SPARKLE == 1 ]]; then
  say "Adding Sparkle (feed $FEED_URL)"
  "$ROOT/scripts/fetch_sparkle.sh" "$BUILD/sparkle" || die "could not fetch Sparkle."
  rm -rf "$SPARKLE_FW"
  ditto "$BUILD/sparkle/Sparkle.framework" "$SPARKLE_FW"
  rm -rf "$SPARKLE_FW/XPCServices" "$SPARKLE_FW/Versions/B/XPCServices"
fi

# Sparkle's helpers are signed inside-out as bundles (never with --deep), before the framework.
sign_sparkle() {
  [[ $SPARKLE == 1 ]] || return 0
  "$@" "$SPARKLE_FW/Versions/B/Autoupdate"
  "$@" "$SPARKLE_FW/Versions/B/Updater.app"
  "$@" "$SPARKLE_FW"
}

# --- 5. Signing (Developer ID + hardened runtime), inside-out: every Mach-O file, then the app.
SIGNED=0
if [[ -n "${DEVELOPER_ID_APPLICATION:-}" ]]; then
  say "Signing with \"$DEVELOPER_ID_APPLICATION\" (hardened runtime)"
  ENT="$ROOT/packaging/entitlements.plist"
  sign() { codesign --force --timestamp --options runtime --sign "$DEVELOPER_ID_APPLICATION" "$@"; }
  # Libraries and extension modules (symlinks are skipped: PyInstaller cross-links folders). The
  # bundled deno is left out here: it gets its own entitlements below.
  while IFS= read -r -d '' f; do
    [[ -n "$APP_DENO" && "$f" == "$APP_DENO" ]] && continue
    if file -b "$f" | grep -q 'Mach-O'; then sign "$f"; fi
  done < <(find "$APP/Contents/Frameworks" "$APP/Contents/Resources" -type f -not -path '*/Sparkle.framework/*' -print0)
  # deno: hardened runtime + allow-jit only (V8 aborts at start without JIT pages). The main
  # executable keeps packaging/entitlements.plist (none).
  if [[ -n "$APP_DENO" ]]; then
    sign --entitlements "$ROOT/packaging/deno-entitlements.plist" "$APP_DENO"
    "$APP_DENO" --version >/dev/null || die "the signed deno does not start (allow-jit missing?)"
  fi
  # Embedded framework bundles (e.g. Python.framework), if PyInstaller kept any as bundles.
  while IFS= read -r -d '' fw; do sign "$fw"; done < <(find "$APP/Contents/Frameworks" -type d -name '*.framework' -not -name Sparkle.framework -prune -print0)
  sign_sparkle sign
  # The executable and the bundle carry the hardened-runtime entitlements.
  sign --entitlements "$ENT" "$APP/Contents/MacOS/cashu"
  sign --entitlements "$ENT" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  SIGNED=1
else
  say "Signing skipped: DEVELOPER_ID_APPLICATION is not set."
  echo "    This build is for local use: it runs on this Mac, but Gatekeeper blocks it on other"
  echo "    Macs after a download (see README, \"Installing the macOS app\")."
  if [[ $SPARKLE == 1 ]]; then
    # The added framework breaks PyInstaller's ad-hoc seal of the bundle: seal it again.
    sign_sparkle codesign --force --sign -
    codesign --force --sign - "$APP/Contents/MacOS/cashu"
    codesign --force --sign - "$APP"
    codesign --verify --deep --strict "$APP"
  fi
fi

# --- 6. Notarization (needs a signed build).
if [[ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
  [[ $SIGNED == 1 ]] || die "NOTARY_KEYCHAIN_PROFILE is set but the app is not signed (set DEVELOPER_ID_APPLICATION)."
  say "Notarizing (profile $NOTARY_KEYCHAIN_PROFILE)"
  SUBMIT="$BUILD/cashU-notarize.zip"
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
ZIP="$BUILD/cashU-$VERSION-macos-$ARCH.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
if [[ $DMG == 1 ]]; then
  DMG_PATH="$BUILD/cashU-$VERSION-macos-$ARCH.dmg"
  STAGE="$BUILD/dmg"
  rm -rf "$STAGE" "$DMG_PATH" && mkdir -p "$STAGE"
  ditto "$APP" "$STAGE/cashU.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -quiet -volname "cashU" -srcfolder "$STAGE" -ov -format UDZO "$DMG_PATH"
  rm -rf "$STAGE"
  if [[ $SIGNED == 1 ]]; then codesign --force --timestamp --sign "$DEVELOPER_ID_APPLICATION" "$DMG_PATH"; fi
fi

say "Done"
echo "    app:     $APP ($(du -sh "$APP" | cut -f1))"
echo "    archive: $ZIP ($(du -sh "$ZIP" | cut -f1))"
[[ $DMG == 1 ]] && echo "    dmg:     $DMG_PATH"
echo "    signed:  $([[ $SIGNED == 1 ]] && echo yes || echo 'no (ad-hoc)')"
echo "    deno:    $([[ -n "$APP_DENO" ]] && echo "$DENO_VERSION (bundled)" || echo 'NOT bundled')"
if [[ $DENO_UNPINNED == 1 ]]; then warn_deno; fi
if [[ $SPARKLE == 1 ]]; then
  echo "    updates: $FEED_URL"
  echo "    release: python3 scripts/make_appcast.py \"$ZIP\"  (signs it, writes the feed next to it)"
fi
