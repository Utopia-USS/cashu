#!/usr/bin/env bash
# S41 measurements on an Android emulator or device (synthetic demo data only; nothing leaves the machine).
#   usage: scripts/measure-android-emu.sh <path/to/app-release.apk> [cold runs, default 10]
# Needs adb on PATH ($ANDROID_HOME/platform-tools) and one device attached. Build the APK first:
#   cd apps/mobile && npx expo prebuild -p android --no-install
#   (cd android && JAVA_HOME=<JDK 17+> ./gradlew :app:assembleRelease)   # add -PreactNativeArchitectures=arm64-v8a for one ABI
#   apk: android/app/build/outputs/apk/release/app-release.apk
# Same steps as measure-ios-sim.sh; times use the device clock (`date` on the device) against the app's
# Date.now(), results come from logcat (`S41BENCH` lines; a release build cannot be read with run-as).
set -euo pipefail
APK=${1:?path to the apk}
RUNS=${2:-10}
PKG=dev.cashu.mobile
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-$HERE/../bench}
mkdir -p "$OUT"
dnow() { adb shell date +%s%3N | tr -d '\r'; }

adb uninstall "$PKG" >/dev/null 2>&1 || true
adb install -r "$APK" >/dev/null
adb logcat -c
launches="$OUT/launches-android.jsonl"
: > "$launches"
: > "$OUT/am-start.txt"
echo "first launch (fixture load)"
echo "{\"kind\":\"launch\",\"first\":true,\"at\":$(dnow)}" >> "$launches"
adb shell am start -W -n "$PKG/.MainActivity" | grep -E "TotalTime" || true
# wait until the fixture is loaded and the first data frame logged (a slow emulator can take minutes)
for _ in $(seq 1 120); do adb logcat -d -s ReactNativeJS:V | grep -q 'S41BENCH.*"startup"' && break; sleep 3; done
sleep 3
for i in $(seq 1 "$RUNS"); do
  echo "cold launch $i/$RUNS"
  adb shell am force-stop "$PKG"
  sleep 2
  echo "{\"kind\":\"launch\",\"at\":$(dnow)}" >> "$launches"
  before=$(adb logcat -d -s ReactNativeJS:V | grep -c 'S41BENCH.*"startup"' || true)
  adb shell am start -W -n "$PKG/.MainActivity" | grep -E "TotalTime" | tee -a "$OUT/am-start.txt" || true
  for _ in $(seq 1 60); do
    [ "$(adb logcat -d -s ReactNativeJS:V | grep -c 'S41BENCH.*"startup"' || true)" -gt "$before" ] && break
    sleep 1
  done
  sleep 2
done
echo "list benchmark (about 55 s)"
adb shell "am start -a android.intent.action.VIEW -d 'cashu://bench?autorun=1' $PKG" >/dev/null
for _ in $(seq 1 120); do adb logcat -d -s ReactNativeJS:V | grep -q "S41BENCH.*\"mount\"" && break; sleep 2; done
adb exec-out screencap -p > "$OUT/bench-android.png"
adb logcat -d -s ReactNativeJS:V | sed -n 's/.*S41BENCH //p' > "$OUT/results-android.jsonl"
node "$HERE/summarize-bench.mjs" "$launches" "$OUT/results-android.jsonl"
echo "am start -W TotalTime (launch -> first native frame, ms):"
sed -n 's/.*TotalTime: //p' "$OUT/am-start.txt" | sort -n | tr '\n' ' '; echo
