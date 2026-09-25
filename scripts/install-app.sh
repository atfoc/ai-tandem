#!/bin/bash
# Copies bin/AI Whiteboard.app (made by scripts/build-app.sh) into ~/Applications, where Spotlight
# finds it.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/bin/AI Whiteboard.app"
dest="$HOME/Applications/AI Whiteboard.app"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

[ -d "$src" ] || { echo "No $src: run scripts/build-app.sh first" >&2; exit 1; }

mkdir -p "$HOME/Applications"
rm -rf "$dest"
ditto "$src" "$dest"
"$lsregister" -f "$dest" # pick up the new icon and version
mdimport "$dest"         # index it for Spotlight now instead of eventually
echo "Installed $dest"

# A server started by an older build keeps running it until it stops. server.json exists only
# while a server runs.
if [ -f "$HOME/.ai-whiteboard/server.json" ]; then
  echo "A server is running from the previous build. To restart on this one:"
  echo "  \"$dest/Contents/MacOS/ai-whiteboard\" stop   (then launch AI Whiteboard again)"
fi
