# Package V2: the board flow and the keys flow on Android, as run

Emulator `Medium_Phone_API_36.1` (Android 16, API 36, 1080x2400, WebView `com.google.android.webview`), lock held for the runs, the emulator
stopped and the lock released at the end. Every command passed on the code merged with `react-native-rewrite` (a63432a).

## Board (B5's Android half)

`node app/e2e/run.mjs board-webview --platform android --device emulator-5554 --release` **PASSED** (first attempt, 92 s with a built APK; 228 s
with the Gradle build after the merge).

- **Which way of AD-56 loads: (1), the Metro asset, `resolvePage()` unchanged.** `asset.downloadAsync()` copies the `res/raw` resource of the Release
  APK into the app's cache and gives `localUri` = `file:///data/user/0/local.aiwhiteboard.app/cache/ExponentAsset-<hash>.html` (logged by the
  self-test as `[aiwb-page]`). That is a real file, so the web view loads it as on iOS (the `file:///android_res/raw/…` address B5 expected in `uri` is
  not used: `localUri` is set). So (2) (`source={{html}}`) and (3) (`withBoardAssets`) are not needed and **not written**.
- **`postMessage` reaches the page.** react-native-webview 13.16.1 on Android dispatches a `MessageEvent` on `document`
  (`RNCWebViewManagerImpl.kt`); the page listens on `window` and `document` (`board-view/src/webview/entry.tsx`, AD-51). All the self-test cases
  pass over it: ready, restore, load (empty, 4 elements, 2,000), `req apply` with its delta, snapshot equals the mirror, `req export` (a PNG).
  `ready` came 1.1 s after the screen opened (Release, emulator).
- **The flow's phone points** (`board-webview.yaml`, `when: platform: Android`): on the phone Excalidraw's toolbar is a floating bar at about 21%
  of the height: pencil (57%, 21%), "A" (65%, 21%), selection (9%, 21%). Three swipes give `touch strokes: 3`, the text tool with the on-screen keyboard
  gives `texts: ["hello"]`.
- **Memory** (`dumpsys meminfo`, section "Total PSS by process", read 2.5 s after the app announces the phase; Release; three runs):

  | Phase | WebView renderer (PSS) | app process (PSS) |
  |---|---|---|
  | empty board | **102–114 MB** | 148–155 MB |
  | 2,000 elements | **150–152 MB** | 150–167 MB |

  (The renderer's rss is 242 and 289 MB: PSS shares the system's WebView code with other processes. The other WebView processes, `webview_apk`,
  `webview_service`, `webview_zygote`, are 4–10 MB PSS each.) +48 MB for 2,000 elements, as the iPad's shape (+72 MB footprint there).
- **Found and fixed in the runner:** `lib/memory.mjs` read all six sections of `dumpsys meminfo` ("Total RSS by process", "by OOM adjustment", "by
  category", then the same for PSS) as PSS, so the first numbers it wrote were the RSS. It now reads "Total PSS by process" only.

iOS on the merged code, `--release` on the iPad Pro 11-inch (M5) simulator: **PASSED** (memory footprint: empty WebContent 77, 2,000 elements 149 MB;
as B5 measured). The iOS flow is unchanged in what it does: the Android taps are in a `when: platform: Android` branch.

## Keys (N3's Android half)

`node app/e2e/run.mjs keys --platform android --device emulator-5554` **PASSED**; the iOS flow `keys --platform ios` also passes after the changes to
the screen. The module (`modules/aiwb-keys/android`) needed no change. What the run shows:

- **Ctrl shortcuts from a focused text box**: Ctrl+B (twice), Ctrl+N, Ctrl+J (twice), Ctrl+Shift+B, Ctrl+L, Ctrl+Shift+L, Ctrl+P, Ctrl+Enter and
  Escape all come, each exactly as the platform makes it (`seen: 9 of 9`, `keys self-test ok`, "prevented" on the three the shell takes), sent with
  `adb shell input keycombination` (Android 13+).
- **Typing untouched**: `ab` typed by Maestro, `hello` and `x` by `adb input text`, the text box keeps `abhellox`; the shortcuts typed nothing; Ctrl+U
  (no shortcut) is not taken.
- **Without focus** (new: the screen's "No focus" button blurs the text box, `focus: none`): Ctrl+B, Ctrl+N and Ctrl+J act (the shell's
  handler hides/shows the sidebar and panel, a chat is made), the text box is untouched.
- **The `Modal` limit, measured** (new: the screen's "Open modal"): with a React Native `Modal` open, Ctrl+B does **not** reach the module (the
  screen's sidebar state, shown inside the Modal, stays and no key is logged). The Modal is a `Dialog` window of its own; its Escape is the system's
  Back, which closes it. This is a limit, not fixed here: U2's overlays are on `Modal`, so a shortcut does not work while a sheet or a dialog is open
  on Android (for a Ctrl+N or Ctrl+B that is arguably right; Escape closes the overlay anyway).
- **The runner's adb script** had never run: uiautomator quotes an attribute with `'` when its value holds a `"` (`typed: "ab"`), which the script's
  regexes missed (three false FAILED on `keys-typed`); it now parses each node's attributes with both quotes, taps by `resource-id` and has the
  no-focus and Modal phases (the Modal's is reported, not an assertion). A run takes 2–3 minutes (each `uiautomator dump` is about a second).
