# Package B5: the board's page in the native app, as built

State: **iOS done and passing; Android run later by V2 and passing, see `v2-android.md`** (the text below on Android is what B5 could say before it) (the emulator lock was held by another agent for more than the hour the
rules allow; see "Android"). What the package changed, what it measured, what is open.

## What it made
- `app` script **`prebuild:board`** (`npm run build:webview -w @aiwb/board-view`): the board's one-file page `dist-webview/board.html`. The runner
  (`app/e2e/run.mjs`) runs it before every build and every Metro; the install script (I1) and a developer's build call the same script.
- **`app/src/dev/BoardSelfTest.tsx`**, `boardSelfTest.ts` (cases and the touch watch, no React Native), `boardfixtures.ts` (4 and 2,000 elements, the
  spike's mix): AD-83 flow 2. Opened by the button `selftest-board` of `SelfTestRoot`. It mounts the real `BoardHost` and runs over its channel:
  page `ready` · `restore` · an empty board loads (**memory phase**) · a 4-element board draws, loading changes nothing · `req apply` (a rectangle with
  a label, an arrow, an update; one `changed` delta before the reply, not the scene) · `snapshot` equals the app's mirror (load + deltas) · `req export`
  (a real PNG, size, bounds, count) · 2,000 elements through one `postMessage` draw and take a change (a delta of the 2,001-id order; **memory phase**).
  Verdict text `board self-test ok` (`boardtest-status`). Then an empty board is left for fingers and `boardtest-touch` shows what the page tells:
  `touch strokes: N; texts: ["…"]`. `test/boardselftest.test.ts` runs the cases under Node against a stand-in page (and one that never sends `changed`).
- **`app/e2e/maestro/board-webview.yaml`**: the self-test, then the Excalidraw toolbar by touch (the pencil), three swipes → `touch strokes: 3`, the text
  tool + canvas tap + `inputText hello` with the on-screen keyboard, the selection tool commits → `texts: ["hello"]`. The tool taps are points of the
  iPad's top toolbar (Maestro takes whole percents only); the Android phone layout has its toolbar elsewhere (see below).
- **Runner** (`run.mjs`, `lib/memory.mjs`, README): `--release` (Release build, no Metro, no development client, `EXPO_PUBLIC_AIWB_SELFTEST=1` only, flows
  with `needs=` empty only), the memory of the app's and the web view's processes read from outside at the phases the app announces (`[aiwb-phase] <name>`
  in `console.log`, read from the simulator's unified log / logcat, since a Release build cannot post to the runner: Android blocks plain http), written to
  `memory.json`; Homebrew `openjdk@17` among the JDK candidates.
- `app.config.ts` is **unchanged** (N1's ATS dict as it was; no `expo-asset` plugin entry: a page `require`d by Metro does not need it). No
  `withBoardAssets` on iOS.

## iOS (iPad Pro 11-inch (M5) simulator, iOS 26.3)
- `node app/e2e/run.mjs board-webview --platform ios --device 821472EB-107A-4CC5-B203-B85924A35CE2` (development build) and `… --release` both
  **PASSED**; the Release run again after merging `react-native-rewrite` (4 min with the build, 15 s without).
- The page loads as in the spike: a Metro asset, `expo-asset` file address, `allowingReadAccessToURL` its folder. `ready` 0.8–1.6 s after the screen
  opens (Release 0.8 s); a 2,000-element `load` takes 106–196 ms; export of the 4-element board 22–52 ms.
- **Memory** (footprint, MB, read from outside 2.5 s after the app announces the phase; Release, 4 runs: 77–79 / 149–153 WebContent; the app's own
  process is the Release app's and not the board's):

  | Phase | WebContent | GPU | app process | Networking |
  |---|---|---|---|---|
  | empty board (first board the view shows) | **77–79** | 18–20 | 70–71 | 24–25 |
  | 2,000 elements | **149–153** | 39–41 | 86–90 | 24–25 |

  The spike measured 50–52 (empty) and 125–130 (2,000) for WebContent; this build is about 25 MB higher in both, with the same shape (+72 MB for 2,000
  elements). Not explained here: the page is the same Excalidraw; the app's board view is the same web view. (The development build reads higher in the
  app process only, 260–277 MB, which is the Metro bundle and the dev client.)
- **`TEXT_INTERACTION`: `true`** (the web view's own default; unchanged from B4). With the on-screen keyboard up (the keyboard is the iPad's software
  keyboard: `ios-text-typing.png`), tapping the text tool, the canvas, typing `hello` and committing gave `texts: ["hello"]` with `true` **and** with
  `false`; a finger drew three strokes with either. The difference seen: a long press in the open text editor kept its caret with `true` and lost it
  with `false`, so `true` stays (the editor is for typing and selecting). A single long press is a thin test: a tap into the middle of the word did not
  move the caret with either value (both gave `helloX`), which is Excalidraw's own editor, not the setting.
- Maestro's `tapOn point` takes whole percents; the on-screen keyboard covers the lower half while a text is open, so the commit is the tool at the top.

## Android: not run
- The lock `/tmp/aiwb-android-emulator.lock` was held from 20:51 (an earlier holder from 19:07 before that) until the end of my work at 21:54; I polled
  every minute from 20:38 (the hour allowed) and for another 15 minutes after, and never obtained it. No Android run was in the process list at the
  end. I did not take it by force. What is ready: `app/android` generated, the **Release APK builds** (`./gradlew assembleRelease`, 3 min, JDK Homebrew
  `openjdk@17`; the self-test root is inside it).
- What the build already shows for AD-56's order: in the Release APK the page is **a resource**, `res/raw/_assets__packages_boardview_distwebview_board.html`
  (4.1 MB, obfuscated to `res/SF.html` by resource shrinking), and **not a file**; `expo-asset` reads such an asset as `file:///android_res/raw/…`
  (`ANDROID_EMBEDDED_URL_BASE_RESOURCE`: `uri`, with `localUri` null until `downloadAsync` copies it into the cache). WebView can load a
  `file:///android_res/` address; so option (1) (the Metro asset, `resolvePage()` as it is: `asset.localUri ?? asset.uri`) is the first thing to run, and
  (2) the page read into a string for `source={{html}}`, (3) `withBoardAssets` are only if it fails. **None of this has run on a device.**
  `resolvePage()` is the one function to change; the self-test logs where it found the page (`[aiwb-page] <uri>`, also reported).
- Android's `postMessage` into the page: react-native-webview's Android `postMessage` dispatches on `document` (the page listens on `window` and
  `document`, AD-51); passing the flow's cases there is the check, and has not been run.
- The flow's tool taps are the iPad's; on a phone Excalidraw's toolbar is at the bottom (the flow needs a `when: platform: Android` branch with its
  own points, taken from a screenshot of the emulator).
- To finish: take the lock, then
  `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home node app/e2e/run.mjs board-webview --platform android --device emulator-5554 --release`,
  fix the flow's Android taps and, if `file:///android_res/` does not load, `resolvePage()`; stop the emulator and release the lock.
