#!/bin/sh
# Starts the AI Whiteboard server of this folder in the background, if it is not running, and
# prints its address and the fingerprint of its certificate. It can be called from any folder. A
# server that was never set up does not start: run setup-remote.sh once first.
#
#   sh start-server.sh [--restart] [server flags]
#
#   --restart      stop the running server first (`relaunch` in place of `launch`); it must be
#                  the first argument
#   server flags   passed on as they are, for example -home DIR (the data folder, default
#                  ~/.ai-whiteboard) and -cwd DIR (the default working folder for new chats,
#                  default the current folder)
#
# Stop the server with: ./ai-whiteboard stop
# AIWB_SERVER_BIN, when set, is the server program to start in place of the one beside the script.
set -eu

dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
bin=${AIWB_SERVER_BIN:-$dir/ai-whiteboard}

case ${1-} in
  -h | --help)
    sed -n '2,/^set -eu$/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//' >&2
    exit 0
    ;;
esac
if [ ! -x "$bin" ]; then
  echo "start-server.sh: no ai-whiteboard program at $bin. Call the script by its real path, not through a link to it." >&2
  exit 1
fi

command=launch
if [ "${1-}" = --restart ]; then
  command=relaunch
  shift
fi
exec "$bin" "$command" "$@"
