#!/bin/bash
# Builds the server folder for one target, for a machine that runs AI Whiteboard as a remote
# server (docs/remote-servers.md, "Use a server on another machine"):
#   scripts/build-server.sh [<os>/<arch>]      default: this machine's
# The targets are darwin/arm64, darwin/amd64, linux/amd64, linux/arm64, windows/amd64 and windows/arm64; the server compiles
# for each on any of them, without cgo. It makes bin/ai-whiteboard-server-<os>-<arch>/:
#   ai-whiteboard      the Go server binary (ai-whiteboard.exe for windows)
#   setup-remote.sh    sets remote access up and prints address, fingerprint and secret
#   start-server.sh    starts the server in the background
#   README.md          how to install and run it (scripts/remote/README.md)
#   headless/          the headless writer for the target (packages/headless): headless.mjs, manifest.json and
#                      engine/ with the native canvas for the target; the server finds it next to its binary and
#                      runs it with Node 22 or later, so boards can be edited with no window open
# The server serves no page, so the folder holds none and its making needs no build of the web
# client. One version is stamped into the Go binary and into headless/manifest.json, as scripts/build-app.sh does: the
# environment variable AIWB_VERSION when it is set and not empty, else `git describe --tags --always --dirty`, else `dev`. The headless writer's native canvas is fetched from its npm package
# for the target (packages/board-engine); a target whose binary can't be had fails the script.
# The binary is the same on every host (-trimpath -buildvcs=false: no path of the host's Go or checkout, no version-control state).
# There is no installer and no service file: copy the folder.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-$(go env GOHOSTOS)/$(go env GOHOSTARCH)}"
case "$target" in
  darwin/arm64 | darwin/amd64 | linux/amd64 | linux/arm64 | windows/amd64 | windows/arm64) ;;
  *)
    echo "usage: scripts/build-server.sh [darwin/arm64 | darwin/amd64 | linux/amd64 | linux/arm64 | windows/amd64 | windows/arm64]" >&2
    exit 2
    ;;
esac
os="${target%/*}"
arch="${target#*/}"
out="$root/bin/ai-whiteboard-server-$os-$arch"
version="${AIWB_VERSION:-}"
[ -n "$version" ] || version="$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo dev)"

rm -rf "$out"
mkdir -p "$out"

[ -d "$root/node_modules" ] || (cd "$root" && npm ci)
case "$arch" in amd64) jsarch=x64 ;; *) jsarch="$arch" ;; esac
jsos="$os" # (Node's name of windows is win32)
exe=ai-whiteboard
if [ "$os" = windows ]; then jsos=win32; exe=ai-whiteboard.exe; fi
echo "==> headless writer for $jsos/$jsarch ($version)"
node "$root/packages/headless/build.mjs" --os "$jsos" --arch "$jsarch" --version "$version" --out "$out/headless" ||
  { echo "the headless writer's build for $jsos/$jsarch failed (see above)" >&2; rm -rf "$out"; exit 1; }
for f in headless.mjs manifest.json engine/engine.mjs engine/node_modules/skia-canvas/lib/skia.node; do
  [ -f "$out/headless/$f" ] || { echo "the headless build has no $f; the board engine is not built or not complete" >&2; rm -rf "$out"; exit 1; }
done

echo "==> server for $os/$arch ($version)"
CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -C "$root" -trimpath -buildvcs=false \
  -ldflags "-X ai-whiteboard/internal/version.Version=$version" \
  -o "$out/$exe" ./cmd/ai-whiteboard

cp "$root/scripts/remote/setup-remote.sh" "$root/scripts/remote/start-server.sh" \
  "$root/scripts/remote/README.md" "$out/"
chmod 755 "$out/$exe" "$out/setup-remote.sh" "$out/start-server.sh"

echo "Built $out"
