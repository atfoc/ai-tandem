#!/bin/bash
# Runs a command at the root of a fresh copy of this repository, in the Linux build image (scripts/linux-build/Dockerfile):
#   scripts/linux-build/run.sh <arm64|amd64> <command...>
#   AIWB_LINUX_OUT=/tmp/out scripts/linux-build/run.sh amd64 'node packages/headless/build.mjs --os win32 --arch x64 --out /out/h'
# The command is run by bash -c in /work, with the copy's `npm ci` done first (the root, and desktop/ when AIWB_LINUX_DESKTOP=1).
# Environment:
#   AIWB_LINUX_OUT      host folder that receives the results (default: bin/linux-<arch> of this repository): what the command
#                       wrote to /out, and the bin/ folder of the copy if the command made one (as bin/ in the folder)
#   AIWB_LINUX_SRC      head (default: the files of HEAD, `git archive`) or worktree (the files git knows, with this checkout's
#                       uncommitted changes and new files)
#   AIWB_LINUX_NPM      0: do not run npm ci (the command does)
#   AIWB_LINUX_DESKTOP  1: also npm ci in desktop/ (electron-builder)
#   AIWB_LINUX_NETWORK  docker's --network (default: the default; none: a run with no network, which needs warm caches)
#   AIWB_LINUX_IMAGE    the image (default: aiwb-linux-build:<arch>)
#   AIWB_VERSION        the version the build scripts stamp (scripts/build-app.sh, build-server.sh). The copy has no .git, so
#                       `git describe` can't be had in the container: unless this is set, run.sh passes the host's
#                       `git describe --tags --always --dirty` (for AIWB_LINUX_SRC=head, of HEAD, without --dirty)
# The checkout of the Mac (with its node_modules: native modules of the Mac) is never mounted: the copy is made in the container
# from a tar stream. The caches (npm, Go, Electron) are named docker volumes (aiwb-cache-*), so a later run is faster; the
# volumes are shared by the two architectures, so do not run both at once.
set -euo pipefail

arch="${1:-}"
case "$arch" in arm64 | amd64) shift ;; *) echo "usage: scripts/linux-build/run.sh <arm64|amd64> <command...>" >&2; exit 2 ;; esac
[ $# -ge 1 ] || { echo "usage: scripts/linux-build/run.sh <arm64|amd64> <command...>" >&2; exit 2; }
cmd="$*"

root="$(cd "$(dirname "$0")/../.." && pwd)"
image="${AIWB_LINUX_IMAGE:-aiwb-linux-build:$arch}"
out="${AIWB_LINUX_OUT:-$root/bin/linux-$arch}"
src="${AIWB_LINUX_SRC:-head}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
if [ -z "${AIWB_VERSION:-}" ]; then
  if [ "$src" = head ]; then dirty=""; else dirty="--dirty"; fi
  AIWB_VERSION="$(git -C "$root" describe --tags --always $dirty 2>/dev/null || true)"
fi
docker image inspect "$image" >/dev/null 2>&1 || {
  echo "no image $image; make it with: docker build --platform linux/$arch -t $image $root/scripts/linux-build" >&2
  exit 1
}

pack() {
  case "$src" in
    head) git -C "$root" archive HEAD ;;
    worktree)
      (cd "$root" && git ls-files -z --cached --others --exclude-standard |
        xargs -0 bash -c 'for f; do [ -e "$f" ] && printf "%s\0" "$f"; done' _ |
        COPYFILE_DISABLE=1 tar --no-xattrs --null -T - -cf -)
      ;;
    *) echo "AIWB_LINUX_SRC is head or worktree, not $src" >&2; exit 2 ;;
  esac
}

# In the container: unpack the stream, install, run the command, and hand the results to /host-out (also when the command fails).
inside='
set -euo pipefail
mkdir -p /work /out && tar -x --warning=no-unknown-keyword -C /work && cd /work
if [ "${AIWB_LINUX_NPM:-1}" != 0 ]; then
  npm ci --no-audit --no-fund
  [ "${AIWB_LINUX_DESKTOP:-0}" != 1 ] || (cd desktop && npm ci --no-audit --no-fund)
fi
status=0
bash -c "$AIWB_COMMAND" || status=$?
cp -a /out/. /host-out/ 2>/dev/null || true
[ ! -d /work/bin ] || { mkdir -p /host-out/bin && cp -a /work/bin/. /host-out/bin/; }
exit $status
'

pack | docker run --rm -i \
  --platform "linux/$arch" \
  ${AIWB_LINUX_NETWORK:+--network "$AIWB_LINUX_NETWORK"} \
  -v aiwb-cache-npm:/cache/npm \
  -v aiwb-cache-go-build:/cache/go-build \
  -v aiwb-cache-go-mod:/go/pkg \
  -v aiwb-cache-electron:/root/.cache/electron \
  -v aiwb-cache-electron-builder:/root/.cache/electron-builder \
  -v "$out:/host-out" \
  -e AIWB_COMMAND="$cmd" \
  ${AIWB_VERSION:+-e "AIWB_VERSION=$AIWB_VERSION"} \
  -e AIWB_LINUX_NPM="${AIWB_LINUX_NPM:-1}" \
  -e AIWB_LINUX_DESKTOP="${AIWB_LINUX_DESKTOP:-0}" \
  "$image" bash -c "$inside"
