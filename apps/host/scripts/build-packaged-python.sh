#!/usr/bin/env bash
# Build a relocatable, pinned Python onedir sidecar for Resources/python.
# Usage: build-packaged-python.sh <Python 3.12+ executable> <built webdist> <build root> <wheelhouse>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
[[ $# == 4 ]] || { echo "usage: $0 <python> <webdist> <build-root> <wheelhouse>" >&2; exit 2; }
PYTHON="$1"
WEBDIST="$2"
BUILD="$3"
WHEELHOUSE="$4"
[[ "$BUILD" == "$ROOT"/build/* ]] || { echo "build root must be inside repo build/" >&2; exit 2; }
case "$BUILD" in
  */../*|*/..|*/./*|*/.|*//*) echo "build root has noncanonical segments" >&2; exit 2 ;;
esac
[[ -d "$ROOT/build" && ! -L "$ROOT/build" && "$(cd "$ROOT/build" && pwd -P)" == "$ROOT/build" ]] || { echo "repo build/ must be a real directory" >&2; exit 2; }
[[ -f "$WEBDIST/index.html" ]] || { echo "built webdist is missing" >&2; exit 2; }
[[ -d "$WHEELHOUSE" ]] || { echo "local wheelhouse is missing" >&2; exit 2; }

# Resolve the nearest existing ancestor before mkdir: a symlink inside build/
# must never redirect creation outside the ignored build tree.
ANCESTOR="$BUILD"
while [[ ! -e "$ANCESTOR" && ! -L "$ANCESTOR" ]]; do
  ANCESTOR="$(dirname "$ANCESTOR")"
done
[[ -d "$ANCESTOR" ]] || { echo "build root ancestor is not a directory" >&2; exit 2; }
CANONICAL_ANCESTOR="$(cd "$ANCESTOR" && pwd -P)"
[[ "$CANONICAL_ANCESTOR" == "$ROOT/build" || "$CANONICAL_ANCESTOR" == "$ROOT"/build/* ]] || { echo "build root ancestor escapes repo build/" >&2; exit 2; }
mkdir -p "$BUILD"
BUILD="$(cd "$BUILD" && pwd -P)"
[[ "$BUILD" == "$ROOT"/build/* ]] || { echo "build root resolves outside repo build/" >&2; exit 2; }
FIXTURE="$(dirname "$BUILD")"
[[ "${CASHU_TESTING:-}" == 1 ]] || { echo "CASHU_TESTING=1 required" >&2; exit 2; }
[[ -n "${CASHU_DATA_DIR:-}" && -n "${CASHU_WORKSPACES_DIR:-}" ]] || { echo "synthetic data and workspaces required" >&2; exit 2; }
for dir in "$HOME" "$CASHU_DATA_DIR" "$CASHU_WORKSPACES_DIR"; do
  [[ "$dir" == "$FIXTURE"/* ]] || { echo "HOME, data and workspaces must be inside fixture root" >&2; exit 2; }
  mkdir -p "$dir"
  [[ "$(cd "$dir" && pwd -P)" == "$dir" ]] || { echo "synthetic paths must be canonical" >&2; exit 2; }
done
cd "$ROOT"
RESOLVED="$(PYTHONPATH="$ROOT/src" "$ROOT/.venv/bin/python" -c 'from cashu.core import paths; print(paths.data_dir())')"
[[ "$RESOLVED" == "$CASHU_DATA_DIR" ]] || { echo "Python data-dir preflight failed" >&2; exit 2; }
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 12))' || { echo "Python 3.12+ required" >&2; exit 2; }

mkdir -p "$BUILD/tmp" "$BUILD/pip-cache"
export TMPDIR="$BUILD/tmp"
export PIP_CACHE_DIR="$BUILD/pip-cache"
rm -rf "$BUILD/venv"
"$PYTHON" -m venv "$BUILD/venv"
LOCK="$ROOT/apps/host/scripts/requirements-sidecar.lock"
PIP_VERSION=26.2.1
grep -q "^pip==$PIP_VERSION " "$LOCK" || { echo "Pinned pip version mismatch" >&2; exit 2; }
awk '/^[A-Za-z]/ { keep = ($1 ~ /^(pip|setuptools)==/) } keep && !/^[[:space:]]*#/' "$LOCK" > "$BUILD/bootstrap.lock"
"$BUILD/venv/bin/python" -m pip install --no-index --find-links "$WHEELHOUSE" --disable-pip-version-check --require-hashes --no-deps -r "$BUILD/bootstrap.lock"
"$BUILD/venv/bin/python" -m pip install --no-index --find-links "$WHEELHOUSE" --disable-pip-version-check --require-hashes --no-deps --no-build-isolation -r "$LOCK"
"$BUILD/venv/bin/python" -m pip install --no-index --find-links "$WHEELHOUSE" --disable-pip-version-check --no-deps --no-build-isolation "$ROOT"
"$BUILD/venv/bin/python" -m pip check

cd "$ROOT"
export PYINSTALLER_CONFIG_DIR="$BUILD/pyinstaller-cache"
export CASHU_PACKAGE_WEBDIST="$WEBDIST"
"$BUILD/venv/bin/python" -m PyInstaller --noconfirm --clean --log-level WARN \
  --distpath "$BUILD/dist" --workpath "$BUILD/work" \
  "$ROOT/apps/host/scripts/packaged-python.spec"
[[ -x "$BUILD/dist/python/cashu-python" ]] || { echo "sidecar executable missing" >&2; exit 2; }
[[ -d "$BUILD/dist/python/_internal/skills" ]] || { echo "shipped skills missing" >&2; exit 2; }
echo "$BUILD/dist/python"
