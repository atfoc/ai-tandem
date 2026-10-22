#!/bin/bash
# Tests scripts/install-app.sh without a Mac of each kind and without Windows: the script is copied into
# a temporary repository root and run with a temporary HOME and stand-ins for uname, sysctl, file,
# ditto, mdimport, lsregister, cygpath and powershell.exe first on PATH. A fake executable holds the
# processors file(1) names as its text. Run: bash scripts/test/install-app.test.sh (about a second).
# scripts/install-app.ps1 is only parsed (by pwsh, when it is installed) here: see the end.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../install-app.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

stubs="$tmp/stubs"
mkdir -p "$stubs"
cat >"$stubs/uname" <<'STUB'
#!/bin/bash
case "$1" in -s) echo "$FAKE_UNAME_S" ;; -m) echo "$FAKE_UNAME_M" ;; *) echo "$FAKE_UNAME_S" ;; esac
STUB
cat >"$stubs/sysctl" <<'STUB'
#!/bin/bash
# only hw.optional.arm64, which an Intel Mac does not have
[ -n "${FAKE_ARM64:-}" ] || exit 1
echo "$FAKE_ARM64"
STUB
cat >"$stubs/file" <<'STUB'
#!/bin/bash
# file -b <file>: what file(1) says of a Mach-O executable, with the file's text as its processors
# ("arm64", "x86_64", "x86_64 arm64" as a universal binary lists both); a file that says "text" is no executable
[ "$1" = -b ] && [ -f "$2" ] || exit 1
case "$(cat "$2")" in
  text*) echo "ASCII text" ;;
  *" "*) echo "Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64:Mach-O 64-bit executable arm64]"
         echo "$2 (for architecture x86_64):	Mach-O 64-bit executable x86_64"
         echo "$2 (for architecture arm64):	Mach-O 64-bit executable arm64" ;;
  *) echo "Mach-O 64-bit executable $(cat "$2")" ;;
esac
STUB
cat >"$stubs/ditto" <<'STUB'
#!/bin/bash
echo "ditto $1 -> $2" >>"$FAKE_LOG"
mkdir -p "$2" && cp -R "$1/." "$2"
STUB
cat >"$stubs/mdimport" <<'STUB'
#!/bin/bash
echo "mdimport $1" >>"$FAKE_LOG"
STUB
cat >"$stubs/lsregister" <<'STUB'
#!/bin/bash
echo "lsregister $*" >>"$FAKE_LOG"
STUB
cat >"$stubs/cygpath" <<'STUB'
#!/bin/bash
echo "W:$2"
STUB
cat >"$stubs/powershell.exe" <<'STUB'
#!/bin/bash
echo "powershell.exe $*" >>"$FAKE_LOG"
exit "${FAKE_PS_STATUS:-0}"
STUB
chmod +x "$stubs"/*

pass=0
failed=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
bad() { failed=$((failed + 1)); echo "FAIL $1: $2"; }
# check <name> <condition command...>
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name" "$*"; fi; }
contains() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }
lacks() { ! contains "$1" "$2"; }

# newcase: a fresh repository root with the script in it and a fresh HOME; sets root, home, log
n=0
newcase() {
  n=$((n + 1))
  root="$tmp/case$n/repo"
  home="$tmp/case$n/home"
  log="$tmp/case$n/log"
  mkdir -p "$root/scripts" "$root/bin" "$home"
  cp "$script" "$root/scripts/install-app.sh"
  : >"$log"
}
# fakeapp <dir of the .app> <archs text: what the stub file(1) turns into the processors>
fakeapp() {
  mkdir -p "$1/Contents/MacOS"
  echo "$2" >"$1/Contents/MacOS/AI Whiteboard"
  echo "server" >"$1/Contents/MacOS/ai-whiteboard"
}
# run <uname -s> <uname -m> <arm64 sysctl answer>: sets out and status
run() {
  out="$(
    PATH="$stubs:$PATH" HOME="$home" FAKE_LOG="$log" AIWB_LSREGISTER="$stubs/lsregister" AIWB_FILE="$stubs/file" \
      FAKE_UNAME_S="$1" FAKE_UNAME_M="$2" FAKE_ARM64="${3:-}" \
      bash "$root/scripts/install-app.sh" 2>&1
  )"
  status=$?
}
logtext() { cat "$log"; }
installed() { [ -f "$home/Applications/AI Whiteboard.app/Contents/MacOS/AI Whiteboard" ]; }

# 1. Apple Silicon, the default build is arm64: installs, as before
newcase
fakeapp "$root/bin/AI Whiteboard.app" arm64
run Darwin arm64 1
check "arm64: exit 0" [ "$status" = 0 ]
check "arm64: installed" installed
check "arm64: Installed line" contains "$out" "Installed $home/Applications/AI Whiteboard.app"
check "arm64: lsregister and mdimport ran" contains "$(logtext)" "lsregister -f $home/Applications/AI Whiteboard.app"
check "arm64: mdimport" contains "$(logtext)" "mdimport $home/Applications/AI Whiteboard.app"
check "arm64: no notice without server.json" lacks "$out" "A server is running"
# the whole output is today's
check "arm64: output is one line" [ "$out" = "Installed $home/Applications/AI Whiteboard.app" ]

# 2. the running-server notice
newcase
fakeapp "$root/bin/AI Whiteboard.app" arm64
mkdir -p "$home/.ai-whiteboard" && : >"$home/.ai-whiteboard/server.json"
run Darwin arm64 1
check "notice: exit 0" [ "$status" = 0 ]
check "notice: relaunch command" contains "$out" "\"$home/Applications/AI Whiteboard.app/Contents/MacOS/ai-whiteboard\" relaunch"

# 3. a previous install is replaced
newcase
fakeapp "$root/bin/AI Whiteboard.app" arm64
mkdir -p "$home/Applications/AI Whiteboard.app/Contents" && : >"$home/Applications/AI Whiteboard.app/Contents/stale"
run Darwin arm64 1
check "replace: stale file gone" [ ! -e "$home/Applications/AI Whiteboard.app/Contents/stale" ]
check "replace: new one there" installed

# 4. Rosetta: uname -m says x86_64 on an Apple Silicon Mac, the build wanted is arm64
newcase
fakeapp "$root/bin/AI Whiteboard.app" arm64
run Darwin x86_64 1
check "rosetta: exit 0" [ "$status" = 0 ]
check "rosetta: installed the arm64 build" installed

# 5. Intel Mac with only an arm64 default build: refuses, names the build and the command, touches nothing
newcase
fakeapp "$root/bin/AI Whiteboard.app" arm64
run Darwin x86_64 ""
check "x64 refused: exit 1" [ "$status" = 1 ]
check "x64 refused: names the build" contains "$out" "the macOS x64 build"
check "x64 refused: names the command" contains "$out" "scripts/build-app.sh --os macos --arch x64"
check "x64 refused: mentions the build found" contains "$out" "bin/AI Whiteboard.app (arm64)"
check "x64 refused: no ~/Applications" [ ! -e "$home/Applications" ]
check "x64 refused: nothing run" [ ! -s "$log" ]

# 6. Intel Mac with the arm64 default build and bin/macos-x64: installs that one
newcase
fakeapp "$root/bin/AI Whiteboard.app" arm64
fakeapp "$root/bin/macos-x64/AI Whiteboard.app" x86_64
run Darwin x86_64 ""
check "macos-x64: exit 0" [ "$status" = 0 ]
check "macos-x64: installed" installed
check "macos-x64: from bin/macos-x64" contains "$(logtext)" "ditto $root/bin/macos-x64/AI Whiteboard.app"

# 7. Apple Silicon with an x86_64 default build and bin/macos-arm64
newcase
fakeapp "$root/bin/AI Whiteboard.app" x86_64
fakeapp "$root/bin/macos-arm64/AI Whiteboard.app" arm64
run Darwin arm64 1
check "macos-arm64: exit 0" [ "$status" = 0 ]
check "macos-arm64: from bin/macos-arm64" contains "$(logtext)" "ditto $root/bin/macos-arm64/AI Whiteboard.app"

# 8. a universal default build fits both
newcase
fakeapp "$root/bin/AI Whiteboard.app" "x86_64 arm64"
run Darwin x86_64 ""
check "universal: exit 0" [ "$status" = 0 ]
check "universal: installed" installed

# 9. Apple Silicon, only a macos-x64 build: refuses with the arm64 command, mentions the other
newcase
fakeapp "$root/bin/macos-x64/AI Whiteboard.app" x86_64
run Darwin arm64 1
check "arm64 missing: exit 1" [ "$status" = 1 ]
check "arm64 missing: names the build" contains "$out" "the macOS arm64 build"
check "arm64 missing: names the command" contains "$out" "scripts/build-app.sh --os macos --arch arm64"
check "arm64 missing: mentions the other" contains "$out" "bin/macos-x64/AI Whiteboard.app"
check "arm64 missing: no ~/Applications" [ ! -e "$home/Applications" ]

# 10. no build at all: refuses, and a previous install stays
newcase
mkdir -p "$home/Applications/AI Whiteboard.app" && : >"$home/Applications/AI Whiteboard.app/previous"
run Darwin arm64 1
check "no build: exit 1" [ "$status" = 1 ]
check "no build: names the command" contains "$out" "scripts/build-app.sh --os macos --arch arm64"
check "no build: previous install kept" [ -e "$home/Applications/AI Whiteboard.app/previous" ]

# 11. Linux
newcase
fakeapp "$root/bin/AI Whiteboard.app" arm64
run Linux x86_64 ""
check "linux: exit 1" [ "$status" = 1 ]
check "linux: says not a target" contains "$out" "Linux is not a target"
check "linux: mentions build-server.sh" contains "$out" "scripts/build-server.sh"
check "linux: no ~/Applications" [ ! -e "$home/Applications" ]
check "linux: nothing run" [ ! -s "$log" ]

# 12. Git Bash, MSYS, Cygwin: runs install-app.ps1 through powershell.exe, with its status
for os in MINGW64_NT-10.0-22631 MSYS_NT-10.0 CYGWIN_NT-10.0; do
  newcase
  run "$os" x86_64 ""
  check "$os: exit 0" [ "$status" = 0 ]
  check "$os: powershell.exe call" [ "$(logtext)" = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File W:$root/scripts/install-app.ps1" ]
done
newcase
out="$(PATH="$stubs:$PATH" HOME="$home" FAKE_LOG="$log" FAKE_UNAME_S=MINGW64_NT FAKE_UNAME_M=x86_64 FAKE_PS_STATUS=7 \
  bash "$root/scripts/install-app.sh" 2>&1)"
check "MINGW: exits with powershell's status" [ "$?" = 7 ]

# 13. anything else
newcase
run FreeBSD amd64 ""
check "other: exit 1" [ "$status" = 1 ]
check "other: names the OS" contains "$out" "FreeBSD is not an operating system"

# 13b. an executable that file(1) does not call Mach-O is no build of any processor
newcase
fakeapp "$root/bin/AI Whiteboard.app" "text arm64"
run Darwin arm64 1
check "not Mach-O: exit 1" [ "$status" = 1 ]
check "not Mach-O: nothing installed" [ ! -e "$home/Applications" ]

# 13c. the script needs no lipo: none is on the PATH of the stand-ins, and it is not named
check "no lipo in the script" bash -c '! grep -n "lipo" "$1" | grep -v "^[0-9]*:#"' _ "$script"

# 14. bash 3.2 habits: no associative arrays, no case-changing expansions
check "no bash 4 syntax" bash -c '! grep -nE "declare -A|\$\{[A-Za-z_]+(,,|\^\^)" "$1"' _ "$script"

# 15. install-app.ps1: parsed by pwsh when it is installed; never installed here
ps1="$here/../install-app.ps1"
if command -v pwsh >/dev/null 2>&1; then
  parse="$(pwsh -NoProfile -Command '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }; exit $(if ($e.Count) { 1 } else { 0 })' "$ps1" 2>&1)"
  check "install-app.ps1 parses" [ "$?" = 0 ]
  [ -z "$parse" ] || echo "$parse"
else
  echo "skip install-app.ps1: pwsh is not installed, the script was not parsed or run"
fi

echo "$pass passed, $failed failed"
[ "$failed" = 0 ]
