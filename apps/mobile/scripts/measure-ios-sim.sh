#!/usr/bin/env bash
# S41 measurements on an iOS simulator (synthetic demo data only; nothing leaves the machine).
#   usage: scripts/measure-ios-sim.sh <path/to/cashU.app> [simulator udid, default: booted] [cold runs, default 10]
# Build the app first in Release (embedded Hermes bundle, no Metro):
#   cd apps/mobile && LANG=en_US.UTF-8 npx expo prebuild -p ios --no-install && (cd ios && pod install)
#   xcodebuild -workspace ios/cashU.xcworkspace -scheme cashU -configuration Release -sdk iphonesimulator \
#     -destination 'id=<udid>' -derivedDataPath ios/build/dd build
#   app: ios/build/dd/Build/Products/Release-iphonesimulator/cashU.app
# Steps: clean install -> first launch (loads the demo log: apply + rebuild timings) -> N cold launches
# (terminate, launch, first data frame) -> the S50 list benchmark (cashu://bench?autorun=1) -> summary.
set -euo pipefail
APP_PATH=${1:?path to cashU.app}
DEV=${2:-booted}
RUNS=${3:-10}
BUNDLE=dev.cashu.mobile
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-$HERE/../bench}
mkdir -p "$OUT"
now() { node -e 'console.log(Date.now())'; }

xcrun simctl terminate "$DEV" "$BUNDLE" 2>/dev/null || true
xcrun simctl uninstall "$DEV" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$DEV" "$APP_PATH"
LOG="$(xcrun simctl get_app_container "$DEV" "$BUNDLE" data)/Documents/bench/results.jsonl"
launches="$OUT/launches.jsonl"
: > "$launches"

echo "first launch (fixture load)"
echo "{\"kind\":\"launch\",\"first\":true,\"at\":$(now)}" >> "$launches"
xcrun simctl launch "$DEV" "$BUNDLE" >/dev/null
sleep 15
for i in $(seq 1 "$RUNS"); do
  echo "cold launch $i/$RUNS"
  xcrun simctl terminate "$DEV" "$BUNDLE" 2>/dev/null || true
  sleep 2
  echo "{\"kind\":\"launch\",\"at\":$(now)}" >> "$launches"
  xcrun simctl launch "$DEV" "$BUNDLE" >/dev/null
  sleep 6
done
echo "list benchmark (about 55 s)"
xcrun simctl openurl "$DEV" "cashu://bench?autorun=1"
sleep 58
xcrun simctl io "$DEV" screenshot "$OUT/bench.png" >/dev/null
cp "$LOG" "$OUT/results.jsonl"
node "$HERE/summarize-bench.mjs" "$launches" "$OUT/results.jsonl"
