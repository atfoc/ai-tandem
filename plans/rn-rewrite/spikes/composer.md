# Spike: the composer's text input with inline board-reference chips

**Verdict: GO** for the composer, on iOS and on the web build. Android is expected to work but is **not verified** (the emulator
was held by another agent); a short check on it is the first thing the real implementation does (see "Android").

The risk named in the goal (section 9: "React Native has no editable rich text with inline elements") is real, and it is
settled by a plain text input that draws a chip as a styled run of its own characters, with the document held beside it
and every edit applied to the document. No native module is needed. Native chips are flat rectangles, not rounded pills,
and a copy out of the input on iOS gives the label, not the tag (both in "What does not work").

Code: `spikes/composer/` on branch `rn-spike-composer`. Everything is checked by one script, `spikes/composer/run.sh`.

## What was built, and why this approach

The page's composer (`web/src/RefInput.tsx`) is a `contenteditable` whose DOM is owned by hand. Its value is the message text
with each reference as an inline tag (`web/src/logic/refs.ts`); that string is what is sent and what a draft keeps. Behaviour
to keep: a chip is put at the caret with a space before and after it as needed; Backspace/Delete next to a chip remove it
whole; the caret goes over a chip as one unit; copy gives the tags, paste of tags gives chips; the sent text is the trimmed
value.

**Approach (a), chosen**: a controlled multiline `TextInput` showing a string in which each chip is its label between two
no-break spaces. On native the chip is a nested `<Text>` with a background colour (children of the `TextInput`); on the web,
where `react-native-web` draws a `<textarea>` that shows no styled runs, the chips are drawn in a `Text` layer behind a
textarea whose own text is transparent (same string, same style, so the lines break at the same places). The truth is a
**document** (`Doc = (string | Ref)[]`, in `src/logic/chipdoc.ts`), and the string shown is derived from it:

- `applyChange(doc, next, hint, known)`: the input reports a new string; it is diffed against the one shown (common prefix and
  suffix, with the previous selection as a hint for equal characters, surrogate pairs kept whole). An edit that touches a chip
  takes the chip away whole (backspace on its last character, forward delete on its first, a word delete across it, typing over
  a selected chip); an insertion inside a chip goes to its nearer edge; a text pasted with tags gives chips; a pasted chip
  label that this input has held gives the chip again.
- `snap(chips, prev, next)`: the selection reported by the platform never stays inside a chip: a one-character step into a chip
  (an arrow key) goes over it, a tap goes to the nearer edge, a selection that ends inside a chip is widened to take it whole.
  The input is told the snapped selection through the `selection` prop.
- `insertRef(doc, selection, ref)`: the page's rules for the spaces around a new chip.
- The message is `serialize(doc)` of **`web/src/logic/refs.ts` imported in place** (Metro `watchFolders`), not a copy. The checks
  compare it with `serialize([...])` of the same content built by the page's own `selectionRef` / `pointRef`.

| File | Lines | Where it runs |
|---|---|---|
| `src/logic/chipdoc.ts` | 200 | everywhere (no React; node-testable) |
| `src/ChipInput.tsx` | 134 | everywhere: the one component, state and handlers |
| `src/ChipField.tsx` | 32 | native: the `TextInput` with `<Text>` children |
| `src/ChipField.web.tsx` | 62 | web: textarea over the `Text` layer, copy/cut hooks |

That is one screen's worth of component for every platform and two small platform modules, as the bounds (goal 6) ask.

### Rejected

- **(b) Placeholder characters (U+FFFC) mapped to a side model.** One character per chip would make atomicity free, but the
  chip cannot be *seen*: a `TextInput` gives no per-glyph layout and no way to give a character a width, so a label cannot be
  drawn in the text's flow; an overlay would have to be placed from measurements that React Native does not expose for an
  input. (a) keeps the same idea (a model beside the string, edits mapped through it) with the label as the characters.
  Not built; rejected by this reasoning, and (a) works.
- **(c) A native text view module.** Not needed. What it would buy, and its cost, is in "What the real implementation should
  do": real rounded pills and exact clipboard tags, for a Swift module (`NSTextAttachment` or a custom `UITextView`) and a
  Kotlin one (`ReplacementSpan`), each a few hundred lines and a contract to test against a fake (goal 6), plus the
  web's contenteditable-free path staying as it is.

## Evidence

Run on this machine: Expo SDK 57 development build on the iPhone 16e simulator (iOS 26.3), headless Chromium 156.
`./run.sh` runs all of it (about 3.5 minutes on a busy machine; the iOS part is most of it). Result of the last run:

| Level | What | Result |
|---|---|---|
| Unit (node:test) | document logic, 13 tests, incl. the message equal to refs.ts for the same content | 13/13 |
| Type check | `tsc` for app, checks and imported page logic | clean |
| Web (Playwright, real key events) | `checks/web.mjs`, 34 checks + 8 "no page errors so far" | 42/42, also under 4x CPU throttle (`WEB_THROTTLE=4`) |
| iOS simulator, Maestro 2.11.0 | `checks/ios/composer.yaml`, asserted from what the app posts at each `mark` | 26/26 |
| iOS simulator, XCUITest hardware keys | `checks/ios-keys/`: 4 tests | 4/4 |

### Required demonstrations

| Behaviour | Web (Chromium) | iOS (simulator) |
|---|---|---|
| Chip inserted at the caret, spaces as the page does, tag in the message | pass: after text, in the middle of a text, before text, a second chip of another kind | pass: after typed text; the same through the button |
| Typing around a chip | pass: before, between chip and its space, after | pass: before the chip (tap at its left half), after it (tap at its right half) |
| Backspace deletes a chip whole | pass: one Backspace removes the space after it, the next removes the chip; Delete at its start removes it | pass: same two steps (Maestro `eraseText`); XCUITest: the delete key at the chip's end removes it |
| Caret/selection never inside a chip | pass: 14 ArrowRight and 14 ArrowLeft across a line never stop inside; one press crosses a chip; a click in a chip goes to an edge; double click selects the chip, not a word of it; Shift+Right takes it whole | pass: a tap in either half of a chip goes to that half's edge (raw selection event 15 became 22); double tap selects the whole chip. XCUITest: 26 left arrows and 26 right arrows never stop inside, one press crosses; Shift+Left from the chip's end selects it whole |
| Hardware keyboard | pass: Playwright sends real key events (Chromium) | pass for the keys below, sent by XCUITest `typeKey` as keyboard events: arrows, Shift+arrows, ⌘A/⌘C/⌘V/⌘X, the delete key; **not testable here**: forward delete and Option+delete do nothing even in plain text on the simulator, so the iOS word and forward delete across a chip are covered only by the unit tests (`applyChange`) and, for forward delete, by the web check |
| Multi-line growth | pass: grows by line (Enter) and by wrap, stops at the maximum (182 px), scrolls and follows the caret | pass: 66 → 88 → 110 → … px as lines are added, stops at its maximum; line breaks are in the message |
| Message model equals refs.ts | pass: 2 selections + a point + a line break = `serialize` of the same content; the sent text is the trimmed message; the box is empty after the send | pass: same content, same string, sent text, box emptied |
| Copy / cut / paste | pass: ⌘C of a selection with a chip puts the tags on the clipboard; paste gives the chips again; ⌘X cuts them | pass within the app: copy a selected chip, paste into the input, it is a chip again (the input knows the label it drew). **Not** the tags (see below) |

Screenshots: `plans/rn-rewrite/spikes/composer/` (`ios-chips.png`: two kinds of chip, wrapped lines, caret at a chip's edge;
`ios-paste.png`: a chip pasted back; `web-chips.png`, `web-multiline.png`).

## Findings that change the real implementation

1. **No state set from an effect after every key on the web.** The first version told its owner of each change from a
   `useEffect`; a burst of keys that made a line wrap hit React's limit on nested updates ("Maximum update depth exceeded",
   minified error #185) in about half the production-build runs, never in the development build. Fixed by telling the owner from
   the handler that made the change, so both go in one render (`ChipInput.tsx`, `tell`). It also showed that the `selection`
   prop must not be set again when the field reports what it was just told (`onSel` returns early). Keep both rules.
2. **iOS: `TextInput` children and the `selection` prop work together** in React Native 0.86 (Fabric): the text is the children,
   no `value`, and the selection is moved with the prop (React Native applies it when it differs from the last one the field
   reported). Verified by 30 iOS checks run repeatedly; no flicker was visible in the screenshots, but a frame in which the
   caret is inside a chip before it is moved is not excluded and was not measured.
3. **iOS word-level selection is whole-chip**: a double tap on a chip selects it all, because the label's spaces are no-break
   spaces, so UIKit takes it as one word.
4. **The Metro environment and `EXPO_PUBLIC_*` are baked in at bundle time**, so the checks start their own Metro with a clean
   cache (`checks/ios.mjs`).

## What does not work, or is not verified

- **Chips on iOS and Android are flat rectangles**, not rounded pills with padding: a nested `Text` takes `backgroundColor`
  but no radius or padding. The padding is the two no-break spaces. On the web the layer draws rounded pills. A chip that falls
  that falls across the end of a line is drawn broken across the two lines (not looked at closely); a label has no break
  inside it (no-break spaces), so only a label longer than a line would be split.
- **Copy out of the input on iOS gives the label text** (no-break spaces around the label), not the tags. Pasting back into
  the same input restores the chip (the input keeps the references it has held, and two *different* references with the same
  label are not guessed: they stay text). Pasting into another input, another app or another session gives text. On the web the
  copy and cut hooks put the tags on the clipboard, as the page does. Closing this gap on native takes a native module or
  a clipboard hook that React Native's `TextInput` does not offer.
- **Autocorrect/predictive text**: the checks run with the keyboard's corrections off (`plain`, so that a check types what it
  types). Run once with them on (`EXPO_PUBLIC_KEYBOARD_ASSIST=1`), the simulator corrected nothing in the typed text ("teh",
  "adn", "recieve" stayed), so the path where the keyboard replaces a word next to a chip is covered by `applyChange`'s unit tests,
  not seen on a device.
- **IME composition** (Japanese, Chinese, Korean, dictation), **undo/redo** (iOS shake and ⌘Z, the browser's Ctrl+Z after a
  programmatic edit such as inserting a chip) and **dragging the selection handles across a chip** were not tested. Each is a
  place where a controlled field that rewrites its text can fight the platform. On the web, undo across a chip insertion is
  likely lost (the page's `execCommand` kept it); on iOS the undo stack is the text view's.
- **Pasting images, the @ mention popup, the ⌘P insert popup, read-only and locked states** were not part of the spike. They
  fit the same shape: the component hands out `onChange(value, beforeCaret)` (already there, for @ mentions);
  `replaceBeforeCaret`, `openInsert`, `locked` and `readOnly` (`editable`) are small additions; `logic/insert.ts` counts
  offsets in the *serialized* value, the component in the *shown* string, so a mapping between the two is needed.
- **Safari and Firefox**: not tried. The web build runs in the desktop app's Chromium window (goal 4.1), and a plain browser tab
  is not a target.
- **Performance and memory**: not measured. The field renders its children on every key (a short list of `Text`).

## Android (expected, not verified)

React Native's Android `TextInput` also takes nested `Text` children as spans, including `backgroundColor`, so the same
`ChipField.tsx` is expected to draw chips. The logic is the platform-free part and does not change. What to expect and check
first, on the emulator (`mkdir /tmp/aiwb-android-emulator.lock`), with the same flow in Maestro (its Android driver sends key events
through `adb`, so arrow keys may be reachable there):

- the keyboard's composition (Gboard's suggestions and its underlined word) when the text is re-set on every key: duplicated or
  lost characters in fast typing are the known failure of controlled Android inputs;
- the `selection` prop and keyboard arrows: the same snapping, with the `selection` applied as `setSelection` (jumpier than on iOS);
- the hardware keyboard on a tablet.

If these misbehave, the fallback is (c) on Android only, a small Kotlin view; nothing of the document logic changes.

## Versions

Expo SDK 57.0.28; react-native 0.86.3; react 19.2.3 and react-dom 19.2.3; react-native-web 0.21.4; expo-dev-client 57.0.20;
TypeScript 6.0.3; Node 24.3.0; Xcode 26.3; iOS simulator runtime 26.3 on the iPhone 16e; Playwright 1.64.1 with Chromium
156.0.8078.4; Maestro 2.11.0 on a Temurin 17 JRE (both downloaded by `checks/get-maestro.sh` into `spikes/composer/.tools/`,
sha256-checked for Maestro, nothing system-wide); the XCUITest project is generated by the `xcodeproj` gem that CocoaPods
brings.

## How to run it

```sh
cd spikes/composer
./run.sh                    # unit tests, type check, web (Chromium), iOS (builds the dev build once)
SKIP_IOS=1 ./run.sh         # no simulator
SIM=<udid> ./run.sh         # another simulator (default: the iPhone 16e of this machine)
KEYS_ONLY=1 node checks/ios.mjs   # only the XCUITest keys, with the app and Metro the script starts
FLOW=<file.yaml> node checks/ios.mjs   # any Maestro flow; what the app posted is in checks/out/posts.json
```

The iOS checks need Xcode and CocoaPods; the first iOS run builds `ios/` (generated, not committed). No credential, team id or
signing identity is used (simulator only).

## What the real implementation should do

1. **Take this as the base**: `chipdoc.ts` + `ChipInput` + the two fields move into the app's component folder; the page's
   `refs.ts` and the logic that uses it (drafts, mentions, `insert.ts`) are imported unchanged. Draft text stays the tag string:
   `docOf(text)` restores the chips from it.
2. **Keep the two rules of finding 1** (no effect-driven state after each key; do not re-apply the selection the field reports).
3. **Add** `replaceBeforeCaret`, `openInsert`/`insertText` with the offset mapping, `locked`/`readOnly`, image paste (check what
   `TextInput` offers for it on iOS and Android), the chip tooltip as a long press if wanted.
4. **Verify Android first** (above), then decide whether (c) is needed there.
5. **Ship flat chips on native** and rounded ones on the web; take (c) only if the design (Part B) asks for rounded pills or if
   copying chips out to other apps matters. Cost of (c): a Swift view and a Kotlin view (a few hundred lines each, one contract
   tested against a fake), and the document logic reused unchanged.
6. **Tests**: port `checks/web.mjs` to the app's browser tests at the three viewports (goal 7.1); keep the Maestro flow and the
   XCUITest keys as the composer's entries in the device list (goal 7.4); keep `test/chipdoc.test.ts` as a unit test.
7. **Hand the autocorrect/IME/undo/handle-drag checks to a manual list** on a device (goal 7.5) until a tool can drive them.
