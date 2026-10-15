#!/bin/sh
# Puts the device-test tool and a JRE for it in app/e2e/.tools/ (git-ignored); nothing is installed system-wide
# (architecture AD-83). Both downloads are checked against a sha256 WRITTEN IN THIS SCRIPT, so a download that
# changed fails; a change of the pins below is a change of this file, reviewed like any other.
#
#   app/e2e/get-maestro.sh          fetches what is not there yet (run again: it fetches nothing)
#
# Maestro: release cli-2.11.0, maestro.zip, sha256 taken once from the release's checksums_sha256.txt.
# JRE 17: Eclipse Temurin 17.0.20.1+1, the JRE archive of the platform, sha256 from Adoptium's release data.
#
# Environment (all optional):
#   AIWB_E2E_TOOLS   the folder to fill (default: .tools beside this script); several worktrees may share one.
#   For this script's own test (app/test/getmaestro.test.ts), which serves fake archives from a local server and
#   gives their sums: MAESTRO_BASE_URL, MAESTRO_SHA256, JRE_BASE_URL, JRE_SHA256. Nobody sets these otherwise.
set -eu

MAESTRO_VERSION=2.11.0
MAESTRO_SHA256_PIN=5384593cb4e7a106489e75a821d157dd43f4e438df6bc308b72e82c685e1283a
JRE_RELEASE=jdk-17.0.20.1%2B1
JRE_FILE_VERSION=17.0.20.1_1

here=$(cd "$(dirname "$0")" && pwd)
tools=${AIWB_E2E_TOOLS:-$here/.tools}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  jre_name=OpenJDK17U-jre_aarch64_mac_hotspot_$JRE_FILE_VERSION.tar.gz;  jre_pin=190480874ccceb358cbc840393207f77ac3e63a4c5f8129d0e23e9518b96ad05 ;;
  Darwin-x86_64) jre_name=OpenJDK17U-jre_x64_mac_hotspot_$JRE_FILE_VERSION.tar.gz;      jre_pin=333cb81123c36568586646c73c8fa2326dab8badc43f5ea388a90fff59c9df27 ;;
  Linux-aarch64) jre_name=OpenJDK17U-jre_aarch64_linux_hotspot_$JRE_FILE_VERSION.tar.gz; jre_pin=b8efcd5acc9109fe8d35bed132499643048a257b4f6042906ece37d03c839d77 ;;
  Linux-x86_64)  jre_name=OpenJDK17U-jre_x64_linux_hotspot_$JRE_FILE_VERSION.tar.gz;     jre_pin=0b2b640e3046b64c8ec504de0ab9d91bb5610182bda21fad454681ce54d45a62 ;;
  *) echo "get-maestro.sh: no JRE is pinned for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

maestro_base=${MAESTRO_BASE_URL:-https://github.com/mobile-dev-inc/Maestro/releases/download/cli-$MAESTRO_VERSION}
jre_base=${JRE_BASE_URL:-https://github.com/adoptium/temurin17-binaries/releases/download/$JRE_RELEASE}
maestro_sha=${MAESTRO_SHA256:-$MAESTRO_SHA256_PIN}
jre_sha=${JRE_SHA256:-$jre_pin}

ready="maestro=$MAESTRO_VERSION $maestro_sha jre=$jre_name $jre_sha"
if [ -f "$tools/READY" ] && [ "$(cat "$tools/READY")" = "$ready" ] && [ -x "$tools/maestro/maestro/bin/maestro" ] && [ -x "$tools/java-home/bin/java" ]; then
  echo "get-maestro.sh: Maestro $MAESTRO_VERSION and the JRE are in $tools; nothing to fetch"
  exit 0
fi

sum() { shasum -a 256 "$1" | awk '{print $1}'; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/aiwb-get-maestro.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

fetch() { # url, file, sha256 it must have
  echo "get-maestro.sh: fetching $1"
  curl -fsSL --retry 3 "$1" -o "$2"
  got=$(sum "$2")
  if [ "$got" != "$3" ]; then
    echo "get-maestro.sh: $(basename "$2") has sha256 $got, the script pins $3: not used" >&2
    exit 1
  fi
}

fetch "$maestro_base/maestro.zip" "$tmp/maestro.zip" "$maestro_sha"
fetch "$jre_base/$jre_name" "$tmp/jre.tar.gz" "$jre_sha"

mkdir -p "$tmp/m" "$tmp/jdk"
unzip -q "$tmp/maestro.zip" -d "$tmp/m"
tar -xzf "$tmp/jre.tar.gz" -C "$tmp/jdk"
[ -x "$tmp/m/maestro/bin/maestro" ] || { echo "get-maestro.sh: maestro.zip holds no maestro/bin/maestro" >&2; exit 1; }
jdir=$(ls "$tmp/jdk" | head -n 1)
if [ -d "$tmp/jdk/$jdir/Contents/Home" ]; then home_rel="$jdir/Contents/Home"; else home_rel="$jdir"; fi
[ -x "$tmp/jdk/$home_rel/bin/java" ] || { echo "get-maestro.sh: the JRE archive holds no bin/java" >&2; exit 1; }

mkdir -p "$tools"
rm -rf "$tools/maestro" "$tools/jdk" "$tools/java-home" "$tools/READY"
mv "$tmp/m" "$tools/maestro"
mv "$tmp/jdk" "$tools/jdk"
ln -s "jdk/$home_rel" "$tools/java-home"
echo "$ready" > "$tools/READY"
echo "get-maestro.sh: ready in $tools (Maestro $MAESTRO_VERSION, JRE $("$tools/java-home/bin/java" -version 2>&1 | head -n 1))"
