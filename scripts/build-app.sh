#!/bin/bash
# Builds bin/AI Whiteboard.app: the Go binary, the built web client (Contents/Resources/web) and
# the icon. Install it into ~/Applications with scripts/install-app.sh.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/bin/AI Whiteboard.app"
version="$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo dev)"

echo "==> web client"
cd "$root/web"
[ -d node_modules ] || npm ci
node build.mjs

echo "==> bundle ($version)"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
go build -C "$root" -ldflags "-X ai-whiteboard/internal/version.Version=$version" \
  -o "$app/Contents/MacOS/ai-whiteboard" ./cmd/ai-whiteboard
cp -R "$root/web/dist" "$app/Contents/Resources/web"
cp "$root/assets/icon/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"

# LSUIElement: no Dock icon. The program only launches the server and opens the browser, then exits.
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>               <string>AI Whiteboard</string>
  <key>CFBundleDisplayName</key>        <string>AI Whiteboard</string>
  <key>CFBundleIdentifier</key>         <string>local.ai-whiteboard</string>
  <key>CFBundleExecutable</key>         <string>ai-whiteboard</string>
  <key>CFBundleIconFile</key>           <string>AppIcon</string>
  <key>CFBundlePackageType</key>        <string>APPL</string>
  <key>CFBundleShortVersionString</key> <string>0.1.0</string>
  <key>CFBundleVersion</key>            <string>$version</string>
  <key>LSMinimumSystemVersion</key>     <string>13.0</string>
  <key>LSUIElement</key>                <true/>
  <key>NSHighResolutionCapable</key>    <true/>
</dict>
</plist>
PLIST
plutil -lint -s "$app/Contents/Info.plist"

codesign --force --sign - "$app" # ad-hoc: enough to run on this Mac

echo "Built $app"
