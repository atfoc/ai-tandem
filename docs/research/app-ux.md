# App prototype: how AI Whiteboard looks, feels and works

**Question.** What should the app look and feel like, and how does it work end to end? That means
page tabs, a real Excalidraw editor, and chats that run real agents that read and edit the boards.
The UI should show which chats are Claude and which are Cursor, and let the user start either.

**Mode.** With a human in the loop. How it looks and feels is the user's call.

**Branch / worktree.** `app-ux`, at `.worktrees/app-ux`.

**Scope, as agreed.**
- Real editor and real Claude (`claude` CLI, stream-json, per the `claude-rpc` findings).
- Cursor is only a UI mock: a scripted agent that uses the same event shapes. It is not connected.
- One direction per round.

## How to run it

```
cd .worktrees/app-ux/web && npm install && node build.mjs     # builds web/dist (node build.mjs --watch while iterating)
cd .worktrees/app-ux && go run ./cmd/ai-whiteboard boards      # serves http://127.0.0.1:4747 and opens the browser
```

- `boards` is the workspace directory of `.excalidraw` files. It is created if missing and
  gitignored. Useful flags: `-port`, `-no-open`, `-claude <bin>`.
- **Variant switch:** a dashed pill in the bottom-left corner of the page shows the variant's
  number and name. Click it to choose a variant, or press **⌥V** to cycle. Switching keeps the
  open pages, chats and scroll position.
- The server also keeps `boards/.layout.json` (variant 4's groups).
- Other keys: **⌘J** toggles the chat panel, **Enter** sends, **Shift+Enter** adds a new line,
  **Esc** stops a running turn, and **@** mentions a page.

## Variants

| # | What it is | Commit | Switch |
|---|---|---|---|
| 1 | **Docked sidebar.** Page tabs across the top bar. Excalidraw fills the middle. A fixed 384px chat panel on the right has a session list (agent glyph, title, live status, model, cost) above the active thread and composer. | `fe4d47b` (id fix `15bc981`) | pill → 1, or ⌥V |
| 2 | **Named chat rail.** Built from 1. The chat list is a column beside the thread instead of above it, with named chats. A new chat picks only the agent; model and effort are chosen in the composer and lock on the first send. A context meter sits in the composer. Deletes are never asked about. | `761581c` | pill → 2, or ⌥V |
| 3 | **Full agents + folder.** Variant 2's layout, but every chat is a normal Claude Code session (as if run from the CLI) with the board tools added, started in a folder picked per chat next to model and effort. The folder locks on the first send. | `5280e5f` | pill → 3, or ⌥V |
| 4 | **Grouped chats + boards.** The app opens on a list of chats in groups you make yourself. A plain chat is a Claude Code session with no whiteboard in it, and it fills the window. A whiteboard is created inside a group and holds its own chats. Opening it shows the board, with its chat panel on the left beside the list. Only board chats get the board tools and context. | `a9f8874` | pill → 4, or ⌥V |

### Variant 1 in detail

- **Top bar.**
  - Brand, then page tabs (`untitled`, `arch`, …), then `+` (new page) and `⌄` (open a page from
    the workspace).
  - While an agent works on a page, that page's tab shows a spinning agent glyph.
  - When an agent edits a page you are not looking at, the tab gets a count badge in the agent's
    colour. Opening the tab clears it.
  - The **Chats** button on the right shows how many chats are waiting for approval.
- **Starting a chat.**
  - **New chat ▾** opens a menu with a *Claude Code* section (Sonnet, the default, then Opus and
    Haiku) and a *Cursor agent* section (Auto, marked `mock`).
  - Each chat spawns its own `claude` process.
- **Session list.**
  - Each row shows the agent glyph on its colour: Claude orange ✳, Cursor dark hexagon.
  - It also shows the title (the first message), a status dot and text (Ready, Thinking…,
    Editing untitled…, Needs your approval, Idle, Stopped), the model, and the running cost.
  - Hovering a row shows × to close the chat, which ends the process.
- **Thread.**
  - User messages appear as violet bubbles, with `@page` mentions shown as clickable chips.
  - Assistant text streams in token by token.
  - Each tool call is a one-line card: *Read untitled*, *Edited untitled · +5 ~1*, *Deleted 2 on
    untitled*. The card has a **Show** link that jumps to the page, and it expands to show the raw
    input and result.
  - The cost of each turn appears under the last reply.
- **Approvals.**
  - Board reads and edits never ask.
  - `delete_elements` is deliberately not on the allow-list, so a delete arrives as an amber card:
    *Delete 1 element on untitled?* with the agent's reason and **Delete** / **Don't** buttons.
  - While the card is pending, the elements are outlined on the canvas with a pulsing red dashed box
    labelled "Delete?".
- **On the canvas.**
  - After each agent edit, a box in the agent's colour outlines what changed for about 2.5 s, with
    a "✳ Claude" tag.
  - A pill at the bottom centre says *"Claude is working on untitled ···"* while tools run.
- **Composer.**
  - A context chip above the input shows what is sent automatically: *👁 untitled · 2 selected*.
    Once you type an `@mention`, it shows the referenced pages instead.
  - The input is an autosizing textarea with an `@` page picker. The send button turns into a stop
    button while a turn runs, and messages typed mid-turn are queued.

### Variant 2 in detail

Built from variant 1 on the user's four requests. Only what differs from variant 1 is listed.

- **Chats in a column beside the thread.**
  - The right side is split into a 212px chat list and a 388px thread. The list has a `+`
    button, then one row per chat: agent glyph with a status dot, the chat's **name**, and
    "Sonnet 5 · Medium" (or the live status while it works).
  - `«` at the bottom collapses the list to a 52px icon rail. Hovering an icon shows the name
    and status. The choice is remembered.
  - **Naming.**
    - After the first message, Haiku writes a 2–5 word title in the background, e.g. "Data
      pipeline diagram". Until then the row shows the first message, greyed.
    - Double-click a row, or click the name in the thread header, to rename. A name you set is
      never overwritten.
- **New chat picks only the agent.**
  - `+` offers *Claude Code* and *Cursor agent (mock)*.
  - The composer toolbar shows **model** (Sonnet 5, Opus 5.5, Haiku 4.5, each with a one-line
    note) and **effort** (Low, Medium, High, Extra high, Max; hidden for Haiku). The defaults
    are Sonnet 5 · High.
  - Each change replaces the pre-warmed `claude` process with one started with the new
    `--model` / `--effort`, so there is still no boot delay on the first send.
  - On the first send, both lock into a static chip: "🔒 Sonnet 5 · Medium". The server
    refuses later changes (409).
- **Context usage.**
  - A ring and text in the composer toolbar, e.g. `◔ 3.8k / 1M 0.4%`. It turns amber above
    50% and red above 80%.
  - Used = the last model call's input + cache tokens (from `message_start.usage`) plus its
    output (`message_delta.usage`). The window comes from `result.modelUsage[*].contextWindow`:
    1M for Sonnet 5 and Opus 5.5, 200k for Haiku 4.5.
  - The hover text shows exact numbers and the cost so far. The Cursor mock has no meter.
- **No approval prompts.**
  - Variant 2 chats start with `delete_elements` on the `--allowedTools` list, so nothing asks.
  - What was deleted gets a red "Removed" outline for about 1.5 s on the canvas.
  - Variant 1 chats still ask. The setting belongs to the chat, so a chat keeps its behaviour
    when you switch variants.

### Variant 3 in detail

Built from variant 2, which it matches except for the following.

- **Same capability as the CLI.**
  - A chat starts `claude` exactly as it runs from a terminal in the chosen folder: Claude
    Code's own system prompt and all built-in tools (Bash, Read/Edit/Write, Grep/Glob, web,
    subagents), plus the user's settings, permissions, hooks, MCP servers, skills and the
    folder's CLAUDE.md. None of the isolation flags from variants 1 and 2 are passed.
  - On top of that it adds:
    - `--mcp-config` with the board server. All board tools are allow-listed, including
      delete.
    - `--append-system-prompt` with `prompt-append.md`. That file explains the
      `<ui-context>` block and the board rules, and says to edit boards only through the
      tools, never through the files.
    - `--permission-prompt-tool stdio`. Anything the user's own settings would ask about in
      the CLI arrives as an approval card. The card now shows the command, file or URL.
  - Cost of this: the first reply started at about 35k tokens of context (Haiku, 18% of
    200k) and cost about $0.09. That is the price of Claude Code's full prompt and tool list.
- **Folder per chat.**
  - A folder chip comes first in the composer toolbar: `📁 app-ux ▾`. The popover offers:
    - a path box (type or paste, `~` works, Enter to go);
    - up to 4 recent folders (remembered in the browser);
    - a browsable list of subfolders with `..`, marked `git` when the folder is a repo;
    - **Use <folder>**.
  - Picking a folder replaces the pre-warmed process, as a model or effort change does.
  - On the first send it locks with the model: `🔒 📁 app-ux  Haiku 4.5`. The thread header
    shows the full path.
  - The default folder is the one the app was started from (`-cwd` overrides it), or the
    most recently used folder.
- **Tool cards for Claude Code's own tools.** One-liners in the same style as the board
  cards: the Bash `description` (or `Ran \`cmd\``), *Read main.go*, *Edited x.ts*,
  *Searched for …*, *Fetched host*, *Subagent …*, *Loaded tools*, and `server · tool` for
  other MCP servers.
- **Verified:** Haiku in `.worktrees/app-ux` listed `cmd/ai-whiteboard/*.go` through Bash,
  loaded the board tools through ToolSearch (the user's MCP tools are deferred as in the CLI),
  and drew the 5 files as boxes. The chat was auto-named "Visualize Go files".

### Variant 4 in detail

Built from variant 3 on the user's request. Pickers, tool cards, approvals and the context meter are
the same. What differs:

- **No top bar and no page tabs.** A 264px sidebar on the left is the whole navigation. From the top:
  - brand and a `+` menu: *Claude Code chat*, *Cursor chat (mock)*, *Whiteboard*, *New group*;
  - ungrouped chats and boards;
  - your groups, each with a header (caret, name, and a count plus a live dot when collapsed);
  - a dashed **New group** button.
- **Groups.**
  - Double-click a group name to rename it. A new group opens with its name already in edit mode.
  - Click the header to collapse or expand it.
  - Hovering the header shows `+` (*New in <group>*: Claude chat, Cursor chat, Whiteboard) and
    `×`. The `×` removes the group and moves its contents to ungrouped; nothing is deleted.
  - Drag a chat or a board onto a group, or onto the ungrouped area, to move it.
  - Groups and placement are saved on the server, in `.layout.json` in the boards folder, so they
    survive restarts and sync across tabs. Chats still don't survive a restart.
- **Plain chats: no whiteboard at all.**
  - They start `claude` exactly as variant 3 does, minus the board MCP server, the whiteboard
    prompt and the `<ui-context>` block. The composer has no page chip and no `@` mentions.
  - Selecting one fills the area right of the sidebar with a centred column (max 780px): header,
    thread, and the composer with the folder, model and effort chips.
- **Whiteboards.**
  - *Whiteboard* in any `+` menu creates `whiteboard.excalidraw` (then `-2`, `-3`, …) in that group.
    Its name opens in edit mode straight away.
  - The right side then shows just the board, with no chat. A thin bar above the canvas has the
    breadcrumb `Group / ▭ board` and a **+ Chat on this board** button.
  - Double-click a board to rename it. That renames the file, and its chats follow.
  - In the list, a board is a sub-group: a caret, then its chats indented beneath it on a guide
    line. Hovering a board shows `+` for a new chat on it.
  - While one of its agents is working, the board's icon becomes the agent glyph.
- **Board chats.**
  - Clicking a board chat, or a board that has chats, opens the board with that chat's panel
    (400px) between the sidebar and the canvas. That is the variant 3 panel, moved to the left.
  - The panel header shows `▭ board · Claude Code · folder`. Its `×` (or ⌘J) hides the panel, and
    then the bar shows **Chats (n)** to bring it back.
  - Clicking the board reopens the chat you last had open on it.
  - Board chats are full Claude Code sessions with the board tools, as in variant 3. A short
    addition to their prompt says the chat is attached to the `active_page` in `<ui-context>` and
    shouldn't create pages or switch views unless asked. It names no page, so it stays true after a
    rename.
  - Their `<ui-context>` always names their own board and leaves out `open_tabs`.

## How it works (the prototype's architecture)

```
browser tab ── Excalidraw (engine for every page) + tabs + chat UI
   ▲ SSE /api/events: chat events, rpc calls          │ POST: messages, approvals, rpc replies, page saves
   │                                                  ▼
Go server (cmd/ai-whiteboard, stdlib only)
   ├─ Pages: .excalidraw files in the workspace dir (GET/PUT/POST /api/pages)
   ├─ Chats: one `claude -p --input-format stream-json …` per chat; stdout lines relayed to the browser
   │         as chat_event, kept for replay on reload; can_use_tool control requests held until the
   │         browser answers
   └─ MCP /mcp/{chatID}: board tools; each call is relayed to the browser as `rpc` and its answer returned
```

- **The browser is the only place a scene changes.**
  - Board tools (`list_pages`, `read_page`, `get_view`, `apply`, `delete_elements`, `create_page`,
    `show_page`) run in the page. They use the `excalidraw-live` skill's engine (`apply.ts`,
    `format.ts`, copied as-is).
  - Edits to the page on screen go through the live Excalidraw API, so the user sees them land
    immediately.
  - Edits to other pages go to their stored element arrays, and the tab is badged.
  - The browser saves every change back through `PUT /api/pages/{name}`.
- **Claude flags:**
  - Session and isolation: `--session-id <chat>`, `--strict-mcp-config`, `--setting-sources ""`,
    `--disable-slash-commands`.
  - Prompt and tools: `--system-prompt <prompt.md>`, `--tools ""` (no shell),
    `--allowedTools mcp__board__{all but delete_elements}`.
  - Approvals: `--permission-mode default`, `--permission-prompt-tool stdio`.
- **Context:** each message is sent as two text blocks: a `<ui-context>` block (active page,
  referenced pages, open tabs, selection lines, viewport), then the user's words. The UI shows only
  the words.
- **Cursor mock:** a Go goroutine emits Claude-shaped events: a fake `read_page` card, then a
  streamed reply saying it is a mock. One reducer (`web/src/chat.ts`) renders both agents. The
  real integration would translate ACP events into the same item model.

## Verified by running it

A headless Chrome run (Playwright) with real Claude on Haiku did the following:

1. It created a chat and asked for "a 3-tier web architecture".
   - Claude called `read_page`, then one `apply`, and drew Browser → API Server → Postgres with
     labelled arrows.
   - The orange change outline and the working pill showed during the edit.
2. It asked Claude to "Delete the Postgres box."
   - The approval card appeared, and the box was outlined red on the canvas.
   - Clicking Delete removed the box and its arrow, and Claude confirmed.
3. It opened a Cursor chat. The mock streamed its reply and showed its tool card.

Fixes made during that run:

- **Overlapping arrows.** Claude first drew two overlapping arrows for request and response. The
  prompt now asks for one arrow per relationship.
- **Orphaned arrow label.** A cascade delete left the arrow's label on the board. It is now
  removed.
- **Your own shapes could not be edited** (`15bc981`, found by the user).
  - `read_page` printed ids cut to 8 characters, as the skill's formatter does.
  - Elements the agent creates have keys, but shapes you draw only have ids. The agent sent the
    short ids back, and they matched nothing.
  - Full ids are printed now, and a unique id prefix in any ref is expanded as a fallback.
  - Re-tested: a rectangle and an ellipse were drawn by mouse. Claude filled and labelled the
    rectangle, and deleted the ellipse after approval.

Cost was about $0.03 for the Claude chat.

Variant 2 was verified the same way (headless Chrome, real Claude, Sonnet 5 · Medium):

- Model Haiku → Sonnet and effort → Medium each replaced the warm process; one `claude` process
  was left.
- The chip locked on the first send, and the context meter read 3.8k / 1M.
- "Delete the Process box" ran with no approval card and showed the Removed outline.
- Rename, a second (Cursor) chat, and collapsing to the icon rail all worked.

Fixes found while testing variant 2:

- `chat_updated` carries the chat object, not its id, so the store ignored it and the model chip
  never changed.
- The title model wrote a diagram after the title. Only its first line is used now, with a
  stricter prompt.

Variant 4 was verified the same way (headless Chrome, real Claude on Haiku, a separate server on
:4749):

- A group "Research" was made. A plain chat started in it was asked whether it had any tools
  containing "board". It answered "No". It was auto-named "Tools containing board", and its context
  started at 32k.
- A whiteboard was made in the group and renamed to `arch` inline, so the file became
  `arch.excalidraw`. A board chat on it drew Client → Server with one `apply` (+3), and the canvas
  showed it live beside the left panel.
- Switching back to the plain chat, then clicking `arch`, reopened that board chat.
- The loose `untitled` board was dragged into Research, and `.layout.json` recorded it.

Found while testing variant 4:

- **A board tool call goes to every open tab, and the fastest answer wins.**
  - The user had my test server open in a second browser. My headless tab answered some of their
    agent's calls with its own state, so they got `NO_PAGE` errors and one drawing landed on the
    wrong board.
  - This was already true before variant 4. It shows up more now that each tab has its own
    selection.
  - Not fixed yet. The fix is to send an `rpc` only to the tab that sent the chat's last message,
    or to one tab chosen as the editor.
- Page lists now sync between tabs: the server broadcasts `pages_changed` on create and rename.

## Answer

*Pending: the user has not yet chosen a variant.*
