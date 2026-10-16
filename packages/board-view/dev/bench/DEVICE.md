## On a device

The numbers that count are those of a real iPhone or iPad on a **Release** build (goal 4.6): a simulator and a development build
say little about smoothness. `device.mjs` does the Mac's part in one command; you do the taps on the device.

```sh
node packages/board-view/dev/bench/device.mjs --device Pedja                  # builds, installs, waits, writes the result
node packages/board-view/dev/bench/device.mjs --device Pedja --auto --label dark-css
node packages/board-view/dev/bench/device.mjs --device Pedja --auto --modes experiment   # the criterion's 5 modes only (about 7 min)
node packages/board-view/dev/bench/device.mjs --device Pedja --auto --modes replacement  # light, the 5 themes, the 5 themes as today (about 15 min)
node packages/board-view/dev/bench/device.mjs --device Pedja --no-install     # the bench build is already on the device
node packages/board-view/dev/bench/device.mjs --help                          # every option and the exit codes
```

### What it measures, and for how long

`--modes` takes a set of modes, a list of modes, or both (`README.md` here, "Sets of modes"):

| `--modes` | Modes | Expected on a phone |
|---|---|---|
| `all` (the default) | 14: light, the 5 `<theme>`, the 5 `<theme>-today`, dark-css, dark-none, dark-matrix | about 19 min |
| `replacement` | 11: light, the 5 `<theme>`, the 5 `<theme>-today` | about 15 min |
| `experiment` | 5: light, dark-today, dark-css, dark-none, dark-matrix (what `experiment.md`'s criterion reads) | about 7 min |

The script prints the modes and the expected duration at the start. The default is `all` because its estimate, with a load of 4 s per
board (a guess: a phone has not been measured; a Mac and the simulator load in about 0.5 s), stays under 20 minutes; a test holds it there
(`test/benchdevice.test.ts`). If a phone is slower than that guess, run the other sets one after another instead:
`--modes experiment`, then `--modes replacement` (each run is a separate build and a separate pair of files; use `--label`). The modes
are built into the page (`AIWB_BOARD_BENCH_MODES`); the page says its modes and the expected time in its first progress line.

### What it does

1. Takes the device lock, `mkdir /tmp/aiwb-ios-device.lock` (one agent at a time on the physical devices), and removes it on every
   way out, Ctrl-C included. If the folder exists it stops with exit 4; wait for the other work to end. `--simulator` needs no lock.
2. Checks the device with `xcrun devicectl list devices`. If it is not reachable it stops with exit 3 and says what to do: connect
   it by cable (or the same Wi-Fi with "Connect via network" paired), unlock it, keep the screen on, answer Trust This Computer,
   check that `xcrun devicectl list devices` shows it as `available`, and run again.
3. Finds this Mac's address on the local network (the interface of the default route) and starts the **collector**
   (`collect.mjs`, an HTTP server on all interfaces, a free port or `--port`) that the page in the phone posts to.
4. Unless `--no-install`, installs a bench build with `zsh -ic 'node app/scripts/install.mjs --platform ios --device "<device>"'`
   (so that `~/.zshrc` gives the signing team; the script never prints it), with
   `EXPO_PUBLIC_AIWB_SELFTEST=1` (the app opens the self-test screen), `AIWB_BOARD_BENCH=1` (the board's page has the bench inside),
   `AIWB_BOARD_BENCH_REPORT=http://<this Mac>:<port>/report`, `AIWB_BOARD_BENCH_MODES=<--modes>` and, with `--auto`, `AIWB_BOARD_BENCH_AUTO=1`. The build takes
   several minutes. The install runs with a fresh empty `TMPDIR` (removed afterwards), because Metro's transform cache lives in
   `$TMPDIR/metro-cache`, is shared by every worktree and is not keyed by `EXPO_PUBLIC_*`: a stale one gives the normal app, not the
   self-test screen. Afterwards the built `main.jsbundle` is searched for `SelfTestRoot`; without it the run stops with exit 5.
   If the install fails, it stops with exit 5 and names the install's log folder.
5. Waits for the progress lines and the result, up to `--timeout-min` (30), printing each line as `[bench] ...`.

### The taps

When the install is done (or at once with `--no-install`) the script prints these. Do them on the device:

1. Open **AI Whiteboard**. It shows the self-test screen.
2. Tap **Open board self-test**. The board opens and its self-test boards load.
3. Tap **Run bench** at the top of the board. (With `--auto` the bench starts by itself 10 s after the self-test's boards stop
   arriving.)
4. Keep the device still, on power if you can, with the screen on and unlocked, for the expected duration (printed at the start). Do not touch it while it
   runs: a touch or a locked screen spoils the frames.

### On the simulator (no taps by hand)

`--simulator --device <your simulator> --auto` builds a Release bench build and waits like the above; the one tap, **Open board self-test**,
can be made with Maestro (`sh app/e2e/get-maestro.sh` puts it in `app/e2e/.tools/`, git-ignored). A flow of four lines, kept outside the
repository:

```yaml
appId: dev.atfoc.aiwb
---
- launchApp
- extendedWaitUntil: { visible: { id: "selftest-board" }, timeout: 60000 }
- tapOn: { id: "selftest-board" }
```

```sh
T=app/e2e/.tools; JAVA_HOME=$PWD/$T/java-home PATH=$PWD/$T/maestro/maestro/bin:$PATH maestro --device <udid> test tap.yaml
```

The run of `--modes replacement` took 11 minutes on the simulator (the estimate: 11); the build 2.5 minutes. Delete the simulator afterwards.

### The files

`--out` (default `plans/excalidraw-optimization/runs/` at the repository root) gets two files with the same name,
`bench-<label or device name>-<YYYYMMDD-HHMM>.json` and `.md`:

- `.json` is the page's result as it came (the schema is at the top of `stats.mjs`: every run with its frame intervals, and the summary);
- `.md` is `formatSummary`: a table per board with fps (mean, min–max), the share against plain light, the p95 frame time and the
  janky share, under a title with the device, its model and iOS version (from `devicectl`), "Release build" and the `--label`;
  below it the exact command that made it.

Use `--label` for what the build is (`baseline`, `filter-v2`): it is in the file name and in the title. Two runs in the same
minute with the same label get `-2`, `-3`.

### Put the normal app back

The device keeps the bench build, with its self-test screen, until you install the normal app. The script prints the command at the
end and does not run it; it is the install without the variables:

```sh
zsh -ic 'node app/scripts/install.mjs --platform ios --device "Pedja"'
```

### When the phone does not reach the Mac

The page posts to `http://<the Mac's address>:<port>/report`. If `device.mjs` shows no `[bench]` line after you tapped, or ends with
exit 6 and "Not one progress line arrived":

- The phone must be on **the same Wi-Fi** as the Mac (not a guest network that isolates devices, not cellular, not a VPN on either).
- On iOS, **Settings > Privacy & Security > Local Network > AI Whiteboard** must be on. The app asks the first time it reaches a
  device on the local network; if you answered No, switch it on there and open the board again.
- A firewall on the Mac must let `node` accept incoming connections (System Settings > Network > Firewall).
- Check by hand: open `http://<the Mac's address>:<port>/` in Safari on the phone; it answers `aiwb bench collector`. The address
  and port are on the `collector:` line the script prints.

**The fallback.** The bench page also shows its summary on the phone's screen when it ends. If the report never arrives, photograph
that screen; the numbers are the same as those in the `.md`. (To get the files, run again with the network fixed: the result is not
stored on the device.)

### The collector alone

`collect.mjs` can be used without `device.mjs` (for a browser run, or a simulator by hand):

```js
import { startCollector } from "./collect.mjs";
const c = await startCollector({ port: 5555 });          // c.url("192.168.1.23") → http://192.168.1.23:5555/report
c.progress.on("line", (text) => console.log(text));
const result = await c.result;                            // the first {"kind":"aiwb-board-bench", ...}; c.latest() is the last
await c.close();
```

It takes `POST /report` (a JSON body, 20 MB at most), answers 204 with `Access-Control-Allow-Origin: *` (and the preflight), and
logs and ignores anything that is not a progress line or a result. Tests: `test/benchcollect.test.ts`, `test/benchdevice.test.ts`.
