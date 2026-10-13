# Remote servers as sections of the sidebar

A goal document for changing how a remote server shows in the app: each remote server becomes a fixed
section of the sidebar that shows everything on that machine, and the local machine keeps nothing of a
remote chat, board or run. Nothing in it is built yet. It says what is built, what is expected at the end,
and the decisions and bounds the work has to keep. It does not say how to build it: no files, no functions,
no steps and no order of work.

The same change is drawn on the whiteboard "change-how-remote-server-shows".

## How to read this

**Marks.** A decision, bound or risk carries one mark:

- `[user]`: the user decided it.
- `[proposed]`: proposed while the change was planned. Not a decision of the user.
- `[not verified]`: a stated risk or an assumption nobody has checked yet.

A statement in section 3 with no mark is `[proposed]`.

**Terms.**

- **Local server**: the server on the user's own machine, the one the page talks to.
- **Remote server**: an AI Whiteboard server on another machine, an entry of the server list.
- **Owner**: whoever uses a remote server on its own machine, through that server's own page.
- **Client**: a local server that is connected to a remote server. One remote server can have several.
- **Page**: the web client as the local server serves it, in a browser tab or in the desktop app.
- **Tree**: the groups of a server with the boards, runs and chats in them, and what is in no group.
- **Section**: the part of the sidebar that stands for one remote server.
- **Local part**: the part of the sidebar above the sections, with what lives on the local server.
- **Record**: what the local server keeps on disk today of a chat, board or run that is on a remote
  server: its last view, its place in the local groups and its archive mark. Records go away.
- **Group "Remote"**: the group a remote server puts everything in today that a client makes. It goes away.
- **Move**: the one-time carrying over, built with images in the composer, of chats and drafts the local
  server still held for a remote server.

## 1. Goal

Today a chat, board or run on a remote server is filed in the user's own groups, next to local things, with
its server's name after the row. The local server keeps a record of each, shows the last view while that
server is away, and reaches only what it made itself. On the remote server those things sit in the group
"Remote".

The goal is that a remote server is one place in the sidebar: a fixed section under the local part that
shows that machine's whole tree, the same tree to its owner and to every client, and nothing when the
server is not connected. The local server stores nothing of it. What the user arranges inside a section is
arranged on that server, for everyone.

## 2. What the user gets

1. The local part holds only what lives on this computer. No row in it names a server.
2. Each server of the server list has a section below the local part, with the server's name and its state.
3. A connected section shows that machine's tree: its groups, boards, runs and chats, whoever made them.
4. A section collapses and expands. It cannot be renamed, moved, deleted or dragged into as a group can.
5. A section of a server that is not connected says so and shows nothing else.
6. Something new made inside a section is made on that server. No question asks where it should live.
7. Groups inside a section are made, renamed, moved and deleted from the client, as the owner does it.
8. A chat that is open when its server drops stays on screen, read-only, under a warning.
9. A whiteboard that is open when its server drops can still be drawn on, as today.
10. The owner of a remote server sees no group "Remote": what a client makes is in the group it was made in.

## 3. What is expected at the end

### 3.1 The sidebar

- The local part is the tree of the local server: its loose items, its groups and "New group". Nothing of a
  remote server is in it, and no local group can hold something of a remote server.
- Below the local part comes one section per entry of the server list, in the order of the list. With no
  entry there is no section and the sidebar looks as it does with no remote server today.
- The sections scroll with the tree. The foot of the sidebar is unchanged, **Servers** included, which
  stays the one place where a server is added, edited, tested and removed.
- The "+" of the sidebar's head makes local things only.
- **Show archived** is one switch for the local part and every section.
- A row inside a section carries no server name: the section says it.

### 3.2 A section

- **The head** shows the server's name as the server list has it, and its state.
- **States.** Connecting, connected, not connected, too old, and whatever other state the server list
  shows for an entry (a changed certificate among them), with the words the server list uses.
- **Collapse.** A click on the head collapses or expands the section. This is the only thing the head has
  in common with a group.
- **Not a group.** A section has no rename, no archive, no delete and no menu of a group. It cannot be
  dragged, nothing can be dragged onto its head from elsewhere, and it is in no list of groups a row can be
  moved to.
- **"+" of the head**, shown while the server is connected: new chat, new whiteboard, new run and new
  group, each made on that server, outside any group.
- **Connecting.** Until the tree has come, the section says that it is connecting and shows no rows.
- **Empty.** A connected server with nothing on it says so in a line.

### 3.3 Inside a connected section

- The section shows that server's tree as that server has it: the same groups, nested the same way, in the
  same order, with the same boards, runs and chats in them, and the loose items first.
- Everything on that server is shown, whoever made it: the owner on that server's own page, this client, or
  another client. A row does not say who made it.
- The rows are the rows of the local part: a board with its chats, a run with its chats and agents, a chat
  with its line, its working mark and its draft mark, a group with its "+" and its menu. Each behaves as
  its local kind does, except for what makes no sense on another machine (revealing a file of that
  machine in this machine's file manager).
- A change made anywhere shows without a reload: a chat made by the owner or by another client appears, a
  rename, a move, an archive mark and a deletion are followed, and so is every change of a group.
- A chat, board or run opens in the same view as a local one, with the same composer, canvas and run view.

### 3.4 Making things

- A new chat, board, run or group made inside a section is made on that server at once, in the group it
  was made in, or outside any group from the section's head. It shows in every client's section and on the
  owner's page at once.
- A chat on a board or on a run of a section is on that server, as today.
- The question "Where should this live?" is no longer asked, for a chat or for a board `[user]`. Where
  a thing is made decides where it lives. The choice stays final: nothing moves between servers.
- A new run no longer follows the server its group used last: a group has one server, its own.
- **Defaults.** A new chat in a group of a section starts with what that server remembers for that group:
  agent, folder, model, effort and subagent settings. These are that server's own, the same for its owner
  and every client. The local server remembers none for a remote server.
- **A run** made in a section is on that server from the moment it is made, before it starts, with its
  goal and its settings `[user]`. Today such a run stays a draft of the local server until it starts.
- **Refusals.** A make that the server cannot take is refused with the server's reason and makes nothing,
  here or there. While the section is not connected there is nothing to make it from.
- **A make whose answer was lost.** If the thing was made, it shows in the section like anything else. No
  clean-up looks for it and nothing is deleted on its account.

### 3.5 Changing, moving, archiving, deleting

- **Groups.** A client makes, renames, moves, nests, archives and deletes the groups of a section, with the
  rules a local group has, deleting a group with everything in it among them `[user]`. The change is made
  on that server and holds for everyone.
- **Moving.** A board, run or chat is moved between the groups of its own section, by menu and by drag, as
  in the local part. Nothing is moved from one section to another, or between a section and the local
  part: such a drop is not offered.
- **Rename, archive, unarchive, delete** of a board, run or chat are made on its server and show for
  everyone. No mark is kept on the local server to be applied later: with the server not connected the row
  is not there, so nothing can be asked for.
- **Deleted elsewhere.** What is deleted on its server, by anyone, leaves every section at once. No greyed
  "gone" row stays behind. If it is open in a page, the view says that it is no longer on that server.

### 3.6 Several clients and the owner

- The owner and every client can open the same chat at the same time. Each sees the thread grow, the
  draft and the working state as the others change them.
- The draft of a branch is one draft for all of them, and its counter decides between writers as it does
  today between two windows: nobody replaces what another typed without being told.
- Anyone who has the chat open can send, stop, answer a permission request and change its settings, where
  the chat's own state allows it.
- One window draws on a board at a time, across the owner's windows and every client's. The take-over
  panel and "Use here" work as today.
- The chat of a run's agent stays read-only for everyone.

### 3.7 A server that is not connected

- Its section shows the state and one line that its chats show when the server is back `[user]`. No rows,
  no greyed rows, no last view.
- Nothing of that server can be opened, made, changed or deleted from the sidebar.
- After a restart of the local server, or a reload of the page, during the outage, nothing of that server
  is known until it connects.
- The app keeps trying the connection as today, and **Servers** still says at which step it fails.

### 3.8 What is open when its server drops

- **A chat** stays on screen as the page had it when the connection ended, read-only, under a warning that
  names the server and says that it is not connected `[user]`.
  - Nothing can be sent, stopped or changed, and the composer says why.
  - Text that was typed and not yet taken by the server stays in the composer and is saved when the server
    is connected again, if the chat is still open then `[user]`. Today the browser keeps such text
    across a reload and a change of chat; that is given up with the rest of what is kept here.
  - Once the user leaves the chat it cannot be opened again until the server is back.
- **A run view** behaves as the chat does: shown as it was, read-only, under the same warning.
- **A whiteboard** stays open and can still be drawn on, as today: the changes stay in that window under
  the banner that they are not saved `[user]`. A board that is not open in a window cannot be opened.
- The row of what is open is gone from the sidebar with the rest of the section. The view does not close
  for that.

### 3.9 When the server is back

- The section shows that server's tree again, as it is now.
- An open chat or run view is brought level with its server, the warning goes, and the composer works
  again. If the thing was deleted meanwhile, the view says so.
- An open whiteboard saves its changes if nobody changed the board there meanwhile. If somebody did, they
  are dropped with the notice of today.

### 3.10 A server that is too old

- This change raises the feature level a server reports by one. The app connects to no server below it, as
  it connects to none below the current one today.
- The section of such a server says that it is too old and that the server on that machine must be
  updated, with the version it reports, and shows nothing else.
- Once that server is updated the entry connects by itself, as today.

### 3.11 The remote server's own page

- There is no group "Remote" `[user]`. What a client makes is in the group of that server it was made in,
  or in no group.
- The owner's page is the page it is today in everything else. It shows the same tree its clients see.
- Whether a group is shown collapsed on the owner's page stays that server's own matter and is not what a
  client's section shows (3.13).
- A section on the owner's page, for a server that machine is itself a client of, is not part of that
  machine's tree and is shown to none of its clients.

### 3.12 What the local server keeps

- On disk: the server list, as today, and nothing else of a remote server `[user]`. No record of a chat,
  board or run, no last view, no draft, no image, no place in a group, no archive mark, no memory of
  makes, and no remembered choice per group and server.
- In memory: whatever it needs while a server is connected, and what an open whiteboard needs to go on
  through an outage. A restart loses it.
- Removing an entry from the server list takes its section away and tells that server nothing. Everything
  stays there. The question before the removal says so and no longer counts chats.

### 3.13 Collapse

- Whether a section is collapsed, and whether each group inside it is, is kept in the browser's storage,
  per browser, as the sidebar's width is `[user]`. It survives a reload and a restart.
- It is never sent to the remote server and is not taken from it: one client collapsing a group changes
  nothing for the owner or another client.
- A group that is new to the page shows expanded. A collapsed section of a server that is not connected
  stays collapsed.
- The collapse of a local group is unchanged.

### 3.14 Changing over what exists

**On a remote server, when it is updated.**

- The group "Remote" is removed, and what is in it goes to no group `[user]`. That holds for its chats,
  and for the boards and runs in it `[user]`. A chat on a board or on a run stays there.
- Everything that server has becomes visible to every client that connects.

**On the local machine, when the app is updated.**

- The records of chats, boards and runs on remote servers are removed. The things themselves are untouched
  on their servers and show in their sections once the server is updated and connects.
- The place those things had in the user's own groups is lost. A local group that held only such things
  stays, empty, for the user to delete.
- The memory of makes is dropped. Nothing is deleted on any server because of it.
- What the app remembered per group and server for new chats is dropped.
- An archive mark that was set here while the server was away and not yet applied there is dropped.
- **What the move had not carried over yet.** A chat that never had a message and is still kept here
  becomes a chat of this computer, with its draft, as it does today when its server is removed from the
  list. A draft kept with the record of a started chat, not yet carried over, is lost `[user]`.
- **An unstarted run** that named a remote server stays in the local part as an unstarted run of this
  computer, with its goal `[user]`.
- The move itself, and everything that exists only for it, is removed.

## 4. Decisions

| # | Decision | Mark |
|---|---|---|
| D1 | The local machine stores nothing of what is on a remote server. | `[user]` |
| D2 | Each remote server shows as a fixed, collapsible section at the top level of the sidebar. It is not a group. | `[user]` |
| D3 | Every client sees all chats of that machine, not only the ones it made. | `[user]` |
| D4 | The same holds for that machine's boards and runs: a section is its whole tree. | `[user]` |
| D5 | A section of a server that is not connected shows that message and nothing else. | `[user]` |
| D6 | A remote server has no group "Remote". | `[user]` |
| D7 | A client may make, rename, move and delete that machine's groups. | `[user]` |
| D8 | Whoever has the secret reads and writes everything on that machine, the owner's own chats too. | `[user]` |
| D9 | A chat that is open when its server drops stays on screen, read-only from the page's memory, with a clear warning. | `[user]` |
| D10 | A whiteboard keeps today's behaviour in an outage if that is easy to keep. If it is not, it becomes read-only from memory, as a chat. | `[user]` |
| D11 | What is in "Remote" today goes to no group. | `[user]` |
| D12 | Collapse is kept in the browser's storage. | `[user]` |
| D13 | Collapse inside a section is never sent to the server, for the section and for its groups. | `[user]` |
| D14 | Where a thing is made decides where it lives. The question about the place goes away for chats and boards. | `[user]` |
| D15 | The defaults of a group in a section are that server's, shared by all who use it. | `[user]` |
| D16 | A run made in a section is on that server before it starts, as everything else made there. | `[user]` |
| D17 | A row does not say who made it. | `[user]` |
| D18 | A section shows what lives on that machine, never that machine's own sections. | `[user]` |
| D19 | The app connects to no server below the new feature level. | `[user]` |
| D20 | Sections are in the order of the server list. | `[user]` |
| D21 | Unsent text of an open chat survives an outage only in the open page. | `[user]` |
| D22 | A draft the move had not carried over for a started chat is lost at the update. | `[user]` |

## 5. Bounds

**The sidebar.**

- **One tree, drawn once.** The rows inside a section are the rows of the local part: the same board row,
  run row, chat row and group node, with the same menus, marks, rename and drag. A section is not a second
  sidebar built beside the first.
- **A section is not a group anywhere.** No group stored on any machine stands for a server, and no
  server's tree holds a group that is one.
- **The views are the local ones.** The chat view, the composer, the canvas and the run view are the ones a
  local chat, board and run use. The warning of 3.8 and the read-only state are added to them, not a view
  of their own.
- **What exists is reused.** The take-over panel and the "not saved" banner of a remote board, the words
  the server list has for a state, and the sentence for a server that is too old.
- **The server list stays where it is.** Sections add, edit and remove no server.

**Between the machines.**

- **The page talks to the local server only.** It never reaches a remote server by itself, and no secret
  reaches the page.
- **One connection per entry** carries everything of that server, as today.
- **Nothing on disk.** After this change the local server's data folder holds the server list and nothing
  else of a remote server. The browser's storage holds the collapse of 3.13 and what it holds today for
  any chat, and no content of a remote server.
- **An id is unique on one server only.** What is on a remote server was made by many machines. Nothing may
  assume that an id seen in one section, or in the local part, is not used in another.
- **No chain.** A remote server never passes a client's call on to a third server.
- **What a client cannot reach** on a remote server: its server list and the secrets in it, its settings,
  its restart and update, and its data folder as files.
- **All or nothing.** The secret gives everything of 3.3 to 3.6. No mark of who made a thing decides who
  sees or changes it.
- **The draft counter decides between writers**, and the counter a page is shown never goes down.
- **One drawer per board.** To a remote server a local server is one user of a board, whatever the number
  of its windows.
- **An image of a remote chat** is served by the local server under its own headers, from the bytes
  alone, as today. No remote server can have the local server serve HTML or SVG.
- **Every call has a defined answer** for a thing in a section: when its server is connected, not
  connected, too old, and when the thing is gone there. None is left to fall through.

**What goes away is removed**, not left unused: the records, the memory of makes, the move, the group
"Remote", the greyed and "gone" rows, the server's name after a row, the question about the place of a
chat or a board, and the choices remembered per group and server.

**Waits.** The time a call between servers may take and the time a too-old entry waits before it is asked
again are production values. Each can be lowered by a test and keeps its value otherwise.

**The README says what is true at the end.** Its parts on chats and whiteboards on a remote server and on
what a client does on a server are rewritten, and the part on the move is taken out.

**Tests follow `AGENTS.md`.** No paid test is run unless the user asks.

## 6. Consequences to know

Each follows from a decision above and is accepted.

- **Everyone with the secret has the whole machine's chats.** They read every thread and every unsent
  draft, send in any chat, answer a permission request of an agent somebody else started, and delete
  anything. Follows from D8.
- **A deleted group is deleted for everyone**, with everything in it. Follows from D7.
- **Nothing of a remote server can be read while it is away**, except what is already open. Today the last
  view of every chat opens. Follows from D1 and D5.
- **The user's own filing of remote things is gone.** A chat can no longer sit in a local group next to
  local work. It sits where it is on its server, and the user's arrangement there is everyone's.
  Follows from D1 and D2.
- **A section can be large.** It holds everything a busy machine has, not the handful the user made.
- **A restart or a reload during an outage** leaves a chat that was open closed until the server is back.
  Follows from D1.
- **Unsent text typed during the last moments before a drop** is lost if the page is closed or the chat is
  left before the server is back. Follows from D21.
- **A make whose answer was lost** can leave an empty chat on that server, visible to all, until somebody
  deletes it. Today the app deletes it. Follows from D1.
- **An unstarted run shows on its server**, to its owner and every client, with its goal. Follows from D16.
- **The choices a new chat starts with are shared.** What one user picked last in a group is what the next
  user of that group starts with. Follows from D15.
- **Collapse differs per browser.** A browser tab and the desktop app each have their own, and clearing
  the browser's storage opens everything. Follows from D12.

## 7. How it is checked

**By tests.** Every statement of section 3 and every bound of section 5 that a test can show has one. Among
them, because they are easy to get wrong:

- two clients and the owner on one server: each sees what the others make, rename, move, archive and
  delete, without a reload, for chats, boards, runs and groups;
- a client sees what the owner made, and what another client made;
- every group action from a client, and that the owner's page follows it;
- a drop from one section into another, and between a section and the local part, is not taken;
- a section in each state: connecting, connected and empty, not connected, too old;
- a server that drops with a chat open, with a run view open, and with a board open and changed; and each
  when the server comes back, with the thing unchanged, changed and deleted there;
- after an update of the app, no file of a remote chat, board or run is left in the data folder, and none
  is written afterwards;
- after an update of a remote server, there is no group "Remote" and what was in it is in no group;
- each case of 3.14 on the local machine;
- two things with the same id, one local and one in a section, are told apart everywhere a page or the
  local server names one;
- a client cannot reach what the bounds keep from it;
- collapse of a section and of a group in it survives a reload and is sent nowhere;
- two writers in one draft, from two clients.

Code where several things happen at once (several clients on one server, a server that drops in the middle
of a call) is also run under the race detector.

**By hand**, with two machines and two apps on one server:

- the sidebar as a whole: local part, a connected section, a collapsed one and one that is not connected;
- pulling the network with a chat open, and with a board open and drawn on;
- the same chat open in both apps and on the owner's page while an agent works in it.

## 8. Risks and what is not verified

| # | What | Mark |
|---|---|---|
| V1 | A whiteboard through an outage needs no record on disk, since its drawing is in the window's memory already. One case is not traced: the local server restarts during the outage while a window still holds unsaved changes. If that cannot be kept simply, D10 says the board becomes read-only. | `[not verified]` |
| V2 | An older app connected to an updated server expects only what it made, in a group "Remote". It must either be served as before or be refused with a reason. It must not be shown a tree it files wrongly. Which of the two is not decided. | `[not verified]` |
| V3 | A server with thousands of chats: the size of what a client is sent at the start, and the sidebar with that many rows. Today a client is sent only its own. | `[not verified]` |
| V4 | A run before it starts does not exist on a remote server today: a client makes and starts it in one step. D16 needs it to exist there unstarted. How much that is has not been looked at. | `[not verified]` |
| V5 | Ids that are the same on two servers. Today the local server makes the id of every remote thing it shows, so they never collide. What a page keys by id alone is not listed yet. | `[not verified]` |
| V6 | Things that today go to "the one client that made the chat": the answer to an agent's board tools, a permission request, a notice. With several clients each needs a rule for who gets it. The board tools keep theirs (the window that holds the board). | `[not verified]` |
| V7 | Whether the owner has put things of their own into the group "Remote", or renamed it. They go to no group with the rest. | `[not verified]` |

## 9. Not in this goal

- Limits per client: a read-only client, a client that sees only some groups, hiding the owner's chats.
- Showing who made a chat, a board or a run.
- Reading a remote chat while its server is away, other than one that is open.
- Moving a chat, board or run between servers, or between a server and this computer.
- Showing a remote server's own remote servers.
- Ordering the sections by drag.
- Two people drawing on one board at the same time.
- Keeping an older remote server usable without this change.
- The prompt library, which already shows one entry per server.
- Search across servers.
