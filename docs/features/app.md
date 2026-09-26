# Feature: the AI Whiteboard app

**Status.** Definition, agreed with the user. Written 2026-09-24.

**Based on.** The UX prototype's **variant 4, "Grouped chats + boards"**
(`docs/research/app-ux.md`, branch `app-ux`, commit `a9f8874`). Its composer pieces come from
variant 3: the folder, model and effort pickers, the context meter, tool cards and approval cards.
To see the reference, run the prototype as `app-ux.md` describes and switch to variant 4.

## What is being built, and why

AI Whiteboard becomes a real local app. It is a place to run coding-agent chats, and some of
those chats work on whiteboards.

The prototype settled the shape:

- The app is a **list of chats in groups the user makes**.
- A chat is an ordinary coding-agent session, exactly as in a terminal.
- A **whiteboard** lives in a group and has **its own chats**. Those chats can see the board and
  draw on it.
- Chats that don't belong to a board know nothing about whiteboards.

This feature turns the prototype into the product:

- a separate local server and client (a web client for now; a native React Native client later);
- boards and chats that persist in the user's home folder;
- archive and delete;
- sticky per-group defaults;
- a clean drawing style;
- real Claude Code and real Cursor agents.

The goal is an app the user keeps open all day next to their code. They should be able to find
every chat and board where they left it, pick up any chat after a restart, and get clean diagrams
from agents without fighting the style.

## The two programs

- **Server.** A separate local program, still written in Go. It runs the agent processes, keeps
  the chats, groups and settings, and serves the board tools the agents call. It can also be run
  on its own from the command line.
- **Client, for now: a web app.** It runs in a browser tab on this machine, as the prototype does.
  It is built separately from the server, and it talks to the server only through the server's
  public interface, so another client can replace it.
  - The board is the real **Excalidraw editor**. It looks and behaves as in the prototype and uses
    the same `.excalidraw` files.
- **Client, later: React Native for macOS.** A native app replaces the web client in a later
  feature, with the board as Excalidraw in an embedded web view. Nothing in this feature should
  make that harder: the server must not assume a browser.
- **Starting.** Running the server opens the client in the browser, or connects to the server
  already running.
  - Closing the tab does not stop the server, so running chats keep working.
  - Stopping the server ends the agents. Their chats can be resumed later (see *Persistence*).
- **One client at a time.** Only one tab is connected to the server.
  - A second tab can take over. The first tab saves its pending changes first, then shows "Opened
    in another window" with a button to take it back.
  - With one client there is never more than one editor answering an agent's board calls. In the
    prototype, two open tabs both answered the same agent, and edits landed on the wrong board.

## Where things live

- Everything is under **`~/.ai-whiteboard`** in the user's home folder.
  - Boards are plain `.excalidraw` files there.
  - Chats (history, names, settings), groups, the sidebar layout and the per-group defaults are
    kept next to them.
- The folder is hidden. **Reveal in Finder** on a board (the server opens Finder at the file)
  keeps the files reachable.
- Nothing is carried over from the prototype, and there is no import: boards are only made in
  the app.

## The sidebar

As in variant 4:

- A sidebar on the left is the whole navigation. There is no top bar and there are no page tabs.
- From the top, it shows:
  - the app name and a **+** menu: *New chat*, *New whiteboard*, *New group*;
  - ungrouped chats and boards;
  - the user's **groups**, in the order the user puts them;
  - a **New group** button.
- **Groups**
  - Created by the user. A new group opens with its name ready to edit.
  - Double-click a group's name to rename it. Click its header to collapse or expand it.
  - When a group is collapsed, its header shows a count, and a live dot if any of its agents is
    working.
  - Hovering the header shows **+** (new chat or new whiteboard in that group) and a menu with
    *Rename*, *Archive*, *Delete*.
- **Moving.** Drag a chat or a board onto a group, or onto the ungrouped area. A board's chats move
  with it. Dragging a group reorders the groups.
- **Boards are sub-groups.**
  - A board row has a caret, a board icon and its name, with its chats indented beneath it.
  - Hovering a board shows **+** for a new chat on it.
  - While one of the board's agents is working, the icon becomes the agent's glyph.
- **Chat rows** show the agent's glyph with a status dot, the chat's name, and a second line. The
  second line shows the model and effort, or the live status while the agent works.
  - Chats are named automatically from the first message by a small model, as in the prototype.
  - Double-click a chat to rename it. A name the user sets is never overwritten.
- **Show archived.** A switch at the bottom of the sidebar. See *Archive and delete*.
- **Theme.** Beside it, a three-way switch: *Light*, *Dark*, or *System* (the default), which
  follows the OS appearance and changes with it live. The choice is kept in the browser and
  survives reloads; the page opens in the right theme with no flash of the other one. The whole
  window follows it, the whiteboard canvas included (Excalidraw's own dark mode; its own theme
  toggle is hidden). Only the look changes: boards are stored the same in both themes.
- **Width.** Dragging the sidebar's right edge resizes it (200–480px, 264px by default), in every
  view. Double-clicking the edge puts it back to the default. The width is kept in the browser and
  survives reloads.

## Plain chats

- A plain chat is a full coding-agent session started in a folder, the same as running the agent
  in a terminal there. It gets all the agent's own tools, the user's settings, MCP servers, skills,
  and the folder's project instructions.
- It has **nothing of the whiteboard**: no board tools, no whiteboard instructions, and no context
  about what is on screen.
- Selecting one fills the area right of the sidebar with the chat: a header (name, agent, folder,
  status), the thread in a centred column, and the composer.
- The composer toolbar has **folder**, **model** and **effort** pickers and a **context meter**.
  - The pickers can be changed until the first message is sent; then they lock.
  - No agent runs until the first message is sent, so changing a picker only changes the setting.
    The first reply waits for the agent to start.
  - Cursor's model list is fetched when the server starts, so its model picker is filled before
    any Cursor chat has run. Until the fetch finishes, the last known list is shown.
  - In a Claude chat, clicking the context meter opens a popover with the chat's context and the
    Claude plan's usage limits: the current session and the current week (all models, and each
    model with its own weekly limit), each with its share used and when it resets. The limits are
    checked when the popover opens (at most once a minute; ↻ checks again) and never stored. They
    are the account's, so every Claude chat shows the same numbers. Cursor chats and subagent
    meters keep their hover tooltip.

## Whiteboards

- **Creating.** *New whiteboard* in a group's **+** menu creates a board in that group. Its name is
  ready to edit straight away. The board is **saved to disk the moment it is created**, as an empty
  `.excalidraw` file.
- **Opening a board with no chat open** shows only the board, to the right of the sidebar.
  - A thin bar above the canvas shows `Group / board name` and a **+ Chat on this board** button.
  - When the board has chats and none is open, the bar also shows **Chats (n)**.
- **Names need not be unique.** Two boards may have the same name, in the same group or not. A
  board's file is named by its id, so renaming never touches the file.
- **Renaming** a board (double-click) changes only its name. Its chats follow, and they know the
  board by its new name from the next message on.
- **Autosave**
  - Every change is saved to the board's file: the user's own drawing, and every agent edit.
  - Saving is debounced: a burst of changes becomes one write, shortly after the last change
    (around half a second).
  - Pending changes are always written before the board is closed, renamed, archived, or the app
    quits. The user never needs a Save action, and never loses more than that short window.
  - Excalidraw's own Open, Save and Save to disk are turned off, and dropping a `.excalidraw`
    file on the canvas does nothing: they would replace the board or save a copy that isn't the
    board. Export image stays.
- **Undo.** Each agent edit is one undo step for the user, as in the prototype.
- **Only the app edits board files.** Every change to a board goes through the app, whether it
  comes from the user or from an agent.
  - Agents never read or write board files on disk. Board chats read and edit boards only
    through the board tools.
  - The agents' instructions say so. The app also blocks agents' own file and shell access to the
    app's folder, `~/.ai-whiteboard`, for every chat, including plain chats.

## Board chats

- **Opening.** Clicking a board chat, or clicking a board that has chats, opens the board with
  that chat's panel **on the left**, between the sidebar and the canvas. That is the prototype's
  chat panel, moved from the right side to the left.
  - Clicking a board reopens the chat that was last open on it.
  - The panel's **×** or **⌘J** hides it, and **Chats (n)** in the board bar brings it back.
  - Dragging the panel's right edge resizes it (300–760px, 400px by default), always leaving the
    canvas at least 320px; double-clicking the edge resets it. Like the sidebar's, the width is
    kept in the browser, and it is one width for every board.
- **What they get**
  - Everything a plain chat has, including its own folder, model and effort, picked the same way.
    The board doesn't change where the agent runs; it only adds the board's context.
  - The **board tools**: read a board, look at the user's view and selection, edit, delete, and
    show a board.
  - The **whiteboard instructions**.
  - With every message, **context naming their board** (its name and id) and the boards the user
    `@`-mentioned. What the user has selected is not sent on its own; the agent can look at the
    user's view and selection with the board tools when asked about "the selection".
- **Pointing at the board.** While a board chat is open beside its board, the user can put parts
  of the board into the message, where they are typing, as many as they like, between words:
  - **⌘L** puts what is selected on the board into the message, shown as a chip (e.g.
    *rectangle “API”*, *3 rectangles*).
  - **⌘⇧L** asks for a point: the canvas shows a crosshair and a hint, and a click puts that spot
    (board coordinates) into the message as a chip. **Esc** cancels.
  - A chip is deleted as a whole with Backspace. The sent message shows the same chips in the
    thread; the agent gets, in the same place in the sentence, the elements' ids and details, or
    the point and the elements near it.
- **Scope.** A board chat works on its own board unless the user points at another board with
  `@name`. A board picked from the `@` list is sent with its id, so a shared name is never
  ambiguous; the board tools
  take only ids. When the user names a board by hand, the agent lists the boards first to find
  its id, and asks if several share the name. It does not create boards or switch the user's view unless asked.
- **Boards an agent creates.** When the user asks a board chat for a new board, the board is
  added to the same group as the chat's board, with no chats of its own. The chat can keep
  working on it by its id, and the sidebar marks it as new until the user opens it.
- **While the user draws.** The user and the agent edit the same board at the same time:
  - an outline in the agent's colour shows what the agent just changed;
  - a pill at the bottom of the canvas says the agent is working;
  - the user's own shapes are never moved or restyled unless the user asks.
- **When the window is closed.** The client owns the open board, so a board chat can't reach its
  board without a window.
  - Board tool calls then fail with a clear message: the board isn't open.
  - The agent says so in the chat, and the user sees it when they return. Nothing is queued.

## Drawing style

Boards default to a clean, technical look instead of Excalidraw's hand-drawn one.

- **The agents' instructions** tell them to draw by default with:
  - sharp corners (no rounded shapes) and sharp, straight arrows;
  - the lowest sloppiness (clean, "architect" strokes);
  - Excalidraw's normal font, not the handwritten one.

  They use another style only when the user asks for one. This holds on boards drawn by hand
  too: new elements are clean unless the user says otherwise.
- **The editor's own defaults** for new shapes, arrows and text match, so what the user draws fits
  with what agents draw. The user can still change any style by hand, and Excalidraw remembers
  their choice for the rest of the session.
- Existing boards keep the style they were drawn in. The defaults only apply to new
  elements.

## Agents

- **Claude Code** runs as in variant 3.
  - It is a full session in the chosen folder.
  - Anything the user's own permission settings would ask about appears in the chat as an
    **approval card**, showing the command, file or URL, with Allow / Don't.
  - Tool calls show as one-line cards.
- **Cursor** is a real integration, no longer a mock. It runs through the Cursor agent's
  machine-readable mode, as researched in `docs/research/cursor-rpc.md`.
  - It has the same chat features: streaming, tool cards, approvals, interrupt and resume.
  - It has its own models and settings in the pickers.
  - Cursor cannot use MCP servers; team policy blocks them. A Cursor board chat reaches the same
    board tools a different way: it runs short commands against the app's local board interface.
    The results, the tool cards and the edits on the board are the same as for Claude.
  - Nothing is written into the chat's folder. A Cursor board chat picks its folder like any
    other chat. The whiteboard instructions and the board context come with the conversation, not
    from `AGENTS.md` or `.cursor/rules` files in the user's project.
  - Cursor runs with the user's own Cursor settings. Changing the model in a chat may also change
    the user's global Cursor default model. That is accepted.
- Both agents show in the **+** menus as *Claude Code chat* and *Cursor chat*. Each chat shows its
  agent's glyph and colour.
- **Messages render Markdown**, in both themes: headings, bold and italic, strikethrough, lists
  (nested, and task lists with their boxes), links, inline code, code blocks, quotes, tables and
  rules.
  - Code blocks are monospace, scroll sideways instead of wrapping, name their language, colour the
    common languages, and have a **Copy** button.
  - Links open in a new tab. Images are shown as links; nothing is fetched from a message.
  - Raw HTML in a message is shown as text, never run or drawn.
  - The user's own messages render Markdown too, and keep their line breaks as typed.
  - References to the board (⌘L, ⌘⇧L) show as chips where they stand in the sentence, in the user's
    messages and in the agent's when it quotes them; `@board` names in the user's messages link to
    their boards. Inside code they stay as typed.
  - While the agent writes, the text is formatted as it arrives, with the caret after the last
    line; a long reply stays smooth.

## Subagents

Subagents that a Claude or Cursor chat starts show in the parent thread as **one compact row**
where the parent's Agent/Task call is. The row never shows what the subagent did, only a summary.
Everything is streamed live from the agent, kept with the chat (each subagent on its own), and
still there after a reload.

- **The row** shows a status mark (a pulsing green dot while it runs, then ✓ completed, ! failed or
  ■ stopped), its name (the description the parent gave it), a type badge only for a non-default
  agent type, and a `background` tag for a background one. Under the name is a one-line summary
  in the sidebar's style. While the subagent runs the line is green and shows what it is doing
  ("Running `ls`…", "Thinking…", or Claude's progress line). After it ends the line reads
  "Done · <first line of its report>", "Stopped", or the error in red. On the right: model ·
  effort (effort for Cursor only), the tool count, a live duration, and a context meter (tokens
  against the subagent model's window, as a bar and %).
- **The drawer.** Clicking the row opens a drawer on the right, `min(700px, 58vw)` wide, with no
  backdrop. It covers the right side of the thread, or of the canvas in a board layout, without
  pushing anything aside, so the chat stays readable and the composer usable. The open row is
  highlighted. Clicking the row again, the **×** or **Esc** closes it. Esc closes only the drawer;
  a second Esc stops the chat as usual. The header repeats the row's mark, name, badges, activity
  line and stats, with ‹ n/N › to step through the chat's subagents. The body shows the prompt
  the parent wrote, then the subagent's own thread (its text, and tool cards that expand like the
  parent's), then its report when that differs from its last text. A running subagent is followed
  as it streams. A finished one opens at the top. Selecting another chat closes the drawer.
- **Approvals** a subagent asks for stay in the parent thread, labelled "Asked by subagent ·
  <name>".
- **How the agents behave.** Claude may start subagents in the background without being asked.
  The parent then goes Idle while they run, and later starts a follow-up turn by itself. Cursor
  keeps the parent's turn running until its subagents finish.
- **Stop stops every subagent.** The app marks subagents stopped itself whenever it can't rely on
  the agent to report it: Stop, an aborted turn, the agent's process ending, and a server restart.
  A single subagent can't be stopped on its own, and a foreground subagent can't be sent to the
  background. A Claude background subagent running while the parent is Idle can't be stopped from
  the app, because the Stop button only shows while the parent is busy.

## Sticky defaults

When the user changes the folder, model or effort in a chat's composer, that becomes the default
for the **next new chat in the same group**. Sending a chat's first message also counts: the
chat's folder, model and effort become the defaults, even the ones the user did not change.

- **The folder** is remembered **per group**, for all agents.
- **Model and effort** are remembered **per group and per agent**. A group remembers Claude's last
  model and effort separately from Cursor's.
- **Agent order** is always Claude Code, then Cursor, in every menu. It never changes with what
  was used last.
- **Ungrouped** counts as a group of its own.
- **A new group** starts with the defaults the user used most recently anywhere. From then on it
  keeps its own.
- Board chats use the defaults of the group the board is in.
- Defaults only affect new chats. Changing one never changes an existing chat. Moving a chat to
  another group doesn't change its settings.
- Defaults are kept across restarts.

## Persistence

- Chats are kept on disk: their names, groups, settings, whole history, and context usage.
- After the server or app restarts, every chat is in the sidebar where it was. Opening one shows
  its history and does not start its agent, so old chats can be read without starting anything.
- Sending a message **resumes the same agent session**, so the agent remembers the conversation.
- An agent that was mid-turn when the server stopped shows as *Stopped*, and the user can continue
  it with a new message.
- If the chat's folder has been moved or deleted, the chat shows the error, and the user can pick
  another folder to continue in.

## Archive and delete

- **Archive**
  - Chats, boards and groups can be archived from their menu.
  - Archived items disappear from the sidebar.
  - Archiving a chat **stops its agent**. Any approval it was waiting on is answered "no".
  - Archiving a board archives its chats. Archiving a group archives everything in it.
- **Show archived**
  - The sidebar's switch shows archived items **in place**, in their groups, greyed and marked.
  - Each has *Unarchive* and *Delete*.
  - An archived chat or board can be opened to look at, but is read-only until it is unarchived.
- **Unarchive** puts the item back where it was. The chat's next message resumes its session.
  - Unarchiving a board chat whose board is archived brings the board back too. The board's
    other archived chats stay archived.
- **Delete** is permanent and always asks for confirmation first.
  - Deleting a **chat** removes it and its history, and stops its agent.
  - Deleting a **board** removes its file and **all its chats**.
  - If an agent is working on the board, archiving or deleting it asks first: "An agent is working
    on this board. Stop it and archive/delete?" The agent's last edit stays as it is.
  - Deleting a **group** asks whether to delete everything in it, or to move its contents to
    ungrouped and delete only the group.

## Impact on the existing project

**Changes**

- `docs/PROJECT.md` describes one Go binary that serves the page and opens a **browser tab**. The
  browser stays the client for now, but server and client become **separate programs**. The
  client is built on its own and uses only the server's public interface, ready for a React
  Native client later.
- *Pages in tabs* goes away. Boards live in the sidebar, and one board is open at a time.
- *Chats sit on top of pages* changes.
  - Chats are no longer floating conversations that can work on any page.
  - A chat either belongs to one board, or knows nothing of boards.
  - "The page you are looking at" is always the chat's own board.
- The research's *isolation* flags no longer apply. Every chat is a full agent session with the
  user's own settings, as in variant 3.
- Boards move from a workspace directory given on the command line to `~/.ai-whiteboard`.

**Adds**

- Groups, board sub-groups and drag-to-move.
- Plain chats with no whiteboard.
- Autosave on create and on every change.
- Archive, delete and the archived view.
- Per-group sticky defaults.
- Resumable chats that survive restarts.
- The clean drawing style.
- Real Cursor.
- Reveal in Finder.

**Removes**

- The prototype's variants 1–3 and its variant switch.
- The sandboxed chats of variants 1–2 (board tools only, their own prompt).
- The approval card for board deletes.
- The Cursor mock.

## Conflicts and open problems

1. **The client owns boards, but chats outlive the window.** Accepted. While the app is closed,
   agents keep running but can't reach any board. A board task started just before closing fails
   partway through. Board work needs the window open.
2. **Autosave happens in the client.** Accepted. Pending changes are written before the window
   closes or the app quits. A crash can lose the last half second of changes.
3. **Cursor's board tools go through commands, not MCP.** Accepted. Because Cursor runs with the user's own
   settings, those commands may ask for approval unless the user's Cursor settings allow them. The
   app should allow them for board chats without widening anything else. If that isn't possible,
   each board edit would need an approval card. The tool cards should show these as board actions,
   not as raw commands.
4. **Agents and the app's folder.** Accepted. Blocking file and shell access to `~/.ai-whiteboard` works
   through each agent's own permission rules. A shell command that reaches the folder indirectly
   (a script, a symlink) can slip past rules like these. The instructions are the main guard.

**Settled and accepted**

- Moving a chat to another group keeps the settings it was created with. Only where it's listed
  changes. Accepted.
- Renaming a board: replies written before a rename still mention the old name. Accepted.
- Hidden storage: boards in `~/.ai-whiteboard` aren't linked to any project. Accepted, with Reveal in
  Finder.
- Excalidraw in a web view inside a native app: avoided for now by keeping the client on the web.
  This is the main risk for the later React Native client.

## Out of scope

- The React Native client (macOS). It is a later feature. Windows and mobile clients too.
- Using the app from another machine, and sharing or collaborating between users.
- A headless board engine on the server, so that agents could edit with no window open.
- Linking boards to project folders, or syncing them to a git repository.
- Queuing board edits while the window is closed.
