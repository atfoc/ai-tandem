# W14 — The Mac app's Electron as the runtime (probe)

**Result: it works. No code change was needed.** On the app built by `scripts/build-app.sh` (version `e530a81d`, darwin/arm64, ad-hoc
signed, Electron 44.4.5), the bundle's own server binary, started with a PATH that has no `node` and with no `-headless-*` flag, ran
an away call (`read_board`, `apply` of a labelled rectangle, `get_image`) with the headless writer on the app's Electron under
`ELECTRON_RUN_AS_NODE=1`. The native canvas loaded, the PNG was drawn, no Dock icon or window appeared. D33.2 is confirmed
(`[not verified]` can come off it), with the cautions under "Things that can break it".

## What was run

- `scripts/build-app.sh` (30 s) → `bin/AI Whiteboard.app`.
- `plans/headless-board/w14-probe.mjs <app> <scratch folder> internal/agenttest/fake-claude <absolute node>` (the scratch server of
  ORCHESTRATION: `remote setup`, then `launch -json` with `-home <tmp>/home -cwd -claude <fake> -cursor/-pi/-cursor-cost
  /nonexistent/...`, `AIWB_MCP_PORT=0`, `AIWB_REMOTE_BIND=127.0.0.1`; it never touched `~/.ai-whiteboard`, the user's server or ports
  4748/6006). The environment of every command of the probe: `PATH=/usr/bin:/bin`, `SHELL=/usr/bin/false` (see "Finding 1").
- The agent is the fake claude. Its shebang is `#!/usr/bin/env node`, which cannot start with no `node` on the PATH, so the probe
  copies it with the shebang set to the absolute node. (Only the agent stand-in uses that node; the server and the writer do not.)
  One chat message: `[[mcp read_board {}]] [[mcp apply {"create":[{"type":"rectangle","key":"w14",…,"label":"W14 probe",…}]}]]
  [[mcp get_image {}]]`, on a new ungrouped board with no window connected (an away call).

## Evidence

- **Server log**: `headless writer: started …/AI Whiteboard.app/Contents/MacOS/AI Whiteboard (pid 34501, electron)`.
- **`ps`**: pid 34501, parent the scratch server (34494), command
  `…/Contents/MacOS/AI Whiteboard …/Contents/Resources/headless/headless.mjs`; its environment has `ELECTRON_RUN_AS_NODE=1` and
  `PATH=/usr/bin:/bin` (no `node` in `/usr/bin` or `/bin`).
- **Chat reply** (the tool texts): `read_board -> away (b_…) (rev 0, 0 elements) (empty board)`;
  `apply -> {"board":"away",…,"created":{"w14":"…"},"conflicts":[],"rev":1}`;
  `get_image -> scope all, bounds x=100 y=100 w=240 h=120 (board coordinates), 1 element, away (b_…)`. The whole turn, including the
  writer's start, took 0.3 s.
- **Native canvas**: `lsof -p 34501` lists `…/Resources/headless/engine/node_modules/skia-canvas/lib/skia.node` mapped in the writer.
- **The picture**: the fake claude keeps only the text parts of a tool result, so the probe repeated `get_image` against the chat's
  MCP endpoint: parts `text` + `image` (`image/png`), a valid PNG, signature `89504e470d0a1a0a`, 272×152 — a light-blue rectangle
  with a black outline and the label "W14 probe" in the board's font (the written text shows the engine's fonts loaded too).
- **`status -json`**: before the call `"headless":{"available":true,"reason":"","running":false,"pid":0,"boards":0}`; after it
  `{"available":true,"reason":"","running":true,"pid":34501,"boards":1}`.
- **No Dock icon, no window**: `osascript … get name of every process whose background only is false` was
  `Finder, Google Chrome, Simulator, iTerm2` before, in every sample taken every 150 ms during the call and after it, and after the
  server stopped. `lsappinfo list` (names) gained no entry in any sample (`AI Whiteboard` is never in it). Electron started by `exec`
  from the server with `ELECTRON_RUN_AS_NODE=1` runs Node only: it does not start AppKit's application, so it never registers with
  LaunchServices; **no `LSUIElement` or other handling is needed** (the app's Info.plist is untouched). (Sampled by tools, not seen
  on a screen.)
- **Stop**: `stop -home <scratch>` ended the server; no `headless.mjs` process was left (`pgrep`).
- The same `skia.node` (the one in the app, ad-hoc re-signed by electron-builder) loads in the app's Electron (Node 24.21.0, ABI 149,
  N-API 10) and in a system Node 24.3.0 (ABI 137, N-API 10): it is N-API, as D33.2 asked.

## Finding 1 — `launch` puts the login shell's PATH in front

`launch` runs `usePath(loginPath())` (`cmd/ai-whiteboard/launch.go:58`): the server it starts gets the PATH that `$SHELL -ilc` prints,
plus the entries of the given PATH. So `PATH=/usr/bin:/bin ai-whiteboard launch` on a machine with Node in the user's profile gives
the server a PATH **with** node (my first two runs showed `/opt/homebrew/bin` in the writer's environment). It does not change which
runtime is chosen — Electron comes before `node` on PATH in `findRuntime` — but a test of "no node" must make the shell print
nothing (`SHELL=/usr/bin/false`: `loginPath` gets no output and `usePath` does nothing) or run `serve` directly. The probe does the
former, and the writer's PATH was `/usr/bin:/bin`. Not a bug: the same line is what lets an app started from Finder find `claude`.

## Hardened runtime and library validation, if the app is ever signed with a real identity

What the build is today (`codesign -d`): the app and every Mach-O in it are **ad-hoc** signed (`flags=0x2(adhoc)`, no `runtime`
flag, no Team ID; `hardenedRuntime: false`). The main executable still carries electron-builder's default entitlements
(`codesign -d --entitlements :- "AI Whiteboard.app"`): `com.apple.security.cs.allow-jit`, `…allow-unsigned-executable-memory`,
`…disable-library-validation`. `skia.node` has its own ad-hoc signature (identifier `skia-…`). The Go server has an ad-hoc signature too.

Apple's rules: with the hardened runtime on, (1) JIT needs `allow-jit` (V8 in Node mode needs it as much as the app does); (2)
library validation lets a process load only libraries signed by Apple or with the **same Team ID** as the process. `skia.node` is
loaded by `dlopen` into the Electron process, so it is a library for the rule.

Measured, on a copy-on-write copy of the built app in which only `Contents/MacOS/AI Whiteboard` was re-signed ad-hoc (no identity
and no credential was used; the copy was deleted):

| Signature of the executable | Result of `ELECTRON_RUN_AS_NODE=1 "AI Whiteboard" w14-skia-load.js` |
|---|---|
| as built (ad-hoc, no `runtime`) | OK, a PNG |
| `--options runtime` + the three entitlements above | OK, a PNG |
| `--options runtime` + `allow-jit`, `allow-unsigned-executable-memory` only | dyld: *Electron Framework … not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs*; the process does not start |
| `--options runtime`, no entitlements | the same dyld failure |

(An ad-hoc signature has no Team ID, so library validation cannot succeed between two ad-hoc files; the last two rows exist only
because the test has no identity. They show that library validation is enforced on exactly this path.)

What that means for a real identity (Developer ID Application) with `hardenedRuntime: true` — reasoned, not measured:

- electron-builder signs every Mach-O of the bundle with the one identity, `Resources/headless/engine/node_modules/skia-canvas/lib/skia.node`
  among them (build-app.sh already checks that the file is signed and the bundle verifies). All carry the same Team ID, so library
  validation passes for `skia.node` and for the Electron Framework. The default entitlements already include
  `disable-library-validation`, so it would pass even if a file were signed by another party.
- The entitlements must stay (`allow-jit`, `allow-unsigned-executable-memory`): the writer is the same executable and runs V8. A
  signing configuration must not replace electron-builder's default entitlements file with one that lacks them.
- The Go server `Contents/MacOS/ai-whiteboard` is a separate process that starts Electron by `exec`; no library validation concerns
  that, and it needs no entitlement for it.
- Notarization requires every nested executable (the server, `skia.node`) to be signed with the hardened runtime and a secure
  timestamp, which electron-builder does when `hardenedRuntime: true`. Gatekeeper checks a downloaded app once, at the user's first
  launch of it; the server's `exec` of the app's own binary is not a new launch.
- No `allow-dyld-environment-variables` is needed: the writer's only special environment is `ELECTRON_RUN_AS_NODE`, which Electron's
  own code reads, not dyld.

## Things that can break it

1. **The `RunAsNode` fuse.** In the app's Electron it is on (`w14-fuses.mjs` reads the fuse wire of the Electron Framework:
   `RunAsNode 1`, `EnableNodeOptionsEnvironmentVariable 1`). If a later hardening step flips `RunAsNode` off (`@electron/fuses`,
   electron-builder's `electronFuses`), `ELECTRON_RUN_AS_NODE` is ignored and the "AI Whiteboard" executable would start the whole
   app with the script as an argument: a window and a Dock icon, and no writer (the start limit would end it). Keep it on, or add a
   check to the build that reads the fuse wire.
2. **Signing**: the entitlements of the main executable must keep `allow-jit` and `allow-unsigned-executable-memory` (above).

## Linux server folders (EN7 merged)

`scripts/build-server.sh linux/amd64` and `linux/arm64` both built (manifest `{"version":"e530a81d","os":"linux","arch":"x64"|"arm64"}`):

```
bin/ai-whiteboard-server-linux-amd64/headless/engine/node_modules/skia-canvas/lib/skia.node: ELF 64-bit LSB shared object, x86-64, version 1 (SYSV), dynamically linked, BuildID[sha1]=9f35fe4d…, not stripped
bin/ai-whiteboard-server-linux-arm64/headless/engine/node_modules/skia-canvas/lib/skia.node: ELF 64-bit LSB shared object, ARM aarch64, version 1 (SYSV), dynamically linked, BuildID[sha1]=c1a5048b…, not stripped
```

Each is the architecture of its folder (the Go binaries beside them: static x86-64 and static aarch64). Not run (no Linux machine here).

## Fallbacks

None needed. If the `RunAsNode` fuse is ever turned off, the fallbacks are what D33 already has: `-headless-node` /
`AIWB_HEADLESS_NODE` with a Node, or a Node 22+ on PATH; shipping a Node in the app would be the last resort.

## Files

- `plans/headless-board/w14-probe.mjs` — the probe described above.
- `plans/headless-board/w14-fuses.mjs` — reads the Electron fuse wire of a framework binary.
- `plans/headless-board/w14-skia-load.js` — loads skia-canvas from a headless folder and draws a PNG; run as
  `ELECTRON_RUN_AS_NODE=1 "AI Whiteboard" w14-skia-load.js <…/Resources/headless>` or with `node`.
