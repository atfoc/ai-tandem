#!/bin/bash
# Builds the phone and tablet app from the current code and installs it on a device: see docs/development.md, "Install the app on a phone or tablet".
# Usage: scripts/install-app-device.sh --platform android|ios [--device <id|name>] [--check] [--no-open]
exec node "$(cd "$(dirname "$0")/.." && pwd)/app/scripts/install.mjs" "$@"
