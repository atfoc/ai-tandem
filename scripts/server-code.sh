#!/bin/sh
# Shows, on this machine's terminal, the code that the app on a phone scans to add this machine's server (Servers, Add server, Scan code).
# The code is a QR code of the text the app reads when it is pasted: the addresses, the certificate's fingerprint and the secret, as
# setup-remote.sh prints them. It is drawn with `qrencode`; without it the script says how to get it, and prints nothing of the secret.
#
#   sh server-code.sh [--home DIR] [--address URL]...     runs setup-remote.sh (found beside this script, in remote/ beside it, or in
#                                                         the app bundle on a Mac) and draws its answer. Run again it changes nothing.
#   sh setup-remote.sh | sh server-code.sh -              draws the output of a set-up that was run before (or on another machine)
#
#   --home DIR      the data folder of the server (default ~/.ai-whiteboard), passed to setup-remote.sh
#   --address URL   put this address in the code and not every one (may be repeated); a smaller code is easier to scan
#
# The code holds the secret, which gives all or nothing on this server: whoever scans or photographs it can use the server. The script
# writes the secret to no file (it is kept in a variable and handed to `qrencode` on its standard input, never in an argument), and does
# not clear the screen: do that when the phone has scanned (Cmd-K, or `clear`).
set -eu

usage() {
  sed -n '2,/^set -eu$/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//' >&2
}

dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

from_stdin=
home=
want=
n=$#
while [ "$n" -gt 0 ]; do
  arg=$1
  shift
  n=$((n - 1))
  case $arg in
    -) from_stdin=1 ;;
    --home | --address)
      if [ "$n" -eq 0 ] || [ -z "$1" ]; then
        echo "server-code.sh: $arg needs a value" >&2
        exit 2
      fi
      val=$1
      shift
      n=$((n - 1))
      if [ "$arg" = --home ]; then home=$val; else want="$want
$val"; fi
      ;;
    --home=* | --address=*)
      val=${arg#*=}
      arg=${arg%%=*}
      if [ -z "$val" ]; then
        echo "server-code.sh: $arg needs a value" >&2
        exit 2
      fi
      if [ "$arg" = --home ]; then home=$val; else want="$want
$val"; fi
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "server-code.sh: unknown option $arg" >&2
      usage
      exit 2
      ;;
  esac
done

# The text setup-remote.sh printed: from the standard input, or by running it (it asks nothing, and changes nothing when the server was
# set up before).
if [ -n "$from_stdin" ]; then
  out=$(cat)
else
  setup=
  for c in "$dir/setup-remote.sh" "$dir/remote/setup-remote.sh" \
    "$HOME/Applications/AI Whiteboard.app/Contents/Resources/remote/setup-remote.sh" \
    "/Applications/AI Whiteboard.app/Contents/Resources/remote/setup-remote.sh"; do
    if [ -f "$c" ]; then
      setup=$c
      break
    fi
  done
  if [ -z "$setup" ]; then
    echo "server-code.sh: no setup-remote.sh beside this script. Run it where the server's folder is, or pass its output: sh setup-remote.sh | sh server-code.sh -" >&2
    exit 1
  fi
  code=0
  if [ -n "$home" ]; then
    out=$(sh "$setup" --home "$home") || code=$?
  else
    out=$(sh "$setup") || code=$?
  fi
  # setup-remote.sh also exits 1 when it did its work and the start's check found a fault: what it printed is still what the phone needs.
  if [ -z "$out" ]; then
    [ "$code" -ne 0 ] || code=1
    exit "$code"
  fi
fi

# The addresses (one to a line, indented), the fingerprint and the secret, as the app reads them.
addresses=$(printf '%s\n' "$out" | sed -n 's|^[[:space:]]*\(https://[^[:space:]]*\)[[:space:]]*$|\1|p')
fingerprint=$(printf '%s\n' "$out" | sed -n 's/^Fingerprint:[[:space:]]*//p' | head -n 1)
secret=$(printf '%s\n' "$out" | sed -n 's/^Secret:[[:space:]]*//p' | head -n 1)
out=

if [ -n "$want" ]; then
  chosen=
  for w in $want; do
    w=${w%/}
    if printf '%s\n' "$addresses" | grep -Fx -- "$w" >/dev/null; then
      chosen="$chosen
$w"
    else
      echo "server-code.sh: $w is not one of this server's addresses:" >&2
      printf '%s\n' "$addresses" | sed 's/^/  /' >&2
      exit 2
    fi
  done
  addresses=$(printf '%s\n' "$chosen" | sed '/^$/d')
fi
if [ -z "$addresses" ] || [ -z "$secret" ]; then
  echo "server-code.sh: that output has no address or no secret. Run setup-remote.sh, which prints both." >&2
  exit 1
fi

if ! command -v qrencode >/dev/null 2>&1; then
  echo "server-code.sh: qrencode is not installed, and it draws the code. Install it:" >&2
  echo "  macOS:           brew install qrencode" >&2
  echo "  Debian, Ubuntu:  sudo apt install qrencode" >&2
  echo "  Fedora:          sudo dnf install qrencode" >&2
  echo "Or add the server without a code: in the app, Servers, Add server, and paste the output of setup-remote.sh." >&2
  exit 1
fi

text="Addresses:
$(printf '%s\n' "$addresses" | sed 's/^/  /')
"
if [ -n "$fingerprint" ]; then
  text="${text}Fingerprint: $fingerprint
"
fi
text="${text}Secret: $secret
"
# Low error correction and a small margin keep the code small: it is read from a screen.
if ! printf '%s' "$text" | qrencode -t ANSIUTF8 -l L -m 2; then
  echo "server-code.sh: qrencode could not make a code of it. Give fewer addresses with --address." >&2
  exit 1
fi
text=
secret=

echo >&2
echo "In the app on the phone: Servers, Add server, Scan code. The code holds the secret: clear this screen when the phone has read it." >&2
if [ -n "$fingerprint" ]; then
  echo "The fingerprint the app will show, to accept only when it is this one:" >&2
  echo "  $fingerprint" >&2
fi
