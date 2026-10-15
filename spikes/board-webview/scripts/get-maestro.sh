#!/usr/bin/env bash
# Puts Maestro and a JDK 17 (it needs one) in $AIWB_TOOLS (default /tmp/aiwb-tools), unless `maestro` is already usable.
# Prints the directory to add to PATH and JAVA_HOME on its last line: "<bin dir>:<java home>".
set -euo pipefail
if command -v maestro >/dev/null 2>&1 && command -v java >/dev/null 2>&1 && java -version >/dev/null 2>&1; then
  echo "$(dirname "$(command -v maestro)"):${JAVA_HOME:-}"; exit 0
fi
T="${AIWB_TOOLS:-/tmp/aiwb-tools}"
mkdir -p "$T/maestro-zip" "$T/maestro" "$T/jdk-tar" "$T/jdk"
if [ ! -x "$T/maestro/maestro/bin/maestro" ]; then
  curl -fsSL -o "$T/maestro-zip/maestro.zip" https://github.com/mobile-dev-inc/maestro/releases/latest/download/maestro.zip >&2
  unzip -q -o "$T/maestro-zip/maestro.zip" -d "$T/maestro" >&2
fi
JH="$(ls -d "$T"/jdk/jdk-17*/Contents/Home 2>/dev/null | head -1 || true)"
if [ -z "$JH" ]; then
  curl -fsSL -o "$T/jdk-tar/jdk.tar.gz" "https://api.adoptium.net/v3/binary/latest/17/ga/mac/aarch64/jdk/hotspot/normal/eclipse" >&2
  tar -xzf "$T/jdk-tar/jdk.tar.gz" -C "$T/jdk" >&2
  JH="$(ls -d "$T"/jdk/jdk-17*/Contents/Home | head -1)"
fi
echo "$T/maestro/maestro/bin:$JH"
