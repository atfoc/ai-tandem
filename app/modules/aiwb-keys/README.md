# aiwb-keys

The hardware-keyboard shortcuts of the tablet app (goal 4.4, architecture AD-73): an iPad with a keyboard, or an Android
tablet with one, has the desktop page's shortcuts where its screen has the action. The module takes **only the shortcuts of the
list below** and emits each as the KeyboardEvent-like object that `app/src/platform/keys.types.ts` (`KeyLike`) describes; the
decisions (what ⌘N does, under which dialog it does nothing) are the page's own logic in `@aiwb/core` and
`app/src/screens/shell/shortcuts.ts`, the same as on the desktop. Typing is never part of it.

| File | What |
|---|---|
| `src/AiwbKeys.ts` | the contract: the event, the module's functions (`addListener("onKey")`, `setTabKeys`) and `SHORTCUTS`, the list below as data; `TAB_KEYS` |
| `src/AiwbKeysModule.ts` | the native module, `requireOptionalNativeModule("AiwbKeys")` (null in a build made before the module: the port then takes no key) |
| `src/AiwbKeysModule.web.ts` | null: the web uses the page's own `keydown` (`platform/keys.web.ts`) |
| `src/fake.ts` | the module in JS, for the tests of the port |
| `ios/AiwbKeysModule.swift` | UIKeyCommands on the root view controller of every window |
| `android/.../AiwbKeysModule.kt` | the activity window's `dispatchKeyEvent` |
| `../../src/platform/nativekeys.ts`, `keys.native.ts` | the adapters `keysOver(module): OnKey` (the keys port) and `tabOver(module)` (Tab on request), and the port itself (`onKey`, `takeTab`) |
| `../../test/nativekeys.test.ts` | the adapters over the fake; the list against what `@aiwb/core` reads; the list and the Tab handling against the Swift and Kotlin sources |
| `../../src/dev/KeysSelfTest.tsx`, `../../e2e/maestro/keys.yaml`, `../../e2e/xcuitest/keys/` | the device test (below) |

## The list

`mod` is ⌘ on iPadOS (`metaKey`) and Ctrl on Android (`ctrlKey`); the event's `key` is the letter, upper case with Shift, as a browser
makes it; `code` is the physical key (`KeyN`, `Enter`, `Escape`). `keyPlatform()` (`screens/shell/keyplatform.ts`) tells the page's
predicates which of the two to read.

| Shortcut | `code` | Desktop page |
|---|---|---|
| mod+N | `KeyN` | a new chat where the user is |
| mod+B | `KeyB` | hide or show the sidebar |
| mod+Shift+B | `KeyB` + shift | the chat's tree |
| mod+J | `KeyJ` | hide or show the chat panel |
| mod+L | `KeyL` | quote the selection / add the board's selection to the message |
| mod+Shift+L | `KeyL` + shift | pick a point on the board |
| mod+P | `KeyP` | insert a prompt |
| mod+E | `KeyE` | open or close the composer's model and effort menu |
| mod+Enter | `Enter` | save (the library's edit form) |
| Escape | `Escape` | close a popup |

Every other key — letters, Enter, Shift+Enter, arrows, Backspace, ⌘A/C/V/X/Z, Ctrl+N on an iPad, Ctrl+Shift+anything on iOS — is the
system's and the text box's. The shortcuts above are the ones the desktop page has **in a text box too** (it handles them on the
window in the capture phase), so they are taken from a text box on a tablet as well; the composer's Enter, Shift+Enter and chip keys
(AD-60) are not among them. The shortcuts that make no sense on touch are not invented. A phone has the same keyboard support when
one is attached; nothing is added for it.

The list is in three places that must agree: `src/AiwbKeys.ts`, the Swift and the Kotlin source. `app/test/nativekeys.test.ts` reads
the two sources and fails when they differ from the TypeScript.

## What the module does

- It takes the keys **while at least one JS listener is added** and gives them back with the last one (`OnStartObserving` /
  `OnStopObserving`): a build in which nothing registers a handler leaves the keyboard to the system.
- `preventDefault()` on the object is a no-op (`KeyLike`'s contract): the key was taken by the native side the moment it was one of the
  list. The object remembers the call for the handlers after it (`defaultPrevented`), as the keys port promises.
- **iOS.** One `UIKeyCommand` per shortcut (`addKeyCommand` on the root view controller of each window scene; a window that becomes key
  later gets them too). UIKit looks for a command along the responder chain from the first responder, so the commands work with
  the focus in a text box or in the board's web view. The ⌘ commands have `wantsPriorityOverSystemBehavior = true` (they win over the
  text editing's own commands, as the page's capture-phase handler wins over the text box); Escape does not. Every command has a
  `discoverabilityTitle`, so the list is on the screen when ⌘ is held. UIKit does not say whether a key is held: a command that fires
  again less than 0.65 s after its last firing is reported as `repeat: true` (the system repeats a held key after about half a second).
- **Android.** The module wraps the activity window's `Window.Callback` and answers `dispatchKeyEvent` first, before the focused view and
  the input method: a key down that is a shortcut (exact Ctrl and Shift, no Alt or Meta) is emitted and taken, its key up with it.
  The wrapper is put back when the last listener goes. A `Modal` of React Native is a window of its own with its own callback, so a
  shortcut is not taken while one is open (U2's overlays are on `Modal`): the key reaches the dialog's own handling instead.

## Tab, on request

Tab and Shift+Tab (`TAB_KEYS`, not part of `SHORTCUTS`) are the system's (the focus moves on Android; on iPadOS the text view types a tab
or the focus moves), except **while the composer's box asks for them**: it has the focus and code editing is on (Settings > Composer).
Then the box indents and outdents, as on the desktop page. `takeTab()` (`platform/keys.native.ts`, over `tabOver` of `nativekeys.ts`)
takes them and answers the function that gives them back; takers are counted, the first calls `setTabKeys(true)`, the last give-back
`setTabKeys(false)`. The keys come through the keys port's handlers (`onKey`) as `{ key: "Tab", code: "Tab", shiftKey, metaKey: false,
ctrlKey: false, altKey: false, repeat }`, so they are taken only while a handler is registered too; a build made before `setTabKeys` has
no such function and `takeTab` does nothing there.

- **iOS.** Two more `UIKeyCommand`s, input `"\t"` without and with Shift, `wantsPriorityOverSystemBehavior = true` (over the text view's
  own tab and the focus system), discoverability titles "Indent" and "Outdent", on every root view controller while the flag is on and
  somebody listens (a root view controller that comes later gets them as the others do); kept apart from the shortcuts' commands and
  removed when the flag goes off or the last listener leaves. Their `propertyList` is `"tab0"` / `"tab1"`; repeat as for the others.
- **Android.** `dispatchKeyEvent` of the same window callback: `KEYCODE_TAB` with no Ctrl, Alt or Meta (Shift allowed) is emitted and
  taken while the flag is on (a `@Volatile` the callback reads), its key up with it; `repeat` is `repeatCount > 0`.

Not verified on a device yet: the Swift and the Kotlin are checked by `app/test/nativekeys.test.ts` only as sources.

## The device test

`node app/e2e/run.mjs keys --platform ios --device <udid>` (`ORCHESTRATION.md`: your own simulator). The flow
`app/e2e/maestro/keys.yaml` opens the keys self-test screen of the development build and types into its text box (Maestro can type
but cannot send ⌘ combinations on iOS); the runner then runs the XCUITest bundle `app/e2e/xcuitest/keys`, which sends the shortcuts as
a keyboard does, from the text box, and reads the screen: the sidebar, the panel and the chat counter changed by the real shell
shortcut handler, the last key as the page's predicates read it, and that nothing typed reached a shortcut. The screen's verdict
(`keys self-test ok` / `FAILED`) is posted to the runner like the other self-tests'. On Android the same screen is driven with
`adb shell input keycombination` (API 33+).
