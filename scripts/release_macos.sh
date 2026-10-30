#!/usr/bin/env bash
# Release cashU.app from this Mac (packaging/RELEASING.md): build origin/main in a temporary worktree, sign
# with Developer ID, notarize, sign the update with the Sparkle key, publish the GitHub release that every
# installed app reads its update feed from.
#
#   scripts/release_macos.sh --check        preflight only (keys, tools, GitHub, the commits to ship)
#   scripts/release_macos.sh --no-publish   + build, sign, notarize, feed; nothing leaves this Mac
#   scripts/release_macos.sh --yes          + publish (the owner has reviewed the commits)
#
# Configuration: packaging/release.local.env (git-ignored; copy packaging/release.env.example). It holds
# names and the PUBLIC update key only. Every secret stays in the login keychain: the Developer ID identity,
# the notarytool profile, the Sparkle private key (generate_keys). Nothing secret is read from or written
# to a file by this script, and the private update key is never exported.
#
# Without a Developer ID yet (DEVELOPER_ID_APPLICATION empty) the release is ad-hoc signed and not notarized:
# updates still need the Sparkle key, but every Mac lets the first install through by hand ("Open Anyway").
# Moving to a Developer ID later is one ordinary release (RELEASING.md, "Ad-hoc until the Developer ID").
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/packaging/release.local.env"
MODE=""
for arg in "$@"; do
  case "$arg" in
    --check|--no-publish|--yes) MODE="$arg" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
[[ -n "$MODE" ]] || { sed -n '2,14p' "$0"; exit 2; }

say() { printf '\n==> %s\n' "$*"; }
ok() { printf '    ok  %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- Configuration (names and the public key only) ---------------------------------------------------
[[ "$(uname -s)" == "Darwin" ]] || die "releases are built on macOS."
[[ -f "$CONFIG" ]] || die "no $CONFIG: copy packaging/release.env.example and fill it in (RELEASING.md, step 4)."
git -C "$ROOT" check-ignore -q "$CONFIG" || die "$CONFIG is not git-ignored: refusing to read it."
# shellcheck disable=SC1090
source "$CONFIG"
: "${SPARKLE_PUBLIC_ED_KEY:?set in $CONFIG}"
DEVELOPER_ID_APPLICATION="${DEVELOPER_ID_APPLICATION:-}"
NOTARY_KEYCHAIN_PROFILE="${NOTARY_KEYCHAIN_PROFILE:-}"
SIGNED=0
[[ -n "$DEVELOPER_ID_APPLICATION" ]] && SIGNED=1
[[ $SIGNED == 1 && -z "$NOTARY_KEYCHAIN_PROFILE" ]] && die "a Developer ID release is notarized: set NOTARY_KEYCHAIN_PROFILE too."
[[ $SIGNED == 0 && -n "$NOTARY_KEYCHAIN_PROFILE" ]] && die "notarization needs a Developer ID: set DEVELOPER_ID_APPLICATION too."
REPO="${CASHU_UPDATE_REPO:-Utopia-USS/cashu}"
BUILD="${CASHU_RELEASE_DIR:-$ROOT/build/release}"
ARCH="$(uname -m)"
for tool in git gh xcrun codesign security python3; do command -v "$tool" >/dev/null || die "$tool not found."; done

# --- Preflight ---------------------------------------------------------------------------------------
say "Preflight"
gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)."
[[ "$(gh api "repos/$REPO" --jq .permissions.admin)" == "true" ]] \
  || die "your GitHub account is not an admin of $REPO: only admins may create release tags."
ok "GitHub: admin of $REPO"
if [[ $SIGNED == 1 ]]; then
  security find-identity -v -p codesigning | grep -qF "\"$DEVELOPER_ID_APPLICATION\"" \
    || die "no signing identity \"$DEVELOPER_ID_APPLICATION\" in the keychain (RELEASING.md, step 1)."
  ok "Developer ID: $DEVELOPER_ID_APPLICATION"
  xcrun notarytool history --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" >/dev/null 2>&1 \
    || die "notarytool profile \"$NOTARY_KEYCHAIN_PROFILE\" does not work (RELEASING.md, step 2)."
  ok "Notarization profile: $NOTARY_KEYCHAIN_PROFILE"
else
  ok "Signing: ad-hoc, not notarized (no Developer ID yet: the first install on a Mac needs \"Open Anyway\")"
fi
"$ROOT/scripts/fetch_sparkle.sh" "$BUILD/sparkle" || die "could not fetch Sparkle."
# Without a key it prints an error to stdout and exits 1: only a successful run is a key.
KEYCHAIN_PUBLIC="$("$BUILD/sparkle/bin/generate_keys" -p 2>/dev/null)" || KEYCHAIN_PUBLIC=""
[[ -n "$KEYCHAIN_PUBLIC" ]] || die "no Sparkle update key in the keychain (RELEASING.md, step 3)."
[[ "$KEYCHAIN_PUBLIC" == "$SPARKLE_PUBLIC_ED_KEY" ]] \
  || die "the Sparkle key in the keychain does not match SPARKLE_PUBLIC_ED_KEY in $CONFIG."
ok "Sparkle update key: in the keychain, matches the config"

git -C "$ROOT" fetch --quiet --tags origin
COMMIT="$(git -C "$ROOT" rev-parse origin/main)"
VERSION="$(git -C "$ROOT" show "$COMMIT:pyproject.toml" | python3 -c 'import sys, tomllib; print(tomllib.loads(sys.stdin.read())["project"]["version"])')"
TAG="v$VERSION"
git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG exists already: nothing new to release."
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && die "release $TAG exists already."
PREVIOUS="$(git -C "$ROOT" describe --tags --abbrev=0 --match 'v*' "$COMMIT" 2>/dev/null || true)"
ok "Release $TAG from origin/main ${COMMIT:0:12}${PREVIOUS:+ (previous: $PREVIOUS)}"
# The commits since the previous release (the last 15 for the first one), without the version bumps.
if [[ -n "$PREVIOUS" ]]; then RANGE=("$PREVIOUS..$COMMIT"); else RANGE=(-15 "$COMMIT"); fi
changes() { git -C "$ROOT" log --no-merges --invert-grep --grep='^Bump version to ' --format="$1" "${RANGE[@]}"; }

say "What ships in $TAG"
[[ -n "$PREVIOUS" ]] || echo "    (first release: the last 15 commits up to ${COMMIT:0:12})"
changes '    %h %an: %s'
[[ -z "$PREVIOUS" ]] || git -C "$ROOT" diff --shortstat "$PREVIOUS" "$COMMIT" | sed 's/^/   /'
[[ "$MODE" == "--check" ]] && { say "Preflight passed (nothing built)."; exit 0; }

# --- Build exactly origin/main in a temporary worktree ------------------------------------------------
SRC="$BUILD/src-$TAG"
cleanup() { git -C "$ROOT" worktree remove --force "$SRC" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
git -C "$ROOT" worktree add --quiet --detach "$SRC" "$COMMIT"
say "Building $TAG ($([[ $SIGNED == 1 ]] && echo "Developer ID, notarized" || echo "ad-hoc"), with the update feed)"
(
  cd "$SRC"
  DEVELOPER_ID_APPLICATION="$DEVELOPER_ID_APPLICATION" NOTARY_KEYCHAIN_PROFILE="$NOTARY_KEYCHAIN_PROFILE" \
    SPARKLE_PUBLIC_ED_KEY="$SPARKLE_PUBLIC_ED_KEY" CASHU_UPDATE_REPO="$REPO" CASHU_BUILD_DIR="$BUILD/macos" \
    scripts/build_macos.sh --clean --dmg
)
APP="$BUILD/macos/dist/cashU.app"
ZIP="$BUILD/macos/cashU-$VERSION-macos-$ARCH.zip"
DMG="$BUILD/macos/cashU-$VERSION-macos-$ARCH.dmg"
FEED="$BUILD/macos/appcast-macos-$ARCH.xml"

say "Verifying the build"
codesign --verify --deep --strict "$APP" && ok "code signature"
[[ -d "$APP/Contents/Frameworks/Sparkle.framework" ]] && ok "Sparkle.framework bundled"
if [[ $SIGNED == 1 ]]; then
  xcrun stapler validate "$APP" >/dev/null && ok "notarization ticket stapled"
  spctl --assess --type execute "$APP" && ok "Gatekeeper accepts it"
  TEAM="$(codesign -dv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  SPARKLE_TEAM="$(codesign -dv "$APP/Contents/Frameworks/Sparkle.framework" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  [[ -n "$TEAM" && "$TEAM" == "$SPARKLE_TEAM" ]] || die "Sparkle.framework is not signed by team $TEAM."
  ok "Sparkle signed by the same team ($TEAM)"
fi

say "Signing the update (Sparkle key from the keychain)"
# The build venv has cryptography (a cashU dependency), which the signature check needs.
"$BUILD/macos/venv/bin/python" "$SRC/scripts/make_appcast.py" "$ZIP" --app "$APP" --sign-update "$BUILD/sparkle/bin/sign_update" \
  --repo "$REPO" --out "$FEED"
shasum -a 256 "$ZIP" "$DMG" | sed 's/^/    /'

if [[ "$MODE" == "--no-publish" ]]; then
  say "Built, not published"
  echo "    $DMG"
  echo "    $ZIP"
  echo "    $FEED"
  exit 0
fi

# --- Publish: a draft first, checked, then published (immutable from then on) --------------------------
say "Publishing $TAG"
NOTES="$(changes '- %s')"
gh release create "$TAG" --repo "$REPO" --draft --target "$COMMIT" --title "cashU $VERSION" \
  --notes "$NOTES" "$ZIP" "$DMG" "$FEED"
ASSETS="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '[.assets[].name] | sort | join(" ")')"
EXPECTED="$(printf '%s\n' "$(basename "$FEED")" "$(basename "$ZIP")" "$(basename "$DMG")" | sort | tr '\n' ' ' | sed 's/ $//')"
[[ "$ASSETS" == "$EXPECTED" ]] || die "the draft has [$ASSETS], expected [$EXPECTED]: fix or delete the draft."
gh release edit "$TAG" --repo "$REPO" --draft=false --latest
ok "published: https://github.com/$REPO/releases/tag/$TAG"
echo "    Installed apps find it at their next daily check, or at once with \"Sprawdź aktualizacje…\"."
