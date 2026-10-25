# The sliders: design and decisions

Part of `small-improvements-goal.md`: sections 3.2 (delay before send), 3.3 (max chats), 3.4 (the slider), decisions 4.1, 4.6–4.8,
4.10, checks 6.2–6.4, risks 7.5–7.6, and the open questions of section 8 that concern the sliders. Marks as in the goal; every
decision here is `[proposed]` by the lead of this part unless it says otherwise.

## 1. One component

`app/src/ui/Slider.tsx` (the control) and `app/src/ui/sliderlogic.ts` (its arithmetic: no React, no react-native, so Node tests
it, as `swipelogic.ts` is for `SwipeRow`). The props are in `Slider.tsx` and are the contract between the slider and its two
callers:

```ts
type SliderProps = {
  value: number; min: number; max: number; step: number; bigStep?: number;   // bigStep: Page Up/Down, default 10 steps
  label: string;                       // the name a screen reader reads
  format(v: number): string;           // the value beside the track, the ends' labels, the value a screen reader reads
  onCommit(v: number): void;           // once per release, tap, key, −/+ press, adjust action; never for the value it has
  onChange?(v: number): void;          // live, while a drag moves
  disabled?: boolean; mark?: number; size?: "sm" | "touch"; verticalKeys?: boolean;
  testID: string;                      // parts: -track (role slider), -handle, -value, -min, -max, -minus, -plus, -mark
};
```

The root carries `data-value` (the shown value: live while dragging), `data-disabled` and `data-dragging`; the focusable,
adjustable element is `<testID>-track`.

**No new dependency (4.8).** The drag and the tap are `react-native-gesture-handler`'s `Pan` and `Tap`, already in the app and
already used the same way by `Sheet` (the handle's pull), `SwipeRow` (a sideways swipe inside a scrolling list on the phone) and
`Resizer` (a mouse drag on the web). It runs on iOS, Android, the web build and the desktop window. The screen reader is React
Native's own accessibility props, the keys are the web's `keydown` (react-native-web passes `onKeyDown`). A library slider
(`@react-native-community/slider`) was not taken: it is a new native dependency, it looks like each platform's own control and not
the app's theme, and its web build has neither the app's focus ring nor one change per drag.

## 2. Behaviour

- **Values are steps.** A value is `min + k·step`, held to the ends. The delay works in milliseconds (100…10 000, step 100), so no
  value is a fraction; the max chats in whole numbers (1…100, step 1).
- **Drag.** A `Pan` that activates after 4 points sideways and fails after 10 points up or down: a vertical move that starts on the
  slider scrolls the sheet or the screen as one that starts elsewhere does, a sideways one is the slider's and the sheet does not
  scroll (3.4, 6.4). The handle's centre goes to the pointer's position on the track (not the pointer's travel), snapped to the
  nearest step. Once active the pan keeps the pointer until it is let go, wherever it goes: it does not end when the finger or the
  mouse leaves the slider (native: the gesture handler's default; web: pointer capture, and the window's pointer moves while active
  as `Resizer` does, because the handler can drop the last move). On the web build `touch-action: pan-y` on the slider leaves a
  vertical finger scroll to the browser.
- **Tap.** A `Tap` on the track (a press that moves less than 10 points) moves the handle there: one commit. `Race(pan, tap)`.
- **Inside a modal.** The slider wraps itself in a `GestureHandlerRootView` (one nested in another renders a plain view): the
  Popover and the Dialog are drawn in a `Modal` that has no root of its own, and on native a gesture inside a modal needs one.
- **A drag does not close what it is in (7.5).** A popover and a dialog close on a press of their backdrop (a `Pressable` whose press
  must *start* on it); a sheet closes on a press of its backdrop and a swipe of its handle only. A drag that starts on the slider
  and ends over the backdrop therefore closes nothing; the browser checks prove it on each surface.
- **One change per gesture (3.3).** `onChange` is called on every new value while a drag moves, `onCommit` once at the release, and
  only if the value differs from `value`. A cancelled gesture (the system takes the touch) commits nothing and the handle goes back.
  A tap, each key press, each −/+ press and each adjust action is one commit.
- **Keys** (web and the desktop window), on the focused track: → and ↑ one step up, ← and ↓ one step down, Page Up / Page Down
  `bigStep` (default ten steps: 1 s, 10 chats), Home / End the ends. A key it handles is `preventDefault`-ed and does not bubble;
  with `verticalKeys={false}` ↑ and ↓ are not its own and bubble (in the Subagents popover they move the menu's focus, which can land
  on the slider: `useMenuKeys` counts `[role="slider"]` among its items).
- **Screen reader.** The track is one accessible element: `role="slider"` (native: adjustable), its name `label`, its value
  (`accessibilityValue` min, max, now, text = `format(value)`; on the web `aria-valuemin/max/now/valuetext`), the actions
  `increment` and `decrement` (the platform's swipe up/down on iOS, volume keys or swipe on Android) one step each, one commit each.
  −/+ are buttons named "Decrease <label>" and "Increase <label>".
- **Disabled.** Greyed (opacity 0.5, as the "Running at once" section is greyed today), cannot be moved by any means, the track is
  `aria-disabled` and out of the tab order, −/+ disabled.
- **Look.** A 4-point track, its filled part (min to the handle) `accentFill`, the rest `line2`; a round handle (14 px wide
  layouts, 24 pt touch) in `knob` with a 1-point `line2` border and `shadowSm`; the mark a 2 × 8 tick in `faint`; the ends' labels
  under the track's ends in small `muted` text (`faint` is 2.5:1 on white, under the floor of 3:1 that text keeps); the value at the right in tabular figures. The focus ring is the app's
  (`focusring.ts`): 2 px `--focus-ring`, outside the track. Light and dark come from the theme tokens alone.
- **Sizes.** `size="touch"`: the touch area is at least 44 pt tall and −/+ are 44 pt squares; `"sm"`: a 28 px row and 24 px −/+.
  Default: `touch` when the pointer is a finger (`usePointer()`: always on native, so an iPad's popover and dialog get the 44 pt
  target), else `sm`.

## 3. The two uses

**Delay before send** (Settings > Voice > Advanced options on the wide layouts; the Voice screen's Advanced group on the phone).
`pauseMs`, default 1200 ms, now `PAUSE_MIN_MS = 100`, `PAUSE_MAX_MS = 10000`, `PAUSE_STEP_MS = 100` in `voice/logic/settings.ts`. A
saved value is clamped into 100…10 000 and rounded to whole milliseconds, as today; it is not snapped to the steps, so every value
saved before (600…3000, steps of 200) reads unchanged (4.6). `onCommit` writes the setting (`setVoiceSettings({ pauseMs })`); the
Speech bar, the pill and the session read the same setting, as today. The slider replaces the picker in the same row: testID
`vs-adv-pause` on both layouts, `data-value` the milliseconds. In the wide dialog the row puts the slider under its label at the row's
whole width (`Row wide`): beside the label, with a finger's 44 pt −/+ on a tablet, the track was about 110 px, under a pixel a step; on the
phone it is a `ControlCell` (the label above, the slider under it).

**Max chats** (the Subagents popover of the composer's chip; the phone's Subagents sheet). `subCap`, 1…100, default 100
(`SUB_CAP_MIN`, `SUB_CAP_MAX`, `DEFAULT_SUB_CAP` in `packages/core/src/logic/subsettings.ts`); the list of offered caps goes. The slider
replaces the "Running at once" rows (popover) and segments (sheet): testID `sub-cap`, `data-value` the cap; the popover keeps
`sub-pop-cap` with `data-off` and its hover reason, the sheet keeps `sub-cap-line`. Depth is untouched. A commit sends one
`PATCH /api/chats/{id}` (the existing `configure` call, 4.1). The caller shows the committed value at once (it holds it until the
answer comes, and drops it on an error, which is shown as today); a commit made while a save is in flight is not lost and not sent
in parallel: the latest one is sent when the save ends. The chip's label and title are unchanged (`subChipLabel`, `subChipTitle`).

## 4. Section 8 answers

- **Labels.** The delay keeps today's label, **"Pause before auto-send"**, and the max chats **"Running at once"** (4.10: today's
  words where they exist; both still fit a slider). "Delay" is the goal's term, not the screen's: the Auto-send note already says
  "after a pause", and "delay before send" could be read as a wait after Send is pressed. Values: the delay with one decimal and a
  unit, "4.7 s", its ends "0.1 s" and "10.0 s"; the max chats a plain number, its ends "1" and "100".
- **Nudge.** Yes: − and + beside the track, on every layout, one step and one commit per press. On a phone the max chats' 99 steps
  are about 3 points apart across a sheet's track, and in the desktop popover about 1.5 px apart (7.6): a drag finds the region, −/+
  find the exact number in a press or two, as the arrow keys and the adjust gesture do for those who use them. They are part of the
  slider, not a new setting or a new place (goal 5).
- **A mark at the default.** For the delay, a tick at 1.2 s (it is near the left end, where a drag lands most often). Not for the max
  chats: its default, 100, is the right end, which is labelled.

## 5. Tests

- `app/test/slider.test.ts`: `sliderlogic.ts` (snapping, ends, keys, value from a position, the commit rule).
- `app/test/voice.settings.test.ts`, `app/test/voicescreen.test.ts`: the new range, old values unchanged, out of range clamped.
- `packages/core/test/subsettings.test.ts`: the cap's range and `subChange` for any whole number 1…100.
- Browser checks (`web/dev/checks`): the existing voice and Subagents checks moved from the picker and the rows to the slider, and
  new checks of the slider on both surfaces (ends, steps, live value, mouse, tap, keys, −/+, a drag that leaves, one call per drag,
  light and dark, the three widths, disabled) and of the delay's timing in Speech mode with the stand-in at 0.1 s, 1.2 s and 10 s.
