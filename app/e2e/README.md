# Device and simulator tests (architecture AD-83, goal 7.4)

Flows for the iOS simulator and the Android emulator, driven by **Maestro 2.11.0** (pinned), run by one command:

```sh
node app/e2e/run.mjs <flow> --platform ios --device <simulator udid>
node app/e2e/run.mjs <flow> --platform ios|android --device <id> --release     # a Release build (no Metro): the board page as it ships
node app/e2e/run.mjs <flow> --platform android --device emulator-5554     # with the emulator lock held, see below
node app/e2e/run.mjs <flow> --platform node                               # the flow's cases under Node, no device
node app/e2e/run.mjs --list
```

Name **your own** simulator (`--device` or `AIWB_IOS_UDID`; `xcrun simctl list devices`) or device (`--device` or
`AIWB_ANDROID_SERIAL`): other agents run this on theirs, so the runner never guesses one. Flows: `conn-on-hermes`, `net-selftest`, `keys`, `board-webview`, `sheets`, `net-pinned-stream`, `composer-chips`, `composer-chips-gallery`, `voice-mic`, `voice-devices`, `ux-stack`, `ux-table`, `ux-composer`, `ux-rows`, `storage-picker-permission`, `ux-board` (the phone's board screen, B1: fitted open, the menu, Edit here, the Chats sheet, landscape; `POST /board?scene=spread` draws its three shapes) (`app/e2e/maestro/*.yaml`; files that start with `_`
are shared parts).

## What a run does

1. `get-maestro.sh`: Maestro and a Temurin JRE 17 into `app/e2e/.tools/` (git-ignored; `AIWB_E2E_TOOLS` moves it, so worktrees may
   share one). Both are checked against sha256 sums **written in the script**; run again it fetches nothing; a changed download
   fails and is not used. Nothing is installed system-wide. (`app/test/getmaestro.test.ts` tests this against a local server.)
   Before every build and every Metro the runner runs the app's `npm run prebuild:board` (`@aiwb/board-view`'s `build:webview`: the board's
   one-file page `board.html`, which Metro takes as an asset, AD-56); the install script and a developer's `expo run:*` go through the same script.
2. What the flow's first lines ask for (`# aiwb-e2e: needs=server,standins`): a **scratch Go server** (as `web/e2e/lib/rig.mjs`
   `Scratch`: its own home, a free port, never 4748/6006; its certificate lists `127.0.0.1` and `localtest.me`) and the stand-ins of
   the connector contract (a refused port, a listener that is not TLS, TLS without h2, a listener that never answers).
3. The development build (`expo run:ios|android --no-bundler`): built when the app is not on the device or its native inputs
   changed (`app/modules/**`, `app.config.ts`, `package.json`, the lock file); `--build` forces it, `--no-build` never does,
   `--clean` makes the generated `ios/`/`android/` again first (AD-5). The build's log is in the run's folder.
4. Metro for that build, with the run's values in `EXPO_PUBLIC_*` (`EXPO_PUBLIC_AIWB_SELFTEST=1` makes `App.tsx` show
   `src/dev/SelfTestRoot.tsx`; `src/dev/selftestEnv.ts` reads the rest).
5. The development build is opened with its link (`exp+ai-whiteboard://expo-development-client/?url=...`) and the flow runs. The
   app also posts what each case did to the runner (`app-cases.log` in the run's folder). The flow passes when Maestro passes and
   no verdict the app posted says FAILED. One more attempt is made when Maestro failed and the app reported no failure.
   `--release` builds the Release variant (`expo run:ios --configuration Release`, `expo run:android --variant release`), always (the JavaScript
   and the board's page are inside it), starts no Metro, opens the app as its icon does, and gives it no value of the run
   (`EXPO_PUBLIC_AIWB_SELFTEST=1` only): no scratch server and no report url (a Release build on Android does not talk plain http to this
   computer), so only a flow whose header has `needs=` empty runs in it. What the app announces for the runner (the memory phases of
   `board-webview`: a line `[aiwb-phase] <name>` in its `console.log`) is read from the device's log (logcat; the simulator's unified log).
6. At the phases a self-test announces (`memory-empty`, `memory-2000` of `board-webview`) the runner reads the memory of the app's and the
   web view's processes from outside (`lib/memory.mjs`: iOS `ps` rss and `footprint`; Android `dumpsys meminfo` PSS and `ps` rss) after the
   app's own pause, and writes them to `memory.json` in the run's folder.
7. Everything started is stopped. The run's folder (printed at the end, `--out` names it) holds the evidence.

Variables the flow gets (`-e`): `APP_ID`, and with `server`: `SERVER_HOST` (127.0.0.1), `SERVER_DOTTED` (localtest.me),
`SERVER_PORT`, `SERVER_FINGERPRINT`, `SERVER_SECRET` (those of the scratch server of the run), and with `control`: `CONTROL_URL`.

`--once` runs Maestro once and not twice (while writing a flow). A flow with `control` is run a second time on a scratch server put back as the run began
(`POST /reset` of the control API), since the first attempt may have given it another certificate.

## The self-test screen (the contract between the app and the flows)

`SelfTestRoot` has the buttons `selftest-board` (opens `BoardSelfTest`, below), `selftest-sheets` (opens `SheetsSelfTest`, below), `selftest-conn`, `selftest-net-ip`, `selftest-net-dotted` and a status text `selftest-status`
that says `conn self-test ok` / `conn self-test FAILED`, and `net self-test ok: <name the server was reached by>` /
`net self-test FAILED: <name>`. `selftest-detail` lists the cases that did not pass.

- `conn self-test` (`connSelfTest.ts`): the connector contract and the core-on-fakes cases of `@aiwb/conn`, over the adapter
  (`nativeConnector.ts`) and the native module's JS fake, inside Hermes. No server, no native code.
- `net self-test` (`netSelfTest.ts`): the connector over the **real native module** (`AiwbNetModule.ts`): the connector contract
  against the stand-ins and the scratch server, and ten checks against the real server (pin, secret, event stream, cancel,
  limits, close). Run twice, reaching the server as `127.0.0.1` and as `localtest.me`.
  Beside the server and the four stand-ins the run starts a **control server** (`app/modules/aiwb-net/dev/control.mjs`): the
  contract's cases that script the server (write on the event stream, cut it, count requests) cannot be run against a real Go server,
  so the kind `aiwb` of the contract is then the stand-in of `@aiwb/conn`'s tests, driven from the device (`src/dev/standinControl.ts`),
  and the whole contract runs on the device. Without `EXPO_PUBLIC_AIWB_SELFTEST_CONTROL` (and under `--platform node`) 13 of its 19
  cases are skipped there with their reason. The module-level cases (`module: ...`) need the native module and run on the device only.

`BoardSelfTest` (`board-webview`, `boardSelfTest.ts`) mounts the real board host (`platform/board`: the web view with the shipped `board.html`) and runs
its cases over the bridge's channel: the page says ready; restore; an empty board loads (memory phase); a board of four elements draws; `req apply`
(a delta before the reply); `snapshot` equals the app's mirror (load + deltas); `req export` (a PNG); 2,000 elements load through one `postMessage`
and take a change (memory phase). The text is `board self-test ok` / `board self-test FAILED` (`boardtest-status`). Then it leaves an empty board for the
flow's fingers and shows what the page tells of it, `boardtest-touch`: `touch strokes: N; texts: ["…"]`. The cases also run under Node against a
stand-in page (`test/boardselftest.test.ts`).

`SheetsSelfTest` (`sheets`, package P1, `src/dev/SheetsSelfTest.tsx`, no server) draws the real `Sheet`, `Dialog`, `Popover` and `Menu` of `ui/` with the real boxes of the
Servers form on a device with its on-screen keyboard. A form sheet with three boxes and its buttons: the flow types into the boxes and presses a button with the
keyboard still up (a button under the keyboard would take the press as a key: the flow fails then, checked by switching the avoidance off on both platforms);
a menu, a dialog with a text box and a second sheet each open from the sheet, declared beside it (`-out`, as the confirm dialog is) and inside it (`-in`), and are
pressed (on iOS a second `Modal` beside an open one does not show); the form closes with a typed secret, and the system must not offer to save a password; typing in the middle of the secret keeps the caret there (`sheets-secret-value` shows the real text); a popover hung from the bottom of the screen with an autofocused text box (`up`, as the composer's model picker) rises with the keyboard, so that the box and its last row are above the keyboard's top (the popover's first line, `geometry ok`, is the app's own measure against the keyboard's frame; the last row is pressed with the keyboard up), and one with more rows than the room that is left takes that room. The composer's picker and the library's insert popup as the app opens them are three more cases: a real `Overlay` declared at the top of the screen (a sheet on the phone, a popover or a dialog on the tablet) with an autofocused text box and rows, opened from the bottom bar with no keyboard (`sheets-toppop`, kind popover, and `sheets-topdlg`, kind dialog) and from a button over a text box that already has the keyboard (`sheets-topkb`, kind dialog); with nothing typed, 6 s after it opened, the overlay's `geometry ok` line says its box is above the keyboard, and the flow takes a screenshot before and after the first letter is typed (`p1-09-*`). The box is controlled, as the picker's search is; what fails when `useKeyboardAvoid` runs a LayoutAnimation again is the flow's wait (4 s, before the measure's render, which brings a lost sheet back) for `sheets-<id>-input` (Maestro reads the native views, and a sheet drawn off-screen is not among them), while the `geometry ok` line says ok even then (it reads the layout, not where the view was drawn). The sheet rises over 300 ms in these three cases and not 180 (`sheetTiming` of `ui/Sheet.tsx`, set by the self-test as the control is pressed): the sheet was lost when the keyboard's LayoutAnimation was still running as its rise ended; the old code lost it at 180 and 300 ms every time and at 450 ms one time in nine on the iPhone simulator, and 300 ms is the middle of that window. Run on an iPhone and an iPad simulator. What
happened is in the sheet's `sheets-log`. The **kit page** (`sheets-kit-open`, package F1 of the UX improvements, the phone kit: `Kit` button of the screen) holds the cases of the new parts: a `fit` ActionSheet and a `large` Sheet measure their own surface (the
DOM-like `getBoundingClientRect` of the host views, found from a probe inside the sheet) and write `fit ok: …` / `large ok: …` (fit at most half the window, large from the safe area's top + 8 pt within 2 pt, both to the
window's bottom; in the sheet's sub-line, and in `sheets-detent-fit` / `sheets-detent-large` after it closed); a FormSheet (P3) with two boxes, the second low in the sheet: with the keyboard up the box and the head's Save are above
its top (`form ok` in `sheets-form-geometry`) and Save is pressed with the keyboard up (`sheets-form-state`: `saved …`), a dirty Cancel opens "Discard changes" over the form (the screenshot shows both: a modal layer hides what is under it from
Maestro), its Cancel keeps the text, Discard changes closes both (`discarded`); three SwipeRows (`sheets-swipe-last`: a finger swipe from the middle of row a shows Archive and Delete, Delete runs; a swipe to the left edge on row b runs
Archive; a long press on a row runs `haptic("select")`, `sheets-haptics: N` counts the calls and `haptics native` says expo-haptics answered, since the simulator has no engine to feel; a swipe that starts inside the 20 pt edge opens nothing, the
same one from 10 % of the width runs row c's full Unarchive). The swipe points of the flow are percentages of the window: the rows are at 50 %, 57 % and 64 % of its height (the iPhone 17 simulator). The development client's round button
stands over the top right (where Save and Done are): `hideDevMenuButton` writes its preference with `plutil`, which the simulator's preferences daemon can overwrite; if a run opens the development menu over a press at the top right, set it
through the daemon once, `xcrun simctl spawn <udid> defaults write local.aiwhiteboard.app EXDevMenuShowFloatingActionButton -bool false`, with the app not running.

`--platform node` runs the same cases under Node (the Node connector instead of the module): it checks the cases and the
stand-ins against the real server without a device.

## Android

The emulator is shared: take its lock (`mkdir /tmp/aiwb-android-emulator.lock`; it fails if held), `rmdir` it when done. The runner
refuses an `emulator-*` serial while the lock folder does not exist. It makes `adb reverse tcp:P tcp:P` for the scratch server,
the stand-ins, Metro and the report port, so the app reaches the computer as `127.0.0.1` (and `localtest.me`, which resolves to
127.0.0.1 inside the emulator). Note that a reversed port with nothing behind it does not refuse the connection as a closed port
on the iOS simulator does. Needs `ANDROID_HOME` (default `~/Library/Android/sdk`) and, for the Gradle build, a JDK 17
(`JAVA_HOME`, Android Studio's, or `/usr/libexec/java_home -v 17`); the JRE of `.tools` is only for Maestro.

## Keys Maestro cannot send (package N3)

Maestro types text but sends no ⌘/Ctrl combinations. A flow whose header has `xcuitest=<name>` is followed, on iOS, by the XCUITest bundle
`app/e2e/xcuitest/<name>/*.swift` (`lib/xcuitest.mjs` makes its project with `xcuitest/make-project.rb`, which needs CocoaPods' `xcodeproj`
gem, `brew install cocoapods`; the app's bundle id stands for `__APP_ID__` in the sources), run against the app the flow left open; a flow
with `adbkeys=<name>` is followed, on Android, by `adbkeys/<name>.mjs` (`adb shell input keycombination`, Android 13+). Either one's
verdict is the run's, and the screen is photographed into the run's folder. `keys` is the first such flow (`modules/aiwb-keys/README.md`). On Android the script also presses the screen's "No focus" button (the shortcuts still come) and "Open modal" (reports whether a Ctrl key reaches the module with a React Native `Modal` open: it does not; `plans/rn-rewrite/v2-android.md`).
XCUITest on the simulator cannot send Return or Escape at all (not even a plain Return into a text box), so the keys screen does not wait
for ⌘Enter and Escape on iOS.

## Writing a flow

Put `app/e2e/maestro/<name>.yaml` with the header line `# aiwb-e2e: needs=server,standins node=<conn|net>` (`needs=` may be empty;
`node=` only when the cases can also run under Node), `appId: ${APP_ID}`, start with `- runFlow: _open.yaml` (`_open-app.yaml` for a flow of the app itself), and read the
screen by `testID`. A screen a flow needs goes into `src/dev/` and into `SelfTestRoot`.

## The app itself, not the self-test root (`net-pinned-stream`, package V1)

A flow whose header says `app=1` runs the real app: the runner starts Metro without `EXPO_PUBLIC_AIWB_SELFTEST`, `_open-app.yaml` waits for Home on the phone (`home`; the sidebar `side-tree` on a tablet), and the app starts as a user's does. The header's `needs=` may then also hold:

- `agent`: the scratch server runs the stand-in agent of the tests (`internal/agenttest/fake-claude`, as `web/e2e/lib/rig.mjs` does): a message gets
  "FAKE(sonnet): <the message>", no paid model.
- `control`: a control API on this computer (`lib/serverctl.mjs`; Maestro runs on this computer, so a script of the flow calls it with `http.post`, the
  shared `_ctl.js` with `env: { METHOD, ROUTE }`): `POST /stop`, `/start`, `/new-cert` (the key and certificate made again, the server started;
  answers the new fingerprint), `/reset`, `/board?name=N`, `/chat?name=N[&text=T]`, `/say?chat=ID&text=T`, `GET /state`. What it does to the server
  it does through the client API (HTTP/2 over the server's certificate, the secret and a client id in headers) or the server program's own commands.
  Board names have no spaces (the server makes them hyphens): use `Streamed-board`.

`net-pinned-stream.yaml` (goals 4.6, 4.7, 7.4, AD-83 flow 1), on the phone layout:
1. the Servers list is emptied of what an earlier run left (`_forget-servers.yaml`: the list's rows, each one's "Remove server…" and its confirm sheet); a board is made on the server through the control API;
2. the Servers button pushes the list; "Add server" › "Paste setup text", the text a server prints typed into the paste box (address, `Fingerprint:`, `Secret:`, with the
   fingerprint changed in one byte; `_add-paste-code.yaml`), "Test connection": the app says "✗ Does NOT match the code — do not trust it", has no way to trust it, and "Cancel";
3. the same with the right fingerprint: "✓ Matches the fingerprint in the code", the fingerprint the server presents is on the screen, "Trust and save"; the list has the row,
   Connected; back, the sidebar's section says `127.0.0.1 — Connected` and has the board;
4. a board made on the server appears without a reload; a chat made on the server is opened, a message sent on the server is answered by the stand-in
   agent, and the answer is on the screen of the open chat;
5. the server is stopped: the foot's button says "Servers: one is not connected", the section says `Unreachable` and "Its chats show when the server is
   back."; it is started: `Connected`, and a board made after appears;
6. the server comes back with another certificate (`/new-cert`): the list's row says "Certificate changed", its detail has the danger notice, "Compare fingerprints" shows
   both prints (the first block of each is looked for); the entry is removed (Remove server…, its confirm sheet);
7. the same server is added by the dotted name `localtest.me` ("Enter address manually": name, address, secret and the self-signed switch typed): the fingerprint is the new one,
   "Trust and save", `dotted — Connected`, and a board made on the server appears. (A server cannot be added twice, "Already added as": the second name takes
   the first's place.)

The shared helpers `_add-server.yaml` and `_forget-servers.yaml` have one branch per layout, chosen by what the Servers button opened: `srv-add` (the phone's pushed list) or `servers-add`
(the iPad's and the tablet's dialog, with its old ids `servers-*` and `addserver-*`). The phone parts that look at the add flow start with `_add-choose.yaml` (list › "Add server" › "Choose how")
and `_add-manual.yaml` ("Enter address manually").

What differs between the platforms, and is in the flow: Maestro's `inputText` types no line break on Android, so the lines are typed with `pressKey:
Enter`; Maestro's `hideKeyboard` is the Back key on Android, which closes the sheet's form (`_blur.yaml` is the dialog's way); the add form is filled with the keyboard up (the sheet rises over it, P1), and iOS must not offer
to save the secret as a password (`assertNotVisible: "Not Now"`); an emulator that is busy
may put "isn't responding" over the app: `_blur.yaml` answers "Wait". The flow takes about 2 minutes on the iOS simulator and 8 on the emulator of a busy
machine (Metro, the Go server and other agents' builds share the processors).


**The shared helpers on the phone** (H1: the app's first screen is Home, `home`; on a tablet it is still the sidebar, `side-tree`; `maestro/_*.yaml`): `_open-app.yaml` waits for `home|side-tree`; `_open-sidebar.yaml` and `_to-sidebar.yaml`
(names kept) end on Home or the sidebar by pressing `nav-back` until one is there (a grouped item needs two backs); `_open-foot.yaml` (param `ID`) presses a control of the sidebar's foot
(`servers-btn`, `settings-btn`, ...): behind Home's gear (`home-gear`, the stop-gap sheet `home-settings-stopgap`) on the phone, directly on the tablet; every flow that opens Servers or Settings goes through it.
Home's rows (`home-row`) carry the label "<name>, <sub-line>", so a flow taps a row by a pattern (`tapOn: "Pic-chat.*"`). The sidebar section's line `<host> — Connected` and the foot's "Servers: one is not connected"
are the sidebar's, not Home's: `_add-server.yaml` checks the line only when `side-tree` is there; `net-pinned-stream` and `storage-picker-permission` still assert them and have not been run against Home (not adapted: S2 gives Home its server sheet).
The development client's round button stands over Home's gear like over Save: if a run opens the development menu instead of Settings, apply the `defaults write` fix of the F1 paragraph above (it was needed on a fresh simulator).

## The composer's chips in the real app (`composer-chips`, package V3)

`node app/e2e/run.mjs composer-chips --platform ios|android --device <id>` (goal 7.4, AD-83 flow 3; the development build, `needs=server,agent,control`).
The header keys of the runner that this flow added (the top of `run.mjs` lists them all):

- `report=1`: the bundle gets `EXPO_PUBLIC_AIWB_REPORT_URL`, so the chip input (`ChipInput.native.tsx`, through `src/dev/chipreport.ts`) tells the runner what it
  holds after every change, `{ text, chips: [[start, end]], selection, value }` (the shown string with a chip as its label between no-break spaces, the chips'
  places in it, the selection, and the value, the text with each chip as its tag), and the selections the platform reported before the box moved them out of
  a chip. By post to the runner's collector and as a line `AIWB_REPORT {...}` of Metro's log (a post through `adb reverse` can hang); each is taken once
  (`run` + `seq`). A build without that variable (every build for people) posts nothing.
- `verify=<name>`: `app/e2e/verify/<name>.mjs` has `checks`, which the flow asks for through the control API (`POST /check?name=<c>[&timeout=ms]`, by
  `_check.yaml`: the runner waits until the check holds for the box's latest state and fails the flow at that step, with what it saw, when it does not), and
  `verify({ posts, api, ... })`, called after the flow and the keys, which answers what did not hold (here: no reported state has the caret inside a chip; the
  server holds one message, with the tag). The control API also answers `GET /box` (the latest state; the XCUITest bundle reads it), `GET /sent?chat=<id>`
  (the user's messages of a chat on the server), `POST /board?name=N&scene=chips` (a board with a filled rectangle labelled "API", `lib/scenes.mjs`: the control client
  takes the board over an open event stream, writes the drawing and lets it go, so that the app can take it) and `POST /chat?board=<id>`.
- `gallery=<name>`: the bundle shows a dev gallery (`EXPO_PUBLIC_AIWB_GALLERY`), as `chips.mjs` did.
- `then=<flow>`: another flow run by the same command after this one passed and everything of it is stopped (its Metro, its server), on the same device with
  `--no-build`, its evidence in a folder of its own. `composer-chips` is followed by `composer-chips-gallery`.
- `xcuitest=<n>`: the sources of the bundle get `__CONTROL_URL__` as well as `__APP_ID__`; `adbkeys=<n>`'s `run` gets `box()` (the latest state) and `maestro(file)`.

`composer-chips.yaml`, on the phone layout: the Servers sheet is emptied and the scratch server added by pasting what it prints; a board with a rectangle and a chat on it
are made through the control API; the board is opened from Home's row (the sidebar's on a tablet), the rectangle tapped (selected: the chat's context row then says "Add 1 selected") and the chat opened
with "Chats". On the phone, with the chat still new and its keyboard lowered, `_ux-c2-chips.yaml` (package C2) asserts the chip row (`composer-chip-row`), opens the model chip
(label "Model and effort: ...": `model-sheet` with "Model and effort" and "Done"; screenshot `ux-c2-model-sheet`), taps Done, opens the folder chip (`folder-sheet` with "Start the agent in" and "Cancel";
`ux-c2-folder-sheet`) and taps Cancel; the row is then not on the screen once the box is tapped (the keyboard is up). Then the selection goes into the message, in one of two shapes:
- **phone** (`_chips-phone.yaml`, since package B2): "Move" is typed, "+" › Add selection takes the person to the board with the wait kept (`pick-bar`), the rectangle is
  tapped and the bar's Add (`pick-add`) opens the chat again (`_chips-add-selection.yaml`): the reference is a chip beside the box (`ctx-chip`, "1 shape · API"), not in its
  text (`phone-plain`); its × (`ctx-chip-remove`) takes it out and it is added again; " to", Enter and "thanks" are typed;
- **wide** (`_chips-inline.yaml`; iPad, tablet): "Add 1 selected" puts an inline chip in, "to" is typed after it. A tap on the chip's left half puts the caret at its start (an "X"
  typed there is before the chip), a tap on the right half at its end ("Y" is after it); Backspace takes the space after a chip and then the chip whole; a double tap on its word
  selects it and a letter replaces it (one more double tap when the box says it was not selected: UIKit takes one in five as two taps); a single tap on it leaves the caret on an
  edge; Enter is a line break. The XCUITest bundle `xcuitest/chips` (arrows, Shift+arrows, forward delete and Backspace and ⌘A/C/V/X around that chip, checked against
  `GET /box`) belongs to this layout and is no longer in the flow's header, which the iPhone runs (package D1).

Send sends, the box is empty and the stand-in agent answers; the server's thread holds the message with the `<selection ids="chips-rect" ...>` tag where the caret was.
`composer-chips-gallery.yaml` is the box alone on its dev gallery (package K2's cases: two chips and a point, read-only, the @ mention, the box's height, Gboard's suggestions on
Android), its marks asserted by `verify/composer-chips-gallery.mjs`; on Android `adbkeys/chips.mjs` sends the hardware keys to it (Ctrl for ⌘, `adb shell input`).

The inline chip is no element of its own, so Maestro taps points (percent of the screen); the percentages in the first lines of `_chips-inline.yaml` were measured on the
iPhone 16e and the Medium Phone API 36.1 emulator, with the soft keyboard up on both while a chip is tapped (the phone layout no longer reaches them since B2).

## The secure storage, the picker and the permissions (`storage-picker-permission`, package V4)

`node app/e2e/run.mjs storage-picker-permission --platform ios --device <udid>` and `--platform android --device emulator-5554` (the lock held). The real app against
a scratch server; header `needs=server,agent,control app=1 devhooks=1`. What it does, in this order (`maestro/storage-picker-permission.yaml` and its parts `_v4-*.yaml`):

1. *The words before the first connection* (iOS): "Add server" › "Enter address manually" says why the system will ask to reach the local network (`add-localnet`); on Android it says nothing.
2. *The secure storage*: a server is added by pasting what it prints; the app is stopped and opened again by the runner; the server is there and connected. What the app keeps
   is read from the device: the app's data folder (iOS: the simulator's data container; Android: `run-as`) is searched for the secret of the run, byte by byte, and the MMKV
   files are named (`Documents/mmkv/aiwb.servers` on iOS, `files/mmkv/aiwb.servers` on Android: they hold the server's address, which the search finds, and not the secret). The
   build's probe (below) says on the screen that the secure store has the secret. The server is removed: the probe says its secret is gone from the store and its entry from the list.
3. *The images*: pictures (lib/fixtures.mjs) are put into the library (`simctl addmedia`; `adb push` and a media scan), the picker is opened from the phone composer's "+" (Add to message > Photo library),
   the thumbnails show (72 pt each, with its ×: `image-thumb-remove`, "Remove <name>"), the message is sent and `GET /chat-images` of the control API says what the server holds: a PNG and a JPEG, and on iOS a HEIC of the library as a JPEG, each of
   the size it had. A BMP and a picture over 5 MB are refused: a marked tile in the strip (`image-refused`, its × `image-refused-remove`) and, in red under it, "<name> is not added: send PNG, JPEG, GIF or WebP." / "<name> is not added: over 5 MB." (`composer-images-line`), one at a time.
   iOS, last: "+" > Take photo (`_ux-c1-camera.yaml`): the camera's permission is asked with the app's words and refused ("The files could not be picked: The camera is off for AI Whiteboard. Allow it in Settings, under AI Whiteboard, then try again."; the sheet is closed, nothing added), then granted: the simulator's own camera opens (iOS 26.3 has one, a grey viewfinder, in the system's screen: the app's own screen leaves the accessibility tree) and is left by its × (touched at 14%,93%): the composer is back, nothing added, no error. A press of the shutter did not bring the review screen in the one attempt made, so a photo taken is by hand.
   for no permission, after `simctl privacy reset` and after `revoke` alike.
4. *The local network*: a connection to the dotted name ends as `local_network_denied` (a forced outcome of the build: the iOS simulator never asks, N1 found), and "New server"
   shows the words and "Open Settings" (`add-open-settings`), which leaves for the system's settings.
5. *The code to scan*: `scripts/server-code.sh` makes the code (the control API's `POST /device/qr` runs it, with a `qrencode` in front that keeps what it is fed and writes the PNG a
   camera would see; the picture is read back with CoreImage, `lib/qrdecode.swift`), the scanner is opened ("Scan QR code" of "Choose how"; × goes back to it), the camera's permission is asked, refused and given on both platforms (iOS:
   the prompt, with the app's words; Android: "While using the app", a second refusal is for good and the scanner says the camera is off), and the text the picture holds is typed
   into the paste box that "Paste text instead" opens, which fills "New server" as a scan does (the same parser): the server it names answers "Matches the fingerprint in the code". The scan itself, a camera looking at
   the code, is by hand (goal 7.5): the simulator has no camera, and the emulator's is a room whose poster the stock walk (`adb emu automation play Walk_to_image_room`) did not bring into view here.

Parts of the runner this package added: `--hold` (everything a flow would have stays up, the app is opened, the values go to `<out>/env.json`, and the runner waits for `<out>/stop`: to drive
Maestro by hand, `maestro --device <id> test -e K=V … file.yaml`; Metro answers the bundle it built at the start, so a change of the app's JavaScript needs a new hold); the header token
`devhooks=1`; the device routes of the control API (`lib/devicectl.mjs`: `POST /device/library?names=`, `/device/privacy?service=photos|camera|all&action=grant|revoke|reset`,
`/device/relaunch`, `GET /device/storage?find=`, `POST /device/qr`); `GET /chat-images?chat=ID` (`lib/serverctl.mjs`); the development client's round button, which stands over the picker's
"Add" and a chat's "Tree", is switched off before the app is opened (`hideDevMenuButton`: the app's plist on iOS, the development menu's shared preferences on Android).

**The dev hooks of the build** (only with `devhooks=1`, and only in a development build, `__DEV__`): `src/dev/StorageProbe.tsx` draws one line at the top of the screen
(`probe-storage`: `probe: list=1 secure=1 match=1 leak=no gone=0 gone-left=0 pending=0`: entries in the saved list, of them with a secret in the secure store, of them whose secret has the SHA-256
the run told the build (the secret itself is not in the bundle, which the app keeps in its files), whether a secret of the store is in the text of an MMKV instance, entries seen in this launch
that left the list, of them with a secret still in the store, deletes still to retry), and `src/dev/forceoutcome.ts` (a connection to the dotted name ends as `local_network_denied`).

**The picker's pictures on iOS are touched at the places of its grid**: the system's picker is another process, so Maestro does not see inside it (only the app's own screen disappears from the
accessibility tree, which is how the flow knows it is up). The library is date-sorted and the flow puts its pictures in one after the other, so "the newest N" are the first cells,
left to right (`_pick-ios.yaml`). Android's photo picker is in the tree, its cells named by their date (`_pick-android.yaml`), and its button is "Done".

## The phone's stack (`ux-stack`, package F2)

`node app/e2e/run.mjs ux-stack --platform ios --device <udid>` and `--platform android --device emulator-5554` (the lock held); header `needs=server,agent,control app=1`. A group
"Stack-group" with a board and a plain chat is made through the control API (`POST /group?name=`, and `group=<id>` on `POST /board` and `POST /chat`); the group's screen (`group-screen`) is reached
from Home by its row (`home-row`; a row's accessibility label is "<name>, <sub-line>", so the flow matches the id and the name as a pattern, `text: "Stack-group.*"`). iOS: the edge swipe (Maestro `swipe` from 1% to 70% of the width) goes back from the chat to the group's screen and from the group to Home, and
does **not** leave the board (`board-stage` stays; its `nav-back` goes to the group). Android: the system's back does all three, the board included. Both: holding `nav-back` on a chat opens
`stack-sheet` ("Go back to"), and its Home row goes to Home. Passed on the iPhone 17 simulator (iOS 26.3); the Android half is written and not yet run on the emulator (it needs a JDK 17 for the Gradle build).

## The phone's composer (`ux-composer`, package C1)

`node app/e2e/run.mjs ux-composer --platform ios --device <udid>`; header `needs=server,agent,control app=1`. A plain new chat "Kbd-chat" is made through the control API (`POST /chat?name=`); the
scratch server runs the stand-in agent. **Asserted** (Maestro): a new chat's box takes the focus as the chat opens, so the soft keyboard is up (its "return" key is in the accessibility tree) and the box
(`composer-input`) is above that key with the primary button (`composer-talk`, while the box is empty) on the screen; the keyboard's return key adds a line and sends nothing (`GET /sent?chat=` of the control API:
no message of the user), then `send` sends and the server holds one message, "line one" and "two" on two lines (`_ux-c1-sent.js`); in the started chat the keyboard comes up again with the box above it and the chip row
(`composer-chip-row`) gone; a new chat's chip row (`composer-chip-row`) is not on the screen while the keyboard is up (`_ux-c1-chips-hidden.yaml`, `useKeyboardUp`) and is back after the keyboard is lowered (no "return" key). **Shown only by the screenshots** (Maestro reads no sizes): the box's bottom edge 6 pt above the keyboard's top with no home
gap (`kbd-02-up`: the box's border ends at 1599 px and the keyboard's shadow starts at 1617 px, 3 px per pt, so 6.0 pt on the iPhone 17), and the thread's last message just above the box (`kbd-07-started-up`).
One step is still a known gap, package T1's (the thread's `ScrollView`: `keyboardDismissMode`), and is an optional run (`runFlow … optional: true`; a miss is a warning in the output and the screenshot is the evidence): a drag down on the thread lowering the keyboard (`_ux-c1-drag-lower.yaml`; neither thread list sets `keyboardDismissMode`), after which a tap on the thread's empty part lowers it (`_ux-c1-lower.yaml`; Maestro's `hideKeyboard` fails on this keyboard).
`storage-picker-permission` reaches the pickers through the same sheet (`_ux-c1-plus.yaml`: "+" then the row's label; the rows are all `action-row` on a device, the `action` is a web `dataSet`). Android: not run in C1.

## Home's rows under a finger (`ux-rows`, package H2)

`node app/e2e/run.mjs ux-rows --platform ios --device <udid> --once` (iOS only; header `needs=server,agent,control app=1`; the Android half is not run, no JDK 17). On a scratch server a group, a board and a chat: a left swipe on the group's row shows Archive and Delete and a tap on another row closes them; a full swipe on the chat archives it (toast and Undo); a long press on the board opens `row-sheet`; a hold of 2 s and then a move drops the chat on the group; a swipe up and down scrolls a Home of 21 rows. The haptic of the hold cannot be asserted. Maestro's finger is one touch-down, one move and one touch-up (the move comes when the `duration` is over, so a long `duration` is a hold first): a partial swipe on a chat or board row from a freshly shown Home often ended as a tap, a hold of 1.5 s did not drop and 2 s did, and a retry of the runner (no `--once`) makes a second group "Rows-group" (a reset removes no groups) and moves the rows: the flow's points are those of one group, one board and one chat on the iPhone 17 simulator. The server is added with the shared `_add-server.yaml` (S2's Servers screens), which ends on Home.

## A wide table in the thread and its viewer (`ux-table`, package T1)

`node app/e2e/run.mjs ux-table --platform ios --device <udid>` (iOS only; header `needs=server,agent,control app=1`). A chat is made through the control API and `POST /say` sends a message that is Markdown
(a line, a heading, a table of 7 columns and 4 rows); the stand-in agent repeats it, so the thread holds the table twice (the user's message is drawn as Markdown too) and the flow takes the answer's, `md-table-open` with `index: 1`.
It checks the pinned first column (`md-table-pin`), the hint and "Open full table"; the tap pushes `table-screen` (known by its title and `table-copy`: the container is no accessibility element on iOS) titled "Table · 7 columns, 4 rows" with its header row and first column on the screen; Maestro's
`setOrientation: LANDSCAPE_LEFT` turns the simulator and the viewer, its title, the header row and the first column are still there, also after a swipe sideways over the body; Copy (`table-copy`) shows the toast
"Table copied"; back to portrait and `nav-back` return to the thread.

## The microphone and the audio session (`voice-mic`, package P17)

`node app/e2e/run.mjs voice-mic --platform ios --device <your own simulator's udid>` (also `--platform android --device emulator-5554` with the emulator lock held: the flow branches by platform where the system's dialogs and the screen's layout differ, see below; voice chats, goal 6.6, architecture §14.4; the development build,
header `needs=server,agent,control,voice app=1`). It covers what only the platform shows of voice: the system's microphone prompt, the audio session of
`app/modules/aiwb-audio` starting and stopping, 16 kHz chunks of 100 ms reaching a service, and the native player playing a stream. Nothing is recognised: the
simulator's microphone is silence or the Mac's input, so the stand-in voice service says what it was told to (`needs=voice`, below).

- `voice`: `web/dev/voicestandin.mjs` runs alone on a free port of this computer (`lib/voice.mjs`; no prefix: the app builds its addresses from an origin,
  `src/voice/platform/origin.ts`). Metro gets `EXPO_PUBLIC_AIWB_VOICE_BASE` at it, which a development build honours for a local host only (a Release build ignores
  it), and the flow gets `VOICE_CONTROL` (`_voice.js` posts to it: `script` the next transcription as `[{ after: <chunks>, partial?, committed? }]`, `pace`, `fail`).
  The runner resets the microphone's answer before each attempt (the system then asks again); with `control` the control API gets `POST /voice/mic?action=grant|revoke` (iOS `simctl privacy … microphone`; Android `pm grant|revoke RECORD_AUDIO`) and `POST /voice/relaunch`. The system ends an app whose permission changes (iOS: exit domain `tcc`; Settings does the same on a phone), so a flow opens the app again after a revoke, and the runner resets only while the app is not running.
  After the flow the runner reads the stand-in's log (`checkLog`) and fails the run unless every transcription socket got only 16 kHz chunks of exactly 100 ms of
  audio, at about real time, had the key header, ended, and the client broke no rule of the protocol (`problems` empty); the log is `voice-log.json` in the run's folder.
- The build has a status line, `voice-dev` (`src/screens/voice/DevLine.tsx`, registered only when `__DEV__` and `EXPO_PUBLIC_AIWB_VOICE_BASE` are set): `voice-dev: phase=<…>
  reading=<key|none> drained=<n> marks=<n>`; the last two count the player's events while a message is read aloud, so `reading=none` with both above zero is a reading played to its end.
- The flow: the scratch server is added, with a chat that has a message and the stand-in agent's answer; Settings > Voice takes `sk_test_…` and Test key finds six voices; Dictate →
  the system's alert with the app's words → Allow → the scripted words come into the box (the script fires by chunk count, so the microphone really ran); Dictate again stops;
  Read aloud on the answer; `simctl privacy revoke microphone` (the system ends the app; the flow opens it again); Dictate → the "can't hear you" popover with "Open system settings"; Remove key.
- **The Mac must let the process that runs the simulator use its microphone.** The simulator takes its input from the Mac's, and the first input call of an audio engine in the app waits for the Mac's
  answer. In a session where nobody can answer the Mac's microphone prompt (the authorization of the running process is "not determined"), that call never returns: CoreAudio says
  `Initialize: RPC timeout. Apparently deadlocked. Aborting now.` after 9 s and the app ends, with Dictate at `phase=starting` and no transcription socket at the stand-in (the flow then fails at "hello there",
  and the runner would fail it for the missing socket). The same call from a plain Swift program on that Mac hangs too, so it is the session, not the app. Run the flow from a terminal the person has
  allowed to use the microphone once (System Settings > Privacy & Security > Microphone). The prompt, Read aloud, the refused permission, the relaunch and Remove key need no microphone and run anywhere.
- Two things the flow works around: a tap on the answer's "⋯" by its id (`fk-more`) does not open the menu on the device, a tap at its place does (and a first tap just after the chat opens is sometimes
  lost, so it is repeated); and the toolbar's "more" sheet, where the phone keeps Dictate, stays open after Dictate is pressed (`_voice-dictate.yaml`, `_voice-close-sheet.yaml`).
- Not covered by a simulator: echo cancellation and the reply's sound not being heard as the next turn (no acoustic echo), Bluetooth routes, a phone call taking the audio; the person confirms them on a real iPhone and
  Android phone. Android runs this flow only with the emulator lock held (see Android; it passes on the Medium Phone API 36.1 emulator, whose built-in microphone gives the stand-in 16 kHz chunks in real time); otherwise its module is proven by `./gradlew :aiwb-audio:compileDebugKotlin` and on a phone.
  On Android the flow differs from iOS in three places, each a `runFlow` with `when: platform:`: the permission is the system's runtime dialog "Allow <app> to record audio?" with no words of the app (the flow taps "While using the app"); after `pm revoke` the app asks again, so the refusal step taps "Don't allow" to reach the "can't hear you" popover; and the answer's "⋯" is tapped at 92%,15% (iOS 92%,20%).

## The audio devices in Settings > Voice (`voice-devices`, package D13)

`node app/e2e/run.mjs voice-devices --platform ios --device <your own simulator's udid>` (voice devices, goal 6.5, architecture §12.4; header `needs=server,agent,control,voice app=1`,
the same stand-in service and runner parts as `voice-mic`). The iPhone layout of the card "Microphone and speaker", against the native module's real `AVAudioSession`. **Part 1 needs no microphone**
and runs where the simulator cannot capture audio (see the Mac's microphone note under `voice-mic`): with no key stored (one left by an earlier run is removed) the card shows only its title and "Add your key to choose a microphone and a speaker." (`vs-devices-nokey`; no picker, no test, no note, no microphone alert), then the stand-in's key is typed, tested and saved (`vs-key`, `vs-key-save`) and the card lists: the Microphone picker lists "System default (<input>)" and the
system's input and listing asked for no permission; the Speaker row is the line "Follows the system: headphones or a headset when connected, otherwise the speaker." with no picker (`vs-speaker`), no
`vs-mic-system`, no note; Test speaker plays the chime through the native player to its end (the dev line's `tested` count, read after the sheet is closed, since the sheet covers the line) with `mic=none`
still (no microphone was opened by any of it); the built-in input is picked and is still the picker's choice after the app is closed and opened again (`POST /voice/relaunch`). **Part 2 needs a real
microphone** (a Mac session that may use its microphone, or a phone): the key is already saved, Dictate asks the system for the microphone (the app's words, Allow), the scripted words come into the box, and the dev
line's `mic=builtIn` says the saved input was opened (its kind, never a name) with no notice; Test microphone shows the level meter (`vs-mic-level`). The flow ends with System default and no key (the card is back to `vs-devices-nokey`), and starts by putting
both so, so it runs again on a device an earlier run left half-way. **On the Android emulator** (`--platform android --device emulator-5554`, lock held; API 36, so both kinds are choices) the whole flow runs, part 2 too: the emulator's built-in microphone works. The Speaker row is a picker (`vs-speaker`: "System default (Phone speaker)", "Phone speaker"; no `vs-speaker-system`) and the card's note says "A headset is used for both listening and speaking while you talk to a chat."; both picks are kept over a relaunch; the permission is the system's dialog ("While using the app"); the card is taller, so the flow scrolls to Test microphone. An Android 7–11 device would show the iOS-style line for the speaker: not covered (the flow assumes API 31+). Loss, pause and headsets (wired, Bluetooth) are not on a simulator: the unit tests over the fake module prove the logic and a person proves the rest on
real devices.

The build's status line has a second text, `voice-dev-devices` (`mic=<none|default|builtIn|external> tested=<n>`): the kind of what the microphone's last start opened, and how many queues played out while no message
was read aloud (Test speaker's chime). A separate text because Maestro matches a text as a whole and `voice-mic` ends its patterns at `marks=<n>`. Metro of a run does not watch files: a change of the app's source is picked up by a new run, not by a held one.
