# The default image of a Claude account's container: Claude Code on Node, with git, and the tools
# the run wrapper uses (setsid from util-linux, script from bsdutils) and the kill uses (procps).
#
# The server builds it itself, on first need, as aiwb/claude:<the app's version>
# (`docker build -t aiwb/claude:<version> -`, this file on stdin, no context), so Claude Code is
# the latest at build time and only changes with a new version of the app.
#
# A custom image chosen for an account instead needs `claude` on its PATH and /bin/sh; setsid
# (util-linux) and script (util-linux/bsdutils) are recommended: without them a run is not in a
# process group of its own, and a login gets no pseudo-terminal. The container's command is
# `sleep infinity`, so the image's entrypoint must pass its command through.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates procps util-linux bsdutils \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

ENV DISABLE_AUTOUPDATER=1
LABEL aiwb.image=1
