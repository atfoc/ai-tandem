# aiwb-indent

The hanging indent of the composer's text box on iOS and Android. When a line of a box that edits like code (`ChipInputProps.editing`)
wraps, its continuation lines start where that line's text starts after its leading tabs and spaces (its indent), not at the box's
left edge; a tab is drawn `tabWidth` columns wide (2, 4 or 8, Settings > Composer). React Native's TextInput has no such style, so the
module puts it on the platform's own text view, **for drawing only**: the text React Native holds and compares is never changed, so
the caret, autocorrect, the input method and `onChange` behave as they do without it. The web box draws its own indent
(`ChipInput.web.tsx`); there the module is null.

The module does not change the text, the caret or the selection, does not handle Tab or Enter (the box's JS does, over `aiwb-keys`),
and does not decide when the indent is on: `hang.ts` asks for it.

| File | What |
|---|---|
| `src/AiwbIndent.ts` | the contract: `setIndent(tag, tabWidth): Promise<boolean>`, the event `onDrawnHeight {tag, height}`, and the rules both native sides follow (`indentColumns`, `paragraphs`, `hangWidth` with `MAX_INDENT_SHARE`, `tabInterval`) |
| `src/AiwbIndentModule.ts` | the native module, `requireOptionalNativeModule("AiwbIndent")` (null in a build made before the module: the box wraps as React Native draws it) |
| `src/AiwbIndentModule.web.ts` | null: the web box draws its own indent |
| `src/fake.ts` | the module in JS, for the tests of `hang.ts` |
| `ios/AiwbIndentModule.swift` | the delegate of the text view's TextKit 2 content storage (below) |
| `android/.../AiwbIndentModule.kt` | spans on the EditText's Editable, kept by a watcher span (below) |
| `../../src/platform/chipinput/hang.ts` | the JS side: attaches at the field's layout (`findNodeHandle`), asks again when the view was not found, and takes the drawn height as the box's height |
| `../../test/aiwbindent.native.test.ts` | the Swift and the Kotlin read as text: the names, the max share against the contract's, the lines the prototype showed to matter |
| `../../test/hangindent.test.ts` | the rules of the contract and the controller of `hang.ts` over the fake |

## What `setIndent` does

`setIndent(tag, tabWidth)` finds the TextInput's native view by its React tag and draws the indent on it with tabs `tabWidth` columns
wide; called again with another width it changes the width; `0` takes everything off. It answers `true` when the view was found,
`false` when it was not (not mounted yet, or gone): the caller asks again at the view's next layout. It never rejects. While the
indent is on, the module emits `onDrawnHeight` with the height the text takes as drawn, padding included (React Native measures the
box from JS's text, without the indent, so a wrapped line can make its height wrong); `hang.ts` sets the box's height from it.

A paragraph's indent is its leading spaces and tabs (a space one column, a tab up to the next multiple of `tabWidth`). Its first line
is not moved (its own spaces and tabs put its text there); the others start `columns × width of a space` from the left edge, at most
half the text's width (`MAX_INDENT_SHARE`). Tab stops are at every multiple of `tabWidth` spaces from the left edge.

## How, per platform

- **iOS.** React Native's Fabric text input (`RCTTextInputComponentView`) compares the attributed string JS sends with the text view's
  (`RCTIsAttributedStringEffectivelySame`, the same attribute runs) and sets the text again when they differ: paragraph styles put in
  the text storage would make every render from JS reset the text (the caret jumps, autocorrect and the input method lose their
  state, an extra `onChange`). So the module changes only what is drawn: the RCTUITextView lays out with TextKit 2, and the module
  becomes the delegate of its `NSTextContentStorage` (keeping the one before, which had none, and forwarding to it). For a paragraph
  with an indent or a tab, `textContentStorage(_:textParagraphWith:)` answers an `NSTextParagraph` of the paragraph's own text with
  each paragraph style's `headIndent` set to the hang, no tab stops and `defaultTabInterval` the tab interval. The paragraphs are made
  again (an attributes edit over the whole text in an editing transaction, the text unchanged) on attach, on a new tab width, on
  detach and when the text's width changes (KVO of the bounds and frame: the cap depends on it). The height is the text view's
  `contentSize` (KVO), which includes React Native's padding. A component view that Fabric recycles (its `tag` set to 0 or another
  tag) is treated as detached until `setIndent` is called for it again. The module never reads `textView.layoutManager`: that
  switches the view to TextKit 1 for good.
- **Android.** React Native puts JS's text into the `ReactEditText` with `Editable.replace` (its `manageSpans` keeps only spans over
  text that did not change) and tells the watchers it was given with `addTextChangedListener` only of the user's edits. The module
  sets a `TextWatcher` on the Editable itself as a span (`SPAN_INCLUSIVE_INCLUSIVE`, priority 200, above TextView's own ChangeWatcher's
  100; a `NoCopySpan`): SpannableStringBuilder tells it of every change, JS's included, before the layout reflows and before React Native
  copies the text into the cache it measures from. In `onTextChanged` it puts a `HangSpan` (a `LeadingMarginSpan`: no margin on the
  first line, the hang on the others) on each indented paragraph and `TabStop`s (k × interval, over the text's width, at most 64) on
  each paragraph with a tab, as a diff (a span already right stays), so a keystroke reflows only what changed. Both implement
  `UpdateLayout`: without it, a span added outside a change of the text (a new tab width) did not move the line breaks. An empty text
  from JS is `setText(null)`, a new Editable: the module's `Editable.Factory` on the EditText watches every new one. A change of the
  view's width applies the spans again (the cap); the height is read before each frame (`OnPreDrawListener`: the layout's height
  plus the padding, in dp). A view whose id is no longer the tag is let go.

## Limits

- An iOS text view on TextKit 1 (something read its `layoutManager`) gets no indent and no heights; `setIndent` still answers `true`.
- An indent is at most half the text's width: a deeper one is drawn that wide, so a line always has room.
- Only spaces and tabs make the indent: a list's `- ` or `1. ` is not part of it (continuation lines start under the dash).
- After a change, one frame may show the box at its old height, until the drawn height reaches JS.
- Checked by hand (a temporary screen with the real box, not committed) on the iPhone 17 simulator (iOS 27.2) and the Android emulator
  (API 36), each with the soft keyboard: the hang of tab and space indents in both box sizes; typing into an indented line (one
  onChange per key, no loop, the caret where it was typed); tab width 2, 4, 8 changed live (the lines broken again; on Android this
  needed `UpdateLayout`); the box's height following the drawn text where React Native's own measure was a line short (tab width 8);
  Enter keeping the indent, the key row's Indent (and its Outdent key, which has since been removed), a chip on an indented line
  (updates from JS); the indent switched off giving React Native's own drawing back; a misspelling next to an indent still marked by
  the spell checker (iOS).
- Not verified: on a real device; input method composition (CJK), dictation, autocorrect actually replacing a word next to an indent
  (the simulator's keyboard did not correct); hardware keyboards; a width change (rotation, iPad split view). The Swift and the Kotlin
  are also checked as sources by `app/test/aiwbindent.native.test.ts`.
