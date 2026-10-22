# Goal: build and install the desktop app for macOS or for Windows, on either processor

This document defines an outcome: what building and installing the AI Whiteboard desktop app can do once the work is done. It
says what exists at the end, the decisions already made, the bounds the work must stay inside, and how to confirm that it is
done. It is not an implementation plan and not an order of work. It names no files and no functions; how to build it is for
whoever builds it.

## 1. How to read this

**Marks.** A decision, bound or risk carries one mark. A statement with no mark is `[proposed]`.

- `[user]`: the user decided it (it was said in the chat that started this work).
- `[standing]`: decided before this goal and kept; it is in the architecture document, in another goal or in the code.
- `[proposed]`: proposed while this goal was written. Not a decision of the user.
- `[not verified]`: a risk or an assumption nobody has checked yet.

**Terms.**

- **The desktop app**: the Electron window that carries the app's page, together with the server binary and the headless writer
  it starts. Today it is built as a macOS bundle. It is not the iOS or the Android app.
- **Target**: the pair of operating system (macOS or Windows) and processor (arm64 or x64) the built app is made to run on.
- **Host**: the computer that runs the build. The hosts that matter are macOS and Linux; Linux is where most Windows builds will be made.
- **App build**: the command that makes the desktop app. **App install**: the command that puts a built app where the person
  uses it from.
- **Headless writer**: the Node process that edits boards while no window is open, as in `docs/architecture.md`.

## 2. Goal

Today the desktop app can be built only as a macOS bundle, for the processor of the Mac that builds it, and installed only on
a Mac. At the end the same build command can make the desktop app for macOS, on a Mac, or for Windows, on a Linux computer
(and on a Mac if that comes at no extra cost), for arm64 or for x64 either way, and the install command puts the build made
for the computer it runs on where that computer's user can run it. `[user]`

## 3. What exists when it is done

### 3.1 Choosing the target

- The app build takes an argument that names the operating system: macOS or Windows. `[user]`
- The app build takes an argument that names the processor: arm64 or x64. `[user]` (the user asked that x86 and arm can both
  be built for both operating systems)
- The macOS app is built only on macOS, for arm64 and for x64. This is a must. `[user]`
- The Windows app is built on Linux, for arm64 and for x64. This is a must. `[user]`
- The Windows app built on macOS is wanted where it comes at no extra cost, and is not required. `[user]`
- The server binary (Go) can be built on macOS and on Linux, for every one of the four targets, from either. `[user]`
- The host's processor never decides what can be built: an arm64 and an x64 host each build every target their operating
  system is meant to build. `[user]`
- With no argument, on a Mac, the build makes what it makes today: the macOS app, for the host's own processor, in the same
  place, with the same name and the same contents. A person or a script that never heard of this goal sees no change.
  `[proposed]`
- With no argument on Linux, where there is no target that is the host's own, the build builds nothing and says which targets
  it can build and which arguments name them. `[proposed]`
- A target that cannot be built from this host, or that is not one of the four, is refused at once, before anything is built,
  with a sentence that says which target and why. It never ends in a half-built app. `[proposed]`

### 3.2 What the Windows build is

- The Windows build is the unpacked app: a folder that holds the app's executable and what it needs, which can be run where it
  is or copied or zipped and run elsewhere. It is not an installer and not a single-file portable executable. `[user]`
- The folder carries the same parts as the macOS bundle does, each made for Windows: the Electron window, the server binary,
  the app's web build, the headless writer with its native canvas, the setup for a remote server, and the app's icon. `[proposed]`
- Both the server and the headless writer are made for the same target as the window, and the headless writer's own record of
  its target agrees with the server's. A folder never holds parts for two targets. `[proposed]`
- The Windows build lands in its own named place under the same output folder as the macOS app, so that a macOS build and a
  Windows build, and builds for two processors, can all exist at once without replacing one another. `[proposed]`

### 3.3 Installing

- The app install finds out which operating system it runs on and installs the build made for that one. The person does not
  say which. `[user]`
- On macOS it does what it does today. `[standing]`
- On Windows it puts the unpacked folder in a place that belongs to the user and needs no administrator, replacing a previous
  install of the same app, and leaves the person able to start the app the way Windows users start apps (a shortcut they can
  find). `[user]`
- On Linux there is no app to install, since Linux is not a target: it says so and installs nothing. `[proposed]`
- It installs the build that matches the computer's processor. If only a build for another operating system or processor
  exists, it says which build is missing and how to make it, and installs nothing. `[proposed]`
- It tells the person, as today, when a server from the previous build is still running and how to restart it. `[standing]`

### 3.4 What is the same everywhere

- One version, taken from the repository as now, is stamped into the server, the web build, the app and the headless writer of
  every target. The page, the server and its headless writer are one build. `[standing]`
- The window finds or starts this computer's server, and the server finds its headless writer next to its own binary and runs
  it with the app's own Electron as Node. That keeps working on every target. `[standing]`
- Nothing about what the app does for the person changes: the same page, the same server, the same agents. `[proposed]`

## 4. Decisions and bounds

- The desktop app stays Electron, packaged by the packager already in use. No second packager. `[standing]`
- The build is one command with arguments, not one command per operating system. `[user]`
- The build of the Windows app must run on Linux without any macOS-only tool. The build of the macOS app keeps using the Mac's
  own tools, as today, and is not made to run anywhere else. `[user]`
- The Windows build is the unpacked folder, as the macOS build is an unpacked bundle. An installer, a signed package or a
  single-file executable is later work. `[user]`
- Cross-compiling covers the server (Go), the headless writer (its native canvas is the file of the target, not of the host)
  and, where it matters, Electron: at least the processor that the host does not have, for macOS on a Mac, and the system and
  the processor that the host does not have, for Windows on Linux. Each part is taken or made for the target, never run on the host to make it. `[user]`
- The server binary of a Windows target is a Windows executable and carries the name Windows expects of one. `[proposed]`
- The headless writer is not built as a macOS-only or Linux-only tool any longer: Windows is a target it can be built for, and
  it still refuses a target it cannot build, saying so. `[proposed]`
- The checks the macOS build makes today stay, and each is made for the target it applies to: the headless parts arrived
  intact, the native canvas is present, Electron's RunAsNode fuse is on (the server needs it to run the headless writer), the
  signature is valid where there is one. A check that cannot be made on a target is replaced by one that can, not dropped.
  `[standing]`
- Signing and notarization stay as they are for macOS (ad-hoc, enough to run on the Mac that built it). A Windows build is not
  signed. `[proposed]`
- The Go side stays buildable and testable on the host as today; the default and the full set of Go tests are not made slower
  by this work. `[standing]`
- A change to the macOS build may not make it slower to build or larger than it is now, beyond the cost of the new arguments.
  `[proposed]`

## 5. Out of scope

- An installer, a portable single file, signing, notarization, an update mechanism or a store listing for Windows. `[user]`
- Linux as a target. `[proposed]`
- Building the macOS app on Linux or on Windows. `[user]`
- The iOS and Android apps and their builds. `[standing]`
- Building from a Windows host, for any target. `[user]` (the builds are made on Linux and macOS)
- Installing on Linux. `[proposed]`
- Making the server's agents (Claude, Cursor, pi) work on Windows beyond what is needed to show that the app starts there; that
  is its own piece of work if it turns out to be needed. `[proposed]`
- Automation of the builds (a service that builds on every change). `[proposed]`

## 6. How it is confirmed

Each statement below is confirmed by running it. The macOS builds are confirmed on a Mac; the Windows builds on a Linux host
(a container is enough), and the Go server for every target on both. What only a Windows computer can show is best effort now and is confirmed later by
the person on one (6.4).

### 6.1 The four builds

- On a Mac, the build is run for macOS arm64 and macOS x64. On a Linux host, it is run for Windows arm64 and Windows x64.
  Each ends in a build in its own place; none replaces another. Where the Mac also builds the Windows targets, those are run
  too.
- The Go server is built for all four targets on a Mac and on a Linux host.
- The executables are of the target they were made for (a Windows executable in the Windows folders, macOS binaries in the
  macOS bundles, the processor each target names), for the window, the server and the native canvas.
- An arm64 host and an x64 host make the same parts for the same target; where Windows is built on both a Linux host and a
  Mac, the two hold the same parts.
- One version is stamped in every part of each build, and the headless writer's record of its target matches the server's.
- The checks of 4 pass on each target.

### 6.2 Nothing changed for macOS

- The build run with no argument on a Mac makes the same macOS app, in the same place under the same name, as the build of `main`
  makes: the same files, and the same result of the checks.
- The install run on a Mac does what it did, and a server running from a previous build is reported as before.

### 6.3 Refusal

- An unknown operating system, an unknown processor, and a target this host cannot build (the macOS app on Linux, for one) each stop the build before any work
  is done, with a sentence that names the target.
- The install with no matching build installs nothing, says which build to make, and leaves a previous install in place.

### 6.4 On Windows

There is no Windows computer to hand now, so the work is best effort here: the builds of 6.1 must be right on inspection, and
the statements below are confirmed later by the person on a Windows computer of the processor of the build. The goal is
done without them; they are the first thing to run when such a computer is there, and what they find is reported, not hidden.

- The folder, copied there or installed, starts the window.
- The window starts this computer's server from the folder, and the server's status in the app shows it running.
- The headless writer starts from the folder and answers when no window holds a board.
- The install puts the app where the user can start it without administrator rights, replaces an older install, and the
  version shown in the app is the version built.

### 6.5 Nothing else moved

- The tests of the repository that `AGENTS.md` names for what changed run and pass: `npm test && npm run check` at the root,
  `cd desktop && npm test`, `cd packages/headless && npm test && npm run check` for the headless writer, and the Go tests for
  the packages touched.
- The desktop end-to-end check (`cd desktop && npm run e2e`) still passes on the macOS build.
- The docs that say how the app is built and installed (`docs/development.md`, `README.md`, and `docs/architecture.md` where
  it describes the bundle) say what is now true: the arguments, the four targets, where each build lands, and how to install.

## 7. Risks

- Go's cgo, if the server or one of its dependencies uses it, makes a cross-compile for another operating system or processor
  need a C toolchain for the target. `[not verified]`
- The app build today is written for a Mac: it uses macOS-only tools to sign, copy and verify. The Windows build has to run
  on Linux, where none of them exists. `[standing]`
- The server has never been run on Windows. It starts agent processes, uses file paths and may use signals, and any of those
  may not work there. The goal shows that the app starts on Windows, not that every feature works. `[not verified]`
- The headless writer's native canvas must exist for each of the four targets, and the packager may rewrite or refuse a native
  file of another target than the host's. `[not verified]`
- Electron's own files for a target other than the host's must be fetched at build time; a build with no network may fail.
  `[not verified]`
- The packager may need a helper (an emulation layer) to finish some Windows steps from Linux or from a Mac, such as setting
  the icon and the file's version information on the executable. `[not verified]`
- A Windows build that is not signed may be stopped or warned about by Windows. That is expected and not a defect of this
  goal. `[proposed]`
- The setup for a remote server is a shell script today and may not run on Windows. `[not verified]`
- The macOS signature checks cannot be made on a Windows folder; the replacement checks (4) must be strong enough to catch a
  part that is missing or of the wrong target. `[proposed]`

## 8. Not decided yet

- Whether the app's own check of its server's version, and the install's notice about a running server, behave the same on
  Windows. Best effort in the build; confirmed on a Windows computer later. `[user]`
