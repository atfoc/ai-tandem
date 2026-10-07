#!/bin/sh
# Sets this machine's AI Whiteboard server up as a remote server: one that the app on another
# machine connects to over HTTPS, with a secret and the fingerprint of this server's certificate.
# It asks nothing. Run again, it changes nothing and prints the same.
#
#   sh setup-remote.sh [--name NAME]... [--port N] [--new-cert] [--new-secret]
#                      [--home DIR] [--server-port N]
#
#   --name NAME       a DNS name or IPv4 address clients reach this machine by; may be repeated.
#                     Without it set-up takes every name and address the machine has.
#   --port N          the remote port (default: keep it, or 4748 at the first set-up)
#   --new-cert        replace the key and the certificate: every client must accept the new
#                     fingerprint
#   --new-secret      replace the secret: every client needs the new one
#   --home DIR        the data folder (default ~/.ai-whiteboard)
#   --server-port N   the server's own port, when it is not the running server's or 4747
#
# It finds the server program beside itself (the server folder of scripts/build-server.sh) or in
# the app bundle it is part of (Contents/Resources/remote/ and Contents/MacOS/ai-whiteboard), and
# does everything through that program's `remote setup` and `secret` commands. It needs no openssl.
# AIWB_SERVER_BIN, when set, is the server program to use in place of the one it finds.
set -eu

usage() {
  sed -n '2,/^set -eu$/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//' >&2
}

dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

home=
server_port=
new_secret=
# The arguments of `remote setup` are collected in "$@".
n=$#
while [ "$n" -gt 0 ]; do
  arg=$1
  shift
  n=$((n - 1))
  opt=
  case $arg in
    --name | --port | --home | --server-port)
      if [ "$n" -eq 0 ]; then
        echo "setup-remote.sh: $arg needs a value" >&2
        exit 2
      fi
      opt=$arg
      val=$1
      shift
      n=$((n - 1))
      ;;
    --name=* | --port=* | --home=* | --server-port=*)
      val=${arg#*=}
      arg=${arg%%=*}
      opt=$arg
      ;;
  esac
  # An empty value is refused: an empty --home would mean the default data folder.
  if [ -n "$opt" ] && [ -z "$val" ]; then
    echo "setup-remote.sh: $opt needs a value" >&2
    exit 2
  fi
  case $arg in
    --name) set -- "$@" -name "$val" ;;
    --port) set -- "$@" -port "$val" ;;
    --home) home=$val ;;
    --server-port) server_port=$val ;;
    --new-cert) set -- "$@" -new-cert ;;
    --new-secret) new_secret=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "setup-remote.sh: unknown option $arg" >&2
      usage
      exit 2
      ;;
  esac
done

bin=${AIWB_SERVER_BIN-}
restart=
if [ -n "$bin" ]; then
  :
elif [ -x "$dir/ai-whiteboard" ]; then
  bin=$dir/ai-whiteboard
  restart="sh \"$dir/start-server.sh\" --restart"
elif [ -x "$dir/../../MacOS/ai-whiteboard" ]; then
  bin=$(CDPATH='' cd -- "$dir/../../MacOS" && pwd -P)/ai-whiteboard
else
  echo "setup-remote.sh: no ai-whiteboard program beside this script ($dir) or in an app bundle around it. Call the script by its real path, not through a link to it." >&2
  exit 1
fi
[ -n "$restart" ] || restart="\"$bin\" relaunch"

if [ -n "$server_port" ]; then
  set -- "$@" -server-port "$server_port"
fi

# `remote setup` exits 1 also when it wrote its files and the start's check then found a fault:
# its message is on stderr, and what it printed says that set-up was done.
code=0
if [ -n "$home" ]; then
  out=$("$bin" remote setup -home "$home" "$@") || code=$?
else
  out=$("$bin" remote setup "$@") || code=$?
fi
if [ -z "$out" ]; then
  [ "$code" -ne 0 ] || code=1
  exit "$code"
fi

# The restart line gets the data folder and the server's own port as `remote setup` printed them:
# the folder's full path, and the port also when it is the running server's and was not given.
if [ -n "$home" ]; then
  folder=$(printf '%s\n' "$out" | sed -n '1s/^Remote access is set up in \(.*\)\.$/\1/p')
  restart="$restart -home \"${folder:-$home}\""
fi
if [ -z "$server_port" ]; then
  server_port=$(printf '%s\n' "$out" | sed -n 's/^Server port: //p')
  [ "$server_port" != 4747 ] || server_port=
fi
if [ -n "$server_port" ]; then
  restart="$restart -port $server_port"
fi

if [ -n "$new_secret" ]; then
  set -- secret -new
else
  set -- secret
fi
if [ -n "$home" ]; then
  set -- "$@" -home "$home"
fi
secret_code=0
secret=$("$bin" "$@") || secret_code=$?

printf '%s\n' "$out"
port=$(printf '%s\n' "$out" | sed -n 's/^Port: //p')
names=$(printf '%s\n' "$out" | sed -n 's/^Names: //p')
if [ -n "$port" ] && [ -n "$names" ]; then
  echo "Addresses, one for each name (a client uses the one it can reach):"
  printf '%s\n' "$names" | tr ',' '\n' | sed -e 's/^ *//' -e '/^$/d' -e "s|.*|  https://&:$port|"
fi
if [ "$secret_code" -eq 0 ]; then
  echo "Secret: $secret"
fi
echo
echo "In the app on the other machine: Servers, Add server, with one of the addresses, the secret and"
echo "\"Self-signed certificate\" ticked. Accept the fingerprint only when it is the one above."
echo "A running server takes a new port, new names or a new certificate at its next start, and a new secret at once. To start it, or to restart it:"
echo "  $restart"
if [ "$(uname -s)" = Darwin ]; then
  echo "macOS: with the firewall on (System Settings, Network, Firewall) incoming connections to the"
  echo "server can be blocked. Allow \"ai-whiteboard\" when macOS asks, or add it there."
fi

if [ "$secret_code" -ne 0 ]; then
  exit "$secret_code"
fi
if [ "$code" -ne 0 ]; then
  echo "setup-remote.sh: the server will not start as it is: see the message above" >&2
fi
exit "$code"
