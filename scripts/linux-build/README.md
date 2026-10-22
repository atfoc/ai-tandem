# Linux build environment

A Docker image (Node 24, Go 1.25.1 as in `go.mod`, git; Debian bookworm) and a helper to run a build in it, to confirm what must
build on Linux: the Windows app (`electron-builder --win --dir`), the headless writer for every target and the Go server for
every target. Linux is not a target of the app; this is only where Windows builds are made and checked.

## The image

```sh
docker build --platform linux/arm64 -t aiwb-linux-build:arm64 scripts/linux-build   # native on an Apple-silicon or arm64 host
docker build --platform linux/amd64 -t aiwb-linux-build:amd64 scripts/linux-build   # emulated on an arm64 host (about 5 times slower)
```

The repository is not in the image.

## Running a command

```sh
scripts/linux-build/run.sh <arm64|amd64> '<command>'
AIWB_LINUX_OUT=/tmp/out scripts/linux-build/run.sh amd64 \
  'CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -o /out/ai-whiteboard.exe ./cmd/ai-whiteboard'
AIWB_LINUX_DESKTOP=1 scripts/linux-build/run.sh arm64 'scripts/build-app.sh --os windows --arch x64'
```

`run.sh` streams a fresh copy of the repository (the files of `HEAD`) into a new container, so the Mac's `node_modules` and its
native modules (esbuild, skia-canvas) never get in; runs `npm ci` in it (root, and `desktop/` with `AIWB_LINUX_DESKTOP=1`); runs
the command with `bash -c` at the root of the copy (`/work`); and copies back what the command wrote to `/out` and the copy's
`bin/` folder to a host folder, `bin/linux-<arch>` of this repository unless `AIWB_LINUX_OUT` names another. The exit status is
the command's.

| Variable | Meaning |
|---|---|
| `AIWB_LINUX_OUT` | host folder for the results (default `bin/linux-<arch>`) |
| `AIWB_LINUX_SRC` | `head` (default) or `worktree`: the files git knows, with uncommitted changes and new files |
| `AIWB_LINUX_NPM` | `0`: no `npm ci` (the command does it, or needs none) |
| `AIWB_LINUX_DESKTOP` | `1`: also `npm ci` in `desktop/` |
| `AIWB_LINUX_NETWORK` | docker's `--network`; `none` makes a run with no network |
| `AIWB_LINUX_IMAGE` | another image than `aiwb-linux-build:<arch>` |
| `AIWB_VERSION` | the version the build scripts stamp; unless set, `run.sh` passes the host's (see below) |

**The version.** The copy in the container has no `.git`, so `git describe` fails there and the build scripts would stamp `dev`.
`scripts/build-app.sh` and `scripts/build-server.sh` take the version from the environment variable `AIWB_VERSION` when it is set
and not empty, else from `git describe --tags --always --dirty`, else `dev`. `run.sh` computes the host's `git describe --tags
--always --dirty` (`--dirty` left out for `AIWB_LINUX_SRC=head`, which is the files of `HEAD`) and passes it in as `AIWB_VERSION`,
unless the caller set `AIWB_VERSION` already (`AIWB_VERSION=v2 scripts/linux-build/run.sh amd64 '…'` stamps `v2`); so a Linux build carries the repository's version. A command run with `run.sh` that
does not use these scripts (a plain `go build`) is not stamped.

## Caches

Named volumes keep what is downloaded between runs: `aiwb-cache-npm` (npm), `aiwb-cache-go-build` and `aiwb-cache-go-mod` (Go),
`aiwb-cache-electron` and `aiwb-cache-electron-builder` (Electron's zips, which electron-builder keeps in `~/.cache/electron`).
Remove them with `docker volume rm aiwb-cache-npm aiwb-cache-go-build aiwb-cache-go-mod aiwb-cache-electron aiwb-cache-electron-builder`.

- Do not run the two architectures at once: they share the volumes, and the Docker VM of a Mac has few CPUs.
- Go's build cache is shared by both architectures (a release toolchain's compiler has the same id on both), so a build in the
  second one reuses the objects of the first. To compare two hosts honestly, start the command with `export GOCACHE=/tmp/gc;`.
- The Electron zip is fetched at build time, and a build with no network fails even with the zip in the cache
  (it still reaches for github.com; tried with `AIWB_LINUX_NETWORK=none`).
  What can be done by hand with no network: unzip the cached `electron-v<version>-win32-<arch>.zip` into a folder and run
  `npx electron-builder --win --dir --x64 -c.electronDist=<folder>` in `desktop/` (after `scripts/build-app.sh` has made the web
  build, the server and the headless writer and stopped at electron-builder). It builds and `scripts/check-build.mjs` passes, but the
  folder then also holds Electron's `version` and `resources/default_app.asar` and its `AI Whiteboard.exe` differs from the one
  of the downloaded path, so `build-app.sh` does not offer it: a Windows build needs the network for the Electron zip.
