# Goal: a board an agent can edit while no window is open, and that many clients can watch while one edits

This document defines an outcome: what a board is, who may change it and how an agent changes it when nobody has the
app open, once the work is done. It says what exists at the end, the decisions already made, the bounds the work must
stay inside, and how to confirm that it is done. It is not an implementation plan and not an order of work. It names no
files, functions or steps; how to build it is for whoever builds it.

## 1. How to read this

**Marks.** A decision, bound or risk carries one mark. A statement with no mark is `[proposed]`.

- `[user]`: the user decided it.
- `[standing]`: decided before this goal and kept; it is in the architecture document or in the code.
- `[trial]`: measured in a throwaway trial made before this goal was written. It is evidence, not a promise: the work
  confirms it again on the real thing (6.1).
- `[proposed]`: proposed while the work was planned. Not a decision of the user.
- `[not verified]`: a risk or an assumption nobody has checked yet.

**Terms.**

- **Board**: one drawing the server stores (the scene and its revision), with a name and a place in the tree.
- **Holder**: the one client that may change a board at a given moment. This goal calls the holder the **writer**.
  Every other client that shows the board is a **reader**.
- **Window**: an app (desktop, phone, tablet) connected to a server. It is a client.
- **Headless writer**: a process on the server's machine that holds boards like a window does, with no screen.
- **Board engine**: the code that turns one `apply` call into a change of the scene (create, update, delete, bind,
  measure text, wrap labels). Today it runs in the board view of a window.
- **Away**: no window holds the board the agent wants to change.

## 2. Goal

Today the server never changes a drawing. Only the window that holds a board changes it, and an agent's board tools
are answered by that window. With no window open, an agent is told that no board is open, and it can do nothing.

At the end:

1. An agent can read and change a board while no window is open, and what it did is there when a window next shows
   the board.
2. Several clients can show the same board at once, live, while exactly one of them is the writer. The others are
   readers.
3. Becoming the writer is an explicit act of the person, a button, and the writer can change hands whenever a person
   asks.

## 3. What exists when it is done

### 3.1 Readers and one writer

- Any number of windows can open a board at the same time. One is the writer and can change it; the rest show the
  board read-only and follow the writer's changes live, without a reload.
- Readers see the same whoever the writer is: when the writer is the headless writer, the agent's changes appear
  live, and the button is offered. `[user]`
- A reader cannot change the board by any route: not by drawing, not by a paste, not by an agent call that is
  answered through it. The server refuses a change that does not come from the writer.
- Every window shows, for a board, whether it is the writer or a reader, and who the writer is when it is not itself:
  another window, or the headless writer.

### 3.2 Taking the writer role

- A reader has a visible button to become the writer. Pressing it is the only way a window becomes the writer. Opening
  a board, switching to it or connecting never takes it. `[user]`
- When the button is pressed, the current writer saves what it has and gives the board up, and the pressing window
  becomes the writer. Nothing the old writer had drawn is lost, and nothing is overwritten by an older version.
- The old writer's window is told, at once, that it is now a reader and who took the board.
- If the old writer does not answer within the existing hand-off time, it loses the board anyway, as it does today
  (4.2).
- The headless writer gives a board up the same way as a window, and always yields to a person pressing the button.
  `[user]`
- A writer that lost its network does not get the board back on its own. It returns as a reader, and the button is
  the way back. `[user]`

### 3.3 The headless writer

- It is a Node process on the server's machine. It runs the board engine of the app, with the parts of the page that
  engine needs stood in for, and measures text with real fonts. `[user]`
- It connects to the server as a client, through the same client API a window uses. To the rest of the server it is a
  client like any other. `[proposed]`
- It holds a board only when an agent needs one that no window holds (away). It keeps the board for a short quiet
  time after the agent's last call, so the next call of a chat does not pay for a reload, then lets it go. When a
  person presses the button, it gives the board up. `[user]`
- When the last window leaves a board, nobody holds it. The headless writer does not take over the boards that were
  open; it takes one only when an agent asks. `[user]`
- While a window holds a board, agent calls on it are answered by that window, as today. The headless writer never
  takes a held board from a person. `[user]`
- It does what an agent needs of a board with no screen: read the board, create, update and delete elements, create a
  board, and draw a picture of the board, a frame, a region or chosen elements (`get_image`).
- What needs a screen, and nothing else, is not available while the agent works away: showing a board to the person,
  the picture of what the person has selected, and the view the person is looking at. The agent is told this in plain
  words when it asks, and it is not a failure of the board. `[user]`

### 3.4 What the agent and the person see

- The same `apply` call gives the same result, element for element, whether a window or the headless writer answers it
  (6.1). An agent cannot tell, from what it gets back, which one answered, except by being told.
- When the person comes back and opens the board, the board shows what the agent did. The person is a reader until they
  press the button, and may watch the agent keep working.
- If the headless writer stops or fails in the middle of work, the board is left as it was after the last finished
  change, free to be taken, and the agent is told the call failed.

### 3.5 What is the same as before

- The board file: its format and its stored colours. Agents, other windows and the image export read the same file.
- The result of an agent's board call when a window holds the board.
- Chats, agents, the prompt library, and everything that has nothing to do with who holds a board.
- Plain servers on other machines, reached as now: the headless writer belongs to the server that stores the board.

## 4. Decisions and bounds

**4.1 One writer per board, always.** `[standing]` There is never a second writer, and no merging of two writers'
changes. A write that is not from the writer, or is based on an older revision than the stored one, is refused as it
is today. Nothing in this work weakens that.

**4.2 The existing hand-off is the way a board changes hands.** `[standing]` A client that wants a held board asks, the
holder is asked to release and has a short time to answer, and then the board is given anyway. The headless writer and
the button use that, they do not add a second way.

**4.3 The server does not edit scenes itself.** `[standing]` Scene changes are made by a client's board engine and saved
by the writer. The headless writer is a client, so this stays true: the server's own code is not given a copy of the
board engine.

**4.4 One board engine, not two.** `[user]` The headless writer runs the board engine of the app, the same code. It is
not a second implementation. A fix or a change of the engine reaches the window and the headless writer together, and
a test of the engine covers both.

**4.5 Excalidraw is the installed one, not patched.** `[standing]` The headless writer runs Excalidraw's own element
code. What it lacks in Node (a page, a canvas) is supplied around it, not by changing it.

**4.6 Text is measured with the real fonts.** `[user]` The sizes of text, and with them boxes, labels, wrapping and
arrow ends, must come from Excalidraw's own fonts drawn by a real canvas, not from an estimate. An approximation is
not acceptable, because the size of an element is stored in the board and a window must show it as the agent made it.

**4.7 The board is saved as often as a window saves it.** `[proposed]` The headless writer saves after each finished
change, so that a hand-off, a crash or a restart loses at most the change in progress.

**4.8 Readers follow, they do not hold.** `[proposed]` Following a board never gives the right to change it and never
delays or blocks the writer.

**4.9 No change to who is allowed in.** `[standing]` The secret, the client id and the level of a client keep deciding
who the server serves. The headless writer is not a way in without them.

**4.10 It costs nothing when it is not used.** `[proposed]` With no agent working away, the headless writer is not
running and takes no memory, and a server that cannot run it still works as before, with agents told that no board is
open.

**4.11 Nothing is paid for by the tests.** `[standing]` No paid model is called to confirm this work.

## 5. Out of scope

- Two people drawing on the same board at the same time, merging, or any form of collaborative editing.
- Permissions per person or per board. Anyone who may use the server may press the button.
- A new drawing surface, or any way for the agent to see a screen. The headless writer has no UI.
- A change of the board file, of the messages between the app and the board view that carry board data, or of the
  picture `get_image` draws in a window.
- Running more than the board engine in Node: no Excalidraw interface, no menus, no undo history of its own.
- Undo across the agent's away changes. What the person can undo in a window is what that window did.
- Running the headless writer anywhere but the machine of the server that stores the board.

## 6. How it is confirmed

### 6.1 The headless writer is as faithful as a window

Using a set of boards and `apply` sequences, run in a real browser (Chromium) and in the headless writer, with the same
input each time:

- **Elements.** The resulting elements are the same in both: position, size, text and its wrapping, bindings of
  arrows, containers and bound text, deletions. Only what is random (ids, seeds) may differ.
- **Pictures.** `get_image` from the headless writer has the same size and bounds as from a window, and the pixels
  agree to the tolerance in 6.4.
- **The set covers** what a board really holds, not only the easy case: text in more than Latin script (accents,
  Cyrillic, CJK, emoji), every font Excalidraw offers, images in the board, frames, groups, bound and elbow arrows,
  long labels that wrap, and a large board.
- `[trial]` In a trial on a small board (rectangles with labels, a wrapping label inside an ellipse, an arrow bound
  between two shapes, a resize, a text change, a delete), all 10 elements came out identical in Node and in Chromium,
  and a picture of it had the same size with 98.2% of pixels identical, the rest being text edges and a one-pixel
  baseline shift. The trial covered Latin text only, with a single font file per family, and no images.

### 6.2 Away

With no window connected, a chat's agent reads a board, changes it, asks for a picture of it, and creates another
board. Then a window connects and shows the board: it has every change, in the order made, and the revision is the
stored one. The agent was never told that no board is open.

### 6.3 Readers, writer and the button

- With three windows on one board, one writer and two readers: a change by the writer appears in both readers without
  a reload, and no change from a reader is accepted by any route.
- A reader presses the button. The old writer's pending change is saved and is in the board, the new writer starts from
  that revision, and the old writer shows that it is a reader and who took the board.
- The headless writer holds a board and a person presses the button: the agent's finished changes are kept, the change
  in progress either finishes or fails cleanly, and the person becomes the writer.
- A writer that does not answer the release loses the board at the hand-off time and its later saves are refused.
- Two windows press the button together: one ends as the writer, the other as a reader, and the board is not damaged.
- Opening, switching to or connecting a window to a board never makes it the writer.

### 6.4 The tolerance of a picture

`[proposed]` Text widths are exact (4.6). A picture from the headless writer has the same width and height as the
picture of the same board from a window, and the share of pixels that differ is no more than the trial's, 2%, with
none differing in geometry. The trial's text-edge and baseline differences are accepted; a different font, a missing
glyph or a shifted shape is not. If a board cannot meet this, the work reports it and says what differs, and the user
decides.

### 6.5 Failure

The headless writer is killed in the middle of a change: the board is not corrupt, it shows the last finished change, it
is free to take, and the agent's call fails with a clear message. A server on a machine where the headless writer
cannot run behaves as today.

### 6.6 Nothing else moved

- A board file opened and shown by a reader is not written.
- A call an agent makes while a window holds the board gives the result it gave before.
- The tests of the repository that `AGENTS.md` names for the packages changed (the Go default set for each, the full set
  of each changed package once before finishing, `-race` where goroutines share state, and the unit tests and type
  checks of the app's packages). The device test that covers the board runs once, on a simulator you name, only if the
  board's window or the native side changed.

## 7. Risks

**7.1 Scripts of the world.** `[not verified]` Excalidraw ships each font in pieces, one per range of characters, and
a plain canvas in Node can use only one piece per family. Text outside Latin would then be measured wrongly. The trial
did not cover it. If it cannot be solved for the scripts people use, 4.6 cannot be met for them and the work says so.

**7.2 Images in a board.** `[not verified]` The trial had none. Drawing and measuring a board with images in Node may
need more than a stand-in canvas.

**7.3 Other parts of the page the engine reaches for.** `[not verified]` Frames, groups, elbow arrows and loading a
saved board do more than the trial's `apply` did. Each may need something the stand-in page does not yet have.

**7.4 A native canvas has to ship.** `[not verified]` A canvas that draws in Node is native code, built per operating
system and processor. How it is installed, and whether the machines people run the server on get it, is not decided.

**7.5 Node on the server's machine.** `[not verified]` Whether a Node runtime is already there, or has to be shipped,
or is found by the server, is not decided (4.10 depends on it).

**7.6 Readers may not be told live today.** `[not verified]` Whether the server already tells a reader, as it happens,
that the writer saved a new revision, is not confirmed. If not, 3.1 needs a way for it that stays inside 4.8.

**7.7 A pixel match is not a look match.** `[trial]` 98.2% was measured on one small board by counting pixels. A board
that is mostly text, or heavy with images, may differ more with the same count.

## 8. Not decided yet

- **The length of the quiet time** the headless writer keeps a board after an agent's last call (3.3). The rule is
  decided; the number is picked when it is measured, against what a reload of a board costs.
