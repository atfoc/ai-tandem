#!/bin/bash
# Builds the phone and tablet app from the current code and installs it on a device: see docs/development.md, "Install the app on a phone or tablet".
# Usage: scripts/install-app-device.sh --platform android|ios [--device <id|name>] [--check] [--no-open]
#        or, for iOS, an .ipa file instead of an install: --ipa [--out <dir>] [--method development|ad-hoc], and --serve to open it by a link over https on the local network
exec node "$(cd "$(dirname "$0")/.." && pwd)/app/scripts/install.mjs" "$@"
