#!/bin/bash
# Tests the arguments, the refusals and the choice of target of scripts/build-app.sh without building anything: the script is
# copied into a temporary repository root and run with stand-ins for uname, sysctl, node, npm, npx, go, git, codesign and ditto first on PATH.
# Only uname, sysctl (the Mac's processor), node (for `node -p process.arch`, the Linux host's) and git (describe) may be called by a refused build; every other call is logged in
# $FAKE_LOG. Run: bash scripts/test/build-app-args.test.sh (about 25 runs of the script, each with a dozen process starts: seconds on a fast machine, minutes where a process start costs 0.7 s).
set -u
unset AIWB_VERSION

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../build-app.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

stubs="$tmp/stubs"
mkdir -p "$stubs"
cat >"$stubs/uname" <<'STUB'
#!/bin/bash
case "$1" in -m) echo "${FAKE_UNAME_M:-x86_64}" ;; *) echo "$FAKE_UNAME_S" ;; esac
STUB
cat >"$stubs/sysctl" <<'STUB'
#!/bin/bash
# sysctl -n hw.optional.arm64: 1 on an Apple Silicon Mac (FAKE_ARCH=arm64), nothing and a failure on an Intel Mac
[ "$1" = -n ] && [ "$2" = hw.optional.arm64 ] && [ "$FAKE_ARCH" = arm64 ] && { echo 1; exit 0; }
exit 1
STUB
cat >"$stubs/git" <<'STUB'
#!/bin/bash
echo vtest
STUB
cat >"$stubs/node" <<'STUB'
#!/bin/bash
# node -p process.arch: the host's processor (FAKE_NODE_ARCH: what a Node under Rosetta says). packages/headless/build.mjs: makes the headless parts. check-build.mjs: logs, passes.
if [ "$1" = -p ] && [ "$2" = process.arch ]; then echo "${FAKE_NODE_ARCH:-$FAKE_ARCH}"; exit 0; fi
echo "node $*" >>"$FAKE_LOG"
case "$1" in
  */build.mjs)
    while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done
    mkdir -p "$out/engine/node_modules/skia-canvas/lib"
    : >"$out/headless.mjs"; : >"$out/manifest.json"; : >"$out/engine/engine.mjs"; : >"$out/engine/node_modules/skia-canvas/lib/skia.node"
    ;;
  */check-build.mjs) exit "${FAKE_CHECK_STATUS:-0}" ;;
esac
STUB
cat >"$stubs/npm" <<'STUB'
#!/bin/bash
echo "npm $*" >>"$FAKE_LOG"
STUB
cat >"$stubs/go" <<'STUB'
#!/bin/bash
echo "go CGO_ENABLED=$CGO_ENABLED GOOS=$GOOS GOARCH=$GOARCH $*" >>"$FAKE_LOG"
while [ $# -gt 0 ]; do [ "$1" = -o ] && { mkdir -p "$(dirname "$2")"; echo server >"$2"; }; shift; done
STUB
cat >"$stubs/npx" <<'STUB'
#!/bin/bash
# npx electron-builder --mac|--win --dir --arm64|--x64 ...: the folder electron-builder makes under dist
echo "npx $*" >>"$FAKE_LOG"
case "$*" in
  *--mac*--arm64*) d="dist/mac-arm64/AI Whiteboard.app" ;;
  *--mac*--x64*) d="dist/mac/AI Whiteboard.app" ;;
  *--win*--arm64*) d="dist/win-arm64-unpacked" ;;
  *--win*--x64*) d="dist/win-unpacked" ;;
  *) exit 1 ;;
esac
mkdir -p "$d" && echo built >"$d/marker"
STUB
cat >"$stubs/codesign" <<'STUB'
#!/bin/bash
echo "codesign $*" >>"$FAKE_LOG"
STUB
cat >"$stubs/ditto" <<'STUB'
#!/bin/bash
echo "ditto $1 -> $2" >>"$FAKE_LOG"
mkdir -p "$2" && cp -R "$1/." "$2"
STUB
chmod +x "$stubs"/*

pass=0
failed=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
bad() { failed=$((failed + 1)); echo "FAIL $1: $2"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name" "$*"; fi; }
contains() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }
lacks() { ! contains "$1" "$2"; }

# newcase: a fresh repository root with the script and a bin/ that holds a sentinel; sets root, log
n=0
newcase() {
  n=$((n + 1))
  root="$tmp/case$n/repo"
  log="$tmp/case$n/log"
  mkdir -p "$root/scripts" "$root/bin/keep" "$root/desktop" "$root/app"
  cp "$script" "$root/scripts/build-app.sh"
  echo sentinel >"$root/bin/keep/file"
  : >"$log"
}
snapshot() { before="$(cd "$root" && find . | sort)"; }
# run <uname -s> <host processor> <args...>: sets out and status
run() {
  local s="$1" a="$2"
  shift 2
  out="$(PATH="$stubs:$PATH" FAKE_LOG="$log" FAKE_UNAME_S="$s" FAKE_ARCH="$a" bash "$root/scripts/build-app.sh" "$@" 2>&1)"
  status=$?
}
logtext() { cat "$log"; }
usageline="usage: scripts/build-app.sh [--os macos|windows] [--arch arm64|x64]"
untouched() { [ "$(cd "$root" && find . | sort)" = "$before" ]; }
# refused <name> <sentence> <uname -s> <processor> <args...>
refused() {
  local name="$1" sentence="$2"
  newcase
  shift 2
  snapshot
  run "$@"
  check "$name: exit 2" [ "$status" = 2 ]
  check "$name: sentence" contains "$out" "$sentence"
  check "$name: usage line" contains "$out" "$usageline"
  check "$name: no tool but uname, sysctl, node, git" [ ! -s "$log" ]
  check "$name: nothing created (bin/ and the rest as before)" untouched
}

refused "unknown flag" "Unknown argument '--bogus'." Darwin arm64 --os mac --bogus
refused "unknown OS" "Cannot build for the operating system 'plan9': the desktop app is built for macOS (--os macos) and Windows (--os windows)." Darwin arm64 --os plan9
refused "Linux as target" "Cannot build for Linux: it is not a target of the desktop app (the targets are macOS and Windows)." Linux x64 --os linux
refused "unknown arch" "Cannot build for the processor 'sparc': the desktop app is built for arm64 (--arch arm64) and x64 (--arch x64)." Darwin arm64 --arch sparc
refused "x86" "Cannot build for the processor 'x86': " Linux x64 --os windows --arch x86
refused "missing OS value" "--os needs a value (macos or windows)." Darwin arm64 --os
refused "missing arch value" "--arch needs a value (arm64 or x64)." Darwin arm64 --arch --os windows
refused "macOS on Linux" "Cannot build the macOS arm64 app on Linux: the macOS app is built only on a Mac." Linux x64 --os macos --arch arm64
refused "macOS on Linux, no arch" "Cannot build the macOS app on Linux: the macOS app is built only on a Mac." Linux arm64 --os mac
refused "FreeBSD host" "Cannot build the desktop app on FreeBSD: it is built on macOS (for macOS and Windows) and on Linux (for Windows)." FreeBSD x64 --os windows
refused "Windows host" "Cannot build the desktop app on MINGW64_NT-10.0: " MINGW64_NT-10.0 x64
refused "host processor neither" "Cannot choose a processor: this computer's is 'ia32'" Linux ia32 --os windows

# Linux with no --os (alone or with --arch): builds nothing and lists the targets
for args in "" "--arch x64"; do
  newcase
  snapshot
  run Linux x64 $args
  check "Linux [$args]: exit 2" [ "$status" = 2 ]
  check "Linux [$args]: Nothing built" contains "$out" "Nothing built"
  check "Linux [$args]: lists windows x64" contains "$out" "scripts/build-app.sh --os windows --arch x64"
  check "Linux [$args]: lists windows arm64" contains "$out" "scripts/build-app.sh --os windows --arch arm64"
  check "Linux [$args]: lists no macOS target" lacks "$out" "--os macos --arch"
  check "Linux [$args]: usage line" contains "$out" "$usageline"
  check "Linux [$args]: no tool but uname, sysctl, node, git" [ ! -s "$log" ]
  check "Linux [$args]: nothing created" untouched
done

# Accepted targets: which server, headless writer and electron-builder run, and where the build lands
# built <name> <uname -s> <processor> <place> <GOOS> <GOARCH> <jsos> <jsarch> <electron-builder flags> <args...>
built() {
  local name="$1" s="$2" a="$3" place="$4" goos="$5" goarch="$6" jsos="$7" jsarch="$8" eb="$9"
  shift 9
  newcase
  run "$s" "$a" "$@"
  check "$name: exit 0" [ "$status" = 0 ]
  check "$name: Built line" contains "$out" "Built $root/bin/$place"
  check "$name: placed" [ -f "$root/bin/$place/marker" ]
  check "$name: server for the target, no cgo" contains "$(logtext)" "go CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch "
  check "$name: headless for the target" contains "$(logtext)" "--os $jsos --arch $jsarch --version vtest"
  check "$name: electron-builder" contains "$(logtext)" "npx electron-builder $eb -c.buildVersion=vtest"
  check "$name: checks run for the target" contains "$(logtext)" "check-build.mjs $root/desktop/dist/"
  check "$name: checks name the target" contains "$(logtext)" "--os $jsos --arch $jsarch --version vtest"
  check "$name: other places untouched" [ -f "$root/bin/keep/file" ]
}
built "Mac, no flags (arm64 host)" Darwin arm64 "AI Whiteboard.app" darwin arm64 darwin arm64 "--mac --dir --arm64"
check "Mac default: codesign ran" contains "$(logtext)" "codesign --verify --deep --strict"
check "Mac default: ditto ran" contains "$(logtext)" "ditto $root/desktop/dist/mac-arm64/AI Whiteboard.app -> $root/bin/AI Whiteboard.app"
# a Node under Rosetta says x64 on an Apple Silicon Mac: the default is still the Mac's own processor (as install-app.sh finds it)
FAKE_NODE_ARCH=x64 built "Mac, no flags, Rosetta Node on an arm64 Mac" Darwin arm64 "AI Whiteboard.app" darwin arm64 darwin arm64 "--mac --dir --arm64"
FAKE_NODE_ARCH=x64 built "Mac, --os windows, Rosetta Node on an arm64 Mac" Darwin arm64 "windows-arm64/AI Whiteboard" windows arm64 win32 arm64 "--win --dir --arm64" --os windows
FAKE_NODE_ARCH=arm64 built "Mac, no flags, Intel Mac" Darwin x64 "AI Whiteboard.app" darwin amd64 darwin x64 "--mac --dir --x64"
built "Mac, --arch alone, x64 host" Darwin x64 "AI Whiteboard.app" darwin amd64 darwin x64 "--mac --dir --x64" --arch x64
check "Mac x64 host: dist/mac" contains "$(logtext)" "dist/mac/AI Whiteboard.app"
built "Mac, the other processor" Darwin arm64 "macos-x64/AI Whiteboard.app" darwin amd64 darwin x64 "--mac --dir --x64" --os macos --arch x64
built "Mac, Windows x64" Darwin arm64 "windows-x64/AI Whiteboard" windows amd64 win32 x64 "--win --dir --x64" --os windows --arch x64
built "Linux, Windows x64" Linux x64 "windows-x64/AI Whiteboard" windows amd64 win32 x64 "--win --dir --x64" --os win32 --arch amd64
check "Windows: no macOS tool called" lacks "$(logtext)" "codesign"
check "Windows: no ditto" lacks "$(logtext)" "ditto"
check "Windows: the server is ai-whiteboard.exe" contains "$(logtext)" "-o $root/desktop/build/ai-whiteboard.exe"
built "Linux, Windows with the host's processor (arm64)" Linux arm64 "windows-arm64/AI Whiteboard" windows arm64 win32 arm64 "--win --dir --arm64" --os windows

# a rebuild replaces only its own place; the server files of another target do not stay in desktop/build
newcase
mkdir -p "$root/bin/windows-x64/AI Whiteboard" "$root/bin/windows-arm64/AI Whiteboard" "$root/desktop/build"
echo old >"$root/bin/windows-x64/AI Whiteboard/stale"
echo keep >"$root/bin/windows-arm64/AI Whiteboard/other"
echo mac >"$root/desktop/build/ai-whiteboard"
run Linux x64 --os windows --arch x64
check "rebuild: stale file of the place gone" [ ! -e "$root/bin/windows-x64/AI Whiteboard/stale" ]
check "rebuild: new build there" [ -f "$root/bin/windows-x64/AI Whiteboard/marker" ]
check "rebuild: the other Windows build kept" [ -f "$root/bin/windows-arm64/AI Whiteboard/other" ]
check "rebuild: no server of the other OS left in desktop/build" [ ! -e "$root/desktop/build/ai-whiteboard" ] 

# the version: AIWB_VERSION when set and not empty (a copy with no .git), else the stub's `git describe` (vtest)
for v in venv ""; do
  newcase
  out="$(AIWB_VERSION="$v" PATH="$stubs:$PATH" FAKE_LOG="$log" FAKE_UNAME_S=Linux FAKE_ARCH=x64 bash "$root/scripts/build-app.sh" --os windows --arch x64 2>&1)"
  status=$?
  want=venv
  [ -n "$v" ] || want=vtest
  check "AIWB_VERSION='$v': exit 0" [ "$status" = 0 ]
  check "AIWB_VERSION='$v': the version is $want" contains "$out" "($want)"
  check "AIWB_VERSION='$v': stamped into the server" contains "$(logtext)" "internal/version.Version=$want "
  check "AIWB_VERSION='$v': stamped into the headless writer and the checks" contains "$(logtext)" "--version $want --out"
  check "AIWB_VERSION='$v': electron-builder" contains "$(logtext)" "-c.buildVersion=$want"
done

# a failing check puts nothing in place
newcase
mkdir -p "$root/bin/windows-x64/AI Whiteboard" && echo old >"$root/bin/windows-x64/AI Whiteboard/old"
out="$(PATH="$stubs:$PATH" FAKE_LOG="$log" FAKE_UNAME_S=Linux FAKE_ARCH=x64 FAKE_CHECK_STATUS=1 bash "$root/scripts/build-app.sh" --os windows --arch x64 2>&1)"
status=$?
check "failed check: exit 1" [ "$status" = 1 ]
check "failed check: the previous build stays" [ -f "$root/bin/windows-x64/AI Whiteboard/old" ]

echo "$pass passed, $failed failed"
[ "$failed" = 0 ]
