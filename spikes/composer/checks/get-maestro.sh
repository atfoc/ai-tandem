#!/bin/sh
# Puts Maestro (the UI test tool of checks/ios.mjs) and a JRE for it in .tools/ of the spike, nothing system-wide.
# Maestro's download is checked against the release's sha256 list; the JRE comes from Adoptium over https.
set -eu
cd "$(dirname "$0")/.."
MAESTRO_VERSION=cli-2.11.0
[ -d .tools/maestro ] && [ -d .tools/jdk ] && exit 0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p .tools
base="https://github.com/mobile-dev-inc/Maestro/releases/download/$MAESTRO_VERSION"
curl -fsSL "$base/maestro.zip" -o "$tmp/maestro.zip"
want=$(curl -fsSL "$base/checksums_sha256.txt" | awk '/maestro.zip/ {print $1}')
[ "$(shasum -a 256 "$tmp/maestro.zip" | awk '{print $1}')" = "$want" ] || { echo "maestro.zip: checksum differs" >&2; exit 1; }
curl -fsSL "https://api.adoptium.net/v3/binary/latest/17/ga/mac/aarch64/jre/hotspot/normal/eclipse" -o "$tmp/jre.tar.gz"
mkdir -p "$tmp/m" .tools/jdk
unzip -q "$tmp/maestro.zip" -d "$tmp/m"
tar -xzf "$tmp/jre.tar.gz" -C .tools/jdk
rm -rf .tools/maestro
mv "$tmp/m" .tools/maestro
echo ".tools ready"
