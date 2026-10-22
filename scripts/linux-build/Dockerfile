# A Linux build environment for AI Whiteboard: Node 24 (the repository's), Go (the version of go.mod) and git, nothing of macOS.
# Used to confirm the builds that must work on Linux (the Windows app, the server and the headless writer for every target).
# The repository is not in the image: scripts/linux-build/run.sh copies a fresh checkout into each container.
#   docker build --platform linux/arm64 -t aiwb-linux-build:arm64 scripts/linux-build
#   docker build --platform linux/amd64 -t aiwb-linux-build:amd64 scripts/linux-build
FROM node:24-bookworm

# The version in go.mod; the official tarball for the architecture of the image.
ARG GO_VERSION=1.25.1
ARG TARGETARCH
RUN set -eux; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" -o /tmp/go.tgz; \
    tar -C /usr/local -xzf /tmp/go.tgz; \
    rm /tmp/go.tgz; \
    /usr/local/go/bin/go version

ENV PATH=/usr/local/go/bin:/go/bin:$PATH \
    GOPATH=/go \
    GOCACHE=/cache/go-build \
    GOFLAGS=-buildvcs=false \
    npm_config_cache=/cache/npm \
    CI=true
# (-buildvcs=false: the fresh copy of the repository has no .git, and Go would stamp a version control state otherwise.
#  CI=true: electron-builder and npm do not ask or draw progress. electron-builder keeps the Electron zips in ~/.cache/electron
#  whatever ELECTRON_CACHE says; run.sh puts a volume there.)

WORKDIR /work
