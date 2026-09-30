#!/bin/sh
# PROTOTYPE ONLY (branch fork-chat-feature): builds this checkout and runs it on its own port and
# data folder, next to the real app. The fork demo chats live in the browser tab (web/src/forkDemo.ts),
# answered by a fake agent; the server never sees them.
#
#   scripts/proto-fork.sh            # http://127.0.0.1:4750
#   scripts/proto-fork.sh --reset    # start again from a fresh data folder
#
# PROTO_HOME (default /tmp/aiwb-fork-demo) and PROTO_PORT (default 4750) change where it runs.
# Cursor's CLI config is copied into the data folder, so the rules the server adds for its data
# folder never reach ~/.cursor.
set -e
cd "$(dirname "$0")/.."
root=$(pwd)
home=${PROTO_HOME:-/tmp/aiwb-fork-demo}
port=${PROTO_PORT:-4750}

[ "$1" = "--reset" ] && rm -rf "$home"
(cd web && [ -d node_modules ] || npm ci --silent) && (cd web && npm run build --silent >/dev/null)
go build -o bin/ai-whiteboard ./cmd/ai-whiteboard

mkdir -p "$home/cursor-config"
real="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/cli-config.json"
[ -f "$real" ] && [ ! -f "$home/cursor-config/cli-config.json" ] && cp "$real" "$home/cursor-config/cli-config.json"
export CURSOR_CONFIG_DIR="$home/cursor-config"

echo "Chat forking prototype: http://127.0.0.1:$port  (data: $home)"
exec ./bin/ai-whiteboard serve -port "$port" -home "$home" -client web/dist -cwd "$root"
