# Goal: a board that pans smoothly in dark and flavour themes on a phone or tablet

This document defines an outcome: what the board feels like on a phone or tablet when the app is in a dark or a
flavour theme, once the work is done. It says what exists at the end, the decisions already made, the bounds the
work must stay inside, and how to confirm that it is done. It is not an implementation plan and not an order of
work. It names no files, functions or steps; how to build it is for whoever builds it.

## 1. How to read this

**Marks.** A decision, bound or risk carries one mark. A statement with no mark is `[proposed]`.

- `[user]`: the user decided it.
- `[standing]`: decided before this goal and kept; it is in the architecture document or in the code.
- `[proposed]`: proposed while the work was planned. Not a decision of the user.
- `[not verified]`: a risk or an assumption nobody has checked yet.

**Terms.**

- **Board view**: the one place Excalidraw runs. In the page itself on the desktop build, in a web view on a phone or
  tablet.
- **Phone target**: the board view as it runs in a web view on iPhone, iPad and Android. The **desktop target** is the
  board view as it runs in the page of the desktop app's window.
- **Canvas theme**: how the board's drawing looks under the app's theme. A view of the board, never a change of it.
- **Canvas filter**: what the board view lays over Excalidraw's canvases to produce the canvas theme.
- **Dark and flavour themes**: plain dark and the four flavours (Latte, Frappé, Macchiato, Mocha). **Plain light**
  has no canvas filter.
- **Stored colours**: the colours the board file holds. Always the light-space ones Excalidraw draws by default: a
  white ground and a `#1e1e1e` stroke.
- **Anchors**: the two colours the canvas theme is held to. The stored white appears as the theme's ground, and the
  stored default stroke appears as the theme's ink.

## 2. Goal

On a phone or tablet, panning, zooming and drawing on a board in a dark or flavour theme lags badly. In plain light
the same board on the same device is smooth. The difference is the canvas filter: it is the only thing plain light
does not have, and it runs over every pixel of every canvas on every redraw.

At the end, the board is as smooth in dark and flavour themes as it is in plain light, on the phone target, and it
looks the same as it does today.

The work has two parts, in this order, and the second happens only if the first confirms the cause:

1. **Confirm the cause.** A cheap experiment on the phone target shows whether removing the expensive part of the
   canvas filter is what makes dark smooth.
2. **Replace the filter.** The canvas filter of the phone target is replaced by one the device can draw without
   lagging, with colours that match today's.

## 3. What exists when it is done

### 3.1 The answer of the experiment

There is a written answer, in words, to this question: *is the canvas filter the cause of the lag in dark and
flavour themes on a phone or tablet?* It says what was changed for the experiment, on which device and build, and
what was measured in light, in dark as it is today, and in dark with the experiment (6.1).

The experiment is for finding out. It is not part of what ships, and it does not have to look right: its colours
may differ from today's.

**If the answer is no, or unclear, the work stops there.** The second part is not built. The answer says what it
found instead, and the user decides what comes next.

### 3.2 The new canvas filter on the phone target

On the phone target, in every dark and flavour theme:

- Panning, pinching to zoom and drawing are as smooth as in plain light on the same device and board (6.2).
- The stored white shows as the theme's ground and the stored default stroke as the theme's ink, within the
  tolerance of 4.5, as they do today.
- Every other stored colour shows in the same family as today: a red stays red, a board that was coloured by a
  person or an agent still reads the same.
- A change of theme while a board is open takes effect at once, with no reload of the board and no loss of what is
  drawn or selected.

### 3.3 What is the same as before

- The desktop target, its filter and its look.
- Plain light, on every target.
- The board file, what agents read and write, the messages between the app and the board view, and the picture
  `get_image` draws.
- Excalidraw's own menus, panels and dialogs, and the colours the app gives them.

## 4. Decisions and bounds

**4.1 The canvas theme is a view, never a change of the board.** `[standing]` The board file keeps the stored
colours whatever the theme. Agents, the image export and other windows read the same file. Nothing in this work may
write a themed colour into a board, into a message that carries board data, or into a picture.

**4.2 Excalidraw is the installed one, not patched.** `[standing]` The fix is made around Excalidraw (what is laid
over it and what surrounds it), not inside its code.

**4.3 Only the phone target changes.** `[proposed]` The desktop target keeps its filter exactly. Its browser draws it
without trouble, and nobody has asked for it to change. The two targets already build separately, and what differs
between them stays inside the board view.

**4.4 The app's side does not change.** `[proposed]` The theme still reaches the board view as the same message
from the same place. The app, the bridge and the theme definitions are not changed to make this work. If the new
filter needs something the message does not carry, that is a finding to report, not a change to make on the way.

**4.5 The look is held to the anchors, with a tolerance.** `[proposed]` The anchors under the new filter must land
within 3 of 255 per channel of where they land today, in every dark and flavour theme. The tests that hold the
canvas theme to its anchors stay the definition of the look. Whether a smooth filter can reach that tolerance is
unknown (7.2). If it cannot, the work reports how close it gets and what the difference looks like, and the user
decides. A visibly different look is not shipped silently.

**4.6 Smoothness is judged on a real device, on a release build.** `[proposed]` A development build and a simulator
skew the result: the first is slower than what ships, and the second does not draw as a phone does. Neither can
confirm or refute the cause.

**4.7 The canvases only.** `[standing]` The filter sits on Excalidraw's canvases, and the rules that apply it stay
reachable from the container of Excalidraw's dialogs, as they are now. The chrome of Excalidraw is not touched.

**4.8 The experiment and the replacement are separate.** `[proposed]` What is kept from the experiment, if anything,
is what the answer said. The replacement is built to its own bounds, not grown out of the experiment's shortcuts.

## 5. Out of scope

Only the colours of the canvas theme are in this work. These are not, even though they were found in the same look at
the lag:

- Limiting how often the board view tells the app about its view (scroll and zoom).
- What the app's overlays on the board subscribe to or redraw.
- Work Excalidraw does on every change (comparing elements, redrawing the static canvas).
- The size or pixel density of the canvases.
- Loading time of the board view's page, its size, caching or fonts.
- Memory use of the web view.

`[user]` If the experiment shows that something else matters as much as the filter, that is written in the answer
(3.1) and left for the user to decide.

## 6. How it is confirmed

### 6.1 The experiment

On a physical iPhone or iPad, release build, with the same board on each run:

- In plain light, in dark as it is today, and in dark with the experiment, pan and pinch the same way and record how
  the frames come (frame time or frame rate during the gesture), not only how it feels.
- At least one board is large: many elements, and one with images.
- The cause is **confirmed** when dark with the experiment is as smooth as plain light, within the run-to-run
  difference, and dark as it is today is clearly worse than both. `[proposed]`

### 6.2 The replacement

- **Smoothness:** the same measurement as 6.1, in every dark and flavour theme, against plain light. The new filter
  is as smooth as plain light within the run-to-run difference. Also on at least one Android device. `[not verified]`
  (7.3)
- **Look:** the same board, in each dark and flavour theme, drawn with the filter of today and with the new one, side
  by side. The anchors are within 4.5, and nothing else changes colour family. Boards used: one with only default
  colours, one with every palette colour, one with images.
- **Nothing else moved:** the picture an agent gets from `get_image` for a board is byte-for-byte what it was, in
  every theme (it does not depend on the theme). A board file opened, shown and left without a drawing change is not
  written.
- **Desktop unchanged:** the desktop target's canvas filter and the browser checks that cover the theme give the
  same result as before.
- **Live switch:** with a board open, changing the theme through every dark and flavour theme and back to light,
  each takes effect at once.
- **The tests of the repository** that `AGENTS.md` names for a change to the app's packages: the unit tests and type
  checks at the root, and the board view's own checks of the phone target in a browser. The device test that covers
  the board in a web view runs once, on the simulator you name, as a regression check of the page and not as a
  measure of smoothness.

## 7. Risks

**7.1 The cause is not entirely the filter.** `[not verified]` Light theme being smooth strongly points at the
filter, but light also has no filter stage of any kind. If the experiment leaves dark noticeably worse than light, the
filter is only part of the cause. Section 3.1 covers that.

**7.2 A smooth filter may not reach the exact colours.** `[not verified]` The filter of today is exact because it
uses an expensive step. What a device draws cheaply is more limited. The goal accepts a small tolerance (4.5) and a
report, not a different look.

**7.3 Android draws differently.** `[not verified]` The web view on Android is Chromium, not WebKit. The same filter
may be cheap there already, or a different one may be. The new filter has to look right and be smooth on both. The
Android device used must be named in the answer.

**7.4 A gain on a simulator does not carry to a device.** `[not verified]` This is why 4.6 and 6.1 insist on a
device. A result from a simulator is not a result.
