# iOS: the picker's and the insert popup's sheet does not show until the first key (diagnosis)

Branch `rn-ioskb-diagnose`. Found and checked on the iPhone 17 and iPad Pro 11-inch (M5) simulators, iOS 26.3, with the software keyboard, React Native 0.86.3 (Fabric), Expo 57.

## What the user saw

On the phone, a tap on the composer's model chip brought the keyboard up, but the picker did not show. When the user typed a letter, something flickered and the picker appeared above the keyboard. The library's insert popup did the same. Both are an `Overlay` with an autofocused search box, and on the phone layout an `Overlay` is a `Sheet`.

## The cause (confirmed)

Two things meet while the sheet opens:

1. **The sheet's rise is a native-driven animation.** `Sheet` (`app/src/ui/Sheet.tsx`) moves its surface (translateY) and fades in its backdrop with `rise`, an `Animated.timing` of 180 ms with `useNativeDriver: true`. It starts when the sheet opens.
2. **The keyboard handler ran a `LayoutAnimation`.** The autofocused box brings the keyboard up while that rise is still running. On `keyboardWillChangeFrame`, `useKeyboardAvoid` (`app/src/ui/useKeyboardAvoid.ts`) called `LayoutAnimation.configureNext(create(duration≈383 ms, "keyboard", "opacity"))` and then `setInset(335)`.

That commit changes the sheet's surface (its padding, maxHeight and position), so the layout animation applies to it. When the native rise ended while that layout animation was still running, the surface ended up off-screen:

- the backdrop was dimmed and the keyboard was up;
- no sheet was visible anywhere, not even its top above the keyboard;
- the surface was missing from the native view hierarchy that Maestro reads.

The layout, meanwhile, was correct. `measureInWindow` gave the surface at y=70, above the keyboard's top at 539, and `inset` was 335. The sheet stayed lost until the next React render of the `Sheet` re-applied its props. In the real picker that render is the first typed letter, because the search box is controlled (`query`). That is the "flicker, then it appears".

**The orchestrator's hypothesis is refuted.** It was: `rootRef` is null, or `measureInWindow` returns garbage, while the Modal is presented, so `inset` stays 0. The logs show `rootRef` set, a correct measure and `inset` = 335 about 200 ms after the tap.

**Popover and Dialog (the tablet layout) are not affected.** They have no native-driven animation, and the iPad passed every case before the fix.

### Evidence

Temporary `[kbdiag]` logging read from the simulator's unified log, toppop on the phone. Times are ms mod 100000; the tap is at 66472.

```
66472 sheet open effect: rise 0->1 start; rootRef=set inset=0
66477 sheet surface onLayout y=343.7 h=530.3
66526 +50ms  surface y=1217.7          (translateY = window height: not risen yet)
66595 sheet Modal onShow
66669 avoid keyboardWillChangeFrame screenY=539 height=335 duration=383.3 rootRef=set
66669 avoid measureInWindow x=0 y=0 w=402 h=874 -> next=335
66670 avoid setInset(335) +LayoutAnimation 383.3        (layout animation until ~67053)
66716 sheet surface onLayout y=70 h=469
66926 sheet rise done finished=true                     (the rise ends inside the layout animation)
67476 +1000ms surface y=70   (the layout says above the keyboard; the screen shows no sheet)
72564 keyboardWillChangeFrame duration=0 (typing "a"): setInset(335), no change
```

**Keyboard already up when the overlay opens (topkb, the insert popup's case).** The keyboard bounces as the focus moves into the new Modal:

1. `keyboardWillChangeFrame` with screenY=874, then `keyboardWillHide`.
2. About 120 ms later, `keyboardWillChangeFrame` with screenY=539 and duration 383.

The second event sets the layout animation again, and the sheet is lost the same way.

**Bisect on the device** (the toppop case on the phone):

| Change | Result |
|---|---|
| No LayoutAnimation (native driver kept) | The sheet shows |
| No native driver (LayoutAnimation kept) | The sheet shows |
| Both kept | The sheet is lost |

**Screenshots** (outside the repository):

- `/tmp/rn-ioskb-repro/evidence/phone-FAIL-*-before-typing.png`: dimmed page and keyboard, no sheet.
- `phone-noLayoutAnimation-PASS-toppop-geometry.png`: the sheet is drawn above the keyboard.

**Timing.** The sheet is lost when the rise ends while the keyboard's layout animation is still running. The table below is lost opens per total, iPhone simulator, with nothing re-rendering the sheet:

| Rise | 180 ms | 300 ms | 450 ms | 600 / 900 / 1500 ms |
|---|---|---|---|---|
| Old hook | 5/5 | 5/5 | 1/9 | 0/5 each |
| Fixed hook | 0/5 | 0/5 | 0/5 | not run |

A 180 ms rise with 150 ms of busy JavaScript also lost it 5/5 with the old hook. Evidence is in `/tmp/rn-ioskb-timing/`.

## Why the existing `sheets` flow did not catch it

- **Its keyboard case is a `Popover`.** The "bottom popover with an autofocused box" (section 5) is a top-level `Popover` on the phone too. A popover has no native-driven animation, so the layout animation does it no harm.
- **Its sheets open with no autofocused box.** The form sheet and the nested sheets are opened without the keyboard; the keyboard comes later, when the flow taps a box, long after the rise has ended.
- **The geometry check reads the layout, and its own render repaired the sheet.** `measureInWindow` reports the layout, not where the view was drawn, so it said `ok` even with the sheet lost. And the re-render that writes the geometry line (1.5 s after opening) put the lost sheet back. That re-render is why the first version of the new cases, without the logging, passed even with the old hook.

## The regression case (in the `sheets` flow, section 6)

`app/src/dev/SheetsSelfTest.tsx` gains `TopOverlay` and `TopKb`. Each holds the real `Overlay` (`ui/Overlay.tsx`), declared at the top of the screen and not inside another overlay, with an autofocused, controlled box and six rows, as `Picker.tsx` has. There are three cases:

- `sheets-toppop`: kind popover, opened from the bottom bar with the keyboard down. This is the model picker.
- `sheets-topdlg`: kind dialog, opened the same way.
- `sheets-topkb`: kind dialog, opened from a button over a text box that already has the keyboard. This is the insert popup.

Where they are a sheet (the phone), the sheet rises over 300 ms. That uses `sheetTiming.riseMs`, a test-only knob in `ui/Sheet.tsx` (production stays 180 ms), and puts the end of the rise in the middle of the losing window.

The flow (`app/e2e/maestro/sheets.yaml`, section 6) checks each case in this order:

1. It waits 4 s for `sheets-<id>-input`. Maestro reads the native views, so a lost sheet fails here.
2. It takes a screenshot.
3. It waits for the geometry line (measured at 6 s, after the wait, because its render repairs a lost sheet) and asserts `geometry ok`.
4. It types a letter, takes a second screenshot and closes the overlay with a row.

`app/test/nolayoutanimation.test.ts` is a source guard in the style of `noplainhttp.test.ts`. It fails on any use of `LayoutAnimation` in `app/src` outside `dev/`.

```sh
node app/e2e/run.mjs sheets --platform ios --device <your iPhone simulator> [--no-build]
node app/e2e/run.mjs sheets --platform ios --device <your iPad simulator> [--no-build]
cd app && npm test        # includes nolayoutanimation.test.ts
```

| Run | Old hook (before the fix) | Fixed hook |
|---|---|---|
| `sheets`, iPhone | **Fails** in section 6, at the wait for `sheets-toppop-input`. Each case alone fails too: toppop 5/5, topdlg 5/5, topkb 4/4 (a fifth topkb failure came from a run that was not repeated). | **Passes**, sections 1–6 |
| `sheets`, iPad | Passed (popover and dialog, unaffected) | **Passes** |
| `nolayoutanimation.test.ts` | **Fails** (lines 43 and 56 of the hook) | **Passes** |

## The fix (implemented: commit `c467bd13`)

`app/src/ui/useKeyboardAvoid.ts`:

- Both `LayoutAnimation.configureNext(...)` calls are removed, with the import; `covered(screenY)` no longer takes a duration.
- The inset is set at once on `keyboardWillChangeFrame` / `keyboardWillHide`, as it already was on Android.
- The header comment says why.

Nothing else changes: Android only ever ran this branch with no animation, and the web's `useKeyboardAvoid.web.ts` is untouched.

**Why the fix belongs in the shared hook.** `LayoutAnimation.configureNext` applies to every view the next commit changes, anywhere in the app. The app has other native-driven animations that a keyboard commit could also touch:

- `screens/board/Overlays.tsx`
- `screens/subagents/Parts.tsx`
- `screens/usage/Popup.tsx`
- `screens/quotes/Flash.tsx`

So switching the Sheet to the JS driver would fix this case and leave the hazard in place. Deferring the autofocus would leave it in place too, and would also need a change in every screen. Removing the layout animation from the shared hook fixes every overlay at once, and the source guard keeps it out.

**The cost.** On iOS the sheet no longer animates its move with the keyboard: it takes its new place at once. When it opens, that move happens inside its own rise. When a box takes the focus in an open sheet, the sheet moves up at once and the keyboard slides in under it. That is what Android already does.

If a smooth follow is wanted later, a safe design is an `Animated` value for the inset that is not on the native driver, so it never shares a commit-wide layout animation. That is not needed for this bug.

## Uncertain, and left as it is

- **The internal mechanism is inferred, not read in React Native's source.** I believe the end of the layout animation puts the surface's starting transform back after the native driver finished with it; the device behaviour and the bisect fit that. The facts above do not depend on it.
- **A lost sheet did not always come back when Maestro typed into an uncontrolled box.** With the controlled box (as in the picker), a render of the sheet brings it back, which is the user's report.
- **The fix is not checked on a physical iPhone.** It is checked on the simulators only.
- **Every mounted overlay subscribes to the keyboard events, open or not.** About nine listeners fire per event, most with `rootRef` null. This is harmless and not changed.
- **I did not check the Android device flows.** The Android branch of the hook only lost the now-unused hide-event parameter.
