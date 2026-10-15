# Package V3: the composer's chips on the devices, as built

`node app/e2e/run.mjs composer-chips --platform ios|android --device <id>` runs the real composer of a board chat on a phone layout against a scratch Go
server, then (`then=`) the box alone on its dev gallery (`composer-chips-gallery`). How it works and what the header keys mean: `app/e2e/README.md`, last section.

## Result
- iPhone 16e simulator and Medium Phone API 36.1 emulator: both parts pass, twice each (before and after merging `react-native-rewrite` the second time, which brought K4's
  images and a rebuild). iOS adds the four XCUITest key tests (arrows, Shift+arrows, forward delete and Backspace, ⌘A/C/V/X) in the **real** composer; Android's hardware keys
  (`adbkeys/chips.mjs`, as K2 had them) run on the gallery part, not in the composer. Android's soft keyboard is Gboard with suggestions on in the gallery part.
- `chips.mjs` and `ios-keys/` are gone; their cases are `maestro/composer-chips-gallery.yaml`, `verify/composer-chips-gallery.mjs`, `adbkeys/chips.mjs`, `xcuitest/chips/`.

## A bug the device found (fixed in `screens/composer/measure.tsx`)
The toolbar measured its controls in a layer one point wide (`MeasuringLayer`). The browser lays a child out at its own width; Yoga lays it out within the width of its parent, so
every text was wrapped at its longest word and reported that (server 10, agent 38, model 22 …, as logged on the iPhone). The fit then thought everything fitted and drew
the controls past the screen's edge: **Send was off the screen on a 390-pt phone.** The layer now holds a 4000-point-wide box inside the clip. The browser checks `A2.2`, `A2.3`,
`P0.1` pass with it. K3's "not verified on a device" for the toolbar fit is verified now, for this one width.

## Decisions and limits
- The box's state is reported by the app itself (`src/dev/chipreport.ts`, enabled by `EXPO_PUBLIC_AIWB_REPORT_URL`, set by the runner for `report=1` flows only), since neither
  Maestro nor XCUITest can read a selection. The reported state is the box's own (`DocState`: what it shows and where it thinks the selection is, after the snap), so the flow
  proves what the box does with what the platform reports, and that the box told the platform (`selection` prop) is held by the taps landing on the right edge; the view's real caret
  is not read from outside.
- Maestro taps points: the percentages in the flow are for the two devices above. A flow cannot find a chip, which is no element.
- "A double tap on a chip" is taken by UIKit as two taps one run in five (K2's note): the flow double taps again when the box says the chip is not selected.
- The control client of the runner must hold a board to write its scene, and only a client with an open event stream can (`unknown_client` otherwise): `apiClient.known(fn)`.
- Enter is a line break and Send is the button on both platforms (K3's decision) and is what the flow does; no hardware ⌘Enter/Ctrl+Enter is sent (XCUITest cannot send Return on the simulator).
- Not covered: undo, IME composition, dragging the selection handles, the board's selection from a Point (`Point at`), a second server.
