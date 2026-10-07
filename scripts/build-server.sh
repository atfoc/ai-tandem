#!/bin/bash
# Builds the server folder for one target, for a machine that runs AI Whiteboard as a remote
# server (README.md, "Use a server on another machine"):
#   scripts/build-server.sh [<os>/<arch>]      default: this machine's
# The targets are darwin/arm64, darwin/amd64, linux/amd64 and linux/arm64; the server compiles
# for each on any of them, without cgo. It makes bin/ai-whiteboard-server-<os>-<arch>/:
#   ai-whiteboard      the Go server binary
#   web/               the built web client, served by the Go server
#   setup-remote.sh    sets remote access up and prints address, fingerprint and secret
#   start-server.sh    starts the server in the background with web/
#   README.md          how to install and run it (scripts/remote/README.md)
# One version (git describe) is stamped into the Go binary and the web client, as
# scripts/build-app.sh does. There is no installer and no service file: copy the folder.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-$(go env GOHOSTOS)/$(go env GOHOSTARCH)}"
case "$target" in
  darwin/arm64 | darwin/amd64 | linux/amd64 | linux/arm64) ;;
  *)
    echo "usage: scripts/build-server.sh [darwin/arm64 | darwin/amd64 | linux/amd64 | linux/arm64]" >&2
    exit 2
    ;;
esac
os="${target%/*}"
arch="${target#*/}"
out="$root/bin/ai-whiteboard-server-$os-$arch"
version="$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo dev)"

echo "==> web client ($version)"
cd "$root/web"
[ -d node_modules ] || npm ci
AIWB_VERSION="$version" node build.mjs

echo "==> server for $os/$arch ($version)"
rm -rf "$out"
mkdir -p "$out"
CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -C "$root" \
  -ldflags "-X ai-whiteboard/internal/version.Version=$version" \
  -o "$out/ai-whiteboard" ./cmd/ai-whiteboard

cp -R "$root/web/dist" "$out/web"
cp "$root/scripts/remote/setup-remote.sh" "$root/scripts/remote/start-server.sh" \
  "$root/scripts/remote/README.md" "$out/"
chmod 755 "$out/ai-whiteboard" "$out/setup-remote.sh" "$out/start-server.sh"

echo "Built $out"
