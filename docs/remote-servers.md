# Remote servers

How to build the AI Whiteboard server for another machine, set it up, and use it from the app as a section of the sidebar: its chats, its whiteboards, the feature levels, and what a remote server offers the apps that connect to it.

## Build the server for another machine

```sh
scripts/build-server.sh              # for this machine's system and processor
scripts/build-server.sh linux/amd64  # or darwin/arm64, darwin/amd64, linux/arm64
```

It makes `bin/ai-whiteboard-server-<os>-<arch>/`: the server binary, the web client (`web/`),
`setup-remote.sh`, `start-server.sh` and a `README.md` with the steps for that machine. Every
target builds on any of them, without cgo. There is no installer and no service file: copy the
folder to the machine. See [Use a server on another machine](#use-a-server-on-another-machine).

## Use a server on another machine

The app can use an AI Whiteboard server on another machine, a remote server, next to its own.
Each remote server shows as a section of the sidebar that holds everything on that machine: its
groups, whiteboards and chats. What is made in a section is made on that machine and runs
there, with that machine's agents and folders (see
[Chats on a remote server](#chats-on-a-remote-server) and
[Whiteboards on a remote server](#whiteboards-on-a-remote-server)). Its
[prompt library](prompt-library.md) shows next to your own. The app connects over HTTPS with a
secret, and accepts one certificate by its fingerprint. The app never installs or starts a
remote server: you set it up and start it on that machine yourself.

A remote server is meant for a private network or a VPN. Its remote port listens on every IPv4
address of the machine; keeping the port off the internet is up to that machine's network and
firewall. HTTPS and the secret do not replace that. The secret gives all or nothing: whoever has
it reads and changes everything the app keeps on that machine, the owner's own chats too. They
read every thread and every unsent draft, send in any chat, answer a permission request of an
agent somebody else started, draw on every whiteboard, and rename, move, archive and delete
every chat, whiteboard and group. Nothing marks who made a thing, and nothing limits an app
to what it made. The secret does not give that machine's own server list with the secrets in it,
its settings, its restart and update, or its data folder as files.

**On the other machine,** with the folder from `scripts/build-server.sh` (its `README.md` has the
same steps in full):

```sh
sh ai-whiteboard-server-linux-amd64/setup-remote.sh   # asks nothing
sh ai-whiteboard-server-linux-amd64/start-server.sh   # starts the server in the background
```

**On a Mac that has the app,** the script is in the bundle and sets the app's own server up:

```sh
sh ~/Applications/AI\ Whiteboard.app/Contents/Resources/remote/setup-remote.sh
~/Applications/AI\ Whiteboard.app/Contents/MacOS/ai-whiteboard relaunch   # restart the app's server
```

Set-up prints the addresses (every name and address the machine has, with the remote port, 4748),
the certificate's fingerprint and the secret, and how to restart the server. Run again, it
changes nothing and prints the same. A set-up takes effect at the server's next start, except a
new secret, which a running server takes at once. On macOS
with the firewall on, incoming connections to the server can be blocked: allow `ai-whiteboard`
when macOS asks, or add it in System Settings, Network, Firewall.

**In the app on your own machine,** open **Servers** at the foot of the sidebar, choose **Add
server** and enter a name, one of the addresses (`https://host:4748`) and the secret, and tick
**Self-signed certificate**. Compare the fingerprint the app shows with the one set-up printed
and accept it only when they are the same. **Test connection** says at which step a connection
fails.

**In the sidebar,** the part at the top holds what lives on this computer and nothing else: no
row in it names a server, and no group of it holds a thing of a remote server. Below it comes
one section per entry of the server list, in the order of the list; with no entry there is no
section. The sections scroll with the rest of the tree. **Servers** is the one place where a
server is added, edited, tested and removed.

- **A section** stands for one remote server. Its head shows the server's name, as the server
  list has it, and its state, in the words **Servers** uses. A click on the head collapses or
  expands the section. A section is not a group: it has no menu, it is not renamed, archived,
  deleted or dragged, nothing is dragged onto its head, and it is in no list of groups a row can
  be moved to. While the server is connected the head has a "+" for a new chat, whiteboard or
  group on that server, outside any group. The "+" of the sidebar's head makes things of this
  computer only, and **Show archived** is one switch for this computer's part and every section.
- **A connected server** shows its whole tree in its section, as that machine has it: the same
  groups, nested the same way and in the same order, with the whiteboards and chats in
  them, and what is in no group first. Everything on that machine is there, whoever made it: its
  owner on that server's own page, your app, or another app that is connected to it. A row does
  not say who made it and carries no server name. The rows are those of this computer's part and
  behave as they do: a whiteboard with its chats, a chat with
  its working mark and its draft mark, a group with its "+" and its menu. Only what makes no
  sense on another machine is left out: a whiteboard's file is not revealed in this machine's
  file manager. A chat or a whiteboard opens in the same view as one of this computer. A
  change made anywhere shows without a reload: a chat somebody else made appears, and a rename,
  a move, an archive mark, a deletion and every change of a group are followed. Until the tree
  has come the section says that it is connecting and shows no rows, and a server with nothing
  on it says so in one line.
- **A server that is not connected** shows its state in its section, with one line that its
  chats show when the server is back, and nothing else: no rows and no last view. Nothing of
  that server can be opened, made, changed or deleted, and nothing of it can be read, except
  what is open in a window at the moment the connection ends: an open chat stays
  on screen, read-only (see [Chats on a remote server](#chats-on-a-remote-server)), and an
  open whiteboard can still be drawn on (see
  [Whiteboards on a remote server](#whiteboards-on-a-remote-server)). After a restart of your
  own server, or a reload of the page, during the outage, nothing of that server is known until
  it connects. The app keeps trying the connection, and **Servers** says at which step it fails.
  A server that is [too old](#a-server-that-is-too-old) says so in its section, with the version
  it reports, and shows nothing else.
- **Where a thing is made decides where it lives.** A chat, a whiteboard or a group made
  in a section is made on that server at once, in the group it was made in, and shows in the
  section of every app connected to that server and on its owner's page. One made in this
  computer's part is on this computer. The app asks nothing about the place, and the place is
  final: nothing is moved from one server to another, or between a section and this computer's
  part, and no drop between them is offered.
- **Arranging a section** is arranging that server, for everyone. You make, rename, move, nest,
  archive and delete the groups of a section from your app, with the rules of a group of this
  computer, deleting a group with everything in it among them. A whiteboard or a chat is
  moved between the groups of its own section, by menu and by drag, and is renamed, archived,
  unarchived and deleted from your app. Each of these changes is made on that server and shows
  to its owner and to every connected app: a group you delete is deleted for all of them, with
  what is in it. What anyone deletes there leaves every section at once, and a window that has
  it open says that it is no longer on that server.
- **What the owner of that server sees** on that server's own page is the same tree. What you
  make there is an ordinary chat or whiteboard of that server, in the group you made it in,
  or in no group: no group of that server stands for the apps that connect to it. A server that
  the owner's machine itself connects to shows as a section on the owner's page only: it is not
  part of that machine's tree, and your section never shows another machine's sections.
- **What your machine keeps.** On disk, the server list and nothing else of a remote server: no
  record of a chat or a whiteboard, no last view, no draft, no image, no place in a
  group, no archive mark, no memory of what was made there, and no remembered choice for new
  chats. The server's log (`server.log` in the data folder, when the server was started in the
  background) names a remote server by the id of its entry in a line about a failure, and
  nothing that is on that server: no id of a chat or a prompt, and no word of what it
  sent. In memory, your server holds what it got from a connected server (its tree, what it
  offers for a new chat, its prompt library) and which window holds an open whiteboard;
  a restart loses all of it. Whether a section is collapsed, and whether each group inside it
  is, is kept in the browser's storage, per browser, as the sidebar's width is. It survives a
  reload and a restart, and it is never sent to the remote server and never taken from it:
  collapsing a group changes nothing for the owner or for another app, a browser tab and the
  desktop app each have their own, and clearing the browser's storage shows everything
  expanded. A group that is new to the page shows expanded. The browser's storage holds no
  content of a remote server.
- **Removing a server from the list** takes its section away and tells that server nothing:
  everything on it stays there. The question before the removal says so. What is open of that
  server in a window is closed with its section.
- **The update from a version without sections.** Before sections, the app filed the chats
  and whiteboards of a remote server in your own groups, kept a record of each in the
  folder `remote/` of its data folder, and reached only what it had made itself, which that
  server kept in a group named **Remote**. At its first start the updated app removes the folder
  `remote/` with everything in it: the records, their last views, the drafts kept with them,
  `makes.json` and, if a build with runs made it, `remote/runs/`. Nothing is deleted on any
  server for it. The things themselves are on their servers, and show in their sections once
  that server is updated as well and connects (until then it is
  [too old](#a-server-that-is-too-old)); the update of a remote server removes its
  group **Remote** and leaves what was in it in no group. On your machine, the place those
  things had in your own groups is lost, and a group that held only such things stays, empty,
  for you to delete. What the app remembered per group and server for new chats is dropped, and
  so is an archive mark that was set here while the server was away and had not reached it. A
  chat that never had a message and was still kept here for a remote server becomes a chat of
  this computer, with its draft, in the group it was in. It gets the agent, the folder and the
  other settings a new chat in its place starts with on this computer, in place of that
  server's. Such a chat on a whiteboard of that server has no place on this computer and is
  deleted, with its draft. A draft that was kept with the record of a started
  chat, and had not been carried over to its server, is lost. The app looks for all of this at
  every start and changes nothing in a data folder that holds none of it.

### A server that is too old

A server says what it offers a client with one number, its feature level (`featureLevel` of
`/api/hello`): level 1 is chats, 2 adds
[whiteboards](#whiteboards-on-a-remote-server), 3 the [prompt library](prompt-library.md), 4
the chat's draft kept on the server (`PUT /api/chats/{id}/draft`) and the images of a message,
with their upload and fetch (`/api/chats/{id}/images`), and 5 the server's whole tree: a client
is given every group, whiteboard and chat of the server and changes them with the calls the
server's own page makes (see [Chats on the remote port](#chats-on-the-remote-port)). A server
of this version reports 5, and the app connects to no server below 5: it shows a server's whole
tree, which an older server does not give, so an older server is not kept usable without it.
A server of level 5 in turn serves no app below 5 (see
[Chats on the remote port](#chats-on-the-remote-port)).

Such a server shows in **Servers**, and in the head of its section of the sidebar, as **Too
old: update the server on that machine**, with the version it reports. Until it is updated:

- Its section says that it is too old and shows nothing else: no group, no chat and no
  whiteboard of that machine.
- It takes no call: nothing of it can be opened, made, changed or deleted from this app.
  Nothing is deleted, here or there.
- The app sends it nothing but the question whether it is still too old: once every five
  minutes, and at once when you edit the entry, press **Test connection** or start the app.

Update the server on that machine (copy the new folder from `scripts/build-server.sh` there, or
update the app there, and restart it). The entry then connects by itself within five minutes,
and its section shows that machine's tree.

| `setup-remote.sh` option | What it does                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `--name NAME`            | adds a DNS name or IPv4 address clients reach the machine by; may be repeated      |
| `--port N`               | the remote port (default: keep it, or 4748 at the first set-up)                    |
| `--new-cert`             | replaces the key and the certificate: every client must accept the new fingerprint |
| `--new-secret`           | replaces the secret: every client needs the new one; a running server takes it at once |
| `--home DIR`             | the data folder (default `~/.ai-whiteboard`)                                       |
| `--server-port N`        | the server's own port, when it is not the running server's or 4747                 |

`start-server.sh [--restart] [server flags]` runs `launch` (with `--restart`, `relaunch`) with
the absolute path of the folder's `web/`, so it works from any folder; the other arguments are
the server's [flags](server-reference.md#server-commands-and-flags). The scripts are called through `sh` because a copy may lose its
executable bit. They need no `openssl`.

### Chats on a remote server

A chat in a section lives on that remote server: its agent runs there, in a folder of that
machine, and its thread, its settings, its draft and its images are stored there. Your own
machine stores nothing of it and passes every call on. What is said here of the calls, their
answers and the events holds for the groups and the
[whiteboards](#whiteboards-on-a-remote-server) of a section too. What that server offers the
apps that connect to it is in [Chats on the remote port](#chats-on-the-remote-port).

- **A new chat** is made in a group of the section, outside any group from the section's head,
  or on a whiteboard of the section: a chat on a whiteboard is on the
  board's server. It is made on that server at once, before any message
  (`POST /api/on/{server}/chats` with `group` or `board`), and the answer is the chat,
  with `locked` false. It starts with what that server remembers for its group: agent, folder,
  model, effort and subagent settings. Those choices are that server's own, shared by its owner
  and every connected app: what one of them picked last in a group is what the next new chat of
  that group starts with, whoever makes it. Your app remembers none for a remote server. The
  settings before the first message are changed there, and the first message is an ordinary
  message: the agent starts there. A make that the server cannot take is refused with that
  server's status, code and sentence, and makes nothing, here or there.
- **Several apps and the owner.** The owner of the server and every app connected to it can have
  the same chat open at the same time. Each sees the thread grow, and the draft and the working
  state as the others change them. Anyone who has the chat open sends, stops, answers a
  permission request and changes the settings before the first message, where the chat's own
  state allows it. A message to a branch that is working is refused (409, `busy`), whoever sent
  the one before. The first answer to a permission request decides, and a later one is refused
  (400). Of two changes of the settings the later one stands.
- **The draft** of a branch is one draft for all of them, kept on the chat's server with that
  server's counter. A save (`PUT /api/on/{server}/chats/{id}/draft?rev=N`) names the counter it
  was typed on and is passed on with the JSON that came, its `images` too (one that names none
  byte for byte), and the answer, `missing` too, is that server's. A save on another counter
  than the stored one is refused (409, `stale`, with the stored counter and draft), so nobody
  replaces what another typed without being told. Your pages get the draft and its counter from
  that server's events. A save with `replace` is refused by your app (400, `replace_refused`).
- **Images** are the chat's server's too (see [**Images in a message**](architecture.md)), and your app keeps none.
  - An upload (`POST /api/on/{server}/chats/{id}/images?name=`) is cut at the size limit by your
    app before it is read (413, `image_too_large`), and is then passed on with its bytes, the
    type it states and its name. The answer is that server's: the image, or its refusal
    (`image_type`, `image_cap`). While the server is not connected, or is too old, the upload is
    refused unread (503, `server_unreachable`).
  - A fetch (`GET /api/on/{server}/chats/{id}/images/{image}`) is never handed on as it came.
    Your app takes the bytes of that server's answer alone, finds the type from them, and serves
    them under its own headers, the ones an image of this computer is served with. Bytes that
    are not a PNG, JPEG, GIF or WebP image of at most 5 MB are answered 502 `bad_answer`,
    whatever type that server claimed for them: no server of your list can have your app serve
    HTML or SVG of its making. A refusal of that server reaches the page with its status, code
    and sentence, and nothing else of it.
  - An image id is checked for its form by your app before it is sent anywhere. A fetch with
    another is refused (400, `image_id`), and so is a message that names one, as for a chat of
    this computer, or whose `images` are no list. A draft save is passed on without such an id,
    and the answer names it in `missing`, with what that server says the chat does not hold.
    What is passed on of a draft or a message that names images is the same JSON object with one
    `images`, the checked list, however the body spelled that key.
- **When the server drops,** its chats leave the sidebar with the rest of the section, and none
  can be opened, made or changed. A chat that is open in a window stays on screen as the page
  had it when the connection ended, read-only, under a warning that names the server and says
  that it is not connected. Nothing is sent, stopped or changed, and the composer says why: its
  box is read-only meanwhile, it keeps what it holds and takes no typing, and no image can be
  removed from the draft. Text that was typed before the connection ended and that the server
  has not taken stays in the open composer and is saved when the
  server is connected again, if the chat is still open then, on the counter the page has (a save
  that is refused as `stale` is handled as any). It is kept nowhere else: the browser's storage
  holds no draft of a chat on a remote server, so it is lost when you leave the chat, reload or
  close the page before the server is back. A chat that was left cannot be opened until the
  server is back, and a reload of the page or a restart of your own server during the outage
  leaves the chat closed until then.
- **When the server is back,** its section shows its tree as it is then. An open chat
  is brought level with its server, the warning goes and the composer works again. One that
  was deleted there meanwhile says that it is no longer on that server.
- **A make whose answer was lost** (504, `no_answer`) can still have made the chat on that
  server. The chat then shows in the section as any other. Your app looks for none and deletes
  nothing on its account, so an empty chat can stay on that server, where its owner and every
  connected app see it, until somebody deletes it.
- **The calls.** A thing of a section is named by two values: the id of its entry in the server
  list, and its own id on that server. An id is unique on one server only, so the same id can
  name a chat of this computer and a chat of a section. The call for a thing of a section is the
  call for a thing of this computer with `/api/on/{server}` in the place of `/api`, `{server}`
  being the entry's id: `POST /api/on/s_0123456789ab/chats/{id}/messages?branch=main` sends a
  message to a chat of that section. Method, the rest of the path, the query and the body are
  those of the local call, and every id in them is that server's own. A call is sent to that
  server as it came, and its answer is handed to the page as it came, status and JSON body, with
  that server's codes and sentences. Your app answers a few by itself: the end of a follow
  (`POST …/unfollow` of a chat); the take, the release, the read and the save of a
  [whiteboard](#whiteboards-on-a-remote-server); the fetch of an image;
  `POST …/boards/{id}/reveal` (400, `not_here`: the file is on another machine, in every state
  of the entry); and
  `PATCH …/groups/{id}` with `collapsed` (400, `collapsed_refused`: collapse is the page's own).
  Another path under the prefix is 404, and so is every call under `/api/on/local/…` or under
  an id that is no entry of the list (`no_server`), these few among them. Every write
  under the prefix needs a known client, as every write on this port. Not under the prefix are
  the folders and the usage of an agent of that server (`GET /api/dirs?server=` and
  `GET /api/usage/{agent}?server=`, with the entry's id), the answer to an agent's board tool
  (`POST /api/rpc-reply`) and the [prompt library](prompt-library.md). The routes without the
  prefix (`/api/chats/…`, `/api/boards/…`, `/api/groups/…`) serve the things of
  this computer only: an id that is none of theirs is 404 `not_found`, whatever another server
  has under it, and a `POST /api/chats` or a `POST /api/boards` whose
  body names a `server` other than `local` is refused (400, `server_refused`), as
  `PATCH /api/chats/{id}` with a `server` is (409, `server_fixed`).
- **The answer of a call** follows the entry's state. A `{server}` that is no entry of the list
  is 404 `no_server`. An entry that is not connected, or is
  [too old](#a-server-that-is-too-old), is 503 `server_unreachable` with a sentence that says
  which, and nothing was sent; an entry that waits for its next try is made to try at once.
  Connected, the answer is that server's own: for a chat, a whiteboard or a group that is
  not there it is 404 with the code `not_found`, which the page shows as no longer on that
  server. A 401 of that server is 503 `server_unreachable` (the secret is the entry's matter),
  an answer that is no JSON or is too long is 502 `bad_answer`, and a call that was sent and got
  no answer in time, or whose connection ended, is 504 `no_answer`; for a message that is 504
  `send_unknown`, since it is not known whether it arrived. While the entry is not connected,
  the end of a follow and the release of a whiteboard are answered 200 all the same. A call has
  15 seconds between the two servers. A call that can wait for an agent's start has 45: a
  message, a fork, the opening of a branch, a read of a chat's context that asks the agent, and
  the archive of a group. A drawing and an image have 60, and the delete of a group with what is
  in it, 3 minutes.
- **The snapshot and the events.** The snapshot your server gives a page (`GET /api/state`, and
  the start of its event stream) has in `groups`, `boards`, `chats`, `states` and
  `defaults` what lives on this computer and nothing else. The trees of the remote servers are
  in `sections`, an object by entry id, each with the same five lists as that server has them
  (without `collapsed` of a group). An entry has a key there only while your server holds its
  tree: its connection is up and its tree was read. A `section` event tells every page of a
  change of that: `{"type": "section", "server", "tree"}` with the whole tree when the server
  connects, the first time or again, which replaces what the page had; and with `"tree": null`
  when your server holds no tree of the entry any more, because the connection ended or the
  entry was removed. An event about a thing of a section is the event of a thing of this
  computer with one more top-level field, `server`, the entry's id; an event without it is about
  this computer. `groups`, `defaults`, `board`, `board_removed`, `chat`, `chat_removed`
  and `branch_state` go to every page, in that server's order; `tree`,
  `chat_items`, `sub` and `sub_items` to the pages that follow the
  chat; `held`, `release_request`, `superseded` and `rpc` to the one page concerned.
  A page follows a chat from its first read of the thread, the tree or a subagent's
  thread until `…/unfollow`, and your server follows the thing on its server
  for all its pages together. Every follow ends when the entry's tree goes: after a `section`
  with a tree, a page reads again what it shows.

### Whiteboards on a remote server

A whiteboard in a section lives on that remote server. You draw on it in the app as on any
board; its drawing is stored on the remote server only, and its chats run there.

- **Creation.** A new whiteboard made in a section, from the "+" of one of its groups or of its
  head, is made on that server at once, in that group, and the window that made it draws on it.
  One made in this computer's part is on this computer. The app asks nothing about the place,
  and the place is final: a board is not moved to another server or to this computer.
- **Where it lives.** The board, its drawing, its name, its group, its archive mark and its
  chats are on the remote server, and your own machine stores nothing of it. Every board of that
  server is in the section, whoever made it, and one an agent makes there with `create_board`
  shows there as the others do. Rename, move, archive, unarchive and delete are made on that
  server and show to its owner and to every connected app. A chat made on such a board is on the
  board's server, and is made there at once.
- **Holding.** One window draws on a board at a time, among the owner's windows and the windows
  of every app connected to that server. Among the windows of your app the board is handed over
  as usual; to the remote server your app is one user of the board, whatever the number of its
  windows. When the board is taken by the owner or by another app, your window is asked to save
  and let go, and shows the take-over panel; **Use here** takes it back. The agents' board tools
  are answered by the window that holds the board, so the board has to be open in a window, of
  the owner or of a connected app, for an agent to draw on it.
- **Outage.** While the server is not connected you keep drawing in the window that has the
  board open: a save is answered 503 `server_unreachable`, the changes stay in that window and a
  banner says they are not saved. The board's row leaves the sidebar with the rest of its
  section, and the window stays. No other window gets the board, and a board that is not open in
  a window cannot be opened: a take and a read are answered 503 too. When the server is back,
  your app takes the board there again for the window that holds it: the changes are saved if
  nobody changed the board there meanwhile, and dropped, with a notice, if somebody did. When
  somebody else holds the board by then, the window shows the take-over panel and keeps the
  changes until **Use here**. A save made after the server is back, while your app is still
  taking the board there again, is answered 503 `not_held_there`: the changes stay under the
  banner, which then reads "Not saved yet, waiting for" the server, and are saved or dropped by
  the same rule when the board is held again. After a restart of your own server during the
  outage the window still has the drawing, with the changes that were not saved, but the board
  cannot be drawn on until the server is back: the window then asks for the board when the
  section's tree is back, and the same rule saves or drops the changes. A board that was deleted
  there meanwhile says that it is no longer on that server.
- **The calls** are those of a board of this computer under `/api/on/{server}/boards/…`, with
  the answers and the events of [Chats on a remote server](#chats-on-a-remote-server). Your
  server alone decides which of its windows holds the board, and holds the board on its server
  for as long as one of them does. An agent's board tool on that server reaches the window that
  holds the board as an `rpc` event with `server`, and the window answers with
  `POST /api/rpc-reply`.
- **Limits.** A drawing saved through a remote server is at most 32 MB, images included; a
  larger one is refused (413, `too_large`) and stays in the window. Two people cannot draw on a
  board at the same time.

### Chats on the remote port

What a client, another AI Whiteboard server, does on a server's remote port. **A client is
served as the server's own page.** It is given the server's whole tree, whoever made what is in
it, and it changes that tree with the calls the server's page makes, with the same answers. No
mark of who made a thing decides who sees or changes it: whoever has the secret reads and writes
everything on the machine, the owner's own chats too.

- **The snapshot** (`GET /api/state`, and the start of the client's event stream) holds every
  group of the server in its order (`groups`), what the server remembers per group for a new
  chat (`defaults`), and every whiteboard (`boards`) and chat (`chats`, with one entry of
  `states` for each branch), archived ones included; and, as before, the server's `agents`, `catalogs`, `home`, `defaultCwd` and its
  prompt `library`. Each list has one order, the same at every read and the one the server's
  own page is given: the groups in the server's order, the whiteboards and the chats
  oldest first (two of the same moment by their id), and the branch states by their chat. It
  never holds the server's own server list, anything of the servers that machine is itself a
  client of, or its data folder.
- **The events** keep that tree current for every client and every page of the server alike:
  `groups` and `defaults` (each whole, after every change), `board` and `board_removed`, `chat`,
  `chat_removed` and `branch_state`, in the order of the changes,
  whoever made them: the owner on the server's own page, this client, another client or an
  agent. The events of a thread go to whoever follows the chat: a read of the thread or the
  tree starts the follow, and `…/unfollow`, the end of the stream or the removal of the thing
  ends it.
- **There is no group named Remote.** What a client makes is in the group it names, or in no
  group. A server that is updated from before level 5 removes that group once, at its first
  start: the group its `state.json` remembers as `remoteGroup`, whatever its name is by then.
  The whiteboards and chats in it go to no group and keep their own archive marks (a chat
  on a whiteboard stays with it), and a group nested in it goes to the top level
  with what is in it. A group that is merely named "Remote" is an ordinary group and stays.

The calls that have something of their own on the remote port:

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/chats` | `id`, `agent`, and one of `group`, `board` | the chat, `locked` false |
| `PATCH /api/chats/{id}?branch=B` | `name`, `group`, `agent`, `model`, `effort`, `cwd`, `subDepth`, `subCap` | `{"ok": true, "chat"}` |
| `PUT /api/chats/{id}/draft?rev=N&branch=B` | the draft | `{"ok": true, "rev", "missing"}` |
| `POST /api/chats/{id}/messages` | `text`, `context`, `references`, `images`, `target` | `{"ok": true, "branch"}` |
| `POST /api/chats/{id}/images?name=` | the bytes of one image, `Content-Type` its type | `{"id", "name", "type", "size"}` |
| `GET /api/chats/{id}/images/{image}` | | the bytes of the image |
| `POST /api/groups` | `name`, `parent` | the group |
| `PATCH /api/groups/{id}` | `name` | `{"ok": true}` |
| `POST /api/groups/{id}/move` | `parent`, `before` | `{"ok": true}` |
| `DELETE /api/groups/{id}?contents=delete\|keep` | | `{"ok": true}` |
| `POST /api/boards` | `name`, `group`, `new` | the whiteboard |

- **A new chat** (`POST /api/chats`) is made in the group or on the whiteboard the
  body names (`group` is a group's id, or `__ungrouped__` for none), unstarted: no agent starts
  and nothing is sent. `id` is a UUID of the client's making, or absent. The chat starts with
  what the server remembers for its place (agent, folder, model, effort and subagent settings),
  and it feeds those choices as any chat of that server does: they are the server's own, the
  same for its owner and every client. Its settings are changed with `PATCH` until its first
  message; once the chat has started, the agent, the model and the subagent settings are refused
  (409). `PATCH` with `group` moves a chat to another group of the server.
- **The first message** is an ordinary message to the chat that has not started
  (`POST /api/chats/{id}/messages`): the agent starts on this server, the branch's draft is
  removed and its counter goes up. A message to a branch that works is refused (409, `busy`),
  whoever sent the one before.
- **The draft** of each branch lives on this server, with a counter that goes up at every change.
  A save names the counter it was typed on (`rev`, 0 for a branch that never had a draft) and is
  refused when that is not the stored one: 409 with `"code": "stale"`, the stored counter (`rev`)
  and the stored draft (`draft`, `null` for none). An empty draft is none. A branch the chat does
  not have is 404 with `"code": "no_branch"`. The page of this server and every client save into
  the same draft, and the counter decides between them: nobody replaces what another typed
  without being told. A draft may name `images`: one the chat does not hold is left out of what
  is stored, and the answer names those left out in `missing` (absent when there are none). The
  chat's `chat` and `branch_state` events and the snapshot carry `draft` and `draftRev`, for a
  chat that has not started too. A save with `?replace=` is refused on both ports (400,
  `"code": "replace_refused"`) and stores nothing: a draft is no longer carried over from
  another server.
- **Images.** The upload and the fetch are the calls this server's own page makes (see
  [**Images in a message**](architecture.md)), with the same answers: the upload is cut at the size limit before
  it is read, the type is found from the bytes, and a draft save and a message name images by
  id.
- **Groups** are made, renamed, moved, nested, archived, unarchived and deleted by a client with
  the rules they have on the server's own page: a group cannot go inside itself or into an
  archived one, and `contents=delete` deletes a group with everything in it, for everyone.
  Whether a group shows collapsed is the server's own matter and each client's: a `PATCH` whose
  body has `collapsed` is refused (400, `"code": "collapsed_refused"`), and the order of the
  groups as a whole (`PUT /api/groups/order`) is not offered.
- **Whiteboards.** A client makes a board in a group (`POST /api/boards`) and holds it at once
  if its stream is open, as a page does. It takes, reads, draws on, renames, moves
  (`PATCH /api/boards/{id}` with `group`), archives and deletes every board of the server, the
  ones its owner made too. One window draws on a board at a time, across the owner's pages and
  every client: to the server a client is one user of the board. A drawing a client saves is at
  most 32 MB (413, `"code": "too_large"`).
- **Several clients and the owner** may have the same chat open. Each gets its thread, its draft
  and its working state as the others change them. A permission request is answered by whoever
  follows the chat: the first answer decides, and a later one is refused (400). The settings of
  a chat that has not started are the last caller's. The chat's current branch is one for all of
  them: it is the branch the last message with `?branch=` or with a `target` went to, whoever
  sent it, and opening a branch (`POST /api/chats/{id}/open`) does not change it. Which branch a
  window shows is that window's own matter.
- **Refusals of a client alone.** A body that names a `server` is refused on `POST /api/chats`,
  `POST /api/boards` and `PATCH /api/chats/{id}` (400,
  `"code": "server_refused"`): what a client makes lives on the server it called, and no server
  passes a client's call on to a third one. A `"run"` key in the body of `POST /api/chats` is
  ignored, so a body with only `agent` and `run` is answered 400 for the missing group, as one
  without `run` is.
  `GET /api/dirs` answers `{"path", "parent", "dirs"}`, `dirs` being the immediate subfolders whose
  names do not start with `.`. To a client that asks for the app's own folder or anything inside
  it, it answers 400; the page of the app may list it.
- **What is gone.** A call that names a chat, a whiteboard or a group that is not there
  is answered 404 with `"code": "not_found"`, on both ports. A 404 for a part that is missing
  keeps its own code or has none (a branch: `no_branch`; a subagent, an image).
- **A client that is too old.** A client states its own level in the header `X-AIWB-Level` of
  every request. A client that states none, or one below 5, is served nothing but `/api/hello`:
  every other request is answered 400 with `"code": "client_too_old"` and the sentence "This app
  is too old for this server: update AI Whiteboard on the machine that connects." An app from
  before level 5 cannot show that sentence: its entry for the server says that the server's
  event stream did not open, and it tries again. The sentence is in the log of the server it
  called, once a minute for each address that tries.
- **What a client cannot reach.** Every route outside the remote port's table is answered 404:
  the server list and the secrets in it (`/api/servers`), the calls for another server's things
  (`/api/on/…`), `POST /api/restart`, the status routes, the reveal of a board's file in that
  machine's file manager, and the page's own files. The data folder is not served as files.
