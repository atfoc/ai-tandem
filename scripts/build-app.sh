#!/bin/bash
# Builds the desktop app for one target with electron-builder (desktop/electron-builder.yml):
#   scripts/build-app.sh [--os macos|windows] [--arch arm64|x64]
#
# The targets and where each build lands (all under bin/; a build replaces only its own place):
#   macOS, this Mac's processor      bin/AI Whiteboard.app                  (--os macos --arch <this Mac's>; the default on a Mac)
#   macOS, the other processor       bin/macos-<arch>/AI Whiteboard.app     (built on a Mac only)
#   Windows, either processor        bin/windows-<arch>/AI Whiteboard/      (the unpacked folder; built on Linux or on a Mac)
# Aliases: --os mac|darwin, --os win|win32; --arch amd64 for x64. On a Mac, --arch alone means macOS and no flag at all
# builds the macOS app for this Mac's processor. --os windows alone means this computer's processor. On Linux there is no
# default target: with no --os it builds nothing, lists what Linux can build and exits 2. What cannot be built here (an unknown
# OS or processor, the macOS app on Linux, any host that is neither macOS nor Linux) is refused first, before any work, with one
# sentence naming the target and the reason, exit 2; nothing in bin/ is touched.
#
# The macOS bundle (Contents/...):
#   MacOS/AI Whiteboard     Electron, the app window (the bundle's executable)
#   MacOS/ai-whiteboard     the Go server binary, which the app runs to start or find this computer's server
#   Resources/app.asar      Electron main process, preload and the connection module
#   Resources/web/          the app's web build (app/dist-web, AD-40): the app's page, loaded from this folder
#   Resources/remote/setup-remote.sh
#                           sets the app's server up as a remote server (run through sh)
#   Resources/headless/     the headless writer (packages/headless): headless.mjs, manifest.json and
#                           engine/ (the board engine, its fonts and the native canvas,
#                           node_modules/skia-canvas/lib/skia.node); the server finds it next to
#                           its own binary (internal/headless/find.go) and runs it with the app's
#                           Electron as Node. Outside app.asar: a native module can't load from it
#   Resources/AppIcon.icns
# The Windows folder holds the same parts: AI Whiteboard.exe (Electron), ai-whiteboard.exe (the server) beside it,
# resources/{app.asar,web,remote,headless,AppIcon.ico}.
# One version is stamped into the Go binary, the web build, CFBundleVersion and the headless writer's manifest.json; the page,
# the server and its headless writer are one build. The version is the environment variable AIWB_VERSION when it is set and not
# empty (a copy of the repository with no .git, as the Linux container has, can't be described: scripts/linux-build/run.sh
# passes the host's), else `git describe --tags --always --dirty`, else `dev`.
# The server is built with CGO_ENABLED=0 for every target, the default included, and with -trimpath -buildvcs=false (no path of
# this computer's Go or checkout, no version-control state in the binary), so that a Linux host, a Mac, an arm64 host and an x64
# host make the same server for the same target (scripts/build-server.sh does the same). The target's checks are
# scripts/check-build.mjs (Node, no macOS tool: the Windows path uses none of ditto, codesign, lipo, plutil and runs on Linux);
# a macOS build also has the signature checks of codesign. Install a macOS or Windows build with scripts/install-app.sh.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
usage="usage: scripts/build-app.sh [--os macos|windows] [--arch arm64|x64]"
refuse() { echo "$1" >&2; echo "$usage" >&2; exit 2; }
lower() { echo "$1" | tr 'A-Z' 'a-z'; }

# ---- 1. arguments and the target, decided before any work ----
reqos=""
reqarch=""
while [ $# -gt 0 ]; do
  case "$1" in
    --os | --arch)
      { [ $# -ge 2 ] && [ "${2#--}" = "$2" ]; } || refuse "$1 needs a value ($([ "$1" = --os ] && echo "macos or windows" || echo "arm64 or x64"))."
      if [ "$1" = --os ]; then reqos="$2"; else reqarch="$2"; fi
      shift 2
      ;;
    *) refuse "Unknown argument '$1'." ;;
  esac
done

jsos="" # Node's and electron-builder's name of the target OS: darwin, win32
if [ -n "$reqos" ]; then
  case "$(lower "$reqos")" in
    macos | mac | darwin) jsos=darwin ;;
    windows | win | win32) jsos=win32 ;;
    linux) refuse "Cannot build for Linux: it is not a target of the desktop app (the targets are macOS and Windows)." ;;
    *) refuse "Cannot build for the operating system '$reqos': the desktop app is built for macOS (--os macos) and Windows (--os windows)." ;;
  esac
fi
arch="" # arm64 or x64
if [ -n "$reqarch" ]; then
  case "$(lower "$reqarch")" in
    arm64) arch=arm64 ;;
    x64 | amd64) arch=x64 ;;
    *) refuse "Cannot build for the processor '$reqarch': the desktop app is built for arm64 (--arch arm64) and x64 (--arch x64)." ;;
  esac
fi

hostos="$(uname -s)"
case "$hostos" in
  Darwin) [ -n "$jsos" ] || jsos=darwin ;;
  Linux)
    if [ -z "$jsos" ]; then
      {
        echo "Nothing built: Linux has no default target, so the target must be named. Linux can build the Windows app:"
        echo "  scripts/build-app.sh --os windows --arch x64"
        echo "  scripts/build-app.sh --os windows --arch arm64"
        echo "(the macOS app is built only on a Mac)"
        echo "$usage"
      } >&2
      exit 2
    fi
    [ "$jsos" != darwin ] || refuse "Cannot build the macOS${arch:+ $arch} app on Linux: the macOS app is built only on a Mac."
    ;;
  *) refuse "Cannot build the desktop app on $hostos: it is built on macOS (for macOS and Windows) and on Linux (for Windows)." ;;
esac

# This computer's processor, which the target's default is. On a Mac it is what install-app.sh asks (sysctl: 1 is Apple
# Silicon), not Node's process.arch, which says x64 for a Node running under Rosetta, so that the two scripts never disagree.
if [ "$hostos" = Darwin ]; then
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then hostarch=arm64; else hostarch=x64; fi
else
  hostarch="$(node -p process.arch)"
fi
if [ -z "$arch" ]; then
  case "$hostarch" in
    arm64 | x64) arch="$hostarch" ;;
    *) refuse "Cannot choose a processor: this computer's is '$hostarch', which the desktop app is not built for; name --arch arm64 or --arch x64." ;;
  esac
fi

case "$jsos-$arch" in
  darwin-*)
    goos=darwin
    if [ "$arch" = "$hostarch" ]; then place="$root/bin/AI Whiteboard.app"; else place="$root/bin/macos-$arch/AI Whiteboard.app"; fi
    builder=--mac
    if [ "$arch" = arm64 ]; then outdir="mac-arm64"; else outdir="mac"; fi
    built_name="AI Whiteboard.app"
    ;;
  win32-*)
    goos=windows
    place="$root/bin/windows-$arch/AI Whiteboard"
    builder=--win
    if [ "$arch" = arm64 ]; then outdir="win-arm64-unpacked"; else outdir="win-unpacked"; fi
    built_name=""
    ;;
esac
if [ "$arch" = arm64 ]; then goarch=arm64; else goarch=amd64; fi
if [ "$jsos" = win32 ]; then serverfile=ai-whiteboard.exe; else serverfile=ai-whiteboard; fi

version="${AIWB_VERSION:-}"
[ -n "$version" ] || version="$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo dev)"
echo "==> $jsos/$arch -> ${place#"$root"/} ($version)"

# ---- 2. the build ----
echo "==> web build ($version)"
[ -d "$root/node_modules" ] || (cd "$root" && npm ci)
cd "$root/app"
EXPO_PUBLIC_AIWB_VERSION="$version" npm run build:web

echo "==> server for $goos/$goarch ($version)"
# (neither server file of a previous build stays: the folder never holds parts for two targets)
rm -f "$root/desktop/build/ai-whiteboard" "$root/desktop/build/ai-whiteboard.exe"
CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -C "$root" -trimpath -buildvcs=false \
  -ldflags "-X ai-whiteboard/internal/version.Version=$version" -o "$root/desktop/build/$serverfile" ./cmd/ai-whiteboard
if [ "$jsos" = darwin ]; then
  # (Go's linker signs a darwin/arm64 binary ad hoc, not a darwin/amd64 one; electron-builder refuses to sign an app that holds an
  # unsigned nested binary, so a binary without a valid signature gets the ad-hoc one here. The arm64 build keeps the linker's.)
  codesign --verify "$root/desktop/build/$serverfile" 2>/dev/null || codesign --sign - --force "$root/desktop/build/$serverfile"
fi

echo "==> headless writer for $jsos/$arch ($version)"
hdir="$root/desktop/build/headless"
rm -rf "$hdir"
node "$root/packages/headless/build.mjs" --os "$jsos" --arch "$arch" --version "$version" --out "$hdir" ||
  { echo "the headless writer's build failed (see above); the app is not built without it" >&2; exit 1; }
for f in headless.mjs manifest.json engine/engine.mjs engine/node_modules/skia-canvas/lib/skia.node; do
  [ -f "$hdir/$f" ] || { echo "the headless build has no $f; the board engine is not built or not complete" >&2; exit 1; }
done

echo "==> app"
cd "$root/desktop"
[ -e node_modules/@aiwb/conn ] || npm ci # also when node_modules is older than the dependency on @aiwb/conn
rm -rf dist
npx electron-builder "$builder" --dir "--$arch" -c.buildVersion="$version"

built="$root/desktop/dist/$outdir"
[ -z "$built_name" ] || built="$built/$built_name"
[ -d "$built" ] || { echo "electron-builder produced no ${built#"$root"/desktop/}" >&2; exit 1; }

# ---- 3. the checks (Node, any host), then the Mac's own ----
node "$root/scripts/check-build.mjs" "$built" --os "$jsos" --arch "$arch" --version "$version" --headless "$hdir" || exit 1
if [ "$jsos" = darwin ]; then
  # (the native canvas is the one file that differs from the build's copy: electron-builder signs it with the app's identity, which rewrites it)
  codesign --verify --strict "$built/Contents/Resources/headless/engine/node_modules/skia-canvas/lib/skia.node" ||
    { echo "headless/engine/node_modules/skia-canvas/lib/skia.node is not signed" >&2; exit 1; }
  codesign --verify --deep --strict "$built" || { echo "the built app's signature is not valid" >&2; exit 1; }
fi

# ---- 4. in place: only this target's own place is replaced ----
rm -rf "$place"
mkdir -p "$(dirname "$place")"
if [ "$jsos" = darwin ]; then ditto "$built" "$place"; else cp -R "$built" "$place"; fi

echo "Built $place"
