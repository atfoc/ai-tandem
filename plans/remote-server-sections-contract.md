# Remote servers as sections: the contract between the three parts

The goal `plans/remote-server-sections-goal.md` is built by three agents in parallel, each in its own
worktree. This file fixes what they need so that their work fits together without talking:

- **A**, the remote server's side: what a server offers its clients on the remote port.
- **B**, the local server's side: being a client of a remote server, and what it gives the page.
- **C**, the page (`web/`).

It fixes four things: the wire between a local and a remote server (section 2), the API between the
page and the local server (section 3), who owns which files (section 4), and a decision for each open
point of the goal's section 8 (section 1). It does not say how each part is built inside.

## How to read this

- **The base** is the branch `composer-image-support` at the commit that adds this file. All three
  branches start there.
- **Marks.** `[contract]` marks a decision made here, while the contract was written. It is not a
  decision of the user. A statement with no mark follows from the goal or describes today's code.
- **"As today"** means: the code at the base does this, and it stays. The place is named, not
  described again.
- **"As for its own page"** means: the remote server answers the call exactly as it answers the same
  call on its own port, with the same handler: status, body, code and sentence.
- **Terms** are the goal's. **Entry id** is the id of an entry of the server list (`s_` and 12 hex
  digits, `servers[].id`). **Tree** is a server's groups, boards, chats, runs and defaults.
- Nobody edits this file while the work runs. An agent that finds it wrong or incomplete says so in
  its report, names the place, and says what it did instead.

## 1. Decisions on the open points (goal, section 8)

| # | Decision | Mark |
|---|---|---|
| V1 | **A whiteboard keeps today's behaviour through an outage, with no record.** The window holds the drawing and the revision it is based on. The local server holds, in memory only, which of its pages holds the board. While the board's server is not connected a save is answered 503 and the window keeps the edit under the banner. When the server is back, the local server takes the board there again for the page that holds it, and the `held` event with that server's revision saves the edit or drops it, as today. **A restart of the local server during the outage** loses only the memory of who holds the board: the window still has the drawing and its revision, asks for the board itself when the section's tree arrives, and the same revision rule decides. Nothing is written to disk for it. Details in 3.6. | `[contract]` |
| V2 | **An older app is refused, with a reason.** A client states its level in a header on every request. A server of the new level answers every route but hello with 400 `client_too_old` to a client that states none or one below 5. Nothing of the tree reaches it. The app of before cannot show that sentence: its entry shows "The server's event stream did not open" and tries again. The sentence is in the answer and, once a minute per address, in the server's log. Details in 2.1. | `[contract]` |
| V3 | **The tree is sent whole.** A client gets every group, board, chat, branch state and run of the server in one snapshot, archived ones included, as that server's own page does. There is no paging and no filter. A snapshot is at most 32 MB (`maxState` of `internal/servers`, as today); a larger one ends the attempt as a state that could not be read. The page draws no row of a collapsed section or of a collapsed group. Nothing was measured: see section 5. | `[contract]` |
| V4 | **A run that has not started is served to clients by the routes the server's own page uses**: `POST /api/runs`, `PATCH /api/runs/{id}`, `PUT /api/runs/{id}/draft` and `POST /api/runs/{id}/start` join the remote port's table. The start call (`PUT /api/runs/{id}`) and the draft check (`GET /api/runs/check`) go away: the run's own view says what the check said (`git`, `dirty`, `blocked`, `folderMissing`, `tierDefaults`). The goal being typed has no counter: the last save wins, as between two windows today. | `[contract]` |
| V5 | **A thing is named by two values, the entry id and its id on that server.** On the wire they are never joined: the entry id is a path segment (`/api/on/{server}/…`) or the top-level field `server` of an event, and every id in a path, a body or an event is that server's own. The local part has no `server`. Inside, the local server keys its follows, its board holds and its tool calls by both. What the page keys by id alone today is listed in 3.10; the page must key all of it by both (the group id `__ungrouped__` and the branch id `main` are the same on every server). | `[contract]` |
| V6 | **Nothing goes to "the client that made the thing" any more.** List events go to every client and every page. Content events go to whoever follows the thing. A permission request is an item of the chat's thread: every follower gets it, anyone answers, the first answer decides, a later one gets that server's refusal. A board tool call goes to the holder of the board, as today. The full rules are in 2.7. | `[contract]` |
| V7 | **The group that is removed is the one `state.json` remembers as `remoteGroup`**, whatever its name is now and whoever put things in it. Its boards, runs and chats go to no group and keep their own archive marks. Groups nested in it go to the top level with what is in them. A group that is merely named "Remote" is an ordinary group and stays. It is done once, at the first start of the updated server; `remoteGroup` is cleared after it. Details in 2.8. | `[contract]` |

## 2. The wire between a local server and a remote server (level 5)

A serves it. B calls it. Everything is on the remote listener, behind the checks of
`internal/server/remote.go` (`RemoteHandler`): secret, Host, client id. Those stay as today.

### 2.1 Levels and the older app

- `GET /api/hello` answers `"featureLevel": 5` (`server.FeatureLevel`). Its other fields are as today.
- A client connects to no server below 5 (`servers.MinFeatureLevel = 5`). Such an entry is `too_old`,
  as today.
- **New header `X-AIWB-Level`.** A client sends `X-AIWB-Level: 5` on every request to a remote
  server: hello, state, the stream, every call, and every request of a connection test.
- **New check** in `RemoteHandler`, after the client id check and before the route table: on every
  route but `GET /api/hello`, the header must hold an integer of 5 or more. Otherwise:

  ```
  400 {"error": "This app is too old for this server: update AI Whiteboard on the machine that connects.",
       "code": "client_too_old"}
  ```

  It is logged like a refused request (one line per source address per minute). Hello stays open to
  every app that has the secret, so an older app still shows the server's version.
- Each side keeps the header's name in a constant of its own: A in `internal/server/remote.go`
  (`LevelHeader`, `MinClientLevel`), B in `internal/servers/outcome.go` (`LevelHeader`,
  `ClientLevel`). Neither adds it to `internal/remote`.

### 2.2 The rule

**At level 5 a client is served as the server's own page**, with these differences and no others:

1. It reaches only the routes of the table in 2.3. Every other route is 404 `{"error":"not found"}`.
2. Its snapshot and its events are the ones of 2.5 and 2.6.
3. The refusals of 2.4 that exist for a client alone (`server_refused`, `collapsed_refused`,
   `replace_refused`, the 32 MB limit of a drawing, the app's own folder in `GET /api/dirs`).
4. No write needs an open stream (no known-client rule), as today.

**The client mark decides nothing.** No route, no list, no event and no default looks at which client
made a thing (`Client` of a chat, a board and a run; `Origin` of a board). After A's change-over (2.8)
no chat, board or run of the server carries a mark in memory, and nothing sets one.

### 2.3 The table of routes

`same`: as today on the remote port. `page`: served as for the server's own page from now on, where
today it was limited to what the client made, or was missing. `gone`: taken out of the table and
answered 404.

| Route | At level 5 |
|---|---|
| `GET /api/hello` | same, `featureLevel` 5 |
| `GET /api/events` | same call; snapshot and events of 2.5 and 2.6 |
| `GET /api/state` | same call; the snapshot of 2.5 |
| `POST /api/groups` | **new**, page |
| `PATCH /api/groups/{id}` | **new**, page; `collapsed` refused (2.4) |
| `POST /api/groups/{id}/move` | **new**, page |
| `DELETE /api/groups/{id}?contents=delete\|keep` | **new**, page |
| `POST /api/groups/{id}/archive`, `…/unarchive` | **new**, page |
| `POST /api/chats` | **changes**: the page's call (2.4). The creation call with `text` is gone |
| `PUT /api/chats/{id}` (the make) | **gone** |
| `GET /api/chats/{id}`, `…/items`, `…/tree`, `…/context`, `…/subagents/{sid}/items` | same |
| `PATCH /api/chats/{id}` | page: `group` is taken; `server` refused as today |
| `POST /api/chats/{id}/messages`, `…/interrupt`, `…/permission`, `…/open` | same |
| `PUT /api/chats/{id}/label` | same |
| `PUT /api/chats/{id}/draft?rev=N` | same |
| `PUT /api/chats/{id}/draft?replace=N` | **gone**: refused on both listeners (2.4) |
| `POST /api/chats/{id}/images`, `GET /api/chats/{id}/images/{image}` | same |
| `POST /api/chats/{id}/fork` | page: on any board (no `board_refused`) |
| `POST /api/chats/{id}/archive`, `…/unarchive`, `DELETE /api/chats/{id}`, `POST …/unfollow` | same |
| `GET /api/dirs`, `GET /api/usage/{agent}` | same |
| `POST /api/runs` | **new**, page (V4) |
| `PUT /api/runs/{id}` (the start call), `GET /api/runs/check` | **gone** |
| `GET /api/runs/{id}` | same |
| `PATCH /api/runs/{id}` | page: the whole patch, not the name alone; `server` refused (2.4) |
| `PUT /api/runs/{id}/draft`, `POST /api/runs/{id}/start` | **new**, page (V4) |
| `POST /api/runs/{id}/stop`, `…/resume`, `…/apply`, `GET …/delivery`, `DELETE /api/runs/{id}` | same |
| `GET /api/runs/{id}/detail`, `…/goal`, `…/tasks/{tid}/brief`, `…/tasks/{tid}/attempts/{n}/report`, `…/attempts/{n}/changes`, `…/notes/{v}` | same |
| `POST /api/runs/{id}/archive`, `…/unarchive`, `…/unfollow` | same |
| `POST /api/boards` | **new**, page: the caller holds the new board if it is free, as a page does |
| `PUT /api/boards/{id}` (a client's creation) | **gone** |
| `GET /api/boards/{id}/scene`, `PUT …/scene`, `POST …/take`, `…/release`, `…/rename`, `…/archive`, `…/unarchive`, `…/seen`, `DELETE /api/boards/{id}` | page: for every board of the server, not only the client's own |
| `PATCH /api/boards/{id}` | **new**, page (`group`) |
| `POST /api/rpc-reply` | same |
| `GET /api/library` and the six library routes | same |

Not in the table, so 404 for a client, as today: `PUT /api/groups/order`, `POST /api/boards/{id}/reveal`,
`POST /api/restart`, `GET /api/remote/status`, `GET /api/mcp/status`, `POST /api/client/flushed`,
every route under `/api/servers` and under `/api/on` (3.4), and the client files. This is what a client
cannot reach (goal, section 5): the server list and its secrets, the settings, restart and update, and
the data folder as files. `GET /api/dirs` still refuses the app's own folder and the folder of the runs'
checkouts to a client, as today. No remote server passes a client's call on to a third server.

### 2.4 The calls that are new or change

Where nothing else is said, request, answer and refusals are those of the same call on the server's
own port.

**`POST /api/chats`**: a new chat that has not started.

- Body: `{"id"?, "agent"?, "group" | "board" | "run"}`. `group` is a group id or `__ungrouped__`.
  `id` is a lowercase version 4 UUID of the caller's making, or absent. Other fields are ignored.
- The chat starts with what the server remembers for its place: agent, folder, model, effort and
  subagent settings (goal D15). It feeds those choices as any chat of that server does.
- Answer: 200, the chat (`ChatView`), `locked` false.
- A body that names `server` (any value) is refused: 400 `server_refused`, nothing is made.
- The first message is `POST /api/chats/{id}/messages`, as today.

**`POST /api/boards`**: body `{"name", "group", "new"?}`, answer 200 the board. The server gives the
caller the board if it is free, as it does for a page. A `server` in the body: 400 `server_refused`.

**`POST /api/runs`**: body `{"group", "name"}`, answer 200 the run's view, `status` `draft`.
**`PATCH /api/runs/{id}`**: the page's patch (`name`, `group`, `agent`, `tiers`, `cwd`, `settings`);
a `server` in the body: 400 `server_refused`, nothing is changed. The code `rename_only` is gone.
**`PUT /api/runs/{id}/draft`**: the goal being typed. **`POST /api/runs/{id}/start`**: body `{"goal"}`,
answer the run's view.

**Groups.** `POST /api/groups` body `{"name", "parent"}`, answer the group. `PATCH /api/groups/{id}`
body `{"name"}`; a body that has the key `collapsed`, whatever its value: 400 `collapsed_refused`,
nothing is changed. `POST /api/groups/{id}/move` body `{"parent", "before"}`.
`DELETE /api/groups/{id}?contents=delete|keep`. `POST /api/groups/{id}/archive` and `…/unarchive`.
The rules are the local group's: nesting, an archived parent, a group inside itself, deleting with
everything in it.

**`PUT /api/chats/{id}/draft?replace=N`** is refused on both listeners: 400 `replace_refused`,
nothing is stored. `draftReplaced` of a `chat.json` is no longer read or written.

**The code `not_found`** `[contract]`. On both listeners, a 404 whose cause is that the chat, the
run, the board or the group the call names is not there carries `"code": "not_found"`
(`chats.ErrNotFound`, `runs.ErrNotFound`, `boards.ErrNotFound`, `app.ErrGroupNotFound`,
`runs.ErrGroup`). Every other 404 keeps what it has (`no_branch`, a subagent, an image, a task, an
attempt, a notes version: no code, or their own). A board that exists is never answered "no such
board" to a client any more. This code is how a client and a page tell "the thing is gone" from "a
part of it is missing".

**Codes that exist for a client alone at level 5:** `client_too_old`, `bad_client`, `own_client`,
`server_refused`, `collapsed_refused`, `replace_refused`, `too_large` (a drawing over 32 MB).
**Gone with their calls:** `group_refused`, `board_refused`, `rename_only`, and the answers of the
creation call, of the make and of the start call (`started`, `sent`, `made`, `id_taken`, `blocked`
as their codes).

### 2.5 The snapshot

`GET /api/state` on the remote port, and the `snapshot` event of a client's stream (its fields inline,
as today):

```
{
  "agents":     [AgentKind],            as today
  "catalogs":   {agent: Catalog|null},  as today
  "home":       string,                 as today
  "defaultCwd": string,                 as today
  "library":    LibraryTree|null,       as today
  "groups":     [Group],                new: every group, in the server's order, with its archive mark
  "defaults":   Defaults,               new: what the server remembers per group
  "boards":     [Board],                changes: every board
  "chats":      [ChatView],             changes: every chat the server's own page lists
  "states":     [BranchState],          changes: one per branch of those chats
  "runs":       [RunView]               changes: every run, the ones that have not started too
}
```

- The lists are what the server's own page gets in its snapshot for the same fields, archived things
  included. A run agent's chat is in no list, as today.
- Never in it: the server's own server list, the lists and libraries of the servers it connects to,
  its sections, `dataDir`. A section of that machine is not part of its tree (goal 3.11).
- `groups[].collapsed` may be present: it is that server's own matter. The client drops it (3.2).
- `defaults.groups[<group id>].servers.local` is what a new chat or run in that group starts with.
  `local` there means that server.
- `agents`, `catalogs`, `home` and `defaultCwd` must stay as they are: the connection and the
  connection test read them (`servers.listsOf`).

### 2.6 The events

A client's stream begins with `hello` and `snapshot`, as today. After that:

| Event | To | Change |
|---|---|---|
| `groups` `{groups}` | every client | **new** for a client: the whole list after every change of a group |
| `defaults` `{defaults}` | every client | **new** for a client |
| `board` `{board}`, `board_removed` `{id}` | every client | was: the client that made the board |
| `chat` `{chat}`, `chat_removed` `{id}`, `branch_state` `{state}` | every client | was: the client that made the chat |
| `run` `{run}`, `run_removed` `{id}` | every client | was: the client that made the run |
| `catalog`, `agents`, `own_library` | every client | same |
| `tree`, `chat_items`, `sub`, `sub_items`, `run_detail`, `run_activity` | the clients that follow the chat or the run | same |
| a run agent's `chat`, `branch_state` | the clients that follow that chat | same |
| `held`, `release_request`, `superseded`, `rpc`, `server_stopping` | the one client concerned | same |

- The shapes are the ones the server's own page gets. Nothing is added for a client.
- Every change of the tree, whoever made it (the owner's page, this client, another client, an agent),
  is told to every client by these events, in the order of the changes. A delete of a group with what
  is in it tells each removed thing and then `groups`, as it does for a page.
- A follow starts with a read (`…/items`, `…/tree`, `…/subagents/{sid}/items`, `…/detail`) and ends
  with `…/unfollow`, with the stream, or with the removal of the thing, as today.
- No page-only event reaches a client: `servers`, `server_state`, `server_lists`, `library`,
  `library_removed`, `section`.

### 2.7 The rules for several clients and the owner

1. **Lists.** Every client and every page of the server see the same tree and the same list events.
2. **A draft** is one per branch. A save names the counter it was typed on (`rev`); on another one it
   is refused 409 `stale` with the stored counter and draft. As today.
3. **A message** to a branch that works is refused 409 `busy`, whoever sent the one before.
4. **A permission request** is answered by whoever follows the chat. The first answer decides. A
   later one is refused as an answer to a request that is not open (400, as today).
5. **Settings before the first message**: the last change wins; `chat` and `branch_state` tell all.
6. **The current branch** (`POST …/open`) is one per chat: the last call wins, as between two windows
   today. Which branch a window shows is that window's matter.
7. **A board** has one holder among all pages and all clients. Take, release, `release_request`,
   `held` and `superseded` are as today. To the server a client is one user of the board, whatever
   the number of its windows. A holder that is a client has 10 s to hand over, a page 3 s, as today.
8. **A board tool call** (`rpc`) goes to the holder of the board; when nobody holds it, to the holder
   of the calling chat's board, who is given the board; else to the server's own page that acted last.
   It never falls to a client that holds nothing. As today.
9. **A board's "new" mark** is one per board: the first `seen` clears it for all.
10. **The chat of a run's agent** is read and followed, never written: 409, as today.
11. **The goal of a run that has not started**: no counter, the last save wins; `run` tells all.
12. **A new secret** ends every client's stream, as today.

### 2.8 The change-over on a remote server (A)

At the first start of the updated server, before it serves a request, once:

- **The group "Remote"** (V7): the group `state.json` names in `remoteGroup` is removed. A board, a
  run and a plain chat in it go to `__ungrouped__` and keep their own archive mark. A chat on a board
  or on a run stays there. A group nested in it goes to the top level, with what is in it. Then
  `remoteGroup` is cleared and never set again. `App.RemoteGroup` is removed.
- **The marks.** After every load, no chat, board or run has a client mark in memory, and nothing
  sets one (2.2). A does this where the things are loaded and at the edges it owns (4.2), not by
  rewriting the code of `internal/chats` and `internal/runs` that tests a mark.
- Everything the server has is visible to every client from then on.

## 3. The API between the page and the local server

B serves it. C calls it. All of it is on the local server's own port, behind `guard`, as today.

### 3.1 How a thing is named

- A thing of the local part is named as today: by its id, with the routes `/api/…` and events that
  have no `server`.
- A thing of a section is named by **the entry id and its id on that server**. The entry id is
  `servers[].id`. It is never the instance id and never a name.
- In a call the entry id is the path segment after `/api/on/`. In an event it is the top-level
  field `"server"`. Every id inside a path, a body or an event is that server's own id, unchanged.
- The page sends a remote server its own ids in everything a body holds: a draft's `mentions`, a
  message's `context` and `references`, a `group`, a `board`, a `run`, a fork's `branch`.
- `local` is not an entry of a section: `/api/on/local/…` is 404 `no_server`.

### 3.2 The snapshot

`GET /api/state` and the `snapshot` event:

- `groups`, `boards`, `chats`, `states`, `runs`, `defaults`: **the local server's own, and nothing
  else.** No object in them has `server`, `gone`, `unmoved`, `moveError`, `start` or `was`: these
  fields go away from the types. `defaults.groups[g]` has no sticky `server`, and its `servers` has
  the key `local` alone.
- `servers`, `lists`, `libraries`, `catalogs`, `agents`, `home`, `defaultCwd`, `dataDir`: as today.
  `lists[<entry id>]` is still what that server offers for a new chat or run (its agents, their
  catalogs, its home and default folder), from the connection, in memory.
- **New: `sections`**, an object by entry id, never null:

  ```
  "sections": {
    "<entry id>": {
      "groups":   [Group],        that server's, in its order; no "collapsed"
      "boards":   [Board],
      "chats":    [ChatView],
      "states":   [BranchState],
      "runs":     [RunView],
      "defaults": Defaults
    }
  }
  ```

  An entry has a key only while the local server holds its tree: its connection is up and its
  snapshot was read. For every other entry there is no key, whatever its state.
- The local server takes each list from that server's snapshot (2.5) and applies that server's events
  to it. It decodes with the types of `internal/model` and adds nothing. It drops `collapsed` from
  every group. It keeps the tree in memory only.

### 3.3 The events

**New: `section`.**

```
{"type": "section", "server": "<entry id>", "tree": {groups, boards, chats, states, runs, defaults}}
{"type": "section", "server": "<entry id>", "tree": null}
```

- With a tree: that server connected (the first time, or again) and this is its whole tree as it is
  now. It replaces what the page had for the entry. From here on the entry's calls work.
- With `null`: the local server holds no tree of the entry any more: the connection is no longer up,
  or the entry was removed. The section shows no rows from here on.
- It goes to every page. It takes the place of `server_back`: what a page did on `server_back` it
  does on a `section` with a tree.

**Events of a thing of a section** are the events of a local thing with one more top-level field,
`"server": "<entry id>"`. Without the field an event is about the local server.

| Event | With `server` it is |
|---|---|
| `groups` `{groups}` | that section's whole group list (no `collapsed`) |
| `defaults` `{defaults}` | that section's defaults |
| `board` `{board}`, `board_removed` `{id}` | a board of that section |
| `chat` `{chat}`, `chat_removed` `{id}`, `branch_state` `{state}` | a chat of that section |
| `run` `{run}`, `run_removed` `{id}` | a run of that section |
| `tree`, `chat_items`, `sub`, `sub_items` | a chat of that section, to the pages that follow it |
| `run_detail`, `run_activity` | a run of that section, to the pages that follow it |
| `held` `{board, rev}`, `release_request` `{board}`, `superseded` `{board}` | a board of that section, to the one page concerned |
| `rpc` `{id, method, params}` | a tool call of an agent on that server: every board id in `params` is that server's |

- The list events go to every page. Their order per section is that server's order.
- The local server sends an event with `server` only while it holds the entry's tree. A page drops
  one that names an entry it has no tree for.
- `server_state`, `servers`, `server_lists`, `library`, `library_removed`: as today. The order between
  `server_state` and `section` is not fixed: the page decides rows by the tree and words by the state
  (3.5).
- **Gone:** `server_back`, `chat_reload`, and `was` of a `run` event.

### 3.4 The routes of a section

```
/api/on/{server}/<the path of the same call for a local thing, after /api>
```

`POST /api/on/s_0123456789ab/chats/<id>/messages?branch=main` is the message call for a chat of that
section. Method, the rest of the path, query and body are those of the local call.

| Under `/api/on/{server}` | What the local server does |
|---|---|
| `POST /groups`, `PATCH /groups/{id}`, `POST /groups/{id}/move`, `DELETE /groups/{id}`, `POST /groups/{id}/archive\|unarchive` | passed on. A `PATCH` whose body has the key `collapsed` is refused here, 400 `collapsed_refused`, and nothing is sent |
| `POST /chats` | passed on |
| `GET /chats/{id}`, `GET /chats/{id}/context` | passed on |
| `GET /chats/{id}/items`, `…/tree`, `…/subagents/{sid}/items` | passed on; the page follows the chat from before the read (3.7) |
| `POST /chats/{id}/unfollow` | answered here (3.7) |
| `PATCH /chats/{id}`, `POST …/interrupt`, `…/permission`, `…/open`, `…/fork`, `…/archive`, `…/unarchive`, `PUT …/label`, `DELETE /chats/{id}` | passed on |
| `POST /chats/{id}/messages`, `PUT /chats/{id}/draft` | passed on, with the image ids checked for their form first, as today (`checkedImages`, `withMissing`); `?replace` refused 400 `replace_refused` |
| `POST /chats/{id}/images` | cut at the size limit unread (413 `image_too_large`), then passed on with its bytes, as today |
| `GET /chats/{id}/images/{image}` | fetched, and served under the local server's own headers from the bytes alone, as today (502 `bad_answer` for anything that is no image of the four types) |
| `POST /runs`, `GET /runs/{id}`, `PATCH /runs/{id}`, `PUT /runs/{id}/draft`, `POST /runs/{id}/start\|stop\|resume\|apply`, `GET /runs/{id}/delivery\|goal`, `…/tasks/{tid}/brief`, `…/tasks/{tid}/attempts/{n}/report\|changes`, `…/notes/{v}`, `POST /runs/{id}/archive\|unarchive`, `DELETE /runs/{id}` | passed on |
| `GET /runs/{id}/detail` | passed on; the page follows the run from before the read |
| `POST /runs/{id}/unfollow` | answered here |
| `POST /boards` | passed on; the page that made the board is given it here, as today |
| `POST /boards/{id}/take`, `…/release`, `GET /boards/{id}/scene`, `PUT /boards/{id}/scene` | 3.6 |
| `POST /boards/{id}/rename`, `…/archive`, `…/unarchive`, `…/seen`, `PATCH /boards/{id}`, `DELETE /boards/{id}` | passed on |
| `POST /boards/{id}/reveal` | refused here: 400 `not_here`, as today |
| anything else | 404 `{"error":"not found"}`, nothing is sent |

- **Passed on** means: sent to that server as it came (method, path after the prefix, query, body),
  and its answer handed to the page as it came, status and JSON body, with the three exceptions of
  3.5. The local server changes no id and reads no body but where the table says so.
- **Not under the prefix**, and as today: `GET /api/dirs?server=<entry id>` and
  `GET /api/usage/{agent}?server=<entry id>`; `POST /api/rpc-reply` (an id that starts with `far_`
  is a tool call the local server passed on); `/api/library/{server}/…`; `/api/servers…`.
- Every write under the prefix needs a known client, as every write on this port.
- **Time limits** between the two servers are those of `remotes.Limits` today: 15 s for a call; 45 s
  for a message, a fork, an open and a run's start; 60 s for a drawing and an image; 3 minutes for the
  delete of a run, and now also for the delete of a group with what is in it. A test lowers them
  through `AIWB_TEST_WAITS`, as today.

### 3.5 The answer of every call, by state

For every route of 3.4 but the ones noted:

| State | Answer |
|---|---|
| `{server}` is no entry of the list, or is `local` | 404 `no_server`, "This server is not in the list." Nothing is sent |
| The entry is not connected: `connecting`, `unreachable`, or any state that waits for the user | 503 `server_unreachable`, "*name* is not connected." Nothing is sent. An entry that waits for its next try is made to try now, as today |
| The entry is too old | 503 `server_unreachable`, "*name* is too old: update the server on that machine." Nothing is sent |
| Connected, and that server answers | **its answer, as it came**: status and JSON body, its codes and sentences |
| Connected, and the thing is gone there | that server's own answer: 404 with `"code": "not_found"` (2.4) |
| Connected, that server answers 401 | 503 `server_unreachable` (the secret is the entry's matter) |
| Connected, the answer is no JSON or is too long | 502 `bad_answer`, "*name* gave an answer that cannot be read." |
| Sent, and no answer came in time, or the connection ended | 504 `no_answer`, "*name* did not answer."; for `POST …/messages` 504 `send_unknown`, as today |

- The code `gone_there` is no longer sent `[contract]`: the page reads `not_found` on a call for the
  thing it shows as "no longer on that server".
- **The exceptions while the entry is not connected:** `POST …/unfollow` (chat and run) is 200
  `{"ok":true}`; `POST /boards/{id}/release` is 200 with `state` `free` or `none`;
  `POST /boards/{id}/reveal` is 400 `not_here` in every state. All others are the 503 above, the
  board's take, read and save too.
- A make that got no answer may still have made the thing. It then arrives in the tree by an event.
  Nothing looks for it and nothing is deleted (goal 3.4).

### 3.6 A board of a section

The rule is today's (`internal/remotes/boardhold.go`, `boardcall.go`): the local server alone decides
which of its pages holds the board, and keeps its own hold on the board's server equal to "a page
here holds it". Everything is keyed by the entry id and the board id.

- **`POST …/take`** body `{"ifFree"?}`, answer `{"state": "held"|"waiting"|"busy", "rev"?}`, as for a
  local board. While a page here holds the board the hand-over is decided here. Otherwise the take is
  made on the board's server for this server, and that server's `held` (with its revision),
  `waiting` or `busy` is the page's answer. That server's later `held` and `superseded` reach the page
  that asked, with `server`.
- **`POST …/release`**: `{"state": "handed"|"free"|"none"}`. When no page here holds the board any
  more, the local server lets it go there.
- **`GET …/scene`**: the drawing, with the revision in `X-AIWB-Scene-Rev`. **`PUT …/scene?rev=N`**:
  at most 32 MB (413 `too_large`); `stale` and `not_holder` as for a local board.
- **A tool call** of an agent on that server reaches the page that holds the board as `rpc` with
  `server` and an id that starts with `far_`. The page answers with `POST /api/rpc-reply`, as today.
- **During an outage** (V1): the page that holds the board keeps holding it here. A save is 503
  `server_unreachable`: the page keeps the edit and shows the banner. A take is 503: no other window
  gets the board, and a board that is not open cannot be opened.
- **When the server is back**: after the `section` event, the local server takes the board there
  again for the page that holds it here. `held` with that server's revision goes to that page, which
  saves its edit at the same revision and drops it, with today's notice, at another. When the board
  is held there by someone else, the page gets `superseded` and keeps the edit until "Use here", as
  today.
- **After a restart of the local server during the outage**: the page's new stream holds no board
  (`hello`). The page keeps the open board, its drawing and its revision in its own memory, does not
  close the view because the section has no tree, and asks for the board (`take`, if free) when the
  `section` event with a tree arrives. The same revision rule then saves or drops the edit.

### 3.7 Follows

- A read that follows (`…/items`, `…/tree`, `…/subagents/{sid}/items`, `…/detail`) makes the page a
  follower here, keyed by entry id and id, before it is passed on. The local server follows the thing
  on its server for all its pages together.
- `…/unfollow` ends the page's follow here and answers 200 `{"ok":true}`. When it was the last page,
  the local server ends its follow there.
- A follow ends when the entry's tree goes (`section` with `null`): that server has forgotten it with
  the stream. After a `section` with a tree, the page reads again what it shows; that read follows.

### 3.8 What changes on the local routes, and what goes away

- **The local routes serve local things only.** No call on `/api/chats/…`, `/api/boards/…`,
  `/api/runs/…` or `/api/groups/…` reaches another server, whatever the id. An id that is no local
  thing's is 404 `not_found`. `remoteFirst` and its four tables are removed.
- `POST /api/chats` and `POST /api/boards`: a body whose `server` is anything but absent or `local`
  is refused, 400 `server_refused`, and nothing is made. `PATCH /api/runs/{id}` the same.
  `PATCH /api/chats/{id}` with a `server` stays 409 `server_fixed`.
- `DELETE /api/chats/{id}`, `/api/boards/{id}`, `/api/runs/{id}` with `?local=1`: refused, 400
  `no_record`, nothing is deleted. There is no record to remove.
- `GET /api/servers/{id}/items` is removed (404). Removing an entry counts nothing.
- `DELETE /api/servers/{id}` removes the entry and tells that server nothing. The pages get `servers`,
  `server_lists` with `null`, `library_removed` (as today) and `section` with `null`.
- **Codes that are no longer sent by the local server:** `gone_there`, `not_moved`, `move_refused`,
  `image_remote`, `no_lists`, `remote_start`, `run_not_started`, `start_unconfirmed`,
  `server_unusable`, `runs_unsupported`, `run_has_chats`, `board_local`.
- **A local group holds local things only.** Archive, unarchive and delete of a local group reach
  nothing of another server.

### 3.9 The change-over on the local machine (B)

At the first start of the updated app, before a page is served (goal 3.14):

- The folder `remote/` of the data folder is removed with everything in it: the records of chats,
  boards and runs, their last views, their kept drafts and `makes.json`. Nothing is deleted on any
  server for it, and nothing is written there afterwards.
- A chat that never had a message and is still kept here for another server becomes a chat of this
  computer with its draft (`chats.Manager.ResetServer`, as when its entry is removed today).
- A run that has not started and named another server becomes a run of this computer that has not
  started, with its goal (`runs.Service.ResetServer`).
- In `state.json`, every group's defaults keep the key `local` alone, and the sticky `server` goes.
- An archive mark that waited for a server, and a draft kept with the record of a started chat, are
  gone with the records.
- The move, and everything that exists only for it, is removed (`remotes/move.go`,
  `server/movedraft.go`, `MoveSoon`, `MovePending`, the wait `move` of `AIWB_TEST_WAITS`).

### 3.10 What the page does with it (C)

These are the page's own, but the other two parts rely on them.

- **The section's head** takes its name and state from `servers`, in the order of `servers`, with the
  words of `logic/servers.ts`. **Its rows** are drawn from `sections[<entry id>]` and from nothing
  else. With no tree: `connecting`, or `connected` before the tree came, says that it is connecting;
  `too_old` says so with the version; every other state says its words and the one line of goal 3.7.
- **Keyed by id alone today, to be keyed by entry id and id** (V5): in `store.ts` the maps `boards`,
  `chats`, `runs`, `agents`, `agentErrors`, `runDetail`, `runErrors`, `runStarts`, `items`, `subs`,
  `states`, `trees`, `moves`, `shown`, `threadErrors`, `waits`, `busyOn`, `roles`, `dropped`,
  `sceneGen`, `outage`, and `sel`, `subDrawer`, `runAgent`, `treeNav`, `picking`, `flashes`; in
  `board.ts` the scenes and what is kept per board; in `conn.ts` what is kept per chat and per run;
  the group ids of the tree and of the drop mark; the keys of `localStorage` that hold a chat id.
  How the page builds its key is its own matter; on the wire the two values stay apart (3.1).
- **Collapse** of a section and of a group in it is kept in `localStorage` only. The page never
  sends `collapsed` under `/api/on/`, and never reads it from a section's tree.
- **No content of a remote server in the browser's storage.** The unsaved copy of a draft
  (`logic/drafts.ts`), the kept drafts (`keptdrafts.ts`, `logic/draftsback.ts`) and anything like them
  are for local chats only. Text typed in a section's chat during an outage lives in the open
  composer, and is saved with the counter the page has when the `section` event with a tree arrives,
  if the chat is still open. A 409 `stale` is handled as today.
- **What is open when its tree goes** stays on screen from the page's memory: a chat and a run view
  read-only under the warning, a board as in 3.6. A snapshot or a `section` with `null` does not close
  it. Once the user leaves it, it is gone until the tree is back.
- **When a tree arrives** (`section` with a tree): the page reads again the thread, the tree and the
  run detail it shows of that entry (which follows them again), takes the open board if it does not
  hold it, and saves the pending draft. A thing that is not in the new tree, or whose read is 404
  `not_found`, is shown as no longer on that server.
- **A drop** from one section into another, or between a section and the local part, is not offered
  and no call is made for it. There is no route that could take one.
- **Goes away in the page:** the server's name after a row, the greyed and "gone" rows, "Remove from
  this sidebar", the choice "Where should this live?" for a chat and a board (`BoardChoice.tsx`,
  `logic/boarddraft.ts`), the server choice of a run that has not started, `unmoved` and `moveError`,
  `server_back` and `chat_reload`, the count of chats in the question before an entry is removed.

## 4. Who owns what

### 4.1 The rules

1. **Each file below has one owner.** Another agent does not edit it, with the exceptions of 4.3.
2. **A branch removes a symbol only when nothing in that branch uses it any more.** What stays
   because the other side still used it is removed after the merge (4.6). Every branch builds and
   passes its tests alone.
3. **A new file belongs to the agent that adds it.** New test files: A's start with `level5_`, B's
   with `section_`, in whatever package.
4. **`web/` and `desktop/` are C's alone. No Go file is C's.**
5. **A file that is not listed has no owner.** A test file that is not listed follows the code it
   tests. An agent that must change any other unlisted file keeps the change as small as it can and
   names the file in its report. `internal/remote` and `internal/testset` are changed by nobody.

### 4.2 Files

**A, the remote server's side**

- `internal/server/remote.go` (level, the table, the level check), `apiclient.go`, `apiboards.go`,
  `apiruns.go`, and their tests (`remote_test.go`, `apiclient_test.go`, `apimake_test.go`,
  `apiboards_test.go`, `apiruns_test.go`).
- `internal/app/apiclient.go` (the snapshot of 2.5, `RemoteGroup` removed), and a new file of the
  package for the change-over of 2.8.
- `internal/boards`, `internal/boardapi`.
- `internal/chats/apistart.go`, `internal/runs/apistart.go`.
- `cmd/ai-whiteboard/main.go`, `remoteserve.go`, `remotecmd.go`, and the tests `apiclient_test.go`,
  `apiruns_test.go`, `remoteserve_test.go`, `remotecmd_test.go`.
- In `README.md`: "Chats on the remote port", and the levels in "A server that is too old".

**B, the local server's side**

- `internal/remotes` (the whole package), `internal/servers` (with `standin` and `linksim`).
- `internal/server/remotechat.go`, `remoteboard.go`, `remoterun.go`, `movedraft.go`, `servers.go`,
  `images.go`, `library.go`, `guard.go`, a new file for the routes of 3.4, and the tests of these
  (`remotechat_test.go`, `remoteboard_test.go`, `remoterun_test.go`, `remotedraft_test.go`,
  `remotefixes_test.go`, `remoteimages_test.go`, `move_test.go`, `movedraft_test.go`,
  `movetouch_test.go`, `nolists_test.go`, `placeaway_test.go`, `boardpair_test.go`,
  `boardentry_test.go`, `servers_test.go`, `libraryremote_test.go`).
- `internal/app/app.go`, `internal/app/remote.go`, `internal/app/library.go`.
- `internal/chats/remote.go`, `internal/runs/remote.go`, `internal/defaults`, `internal/store`.
- `cmd/ai-whiteboard/serverlist.go`, `testwaits.go`, and the tests `remotechat_test.go`, `remoteboard_test.go`, `remoterun_test.go`, `remoteimages_test.go`,
  `remotemove_test.go`, `remotelibrary_test.go`, `serverlist_test.go`, `testwaits_test.go`.
- `AGENTS.md` (the names of `AIWB_TEST_WAITS`).
- In `README.md`: everything else about a server on another machine: "Use a server on another
  machine", "Chats on a remote server", "Whiteboards on a remote server", the remote parts of
  "Subagent settings", "Images in a message" and "Prompt library", and "The move of chats from
  before", which is taken out.

**C, the page**

- `web/` (source, tests, styles) and `desktop/`. If the README needs a sentence about the sidebar, C
  says so in its report and does not edit the README.

### 4.3 Files that two agents edit

| File | A edits only | B edits only |
|---|---|---|
| `internal/server/server.go` | the lines inside a `fromRemote(r)` test, the calls of `ownBoard` and `marked`, `replaceDraft` and `replaceRefused`, one new case for `not_found` as the last case of `codeOf`, and the registration of the routes that leave the table | `Handler` (`remoteFirst`), the cases of `statusOf` and `codeOf` for the errors and codes that go away (3.8), and the lines that name `s.Remotes`, a body's `Server`, `movedMeanwhile`, `moveSoon`, `savedMeanwhile`, `entryOf`, `onEntry`, `PlanChat`, `RemoteDraft` |
| `internal/editorbridge` | `APIEvents`, the row of `KindAPI` in `New`, and what makes a list event reach every client | the rows of `Events` (`section` added; `server_back` and `chat_reload` removed), and what keys a follow, a board hold and a role event by entry id as well |
| `internal/model` | `State.RemoteGroup` | everything about a thing on another server: `Server`, `Gone`, `Unmoved`, `MoveError`, `Start`, `Was`, `RemoteStart`, `GroupDefaults.Server`, the keys of `GroupDefaults.Servers` |
| `internal/chats` (but `apistart.go`, `remote.go`) | the places that load a chat, to blank its mark | the lines about a chat's server (`Server`, `newSide`, `PlanChat`, `RemoteUnstarted`, the `on` argument of `startChoiceOn` and `subChoiceOn`) |
| `internal/runs` (but `apistart.go`, `remote.go`) | the place that loads a run, to blank its mark | the lines about a run's server (`Server`, `RemoteStart`, `svcSide`, `Remote`) |
| `README.md` | its two parts (4.2) | its parts (4.2) |

- **A line both would change is B's.** In `internal/chats` and `internal/runs` that is every call
  that passes both a server side and a mark (`startChoiceOn(on, …, marked)`). A leaves the mark's
  parameters, fields and tests in those two packages and in `internal/model` as they are: with no mark
  in memory they do nothing, and they are removed after the merge (4.6).
- A may leave `Bridge.SetMark`, `MarkOf`, `MarkBoard` and their callers. They must decide nothing.
- A does not touch `internal/servers/standin`. B does not touch `internal/boards`.

### 4.4 Tests on each branch

On A's branch the client half of the program is still the old one, and on B's branch the server half
is. A test that runs **both halves for real** cannot pass on either branch alone: the pairs of
`internal/server` (`newPair…` in `boardpair_test.go`) and the tests of `cmd/ai-whiteboard` that start
a client server and a remote server.

- **A tests its side with plain HTTP clients**: requests on the remote listener with the three
  headers, several client ids for several clients, and the server's own port for the owner. That
  covers every statement about the remote server without B.
- **B tests its side against `internal/servers/standin`**, which B brings to this contract's level 5
  (`DefaultFeatureLevel = 5`, the snapshot of 2.5, the level header), and against scripted answers.
- **C tests the page against the shapes of section 3**, with no server.
- A test of both halves that fails on a branch for want of the other half is skipped there with
  exactly this line, at the top of the helper that starts the pair where there is one, else at the
  top of the test:

  ```go
  t.Skip("remote-server-sections: needs both halves; see plans/remote-server-sections-contract.md 4.4")
  ```

  A adds only this line to a test file of B's. When the merge then finds such a file changed by A and
  changed or deleted by B, **B's side is taken.**
- No paid test is run. `AGENTS.md` holds for which set is run when.

### 4.5 What each may assume of the others

**A may assume:** every client sends `X-AIWB-Level: 5`; a client calls only the routes of 2.3 and
sends that server's own ids; a client never sends `collapsed`, `server` or `replace`; a client is one
user of a board. A may not assume that a client is well behaved: every refusal of 2.4 is checked.

**B may assume:** a server of level 5 serves 2.3 to 2.7 exactly; its snapshot is its whole tree and
its events keep that tree current, for every change by anyone; a 404 with `not_found` means the named
thing is gone; an answer is JSON. B may not assume anything of a server below 5 (it does not connect),
nor that an id of one server is not used on another or locally.

**C may assume:** the snapshot and the events of 3.2 and 3.3; that every route of 3.4 has the answer
of 3.5 in every state; that a list event of a section arrives for every change made by anyone; that a
`section` with a tree is followed by working calls. C may not assume an order between `server_state`
and `section`, nor that a call it sent before a `section` with `null` was answered.

**B and C may assume of the local part** that it is as today, minus 3.8.

### 4.6 After the merge

Merged in the order A, B, C. Then, by whoever does the merge, not by A, B or C on their branches:

1. The skips of 4.4 are removed, and the tests of both halves are made to hold for sections.
2. The tests of the goal's section 7 that need two real halves are written: two clients and the owner
   on one server, a server that drops and comes back with a chat, a run view and a board open, and
   the data folder after both change-overs.
3. What rule 2 of 4.1 left is removed: the client mark (`Client` and `Origin` in `internal/model`,
   the mark's parameters and tests in `internal/chats` and `internal/runs`, `SetMark`, `MarkOf`,
   `MarkBoard`, `ViewsOf`, `StatesOf`, `ClientOf`, `ListOf`), `runs.DraftFacts` if nothing reads it,
   and the two constants of the level header, which become one.
4. `AIWB_TEST_FULL=1 go test -timeout 20m ./...` once, `go test -race` for `internal/remotes`,
   `internal/servers`, `internal/editorbridge` and `internal/server`, and the web checks.

## 5. Not settled

- **V2, the older app's own words.** The refusal is exact on the wire, but the app of before can
  only show "The server's event stream did not open", and it tries again every 30 seconds for as long
  as it is not updated. Nothing in this goal can change what that app says. A later level could add a
  `minClientLevel` to hello and a state for it; that is not in this contract.
- **V3, the size.** Nothing was measured. A server with several thousand chats sends a snapshot of
  some megabytes to every client at every connect, and the local server sends every section's tree to
  every page at every page connect. Whether that, and a sidebar with that many rows, is fast enough is
  open until it is tried.
- **V1 was traced in the code, not run.** The page's own rules (`board.ts` `streamOpened`,
  `takeAfterSnapshot`, `serverBack`, `logic/roles.ts`) already save or drop by the revision. That an
  open board survives a restart of the local server during an outage depends on C keeping the board in
  the page's memory while its section has no tree. If that turns out not to hold simply, goal D10
  applies: the board becomes read-only from memory, as a chat.
- **Who writes the tests of both halves** (4.6, points 1 and 2). They cannot be written on any of the
  three branches. The contract leaves them to the merge.
- **The codes of the page's calls on the remote port.** For the calls that are served "as for its own
  page", the statuses and codes are the handler's own and were not listed one by one here. B passes
  them on unread, so nothing depends on the list, but a refusal that a client could not get before
  (for example `agent_missing` on `POST /api/chats`) now reaches the page as that server said it.
