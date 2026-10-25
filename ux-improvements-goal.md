# Goal: the phone app is easy to read, reach and find your way in

This document defines an outcome: how AI Whiteboard looks and behaves on a phone once the UX improvements drawn on the
whiteboard **v3** are built. It says what exists at the end, the decisions already made, the bounds the work must stay
inside, and how to confirm that it is done. It is not an implementation plan and not an order of work. It names no files,
functions or steps; how to build it is for whoever builds it. It builds on `voice-chats-goal.md` and `voice-devices-goal.md`:
what they say stays true unless 4.9 of this document says otherwise.

## 1. How to read this

**Marks.** A decision, bound or risk carries one mark. A statement with no mark is `[board]`.

- `[user]`: the user decided it. It was written by the user as a note on the board (22 pink notes, each answered by a green
  one) or said in the chat that started this work.
- `[board]`: drawn on the board, with its numbered notes, and not commented on by the user. It is the design to build. If
  the user later says otherwise, the user wins.
- `[standing]`: decided before this goal and kept; it is in the architecture document, in an earlier goal or in the code.
- `[proposed]`: proposed while this goal was written. Not a decision of the user, not drawn.
- `[not verified]`: a risk or an assumption nobody has checked yet.

**Where the design is.** The whiteboard **v3** is the source. Each mockup on it is a phone, 393 pt wide, with numbered
callouts and a note under it saying what each number means. Mockups are named here by the title they carry on the board
(for example "10a Home v2", "05 Permission request"). The board holds both the first design of each area and the revisions
the user asked for; where they differ, the revision, and then the green notes beside it, win. The user's pink notes and
their green answers are listed in 4.1.

A study of today's app and of the design (`design/mobile-ux`, branch `mobile-ux-improvement-suggestion`) was made before
the board. The board's callouts cite its ids (`SHELL-3`, `CHAT-8`, `COMP-7`, `DLG-1`, `SRV-3`, `LIB-1`, `SET-2` and so on)
and decision numbers (`D1` to `D16`). This document does not depend on them; it says in words what they mean. Where the
study and the board disagree, the board wins. The decision numbers on the board's newest mockups (Home v2, the board's chat,
selecting) were renumbered by the user's own answers and are not those of the study; do not look them up there.

**Terms.**

- **Phone layout**: the layout the app uses at a window width under 700 points: on iOS, on Android, and in the web build or
  the desktop window made that narrow.
- **Server**: a computer the app is connected to; a person may have several. Each has its own boards and chats.
- **Group**: a folder of boards, chats and other groups on a server. **Board**: a whiteboard. **Chat**: a conversation with
  an agent, standing alone or attached to a board.
- **Content screen**: a screen that is one thing, a board, a chat, a subagent, a full diff or table. **Place screen**: a
  screen that is a list the person browses, Home, a group, Settings and what is under it.
- **Sheet**: something that comes up from the bottom over the screen. **Pushed screen**: a screen that slides in over the
  one before it and goes away with Back.
- **Patterns P1 to P5**: the five shapes every sheet and screen below has (3.1.4).
- **Blocked state**: a reason the person cannot send a message right now (offline, archived, no agent, an old board
  connection, a model too small).
- **Touch target**: the area that answers a tap. **pt**: a point, the phone's unit of size.
- **Today**: the app as it is before this work.

## 2. Goal

On a phone today the app is built from the desktop's parts made smaller. Touch targets are 20 to 27 px; body text is 12 px;
a board's name is cut to "Che…" and a folder path to "checkout-ser…"; every message carries a 20×20 "…"; a command waiting for
approval is cut at 120 px beside a red Allow button; a server being offline is said three times; a button is a 27 px
"Unarchive"; settings and servers are popups; a hover hint stands where a phone has no hover. The person works around the
interface instead of through it.

At the end the phone layout is a phone app. Home is the list, with one native stack and no tab bar. Every action is within
a thumb's reach and at least 44 pt. Text is readable at arm's length. Every sheet says what it is about. What blocks sending
is said once, where the box would be. A board is Excalidraw's own and the app does not draw over it. A chat attached to a
board opens full screen and goes back to the board. Voice has one vocabulary and one place for its settings.

This is a redesign of what the phone layout shows and how it moves. It adds no new agent ability, no new board ability and
no new kind of chat. `[proposed]`

## 3. What exists when it is done

### 3.1 Rules that hold on every phone screen

**3.1.1 Size and reading.**

- Every touch target is at least 44 pt. A control that looks smaller has a 44 pt target around it.
- Side margins are 16 pt. Controls, lists, sheets and the composer's box use 17 pt text. A chat's reading body is 16 pt with
  a line height of 1.5; this difference is intended. Secondary text is at least 13 pt, everywhere.
- Names are not cut to fit a bar: a screen's bar gives its title the room it needs and moves actions out of its way.

**3.1.2 Back.**

- One back control everywhere: an accent chevron in a 44×44 target.
- On a place screen (Settings and everything under it, a group, the Archived list) the chevron carries the name of the
  screen it goes back to ("‹ Home", "‹ Settings", "‹ Servers", "‹ Checkout service") and the title is centred.
- On a content screen (a board, a chat, a subagent, a full diff or table) the chevron stands alone. The title leads, in two
  lines: the name at 17 pt, the place or the state at 13 pt. At most two 44 pt actions stand at the right.
- A swipe from the left edge goes back, on every screen except a board (the canvas needs its own pans) and except while a
  point or items are being picked on a board.
- Holding the back opens a sheet that lists the stack, so a person can go several levels at once (for example Home ›
  Checkout flow › the chat). `[board]`
- The stack is the same whichever way the person came (a row, a search result, a notification): Home › group › board › its
  chat. A chat on a board always has its board under it.

**3.1.3 Words, hints and states.**

- No desktop words or marks on a phone: no "⌘P", "right-click", "Esc", no keyboard hint, no focus ring, no hover title.
  Anything a hover title said is said by a visible line.
- One list of state words and colours is used by Home, the server chips, the server sheet, the Servers screen, Chat info and
  a chat's header: for a server, **Connected** (green), **Connecting…** (grey, with placeholder rows), **Unreachable** and
  **Offline** (red), **Certificate changed · paused** (red), **Local network off** (red, iOS only), **Too old** (amber); for a
  chat, **Writing…** (green), **Needs your approval** (amber), **Waiting on N subagents** (green), **Stopped** and **Failed**
  (red). A chat's header says "Needs your approval" while a request waits, not "Waiting for you". `[board]`
- What blocks an action replaces it and is said once (3.7.1). It is not said again as a banner, a placeholder and a line.
- A reversible action does not ask: it happens and offers **Undo** in a toast that lasts about 5 seconds. An action that
  cannot be undone asks, with the confirm of P4. Archive is the first kind; delete is the second.
- A toast is one shared thing used for Undo, for "Back online" and for "Server added".

**3.1.4 The five patterns.** Every sheet and every screen in the sections below is one of these. `[board]`

- **P1, action sheet**: doing something to one thing. A head with the item's icon, its name and "type · place · model"; 50 pt
  rows, each with an icon and a 17 pt label, and a second line where the action needs one; the destructive row last, red,
  after a separator and naming what it deletes. No Cancel row: the grabber, a tap outside, a swipe down and Android's back
  close it.
- **P2, picker sheet**: choosing one value. A centred title and a sub-line saying what is chosen and for what; 50 to 52 pt
  rows, the chosen one tinted with an accent ✓ and no focus ring, a second line per option; a tap chooses and closes. **Done**
  stands at the right only when the sheet holds more than one control (model with effort, subagent depth with its cap).
  **Cancel** stands at the left only in a flow that commits with a button (the folder browser). Past about eight options the
  sheet opens large with a search that stays pinned.
- **P3, form**: typing one or several values. A head of "Cancel · Title · Save". Save is off until there is something to
  save and is always above the keyboard; the sheet rides on the keyboard; closing a changed form asks first.
- **P4, confirm**: what cannot be undone. A red tile, a 20 pt title with the object in quotes, a sentence saying what is lost
  and where ("from Studio Mac"), a full-width 50 pt red button that repeats the verb and the noun ("Delete chat"), a grey
  Cancel below it. Busy and error states stay inside the sheet; it is never the centred system alert.
- **P5, pushed list screen**: a place the person browses. Back with the name of the previous screen, a centred title, grouped
  cards of 48 pt cells with values and chevrons.
- One decision is a sheet, typing is a form, a place is a pushed screen. No sheet over a sheet, except a P2 or a P4 over a P3.

### 3.2 Home and the stack

Mockups: "10a to 10d Home v2", "02 The stack and the back", "08 Empty Home and first run".

- **Home is the list, plus one native stack. No tab bar.** `[board]` Home has a large title, a labelled **+ New**, a gear
  that opens Settings, a search field and, with two servers or more, a row of server chips.
- **One server at a time.** `[user]` There is no "All". Exactly one server is selected; the chips switch Home between
  servers. With one server there are no chips and the sub-line under "Home" names the server.
- **Groups, boards and chats keep their hierarchy.** `[user]` Home shows the selected server's tree: groups first, then boards
  that are in no group, then chats that are on no board.
- **There is no "Needs you" section.** `[user]` A chat that needs the person (waiting for approval, stopped, failed) shows an
  orange dot on its row, and a group shows a count. A dot on a board means that a chat on it needs the person.
- **A group is a screen, not an indent.** `[user]` A group is a row with a folder and a chevron; a tap pushes the group as its
  own screen: its name as the large title, back naming the parent group, its subgroups first, then its boards and chats, with
  the same rows as Home. A nested group is one more push, at any depth. An empty group says "Nothing here yet" and offers
  **+ New**. The place line under the title gives the full place, server first.
- **Home lists boards, not a board's chats.** `[user]` A board's row says "2 chats"; its chats are under the board's **Chats**
  button (3.4). A chat that is on no board is a row on Home.
- **A server's trouble shows on that server's own Home only.** `[user]` The selected server, if it is unreachable, shows a
  problem card with its reason and **Try again** and **Details**; the list below stays, faded, from the last sync, and opening
  an item says the server is offline. Other servers show only a dot on their chip. A server whose certificate changed shows
  its "Certificate changed · Review" card when it is the selected one.
- **A row has one target.** A row is 60 pt, with an icon, a name, a sub-line and, where known, when it last changed. No "…" and no
  "+" is drawn on a row. Its actions are on swipe and long press (3.3).
- **First run.** With no server, Home is onboarding: "Connect to your computer", one paragraph, one primary **Add a server**,
  **Scan the server's code**, three numbered steps for the computer and a link to the guide. The gear stays; **+ New** is
  absent until a server is connected. While a server is connecting, Home shows placeholder rows and a dimmed **+ New**.
- **An empty Home on a connected server** says "Start a chat or a whiteboard" with 50 pt buttons and names the server in its
  agents line.
- **A server's sheet.** `[user]` Long press on a server chip opens a sheet with the server's name, state, version and
  address, **Test connection** with its result shown in place, and rows **Name**, **Certificate** and **Server settings**,
  each pushing a page, and **Remove server** in red, which asks first. There is no "New chat" and no "New whiteboard" here
  (the person selects the server on Home and presses **+ New**), and no "Hide from Home".

### 3.3 Rows, renaming, creating, archive, search

Mockups: "04 Row actions", "05 Renaming", "11 New sheet v2", "07 Settings › Archived", "09 Search".

- **Swipe left on a row** shows **Archive** (grey) and **Delete** (red), each 88 pt wide and the row's full height. A full
  swipe only archives. Delete must be tapped, and then asks (P4). Boards swipe the same way. Archive shows the "Archived …"
  toast with **Undo**.
- **Long press** (0.5 s, with a haptic) opens the item's P1 sheet: **Open**, **Rename…**, **Move to…** (naming the group),
  **Archive**, and **Delete…** last. Moving a finger 10 pt after the press starts a drag instead, to move the item.
- **Rename** is one sheet (P3), "Cancel · Rename chat · Save", with the place and server under the title, a 44 pt field with the
  whole name selected and a clear button. Save is off while the name is empty or unchanged; Return saves. It is the same sheet
  from a row, from Chat info and for a board.
- **+ New** opens a sheet, "New", in two steps in one place. `[user]` First **where**: a card with the server › group the
  person is in, already chosen, and **Change**, which pushes a page inside the sheet ("‹ New") that shows one level at a
  time, with a crumb going up and a row "Put it in <group>" choosing that level; only the selected server's tree is offered.
  Then, after a bigger gap, **what to make**: **Chat** and **Whiteboard** as two tiles, and **Group** as a row that names
  itself next. A chat on a board is not made here (3.4).
- **A new whiteboard** is named in its title bar after it opens. `[proposed]`
- **Archived chats leave Home.** They are listed in Settings › Archived (3.8.1), by server and then group as on Home, with the
  archive date on the sub-line, **Unarchive** on a right swipe (accent) and **Delete** on a left swipe (red, confirmed). The
  footer says archived chats are read-only. There is no "Show archived" switch on the phone.
- **Search.** A tap in the field moves it to the top with **Cancel**; the bar and title slide away. Scope chips **All**,
  **Boards**, **Chats**; Home's server chip stays a filter. Before typing: recent searches (kept on the device) and the last
  boards and chats opened, each with its place. Results are grouped by kind with "server › group" and the match in bold; an
  offline server's results stay, faded; a chat found through its board says "on Checkout flow" and its back goes to the board;
  a group result opens Home on that group. With no results it says "No boards or chats match "…"", which servers were
  searched, and offers a new chat with the words. Search matches names on the device; searching inside chats is not part of
  this goal.

### 3.4 A board, and the chats on it

Mockups: "01 to 09 board", "10 Chat from a board", "11 Add selection", "12 Selecting on the board", "12a to 12c A new chat on
a board".

**The board itself is Excalidraw's.** `[user]` The app changes nothing about how Excalidraw zooms, pans, selects or draws. It
adds no "Fit" control, no double-tap zoom and nothing drawn over the canvas.

- **The board opens fitted** the first time, with 16 pt margins, in the area between the bar and the bottom row; later opens
  restore the last view. After that the view is Excalidraw's own: pinch, pan and its own "fit the whole board" are all there
  is. On rotation the app does not re-fit.
- **The bar.** Back is the chevron alone. The board's name is the title at 17 pt, not cut. The second line is the place (13 pt)
  and the state: **View only**, **Taking over…**, **Editing**, **Claude is working…** (in Claude's colour). Nothing floats over
  the board. A labelled **Chats 2** button (44 pt) is the board's only way to its chats; it takes the agent's colour while one
  of the board's chats is busy.
- **One bottom row.** Excalidraw's own footer (menu, colours, duplicate, delete, undo, redo) with a right inset of 64 pt for
  the voice orb. The orb (52 pt, the waveform of **Talk**) fills it, with a "1" badge when a selection goes along in speech
  mode. In a reader's view the row holds **Edit here**, a 44 pt primary button at the thumb that says **Taking over…** while
  it works. About 100 pt of canvas come back compared with today.
  `[board]` If the inset breaks when Excalidraw is updated, the fallback drawn on the board (Excalidraw's row untouched and the
  orb floating above its right end) is the one to ship; the docked orb is the better screen. `[not verified]` whether the
  inset holds.
- **The Excalidraw menu** is trimmed on a phone to **Find**, **Fit**, **Export image…** and **Share image…** (the system
  sheet), headed by the board's name. No "Save to…", no Help, no Excalidraw links. **Clear the board…** is last, red, and its
  confirm names the board and who sees it. The menu opens above the bottom row and nothing covers its last rows.
- **Another window takes the board:** the bar's second line says so, with a toast whose action is **Edit here**.
- **The Chats sheet** is the board's only chooser of a chat. It is titled "Chats on "Checkout flow"", has 44 pt rows, marks the
  chat voice talks to with "Voice", and holds **+ New chat** for this board, once, at the top. `[user]` The voice card's "To:"
  chip opens the same sheet. A tap on a chat opens it full screen over the board; **Done** or a swipe down returns to the
  board.
- **A chat on a board is always full screen.** `[user]` There is no half sheet with the board showing beside it and no board
  strip. Its bar is the chevron alone, the chat's name as the title and "<agent> · on Checkout flow" as the second line. Back
  returns to the board at the view it was left in.
- **Making a chat on a board** `[user]`: from the board, **Chats › + New chat**, which opens an empty full-screen chat "on
  Checkout flow". The person types or talks at once; the board's chip, **Add selection** and the point are in the composer.
  The title becomes the chat's topic after the first message. Such a chat is not on Home.
- **Point at.** In the composer's "+" sheet. It opens the board full screen; the bottom row becomes an accent banner that
  names the chat, with a white 44 pt **Cancel** where the orb was; the bar says "Picking a point", Chats is dimmed and the
  canvas has an accent border. A tap picks; the pin and its label stay for 600 ms and the chat opens again. Back and a swipe
  back cancel too. The point comes back as a chip that says what it is near and has an ×; the agent still gets the x and y.
  The draft typed before is kept.
- **Add selection.** `[user]` In a chat, **Add selection** opens the board the way Point at does. The person selects with
  Excalidraw's own tools (tap, box, its toolbar); nothing app-made is drawn on the canvas. The bottom row becomes an accent
  bar, "Select items · Add (n)", naming the chat; **Add** is off while nothing is selected; Back or a swipe back cancels. **Add
  (n)** returns to the chat and the items come back as one chip with their count and names and an ×; the agent gets their
  element ids.
- **A selection on the board goes to no chat by itself.** `[user]` Selecting on the board is Excalidraw's and nothing more:
  no chip, no "Add to chat". The one exception is speech mode: while it is on, what is selected is added to the chat that
  voice is set to, as "With 2 selected shapes ×"; × drops it. A chat the person types in never receives a selection this way.
- **Voice on a board** (3.8): one voice card, no pill, no caption.
- **Dark theme and landscape.** In dark theme the app's own parts (bars, rows, cards, sheets) take dark tokens; the canvas is
  Excalidraw's. Turned to landscape, the bars become floating controls in the corners (back, name and state, **Edit here**,
  **Chats**, the orb) and there is no status bar; the view stays Excalidraw's.

### 3.5 A chat

Mockups: "01 to 10 Chat thread".

- **Header.** Back (chevron alone), the title and a readable two-line sub-line ("Claude Code · checkout-service", or the
  state, or "● Build box · offline" with a red dot, or "Archived · checkout-service"). A tap on the title opens **Chat info**.
  A **Tree** icon with a count badge and **⋯**, each 44 pt. A "New chat" is grey until it is named and has no Tree yet.
- **Thread.** 16 pt margins, body 16 pt, line height 1.5, headings that stand out (h2 20, h3 17), lists indented 24 pt, inline
  code in a chip. No floating "…" above messages. A **Latest** pill appears when the person has scrolled up and new text has
  arrived.
- **Messages.** Press and hold lifts the message over a dimmed thread and opens one P1 sheet that names the message with an
  excerpt. A quick row: **Copy**, **Quote**, **Read aloud**, **Select**. Below, rows that say what they do; on the person's own
  message **Branch and edit** leads; an action that must wait stays, faded, with its reason. **Quote** has its own sheet,
  "Quote from Claude's reply": the whole message with the system's handles, buttons **Quote selection** and **Whole message**
  in thumb reach, then a comment sheet with **Add to message**.
- **Markdown.** Tables bleed to the edges with the first column pinned, a fade and a swipe hint; **Open full table** pushes a
  viewer, which may turn to landscape, with every column at 16 pt, the header row and first column pinned, pinch to zoom and
  **Copy** (the table as Markdown). A link is underlined; holding it opens a link sheet. A code block has a head: language,
  **Wrap**, **Copy**.
- **Tool steps.** A step is a two-line 44 pt card; a failure is red. A failed step opens by itself with its exit code, the
  command with **Copy** and its last 6 lines. Steps that only read fold to one row. An edit says "+5 −2" and shows a diff with
  line numbers and signs, at most 10 rows under a fade, with **Show full diff** and **Copy**. The full diff is a pushed screen
  (file name, **Wrap**, **Copy**, "+5 −2 · 2 changes" with ⌃ ⌄ to jump, old and new line numbers, unchanged runs folded as "⋯ 41
  unchanged lines").
- **A permission request.** The card says in words what the agent wants ("Claude wants to run a command") over its own
  description, shows the full command wrapped and never cut, and has a full-width 48 pt **Deny** (bordered) and **Allow**
  (accent fill, not red). `[board]` While the card is off screen a dock above the composer shows the title, the command and
  the same two buttons, with "1 of 2" when two wait and **Show** to scroll to the card; answering in either place answers
  both. An answered card folds to one line with the time and opens on a tap. While a request waits the header's sub-line says
  "Needs your approval" in amber.
- **Busy.** A line on the 16 pt margin, 15 pt, with a spinner and the step's seconds; **Stop** stays in the composer.
- **Subagents.** One card per call, "4 subagents · in the background · 2 running", with two-line rows (a 28 pt status mark, the
  task at 15 pt, how it went at 13 pt; 60 pt targets); a nested subagent hangs under its parent; the report is a 48 pt row.
  A row opens the subagent as a pushed content screen: chevron alone, the task as the title, "Subagent 1 of 4 · Done" under it,
  its model, tools, time and context as pills, **Prompt**, **Steps** and **Report** headings with **Copy**, a finished
  subagent's steps folded to one row, and a 44 pt bottom bar with previous and next by name. It has no ×.
- **Branches and the tree.** Under a message that branched: "‹ Branch 1 of 2 ›", whose arrows switch in place and whose middle
  opens the tree. The Tree opens as a full-height sheet: title, the chat's name with a count, **Done**; a 32 pt Messages /
  Labeled switch, a 44 pt search, 48 pt rows with guides, a "You are here" pill on a tinted row; one tap opens, press and hold
  opens the actions sheet; **Label…** has its own form (Cancel · Label · Save).
- **Chat info** (one sheet, from the title or ⋯): the **Name** row with a visible **Rename**; **Agent**, **model** and
  **effort** in words, locked; the whole **folder** path, wrapped, with **Copy**; the **Server** with its state, which opens that
  server's detail; **Context** and **Chat tree** as rows; **Archive**; **Delete** in red with its confirm. The locked rows say
  why ("Fixed after the first message") and what to do ("Fork the chat"). A started chat has no "…" in its composer and no
  chip row.
- **Context and usage** opens from Context or the meter: a title naming the chat and the agent, one large number with tokens in
  words, legend rows of 38 pt, "Counted … 2 min ago", and plan limits with reset times, amber from 80 %.
- **An empty chat.** A larger welcome (56 pt glyph, 22 pt name, 16 pt line), a setup hint in quiet grey, and "Try asking"
  starters of 48 pt above the composer.
- **Images.** In the thread, 116×140 pt thumbnails. A tap opens a black full-screen viewer with close, the name and "Image 1 of
  2" at the top, swiping between images, pinch to zoom, page dots at the bottom and **Share**, **Save** and **Ask about it**
  (puts the image in the composer).
- **Another server, offline or archived** (3.7.1 and the header above): the thread stays readable, not dimmed; a waiting
  permission card has its buttons off and one line; there is no top banner; a "Back online" toast appears on return; an
  archived chat's Chat info offers **Unarchive**.

### 3.6 The composer: its box, its chips and its sheets

Mockups: "01 to 07 Composer".

- **The box.** 17 pt text, growing to 6 lines and then scrolling inside; images stay on top of it. Under it a toolbar: **+**, the
  context ring, **Dictate** (mic) and **one primary button**. `[user]` (the user chose this design over a labelled tool row.)
- **+ opens "Add to message"**, a titled sheet of named 52 pt rows with a sub-line: **Take photo**, **Photo library**, **Files**,
  **Insert a prompt** and, in a board chat only, **Add selection** (with its count) and **Point at**. `[user]` There is no photo
  strip of recent pictures and no unlabelled icon row. Take photo is new on the phone.
- **The context ring** has no text; it turns amber from 80 %. Tapping it opens Context and usage.
- **The primary button** changes with the moment: **Talk** when the box is empty, **Send** when there is text, **Stop** while
  the agent works. Return adds a line on touch; only the button sends.
- **The row of chips** above the box, in a new chat only: **agent**, **folder**, **model · effort** and **subagents**, 36 pt
  chips in a row that scrolls sideways; each opens its picker. `[user]` The chips hide while the keyboard is up. A started
  chat has no chip row: its settings are locked and live in Chat info.
- **A new chat's intro** has 17/15 pt text and 44 pt starter prompts; the hint under the chips points at something real.
- **The pickers** are P2 sheets:
  - **Agent**: titled "Agent" with a sub-line; each row has a 34 pt glyph, the name and a one-line description; a tap picks and
    closes; a missing agent is listed dimmed with the reason; it says a switch brings the agent's default model.
  - **Model and effort**: one sheet with both, **Done**, 52 pt rows (name, a note, the context size), the effort beneath the
    list with one line on what effort costs. With one provider there are no headings; with several (pi) rows fall under
    headings.
  - **Folder** ("Start the agent in"): a flow, so **Cancel** at the left; the path shown once with its end visible and a 44 pt
    **Up**; a tap on the path types one; 52 pt folder rows with a chevron; a sticky full-width **Use <folder>**. `[user]` There
    is no Recent list: the sheet opens in the chat's folder and Up and the path reach any other. An empty folder says "No
    subfolders" and what to do.
  - **Subagents**: depth as a segmented control (Off · 1 level · 2 · 3) and "running at once" (5 · 10 · 25 · 50 · 100), greyed
    when depth is Off; each control says in words what it means.
  - **Prompt**: the prompt library's search as a sheet: title, Cancel and **Library** in the head, a full-width 17 pt search
    (so Safari does not zoom), folders as section heads, recent first (gone while searching), two-line rows.
- **A board chat's context row.** A 44 pt row of 34 pt chips that scrolls: the board chip first (opens the board), **@** boards,
  "2 quotes", and **Add 2 selected** only while something is selected. `[board]` @ suggestions dock full width above the
  composer, not over it: 52 pt rows (icon, name, group), at most 4, the first lit, a picked one becoming a chip with ×. The
  "2 quotes" chip opens a sheet "Quoted in this message" in which each quote has its passage, where it is from, its comment as
  an editable field (or a dashed "+ Add a comment") and a 44 pt trash that removes it from the message only. Quoted passages
  are marked soft yellow in the thread.
- **Images in the box.** Thumbnails of 72 px with a × (24 px visible, 44 pt target). An upload shows a ring on its thumb and
  **Send** waits, lit softly; × cancels. A refused image stays, marked, with its reason in red under the strip. Limits are
  said only when they are hit: the line names the limit and what was left out, and **Photo library** is dimmed until one is
  removed. A model that takes no images makes **Send** off and says why right above it, with **Change**.
- **The keyboard.** The composer sits right on the keyboard, 6 pt under the box, with no home gap; Send never leaves the
  screen; the thread keeps the last message just above the box; a drag down lowers the keys.

### 3.7 The composer: what blocks it, and voice

**3.7.1 Blocked states.** `[board]` (numbered so the rule 3.1.3 can point at it.) What blocks sending replaces the toolbar in
the box's place and is said once, in words, with the draft kept visible and the box read-only and greyed. No yellow box in the
thread, no placeholder, no red line.

- **Offline**: "<Server> is offline since 14:02. Your draft is kept." with a 44 pt **Servers** button that opens the server's
  detail, where it can be retried. The chat's sub-line says "offline".
- **Archived**: one bar with the box's shape, so the layout holds, with a full-width 44 pt **Unarchive** whose sentence says
  what it does. Archived and offline at once: the offline notice, the bar without its button.
- **No agent installed**: a bar instead of the box, said once.
- **An old board connection**: a bar whose button does what its sentence says.
- **A model too small for the chat**: amber, no ×, Send greyed, **Pick a model** opens the picker.
- **A refused send** (for example the folder is gone): red, above the box, with the reason; the text is kept.

**3.7.2 Voice in the composer.** Mockups "06 Voice in the composer", "05 Talking to the board", "07b Settings › Voice".

- **One vocabulary** `[board]`. States: **Listening**, **Sending in N s**, **Thinking…**, **Speaking**, **Muted**. Actions: **Talk**
  (speech mode; the waveform icon), **Dictate** (the mic icon: words into the box), **Send**, **Cancel** (always before Send),
  **Interrupt** (cut a spoken reply), **Mute**, **End** (leave speech mode; unsent words go to the box as a draft). **"Stop" is
  only for stopping the agent.**
- **Dictate.** While it listens the mic fills with the accent and the control that started it stops it; a "Listening…" line
  with a live level and "Tap the mic to stop" shows inside the box; live words are muted after what was typed and turn plain
  when final; the primary stays **Send**; typing stops dictation and the keyboard stays down.
- **Speech mode** is a bar that takes the box's place, with a state in words, one action of the moment (Send, Cancel or
  Interrupt), a 48 pt waveform, the heard words at 17 pt and the live guess muted, a 46 pt **Mute** and a red **End**. It has
  no Auto-send switch (3.7.3). While the reply is spoken the microphone is closed: there is no barge-in; **Interrupt** is the
  way to cut it.
- **Voice without a key.** Every voice problem uses one sheet, "Set up voice": it says what voice does, then what ElevenLabs is
  and that the key stays on this device, with one 50 pt primary **Open Settings › Voice** and **Not now** as a full-width text
  button. `[user]` The key is set only in Settings; there is no key field in the composer. Back in the chat, Talk works.
- **3.7.3 Auto-send is one setting.** `[user]` "Auto-send after speaking" is one switch, in Settings › Voice, for every chat,
  board or not. It is not in the speech bar, not on the voice card and not on the board.
- **The voice card on a board.** `[board]` One card in place of the old pill, caption and chip: "To: <chat> ⌄" (44 pt, opens the
  board's Chats sheet), the heard words, "With 1 selected shape ×" (speech mode only), **Cancel** and **Send** (44 pt). The
  orb stays docked, its ring showing that it listens. The card leaves the bar, the tools and the shape in sight. While Claude
  works the bar says so and the Chats count takes Claude's colour; a moved note flashes "Claude · moved"; the reply reads in
  the card at 17 pt, **Interrupt** cuts the spoken reply and **Open chat** pushes the chat.

### 3.8 Settings, servers, certificates, the prompt library

Mockups: "01 Menus", "02 Confirm", "03 Servers", "04 Add a server", "05 Certificate changed", "06 Prompt library", "06b",
"07 Settings", "07b Voice and Theme", "13 Server sheet and Settings v2".

**3.8.1 Settings.** One pushed screen (P5) from Home's gear: "‹ Home", a centred title, grouped rows. `[user]` Rows: **Servers**
(with its state, amber when something needs attention), **Prompt library** (with its count), **Archived** (a count, pushes its
screen), **Voice** (its value), **Appearance** (its value) and **About** (version, Help; "Server log" on desktop). Every row
pushes a page; there are no inline controls in Settings. **Appearance** pushes its own page: **Theme** as a checked list (Light,
Dark, System, with a line saying what System follows) and **Catppuccin flavours** as a row naming the one in use, which pushes
a P2 list: 50 pt rows with a two-colour swatch, each saying Light or Dark, a tap choosing and closing. A change applies at once.

**3.8.2 Servers.** Pushed under Settings, back naming it. One A–Z list of 64 pt rows (tile, name, state, host; no buttons); a
problem shows on its own row with a red or amber tile and the state words. `[user]` There is no "Needs attention" group. **Add
server** is at the end of the list and a **+** at the top opens the add flow. A server's detail is one screen: a status header
(state and when checked), facts as cells (address with **Copy**, version, agent chips, a short certificate), **Test connection**
answering in place, and **Remove server…** last, red, with its P4. That screen is the one place for a server: Home's problem
card, a chip's sheet ("Server settings"), the composer's "Servers" button and Chat info's Server row all go to it.
Unreachable shows the state in red with the last contact, why in plain words, what to try as numbered steps and **Test again**;
Too old shows both versions and how to update; Local network off (iOS) has one **Open Settings**.

**3.8.3 Add a server** is a flow, not a form. `[board]`

1. **Choose how** (a P1 sheet that names the task and what it needs): scan a code, paste a setup text (offered, tinted, "In
   clipboard", when the clipboard holds one) or type an address; plus a help row for a first-time user.
2. **Scan the code**: full-screen camera with a 44 pt × and a title, saying where the code comes from (run `server-code.sh` on
   the server); **Paste text instead** at the thumb. A code that is not a server's says so on the camera and scanning goes on.
3. **Check and test** (P3: Cancel · New server · Save): says what the code filled in, so only the name is left to check; the
   secret as dots, "from the code", never typed; on iOS, Local Network is announced before the system asks, with what to
   choose; one button, **Test connection**. Save stays off until the test passes.
4. **Trust and save**: the test result as cells (connected, time, version, agents), the fingerprint in 16 blocks of 4 in green,
   **Trust and save**, which says what it does. Then back on the list with a toast "Studio added · its chats are in your list".
   If the fingerprint does not match the code, every block is red, the code's own fingerprint is shown below with "Does NOT
   match the code — do not trust it", **Save** stays off, there is no accept button, and only **Cancel** is offered, saying that
   nothing secret was sent. This replaces today's red line beside an active "Accept fingerprint".

**3.8.4 A certificate changed.** `[board]` The server's row keeps its place in the list and turns red with a shield and
"● Certificate changed · paused"; its chats in the shell's list are marked the same way. Its detail has a danger notice that
names both readings (renewed, harmless; or someone posing) and says that nothing is sent until the person decides, so "paused"
is not read as broken. One way forward, **Compare fingerprints**, which shows where to read the true fingerprint (the command,
with **Copy**) or to scan its code, the fingerprint presented now in 16 red blocks and the old one muted below for reference;
**Trust…** is tinted red, not primary, and **Not now** goes back and leaves it paused. Trusting asks once more (P4: "Trust and
reconnect"), repeating what to check, except after a matching scan, when that confirm is skipped because the check was made.
**Remove** stays last.

**3.8.5 Voice settings.** `[board]` One pushed screen: the key as one row with its state and the privacy note under it; the chosen
voice with a 44 pt play and **Choose voice ›**; **Auto-send after speaking** (3.7.3); **Advanced** rows with values that open P2
pickers (including Microphone and Speaker, as `voice-devices-goal.md` says); **Remove key** last, alone, red, with its P4. With
no key yet one card says what voice is, whose account it uses and the one action; the Voice row is dimmed with its reason; speech
mode and Advanced wait for the key. **Add key** is a P3 on the large detent: Cancel · ElevenLabs key · Save, a hidden monospaced
field with a 44 pt eye, **Paste** and **Test key** side by side at 44 pt, a result line (✓ or ! in green or red). **Choose
voice** is a P5 list with a search always visible, the chosen voice checked and first, a tap that chooses and stays so voices can
be compared, a 44 pt play ("Playing sample…" while it plays) and "6 of 34 voices" with **Show all voices**.

**3.8.6 The prompt library** is a stack of pushed screens. `[board]` Pushed from Settings with its back label and no Close; a
**+** opens a sheet "New in Prompt library"; one 44 pt search whose hits are a flat list with paths; a section per server only
when there are several; groups as 60 pt rows with a folder tile, a count and a chevron; prompts show their first line and swipe
for more. A group is a screen (back names the parent, the title is the group; a nested group is one more push); its "…" sheet
(P1) has the group's tile, name and "Group in git · 2 prompts", "New … here" (the group on screen), **Rename**, **Move** and
**Delete**, which says "Delete group and 2 prompts" in its P4. A left swipe gives **Move** and **Delete**; **Move** opens a P2
picker (top level first, groups indented by depth, the current group tinted with "Now here", other servers greyed with the
reason). The prompt editor is a P3 with Save always above the keyboard, a "Group" row that opens the move picker instead of a
drag, tall monospaced text in its own card, a keyboard bar with **Done** and "Edited · not saved", and **Delete prompt…** at the
end; Return adds a line and never saves. Leaving a changed prompt asks with a P4-shaped sheet: **Discard changes** (red),
**Save and close**, **Keep editing** last as a plain link. On an offline server one notice is shown and the fields are locked.

## 4. Decisions and bounds

**4.1 What the user decided.** `[user]` The user's notes on the board, with what the board and this document did with each:

1. Home keeps the server › group › board hierarchy; "Needs you" goes; attention is a dot on the row and a count on the group
   (3.2).
2. Nested groups are not indented; each group is its own screen (3.2).
3. In "New", where first, then what to make (3.3).
4. A chat made on a board is made from inside the board (3.4).
5. No "All" on Home: each server is selected, one at a time (3.2).
6. A server's sheet keeps server info and settings; no "New chat" or "New whiteboard", no "Hide from Home" (3.2).
7. Problem cards show only inside that server, for that server (3.2).
8. Appearance is a row that pushes its own screen (3.8.1).
9. Home shows boards, not a board's chats; the chats are inside the board, and so is making a new one (3.2, 3.4).
10. The board's UX is Excalidraw's; the app adds nothing over it, no Fit pill, no double-tap zoom (3.4).
11. Auto-send is only in Settings and covers board and regular chats alike (3.7.3).
12. The board strip and the "Board" button in a board's chat are removed; back already goes to the board (3.4).
13. A board's chat is full size, never half a sheet (3.4).
14. Add selection opens the board, selecting there says "Add", and the items return to the chat as a selection; on a board a
    selection goes only to the chat speech mode is set to (3.4).
15. The composer is the design with "+", the ring, mic and one Talk/Send/Stop button, and the chip row of agent, folder,
    model · effort and subagents (3.6).
16. No recent folders in the folder picker (3.6).
17. No strip of recent photos; the "+" sheet names Take photo, Photo library, Files and Insert a prompt (3.6).
18. The ElevenLabs key is not set from the composer; the person is sent to Settings (3.7.2).
19. The Servers list is one A–Z list with no "Needs attention" group (3.8.2).

**4.2 Where the app changes and where it does not.** `[proposed]` The change is to the phone layout. The tablet and desktop
layouts are not redesigned and must look and work as they do today. Where a part is shared with them, the phone's shape is
chosen by the layout, and the other layouts keep theirs.

**4.3 The shared parts are respected and grown, not bypassed.** `[standing]` Every sheet, menu, dialog, button and overlay is
made from the app's shared interface parts (the sheet, the menu, the overlay with a pushed-screen kind, the dialog and its
footer, the button, the icon button, the switch, the secret input, the theme tokens and the breakpoints). Where the design needs
what they cannot do, they grow, in all layouts' interest: a sheet head with a title, a sub-line, a leading item and detents; a
menu of 50 pt rows with an icon and a danger group; a pushed-screen overlay kind on the phone; stacked and form footers; a 44 pt
button size and a 17 pt text ramp for the phone; one shared back control with an optional label; and one shared toast. A screen
does not draw its own sheet, back button or toast. Colours, sizes and fonts come from the theme's tokens, and every screen is
correct in the light theme, the dark theme and the Catppuccin flavours.

**4.4 Excalidraw is untouched.** `[user]` The board view's engine, its bridge and Excalidraw's own tools are not changed to
make the board look different. The app's bars and rows are outside the canvas. Anything the board shows that is the app's (the
bottom row's inset, the orb, the picking banners) sits in the app's chrome, not on the canvas.

**4.5 Voice rules that this work keeps.** `[standing]` What `voice-chats-goal.md` and `voice-devices-goal.md` say about what is
sent, what is heard, what is stored, the key (it is in no place but where the architecture document says, and in no request but
the one to ElevenLabs) and the devices, stays exactly. This work changes where voice is shown and where a setting is, not what
voice does. A voice screen still makes no request, asks for no microphone and lists no device until the person uses it.

**4.6 What a screen needs from the server.** `[proposed]` This goal is about the app. Some parts of the design show data the
server does not give today: a chat's last-activity time and a board's edited time on rows, an archive date, the agents a server
did not find (for the dimmed rows of the agent picker), a note and the context size per model, and a minimum server version
for the "Too old" state. Where the data is absent the screen shows what it can without it and does not invent it: no time on a
row, the chat's last activity in place of the archive date, only the agents found, no note. Adding any of that data to the
server is a separate decision and is not needed for this goal. `[not verified]` how many of these the server already sends.

**4.7 One word for one thing.** `[board]` The vocabulary of 3.1.3 and 3.7.2 is used in every screen, and in the labels that
assistive technology reads. Every control has a label for a screen reader, including those drawn as an icon.

**4.8 Navigation is native.** `[board]` The stack, the swipe back, the sheets with their detents and the swipe actions behave as
the platform's own do on iOS and on Android, with Android's back doing what a swipe back does. A custom gesture may not take a
platform's edge swipe, and none may take the board's pans.

**4.9 What this changes in earlier goals.** `[user]` Two things in `voice-chats-goal.md` no longer hold, and this document is the
one that decides them. The board's **voice pill**, a floating control over the canvas with its own chat chip and "+ New chat",
becomes the docked orb and the voice card of 3.4 and 3.7.2, in the app's chrome. And the **Auto-send toggle is not in the speech
bar and not on the board**; it is one setting, in Settings › Voice. Everything else in that goal stays.

**4.10 Both layouts' checks follow.** `[standing]` A check of today's phone layout that no longer describes the screen is
changed to describe the new one in the same piece of work; it is not left failing or removed without a replacement.

## 5. Out of scope

- The tablet and desktop layouts (4.2).
- Any new agent, board, voice or server ability; any change to what is sent to an agent or a server. New server data (4.6).
- The chat as a half sheet over a live board. It was drawn and dropped.
- A tab bar. A "Fit" control, double-tap zoom or any app-made selection control on the canvas.
- Notifications for a permission request, and any background connection or push they need.
- Searching inside chats' messages.
- A way to show Home "All servers", and "Hide from Home".
- Changing what the agents are told to draw (the size of the text they put on boards).
- Duplicating a prompt; probing several addresses of a setup code; upload progress in bytes.
- Redrawing the mockups. They are the design as they stand; a change to them is a change to this goal.

## 6. How it is confirmed

The work follows `AGENTS.md`: the change is to `app/` and the packages, so the unit tests and type checks at the root and the
tests of `web/` and `desktop/` each time; no Go test unless the server is touched. No paid model is called.

### 6.1 Every screen against its mockup

For every mockup of section 3, at the phone's width and in the light and the dark theme, the screen shows every numbered item
of its callouts, in the place and the words drawn, with the sizes of 3.1.1. A browser check at the phone viewport, run against
the mock server, covers each of these screens and their states: Home (one server, several, a problem on the selected server, a
dot and a count, first run, empty), a group and a nested group, "+ New" and its Where page, a row's sheet, swipe and Undo
toast, rename, search in each of its states, Archived, a board's bar in each of its states, the Chats sheet, a board chat,
Point at, Add selection, the chat's header, thread, tool steps, permission card and dock, message sheet, branches and tree, Chat
info, usage, the composer in each state (new chat with chips, started, each blocked state, dictation, speech mode, board
context, quotes, images, keyboard up), each picker, Settings and every page under it, Servers and its detail in each state, the
add flow with a matching and a non-matching fingerprint, a changed certificate, voice settings with and without a key, and the
prompt library.

### 6.2 The rules, as a check that cannot drift

- No touch target under 44 pt and no text under 13 pt (16 and 17 where 3.1.1 says so) on any phone screen listed in 6.1. One
  check walks every screen and fails by naming the control.
- No desktop word or focus ring appears on the phone layout (3.1.3).
- Every sheet has its subject in its head, a destructive row is last and red, and no P1 sheet has a Cancel row.
- Every blocked state of 3.7.1 is said once on screen, and the box is read-only with the draft visible.
- Every state word of 3.1.3 comes from one list: a server in each state reads the same on Home, on its chip, in its sheet, in
  Servers, in Chat info and in the chat's header.
- A delete asks and an archive does not, and an archive's Undo restores the item where it was.
- Back and the swipe back land where 3.1.2 says from every way into a screen, including a chat found by search or opened from a
  board's Chats sheet; a chat on a board returns to the board at the view it was left in.
- Auto-send is in Settings › Voice and in no other place, and changing it changes it for a board chat and a regular chat
  (3.7.3).
- Selecting on a board sends nothing to any chat except in speech mode, and then only to the chat voice is set to; Add selection
  and Point at return their chips and the agent gets the ids and the point.
- Nothing is drawn by the app over the canvas.

### 6.3 What only a device shows

Swipe and long press on rows (with the haptic and the drag after 10 pt), the swipe back from the edge and its exclusion on a
board, the sheet's detents and keyboard avoidance, Take photo and the system pickers, the camera scan, Local Network, the board's
bottom row with the orb docked (and the fallback if the inset breaks), landscape on a board and a table, and Android's back are
confirmed with the device flows of `app/e2e` on an iOS simulator and an Android emulator the person names, as `AGENTS.md` says:
only for the screens whose change only a device shows, never "to be sure".

### 6.4 What does not change

- The tablet and desktop layouts look and behave as before; their browser checks pass unchanged.
- What is sent in a message, what an agent receives for a selection, a point or a quote, and what is stored are as before.
- The voice checks of `AGENTS.md` (the unit tests, `VC`, the voice end-to-end script and, if the key's store or the desktop bridge
  changed, the desktop end-to-end) pass with the changes of 4.9 reflected in them and nothing else.
- Nothing about a board's content or its engine changes (4.4): the board engine's tests and its faithful comparison still pass.

### 6.5 Not confirmed by tests

Whether the 44 pt targets and 16 pt text are *comfortable* in a person's hand, whether "+" is found by someone who has not used
it, and whether the docked orb holds across Excalidraw updates are judged by people, not by checks. `[not verified]` The person
may ask for a run on a device and a short test with real users after the first screens ship.

## 7. Open questions

These were asked in the study that preceded the board and are not answered by it. None blocks the rest; each is a decision for
the user when the part it concerns is reached. `[not verified]`

1. Whether the docked orb in Excalidraw's footer can rely on a right inset (3.4); the fallback is drawn.
2. Whether "+" alone hides photo, prompt and board too well (3.6); a labelled tool row was drawn as an alternative and not chosen.
3. Whether the speech bar, about 270 pt tall, should fold its heading away after the first turn on a small phone.
4. Whether landscape on a phone keeps the phone layout (3.4 draws it) or switches to the tablet layout on the shorter side.
5. Whether Allow in the accent colour (3.5) is acceptable when the app cannot tell a risky command from a safe one, and whether
   agents should one day mark risky commands so red can return for those.
6. Whether four Catppuccin flavours stay on the phone (3.8.1 keeps them behind Appearance).
7. Where the "+ New chat" row stands in a board's Chats sheet: the first mockup of the sheet draws it last, the newest draws it
   first. This document says first (3.4).
8. How the server sheet of a chip (3.2) and a server's detail screen (3.8.2) share one body, so a server has one place and not
   two; both are drawn and say the same facts.
