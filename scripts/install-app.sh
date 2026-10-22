#!/bin/bash
# Installs the desktop app that scripts/build-app.sh made, for the operating system this runs on:
#   macOS    copies the build of this Mac's processor into ~/Applications, where Spotlight finds it:
#            bin/AI Whiteboard.app if its executable is of that processor, else
#            bin/macos-<arch>/AI Whiteboard.app. With neither, it names the build to make and
#            installs nothing.
#   Windows  (Git Bash, MSYS, Cygwin) runs scripts/install-app.ps1, which copies
#            bin\windows-<arch>\AI Whiteboard into %LOCALAPPDATA%\Programs and makes a Start Menu
#            shortcut.
#   Linux    is not a target of the desktop app: installs nothing.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

# The test of this script (scripts/test/install-app.test.sh) points AIWB_LSREGISTER and AIWB_FILE at stand-ins.
filebin="${AIWB_FILE:-/usr/bin/file}"
lsregister="${AIWB_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"

# archs_of <app>: the processors (arm64, x86_64) the app's main executable is built for, read from
# the text of file(1), which every Mac has (lipo comes with the Xcode Command Line Tools, which a Mac
# may not have). A universal binary lists both.
archs_of() {
  local exe="$1/Contents/MacOS/AI Whiteboard" out found="" a
  [ -f "$exe" ] || return 1
  out="$("$filebin" -b "$exe" 2>/dev/null)" || return 1
  case "$out" in *Mach-O*) ;; *) return 1 ;; esac
  for a in arm64 x86_64; do
    printf '%s\n' "$out" | grep -qw "$a" && found="$found $a"
  done
  [ -n "$found" ] || return 1
  echo "${found# }"
}

# has_arch <app> <arm64|x86_64>: 0 if the app's main executable is built for that processor.
has_arch() {
  local archs
  archs="$(archs_of "$1")" || return 1
  case " $archs " in *" $2 "*) return 0 ;; esac
  return 1
}

install_macos() {
  local arch filearch other
  # uname -m says x86_64 to a process running under Rosetta, even on an Apple Silicon Mac
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  else
    case "$(uname -m)" in
      arm64) arch=arm64 ;;
      x86_64) arch=x64 ;;
      *) echo "Cannot install: this Mac's processor ($(uname -m)) is not one the app is built for." >&2; exit 1 ;;
    esac
  fi
  filearch="$arch"
  [ "$arch" = x64 ] && filearch=x86_64

  local src="$root/bin/AI Whiteboard.app"
  if ! has_arch "$src" "$filearch"; then
    src="$root/bin/macos-$arch/AI Whiteboard.app"
    if ! has_arch "$src" "$filearch"; then
      echo "Nothing installed: the macOS $arch build is missing (this Mac's processor is $arch)." >&2
      echo "Make it with: scripts/build-app.sh --os macos --arch $arch" >&2
      # builds that exist but do not fit
      if [ -d "$root/bin/AI Whiteboard.app" ]; then
        other="$(archs_of "$root/bin/AI Whiteboard.app" || true)"
        echo "Found, but not for this processor: bin/AI Whiteboard.app (${other:-unknown processor})" >&2
      fi
      for other in "$root"/bin/macos-*/"AI Whiteboard.app"; do
        [ -d "$other" ] && echo "Found, but not for this processor: ${other#"$root"/}" >&2
      done
      exit 1
    fi
  fi

  local dest="$HOME/Applications/AI Whiteboard.app"
  mkdir -p "$HOME/Applications"
  rm -rf "$dest"
  ditto "$src" "$dest"
  "$lsregister" -f "$dest" # pick up the new icon and version
  mdimport "$dest"         # index it for Spotlight now instead of eventually
  echo "Installed $dest"

  # A server started by an older build keeps running it until it stops: opening the app never
  # restarts it, since that would end the running agent chats. server.json exists only while a
  # server runs.
  if [ -f "$HOME/.ai-whiteboard/server.json" ]; then
    echo "A server is running from the previous build. AI Whiteboard will offer to restart it on"
    echo "this one (Restart server, in the section "This computer" of the sidebar), or restart it now with:"
    echo "  \"$dest/Contents/MacOS/ai-whiteboard\" relaunch"
  fi
}

case "$(uname -s)" in
  Darwin) install_macos ;;
  Linux)
    echo "Nothing installed: Linux is not a target of the desktop app, which is built for macOS and Windows." >&2
    echo "On Linux the server alone is built, with scripts/build-server.sh." >&2
    exit 1
    ;;
  MINGW* | MSYS* | CYGWIN*)
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$root/scripts/install-app.ps1")"
    ;;
  *)
    echo "Nothing installed: $(uname -s) is not an operating system this installs the app on (macOS and Windows are)." >&2
    exit 1
    ;;
esac
