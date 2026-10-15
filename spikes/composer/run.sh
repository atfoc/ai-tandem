#!/bin/sh
# The composer spike's checks, all of them: unit tests of the document logic, the type check, the web build in headless
# Chromium (Playwright), the iOS simulator through Maestro. Each prints PASS/FAIL lines; the exit status is 0 only if
# every one passed.
#
#   ./run.sh                   everything
#   SKIP_IOS=1 ./run.sh        no simulator (the web build and the unit tests only)
#   REBUILD=1 ./run.sh         build the development build again (`expo run:ios`), also when it is installed
#   SIM=<udid> ./run.sh        another simulator than the iPhone 16e of the machine this was written on
set -eu
cd "$(dirname "$0")"
export LANG=en_US.UTF-8 NODE_NO_WARNINGS=1 CI=1
SIM=${SIM:-568782F7-8947-4040-A2B4-9375249806FB}
BUNDLE=dev.aiwhiteboard.spike.composer
status=0

[ -d node_modules ] || npm install
[ -d node_modules/playwright ] || npm install --no-save playwright
npx playwright install chromium >/dev/null

echo "== unit tests (node:test, the document logic and the message against refs.ts)"
node --test test/*.test.ts 2>&1 | grep -E '^(✔|✖|ℹ (tests|pass|fail))' || status=1
[ "$(node --test test/*.test.ts 2>&1 | grep -c '^✖')" = 0 ] || status=1

echo "== type check"
npx tsc -p . 2>&1 | grep -v "node:" && status=1 || true

echo "== web (react-native-web build, headless Chromium)"
npx expo export --platform web >/dev/null
node checks/web.mjs || status=1

if [ -z "${SKIP_IOS:-}" ]; then
  echo "== iOS simulator ($SIM)"
  sh checks/get-maestro.sh
  if [ -n "${REBUILD:-}" ] || ! xcrun simctl get_app_container "$SIM" "$BUNDLE" >/dev/null 2>&1; then
    xcrun simctl boot "$SIM" 2>/dev/null || true
    npx expo run:ios -d "$SIM" --no-bundler
  fi
  node checks/ios.mjs || status=1
fi
[ $status = 0 ] && echo "ALL PASSED" || echo "SOME FAILED"
exit $status
