# Cross-platform build: decisions and work packages

The goal is `cross-platform-build-goal.md` at the repository root. This file fixes the decisions every work package
builds on, so packages can be built in parallel. A change to a decision here is made here first.

## Decisions (D)

**D1. One build command, two flags.** `scripts/build-app.sh [--os <os>] [--arch <arch>]`.
- `--os`: `macos` (aliases `mac`, `darwin`) or `windows` (aliases `win`, `win32`).
- `--arch`: `arm64` or `x64` (alias `amd64`).
- On a Mac with no flag: the macOS app for the host's processor, exactly as today. `--arch` alone on a Mac means macOS.
  `--os windows` alone means the host's processor.
- On Linux with no `--os`: builds nothing, prints the targets it can build and the flags that name them, exits 2.
  `--arch` alone on Linux is refused the same way (no default OS there).
- Refusals (unknown OS, unknown arch, macOS on Linux, any host that is not macOS or Linux) happen before any work, with
  one sentence naming the target and why, exit 2. Nothing in `bin/` is touched by a refused build.
- Windows from a Mac is attempted with the same code path as from Linux (it must not use a macOS-only tool); it is
  "wanted, not required": if it works, it is documented as working.

**D2. Where builds land** (all under `bin/`, none replaces another):
| Target | Place |
|---|---|
| macOS, host's processor (the default) | `bin/AI Whiteboard.app` (unchanged) |
| macOS, the other processor | `bin/macos-<arch>/AI Whiteboard.app` |
| Windows | `bin/windows-<arch>/AI Whiteboard/` (the unpacked folder; `AI Whiteboard.exe` inside) |

A rebuild of one target replaces only that target's place.

**D3. Inside the Windows folder** (electron-builder `--win --dir`, its normal layout):
```
AI Whiteboard/AI Whiteboard.exe          Electron (the window), app icon and version info set
AI Whiteboard/ai-whiteboard.exe          the Go server, next to the window's executable (as in Contents/MacOS)
AI Whiteboard/resources/app.asar
AI Whiteboard/resources/web/             the app's web build
AI Whiteboard/resources/remote/setup-remote.sh
AI Whiteboard/resources/headless/        headless.mjs, manifest.json, engine/ (skia.node of win32-<arch>)
AI Whiteboard/resources/AppIcon.ico
```
The server finds the Electron runtime and the headless folder from its own place on Windows too (D7).

**D4. Names.** Go uses `windows`/`amd64`/`arm64`; Node and electron-builder use `win32`/`x64`/`arm64`. The headless
writer's `manifest.json` keeps Node names (as today: `darwin`/`linux`/`win32`, `arm64`/`x64`). "Agrees with the server"
means: manifest `os`/`arch` mapped to Go names equals the server binary's target. The build checks this.

**D5. Packager.** electron-builder stays the only packager. Per-platform `extraFiles` (the server binary goes to
`MacOS/ai-whiteboard` on mac, `ai-whiteboard.exe` on win). The Windows build must run on Linux without Wine and without
any macOS tool. If electron-builder needs Wine to set the icon/version info of the exe, turn that step off for win
(`signAndEditExecutable: false`) and set icon and version info in an `afterPack` step with a pure-JS editor (`resedit`,
a devDependency of `desktop/`). The Windows icon is `assets/icon/AppIcon.ico`, made from `AppIcon.png` by
`scripts/make-icons.py` and checked in. Windows is not signed.

**D6. Go server on Windows, stdlib only.** The module has no dependencies today and gets none (no `golang.org/x/sys`):
Windows-only calls go through `syscall` (and `syscall.NewLazyDLL` for kernel32 procs such as `LockFileEx`). Unix code
moves behind `//go:build !windows`, the Windows twin is `_windows.go`. On Unix nothing changes in behaviour or tests.
Windows behaviour, best effort: a process "group" is the process tree (`taskkill /T` or a Job Object); a signal other
than kill becomes kill; the detached launch uses `CREATE_NEW_PROCESS_GROUP|DETACHED_PROCESS`; the lock is `LockFileEx`;
the remote reload (SIGUSR1) says on Windows that it needs a restart of the server instead. Agents on Windows are out of
scope beyond compiling and not crashing. `CGO_ENABLED=0 GOOS=windows go vet ./...` must pass for amd64 and arm64.

**D7. Server finds its runtime and headless writer on Windows.** Beside `<exe dir>/../Resources/headless` and
`<exe dir>/headless`, `findBundle` also tries `<exe dir>/resources/headless`; `findRuntime` takes the desktop app's Electron
when `<exe dir>/AI Whiteboard.exe` exists next to the server on Windows (the mac rule is unchanged). The desktop app's
`serverBin` is `ai-whiteboard.exe` on win32.

**D8. Checks per target** (a Node script, `scripts/check-build.mjs <app-or-folder> --os <os> --arch <arch> --version <v>`,
run by the build after packaging; no macOS tool needed for a Windows target):
- headless parts arrived intact (byte-compare `headless.mjs`, `manifest.json`, `engine/engine.mjs` with the build's copy);
- the window's executable, the server and `skia.node` are executables of the target: Mach-O cpu type for macOS, PE machine
  type (0x8664 x64, 0xAA64 arm64) for Windows (`skia.node` a DLL);
- the manifest's version is the build's version, its os/arch the target (D4); the version is in the web build;
- the RunAsNode fuse is on (`@electron/fuses` reads both formats);
- macOS only: `codesign --verify` of `skia.node` and of the app (kept in `build-app.sh`, as today).
`scripts/check-run-as-node.mjs` stays (it may be called by the new script).

**D9. Install.** `scripts/install-app.sh` detects the OS: macOS installs (as today) the build of the Mac's processor —
`bin/AI Whiteboard.app` if its executable is of that processor, else `bin/macos-<arch>/AI Whiteboard.app`, else it says
which build is missing and the command that makes it, and installs nothing. Linux: says Linux is not a target, installs
nothing, exit 1. Git Bash/MSYS/Cygwin on Windows: runs `scripts/install-app.ps1`. `scripts/install-app.ps1` (Windows
PowerShell 5.1, no admin): the processor from `RuntimeInformation.OSArchitecture` (not `PROCESSOR_ARCHITECTURE`, which
lies under emulation); copies `bin\windows-<arch>\AI Whiteboard` to `%LOCALAPPDATA%\Programs\AI Whiteboard` (replacing a
previous install only after the source is found, so a missing build leaves the old install in place), makes a Start Menu
shortcut `%APPDATA%\Microsoft\Windows\Start Menu\Programs\AI Whiteboard.lnk`; prints the running-server notice when
`%USERPROFILE%\.ai-whiteboard\server.json` exists, with `"...\ai-whiteboard.exe" relaunch`.

**D10. Server-only folders.** `scripts/build-server.sh` also takes `windows/amd64` and `windows/arm64` (the binary named
`ai-whiteboard.exe`). Every one of the six targets builds from macOS and Linux, on either processor.

**D11. Tests and speed.** No new Go test in the default set that builds binaries for other targets; a cross-compile
check of Windows belongs in the build script and in the verification, not in `go test`. JS unit tests for the new pure
logic (flag parsing / target table if written in Node, PE/Mach-O header checks, `serverBin`).

## Work packages

| WP | What | Depends on |
|---|---|---|
| WP1 | Go server compiles for Windows and does the D6/D7 Go parts | — |
| WP2 | Headless writer and board engine accept win32 targets (skia win32 binaries, PE check, manifest) | — |
| WP3 | Desktop: `serverBin` on win32, electron-builder config per platform, Windows icon, no-Wine exe edit | — |
| WP4 | Install: `install-app.sh` OS/arch detection and `install-app.ps1` | — (uses D2) |
| WP5 | `build-app.sh` flags, refusals, per-target places, `check-build.mjs`; `build-server.sh` Windows | WP1–WP3 |
| WP6 | Verification of goal §6 on the Mac and in Linux containers (arm64 and amd64) | WP1–WP5 |
| WP7 | Docs: `docs/development.md`, `README.md`, `docs/architecture.md` | WP5 |
