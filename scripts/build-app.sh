#!/bin/bash
# Builds bin/AI Whiteboard.app with electron-builder (desktop/electron-builder.yml):
#   Contents/MacOS/AI Whiteboard     Electron, the app window (the bundle's executable)
#   Contents/MacOS/ai-whiteboard     the Go server binary, which the app runs to start or find
#                                    this computer's server
#   Contents/Resources/app.asar      Electron main process, preload and the connection module
#   Contents/Resources/web/          the built web client: the app's page, loaded from this folder
#   Contents/Resources/remote/setup-remote.sh
#                                    sets the app's server up as a remote server (run through sh)
#   Contents/Resources/AppIcon.icns
# One version (git describe) is stamped into the Go binary, the web client and CFBundleVersion;
# the page and the app are one build.
# Install it into ~/Applications with scripts/install-app.sh.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/bin/AI Whiteboard.app"
version="$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo dev)"

echo "==> web client ($version)"
cd "$root/web"
[ -d node_modules ] || npm ci
AIWB_VERSION="$version" node build.mjs

echo "==> server ($version)"
go build -C "$root" -ldflags "-X ai-whiteboard/internal/version.Version=$version" \
  -o "$root/desktop/build/ai-whiteboard" ./cmd/ai-whiteboard

echo "==> app"
cd "$root/desktop"
[ -d node_modules ] || npm ci
rm -rf dist
npx electron-builder --mac --dir -c.buildVersion="$version"

built=(dist/mac*/"AI Whiteboard.app")
[ -d "${built[0]}" ] || { echo "electron-builder produced no AI Whiteboard.app" >&2; exit 1; }
rm -rf "$app"
mkdir -p "$root/bin"
ditto "${built[0]}" "$app"

echo "Built $app"
