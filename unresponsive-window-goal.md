# Goal: an agent's board call is not lost to a window that holds the board and does not answer

This document defines an outcome: what happens to an agent's board call when the window that holds the board is gone
without having let go of it. It says what exists at the end, the decisions already made, the bounds the work must stay
inside, and how to confirm that it is done. It is not an implementation plan and not an order of work. It names no
files, functions or steps; how to build it is for whoever builds it.

## 1. How to read this

**Marks.** A decision, bound or risk carries one mark. A statement with no mark is `[proposed]`.

- `[user]`: the user decided it.
- `[standing]`: decided before this goal and kept; it is in the architecture document or in the code.
- `[proposed]`: proposed while the work was planned. Not a decision of the user.
- `[not verified]`: a risk or an assumption nobody has checked yet.

**Terms.** As in `headless-board-goal.md`: board, holder (writer), window, headless writer, away. Added here:

- **Gone window**: a window that holds a board, whose connection to the server still looks open, and that no longer
  answers. It was closed without a clean goodbye, suspended, crashed, put to sleep, or cut off from the network.
- **Call time**: the time an agent's board call waits for the answer of the client it was given to (30 seconds today).

## 2. Goal

Today a board call that is given to a gone window waits the whole call time and fails. The window still holds the
board afterwards, so the agent's next call is given to the same window and fails the same way, again and again, until
the system finally notices the connection is dead (minutes). The headless writer, which exists to work on boards no
window is using, is never asked, because the server believes a window is using the board.

At the end, a gone window costs an agent at most one failed or delayed call. After it, the board is free and the
headless writer answers like it does for any board nobody holds.

## 3. What exists when it is done

### 3.1 A call that gets no answer frees the board

- When a call given to a window gets no answer within the call time, the window loses the board. The board has no
  writer until someone takes it, and the people looking at it are told, as for any change of writer.
- A window that was only slow, not gone, is told at once that it is now a reader, as in a hand-off (headless goal 3.2).
  Nothing it saves afterwards is accepted, and the person is shown that the board was taken, with the note a window
  already shows for a change it could not keep.
- The board is as it was after the last change that was saved. Nothing is merged and nothing is overwritten by an
  older version.

### 3.2 What the agent is told and gets

- A call that only reads (`read_board`, `get_image`) is answered, within the same call, by the headless writer after the
  board was freed. The agent gets its answer, later than usual, and is not told of the gone window.
- A call that changes the board (`apply`, `delete_elements`) is not repeated by the server, because the gone window
  may have made the change and saved it before it went silent. The agent is told in plain words that the call did not
  finish, that the board is as it was after the last saved change, and that it should read the board again before it
  changes it. `[proposed]`
- The next call of that chat, to the same board, is answered by the headless writer with no wait for a window.
- Calls that are about a person's screen (`get_view`, `show_board`) are not changed: they go to a window or are
  answered that no window shows the board, and they never go to the headless writer.

### 3.3 What is the same as before

- A window that answers within the call time: the call, its result and who holds the board.
- A call given to the headless writer that does not answer: the process is stopped and the agent is told, as now.
- A person pressing **Edit here**, the hand-off and its time, and the one-writer rule.
- The call time itself. It is not made shorter to hide the wait. `[proposed]`
- Everything that has nothing to do with who holds a board.

## 4. Decisions and bounds

**4.1 One writer per board, always.** `[standing]` Freeing a board never leaves two writers, and a late answer or a
late save from the window that lost the board is refused, never merged.

**4.2 The existing ways of losing a board are the ones used.** `[standing]` A holder that does not answer loses the board
the way a holder that does not release in a hand-off does today. No second kind of loss, and no new state of a board,
is added.

**4.3 A person's window is not taken from a person who is there.** `[user]` The headless writer never takes a board from
a window that is answering. This goal changes only what a window that does not answer within the call time means: it
is treated as gone. `[proposed]` that this is acceptable for a slow window too, since a call that waits longer than
the call time has already failed for the agent.

**4.4 A change is never made twice.** `[proposed]` The server does not repeat a call that changes a board after a
silence (3.2). A repeated change can duplicate elements, which is worse than a failed call.

**4.5 The server does not edit scenes itself.** `[standing]` The headless writer answers, as a client. The server's own
code does not read or change a scene to cover for the window.

**4.6 No change of the protocol between server and clients.** `[proposed]` The fix is in the server alone: no new
message, endpoint or level, and no change in the app, so that every client in use today benefits without an update.

**4.7 The fix does not replace finding a dead connection.** `[proposed]` A heartbeat, or any other way for the server to
learn sooner that a window is gone, is a separate piece of work. This goal is about what happens to a call until then,
and must stay correct if that work is done.

**4.8 Nothing is paid for by the tests.** `[standing]` No paid model is called to confirm this work.

## 5. Out of scope

- Finding a gone window sooner than the call time (4.7).
- A window that holds a board and is stuck in a way that still answers calls slowly but within the call time.
- A change of the call time, of the hand-off time, or of the quiet time of the headless writer.
- Repeating a call that changes a board (4.4), or telling the agent which of its changes were made.
- A change to what the window shows beyond what a lost board already shows.

## 6. How it is confirmed

Using a stand-in client that connects like a window, takes a board and then never answers a call, and the real server
and the headless writer (or a stand-in for it that answers):

### 6.1 A gone window

- A read of the board by an agent is answered after the call time, with the board's content, and the stand-in no longer
  holds the board; the board has no writer, or the headless writer holds it.
- A change by an agent fails after the call time with the text of 3.2, and the board's stored content and revision are
  unchanged.
- The next call of that chat, of either kind, is answered at once by the headless writer, with no wait.
- A followed board's readers were told the writer changed.

### 6.2 A window that was only slow

- The stand-in answers after the call time. Its answer is ignored, its later save is refused, and it was told that it
  became a reader. The board holds no change of it and no change twice.

### 6.3 What does not change

- A window that answers within the call time keeps the board, and its call is answered as before.
- A call that is about a screen, given when only the gone window follows the board, still does not reach the headless
  writer.
- A call given to the headless writer that does not answer still ends the process and gives the agent the text it
  gives today.
- Two calls on one board waiting at once on the gone window: both end, and the board is freed once.
- A person presses **Edit here** while a call waits on a gone window: one writer ends, and no call is left open.

### 6.4 The documents

The documents that describe how an agent's call is routed and what an agent can be told say what happens to a call that
gets no answer, and the table of what an agent is told lists the new text.
