# Package P1: sheets and overlays with the on-screen keyboard, as built

Found by V1 on the iOS simulator and the Android emulator; all three fixed in the overlay primitives (`app/src/ui`), no screen changed but the Servers form's own props.
Flow `app/e2e/maestro/sheets.yaml` (screen `src/dev/SheetsSelfTest.tsx`, `app/e2e/README.md`) and the add-form steps of `net-pinned-stream`.

## 1. The sheet rises over the keyboard
- `ui/useKeyboardAvoid.ts` (the web's `.web.ts` does nothing, the web's layouts are as they were): the overlay's full-window layer is measured against the
  keyboard's top (`Keyboard` events: `keyboardWillChangeFrame` on iOS, `keyboardDidShow` on Android; a floating iPad keyboard covers nothing), which gives the
  points to leave free. `Sheet` and `Dialog` pad the bottom of the layer by that and take the height that is left (`maxHeight`); the safe area is the keyboard's while it is up.
  Measured, not the keyboard's height alone: a window the system already resizes would be covered twice.
- The scroll view scrolls the focused box into view (iOS does not; with `ROOM_BELOW` points under it, so a hint, the next box or a check box shows too).
- `ui/sheetfooter.tsx`: a form taller than what the keyboard leaves would still hide its buttons, so on native a sheet draws the screen's `DialogActions` below its
  scroll view (pinned). Dialogs, popovers and the web keep them at the end of the content (L3 and L7 look for them inside the form). The Servers form dismisses the keyboard when
  Test connection or Save is pressed (the answer shows below the boxes).
- Checked by pressing every button of the sheet with the keyboard up on both platforms, and by switching the avoidance off: the flow fails at the first button on both.
- Added by rn-sw-nativekb: a `Popover` is placed in the part of the window the keyboard leaves (`placement.ts` `covered`, `useKeyboardAvoid` in `Popover.tsx`; native only): an `up` popover whose anchor is under the keyboard rises with the keyboard's top, one that does not fit gets the height that is left and scrolls. It is the composer's model picker and folder browser on the tablet layout. `sheets.yaml` step 5, on an iPad and an iPhone simulator.

## 2. A popup opened from a sheet
- `ui/overlayhost.tsx`: every overlay draws an `OverlayHost` inside its `Modal`; `InTopOverlay` wraps each primitive's `Modal` and, when another overlay is open as it opens, puts it
  into the topmost host (a portal), whether it is declared beside the sheet (the confirm dialog at the root of the shell) or inside its content. `nestedlayer.tsx` and the confirm's
  `nested` mode are gone. Only the `Modal` goes through the host: the primitive's hooks stay where it is declared, its content sees the host's contexts (same providers).
- Checked on iOS and Android: Menu (Popover), Dialog with a text box and a second Sheet, each declared beside and inside the form sheet (`sheets.yaml`); `net-pinned-stream` removes a server
  through the confirm dialog over the Servers sheet. Web: L1, L7, L3, L2.

## 3. The secret is not a password
- `textContentType`, `autoComplete`, `importantForAutofill` are set (`PLAIN_INPUT` for the other boxes of the form, `SECRET_INPUT`), but on iOS that is not enough: with
  `secureTextEntry`, with `oneTimeCode` or with `none`, a form that was filled, tested and saved still made iOS ask "Save Password?" (reproduced in `net-pinned-stream`'s second add,
  not on a shorter form). So on iOS `ui/SecretInput` is an ordinary box that shows one bullet per character and keeps the real text in `value`; `ui/maskededit.ts` works out what each edit
  (typing at the caret, backspace, over a selection, a paste) did to it (`test/maskededit.test.ts`). Android and the web keep `secureTextEntry` with autofill off.
- Typing in the middle of the text: on iOS 26 (React Native 0.86) the caret stays where the edit left it, since React Native keeps it at its distance from the end of the text, which an edit at the caret does not change (`sheets.yaml` step 4 types at the start and checks the text). A `selection` prop set after an edit made it worse (it was applied again over the caret the person had moved: "XY" typed at the start went to the end), and so would a `setSelection` race the next key; `maskededit` answers the caret after each edit (`applyMaskedEditAt`) and the box reads the next edit against it until the box reports its own. Copying out of the box gives the bullets, not the secret, and that stays (a hidden secret is not copied out, as with a password field; pasting in works).
