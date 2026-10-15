#!/usr/bin/env bash
# The board-in-a-web-view spike, end to end: builds the board bundle, builds and installs the app on the iPad simulator,
# launches it, exercises the bridge, takes memory and timing readings, draws with touches through Maestro, and prints it.
#   ./run.sh [--no-build] [--no-touch] [--no-auto] [--runs N]
# Needs: Xcode with the simulator below, Node, CocoaPods, and for the touch check Maestro (fetched to /tmp/aiwb-tools if missing).
# Only the simulator named below is used (AIWB_SIM_UDID overrides the lookup by name). Results land in ./out (not committed).
set -euo pipefail
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
export NODE_OPTIONS="--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"
cd "$(dirname "$0")"
NAME="iPad Pro 11-inch (M5)"
UDID="${AIWB_SIM_UDID:-$(xcrun simctl list devices available | grep -F "$NAME (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')}"
[ -n "$UDID" ] || { echo "no simulator named $NAME"; exit 2; }
BUILD=1; PASS=()
for a in "$@"; do case "$a" in --no-build) BUILD=0;; *) PASS+=("$a");; esac; done
echo "simulator: $NAME $UDID"

echo "== bridge unit tests"
node --test --experimental-strip-types bridge/protocol.test.ts 2>&1 | grep -E '^(# |ℹ) (tests|pass|fail)|✖' || true

if [ "$BUILD" = 1 ]; then
  echo "== board bundle"
  [ -d webview/node_modules ] || (cd webview && npm install --no-audit --no-fund)
  (cd webview && node build.mjs)
  echo "== typecheck"
  [ -d node_modules ] || npm install --no-audit --no-fund
  npx tsc --noEmit
  echo "== app (expo run:ios, Release: the JS and the board page are inside the app, no Metro)"
  xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID"
  CI=1 npx expo run:ios --device "$UDID" --configuration Release --no-bundler > out-build.log 2>&1 || { tail -30 out-build.log; exit 1; }
  rm -f out-build.log
else
  xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID"
fi

echo "== bundle size"
stat -f%z assets/board.html | awk '{printf "board.html %d bytes\n", $1}'
gzip -9 -c assets/board.html | wc -c | awk '{printf "gzip -9 %d bytes\n", $1}'
APP="$(xcrun simctl get_app_container "$UDID" dev.aiwb.spike.boardwebview app)"
du -sk "$APP" | awk '{printf "installed app (simulator build, Release) %d KB\n", $1}'

node scripts/run-checks.mjs "$UDID" "$PWD/out" "${PASS[@]+"${PASS[@]}"}"
