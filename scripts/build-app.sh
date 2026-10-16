#!/bin/bash
# Builds bin/AI Whiteboard.app with electron-builder (desktop/electron-builder.yml):
#   Contents/MacOS/AI Whiteboard     Electron, the app window (the bundle's executable)
#   Contents/MacOS/ai-whiteboard     the Go server binary, which the app runs to start or find
#                                    this computer's server
#   Contents/Resources/app.asar      Electron main process, preload and the connection module
#   Contents/Resources/web/          the app's web build (app/dist-web, AD-40): the app's page, loaded from this folder
#   Contents/Resources/remote/setup-remote.sh
#                                    sets the app's server up as a remote server (run through sh)
#   Contents/Resources/headless/     the headless writer (packages/headless): headless.mjs, manifest.json and
#                                    engine/ (the board engine, its fonts and the native canvas,
#                                    node_modules/skia-canvas/lib/skia.node); the server finds it next to
#                                    its own binary (internal/headless/find.go) and runs it with the app's
#                                    Electron as Node. Outside app.asar: a native module can't load from it
#   Contents/Resources/AppIcon.icns
# One version (git describe) is stamped into the Go binary, the web build, CFBundleVersion and the
# headless writer's manifest.json; the page, the server and its headless writer are one build.
# Install it into ~/Applications with scripts/install-app.sh.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/bin/AI Whiteboard.app"
version="$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo dev)"

echo "==> web build ($version)"
[ -d "$root/node_modules" ] || (cd "$root" && npm ci)
cd "$root/app"
EXPO_PUBLIC_AIWB_VERSION="$version" npm run build:web

echo "==> server ($version)"
go build -C "$root" -ldflags "-X ai-whiteboard/internal/version.Version=$version" \
  -o "$root/desktop/build/ai-whiteboard" ./cmd/ai-whiteboard

echo "==> headless writer ($version)"
# (this machine's target: the app is built for it; another target fails in build.mjs, which says so)
hdir="$root/desktop/build/headless"
rm -rf "$hdir"
node "$root/packages/headless/build.mjs" --os darwin --arch "$(node -p process.arch)" --version "$version" --out "$hdir" ||
  { echo "the headless writer's build failed (see above); the app is not built without it" >&2; exit 1; }
for f in headless.mjs manifest.json engine/engine.mjs engine/node_modules/skia-canvas/lib/skia.node; do
  [ -f "$hdir/$f" ] || { echo "the headless build has no $f; the board engine is not built or not complete" >&2; exit 1; }
done

echo "==> app"
cd "$root/desktop"
[ -e node_modules/@aiwb/conn ] || npm ci # also when node_modules is older than the dependency on @aiwb/conn
rm -rf dist
npx electron-builder --mac --dir -c.buildVersion="$version"

built=(dist/mac*/"AI Whiteboard.app")
[ -d "${built[0]}" ] || { echo "electron-builder produced no AI Whiteboard.app" >&2; exit 1; }
inapp="${built[0]}/Contents/Resources/headless"
for f in headless.mjs manifest.json engine/engine.mjs; do
  cmp -s "$hdir/$f" "$inapp/$f" ||
    { echo "electron-builder did not put headless/$f into the app intact" >&2; exit 1; }
done
# (the native canvas is the one file that differs: electron-builder signs it with the app's identity, which rewrites it)
skia="$inapp/engine/node_modules/skia-canvas/lib/skia.node"
[ -f "$skia" ] && codesign --verify --strict "$skia" ||
  { echo "headless/engine/node_modules/skia-canvas/lib/skia.node is missing from the app or not signed" >&2; exit 1; }
# (the server runs the headless writer with this Electron as Node, ELECTRON_RUN_AS_NODE=1, which only works with the RunAsNode fuse on)
node "$root/scripts/check-run-as-node.mjs" "${built[0]}" || exit 1
codesign --verify --deep --strict "${built[0]}" || { echo "the built app's signature is not valid" >&2; exit 1; }
rm -rf "$app"
mkdir -p "$root/bin"
ditto "${built[0]}" "$app"

echo "Built $app"
