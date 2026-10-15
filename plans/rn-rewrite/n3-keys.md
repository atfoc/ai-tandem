# N3 — aiwb-keys: what was found

Package N3 (`app/modules/aiwb-keys`, `app/src/platform/keys.native.ts`). Module contract and list: `app/modules/aiwb-keys/README.md`.

## Checked

- iPad Pro 13-inch (M5) simulator, development build: `node app/e2e/run.mjs keys --platform ios --device <udid>` passes. The Maestro flow
  `keys.yaml` opens the keys self-test screen and types into its text box; the runner then runs the XCUITest bundle
  `app/e2e/xcuitest/keys`, which sends ⌘B (twice), ⌘N, ⌘J (twice), ⌘⇧B, ⌘L, ⌘⇧L, ⌘P from the focused text box. The screen (real shell
  shortcut handler over the real keys port and store) hides and shows its sidebar and panel, counts the chat ⌘N made, shows each key as the page's
  predicates read it, and the text typed around them is untouched. The app posts `keys: ok` to the runner. Screenshot: `n3-keys-ios.png`
  (⌘B and ⌘J pressed twice, so sidebar and panel are shown again; `chats made: 1`; the last keys listed).
- Android: `:aiwb-keys:compileDebugKotlin` builds (JDK 17 from Homebrew, `expo prebuild --platform android`, then gradle in `app/android`).
  **Run later by V2: passes, see `v2-android.md`** (the Modal limit measured). Not run by N3: its lock (`/tmp/aiwb-android-emulator.lock`) was held the whole time. The flow's Android half
  (`app/e2e/adbkeys/keys.mjs`, `adb shell input keycombination`) is written and not run.

## Findings

- A `UIKeyCommand` added with `addKeyCommand` to the root view controller works with the focus in a text box and with none (⌘N arrived after
  the keyboard was dismissed). `wantsPriorityOverSystemBehavior = true` on the ⌘ ones.
- The development client may replace the root view controller after the start, so the module looks again every second while someone listens.
- **XCUITest on the simulator cannot send Return or Escape** (even a plain Return into the text box does nothing; ⌘Return and Escape never
  reached UIKit, not even as extra debug commands with other `input` spellings). ⌘Enter and Escape are therefore implemented
  (`"\r"`, `UIKeyCommand.inputEscape`) but **not verified on iOS**: the screen does not wait for them there. Check by hand on an iPad.
- The first ⌘ key XCUITest sends after typing is lost on its way to the app (the same key sent again arrives; later ones are fine): the test
  sends ⌘U, which is no shortcut, first.
- UIKit does not say whether a key is held. A command that fires again within 0.65 s of its last firing is reported `repeat: true`
  (the system repeats a held key after about half a second). A person who presses ⌘N or ⌘B twice within 0.65 s has the second press
  ignored (those two handlers ignore repeats); ⌘J and the rest do not look at `repeat`. Not tested with a really held key.
- Android: a React Native `Modal` is a window of its own, so Ctrl shortcuts (and Escape) are not taken while a `Modal` is open. U2's overlays are on `Modal`.
