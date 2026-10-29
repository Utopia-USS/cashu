#!/usr/bin/env bash
# Fetch Sparkle (auto-update of cashU.app) into a folder: the release archive pinned by sha256, unpacked to
# <dir>/Sparkle.framework and <dir>/bin (generate_keys, sign_update, ...). Kept between runs: a second call
# with the same version does nothing. Used by build_macos.sh and release_macos.sh.
#
#   scripts/fetch_sparkle.sh <dir>
set -euo pipefail

SPARKLE_VERSION="2.10.0"
SPARKLE_SHA256="c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c"

DIR="${1:?usage: fetch_sparkle.sh <dir>}"
mkdir -p "$DIR"
if [[ "$(cat "$DIR/VERSION" 2>/dev/null)" == "$SPARKLE_VERSION" && -d "$DIR/Sparkle.framework" && -x "$DIR/bin/sign_update" ]]; then
  exit 0
fi
TAR="$DIR/Sparkle-$SPARKLE_VERSION.tar.xz"
if [[ ! -f "$TAR" ]]; then
  curl -fsSL -o "$TAR.part" \
    "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz"
  mv "$TAR.part" "$TAR"
fi
echo "$SPARKLE_SHA256  $TAR" | shasum -a 256 -c --quiet - \
  || { rm -f "$TAR"; echo "error: Sparkle archive checksum mismatch" >&2; exit 1; }
rm -rf "$DIR/x" "$DIR/bin" "$DIR/Sparkle.framework" && mkdir -p "$DIR/x"
tar -xJf "$TAR" -C "$DIR/x"
mv "$DIR/x/bin" "$DIR/bin"
mv "$DIR/x/Sparkle.framework" "$DIR/Sparkle.framework"
rm -rf "$DIR/x"
echo "$SPARKLE_VERSION" > "$DIR/VERSION"
