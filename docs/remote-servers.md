# Remote servers

How the app uses servers as sections of the sidebar, this computer's first and any number of remote ones after it; how to build the AI Whiteboard server for another machine and set it up; the feature levels; what the app does for each kind of server; and what a server offers the apps that connect to it.

## Build the server for another machine

```sh
scripts/build-server.sh              # for this machine's system and processor
scripts/build-server.sh linux/amd64  # or darwin/arm64, darwin/amd64, linux/arm64
```

It makes `bin/ai-whiteboard-server-<os>-<arch>/`: the server binary, `setup-remote.sh`,
`start-server.sh`, a `README.md` with the steps for that machine, and `headless/`, the program that
edits boards while no window is open, with the board engine and its native canvas for that target
([The board engine in Node](architecture.md#the-board-engine-in-node)). The server serves no page, so
the folder holds none and making it needs no build of the web client. Every target builds on any
of them, without cgo; the canvas of a target other than the machine's own is fetched from npm, so
that build needs the registry (or npm's cache), and it fails if a target's canvas can't be had.
The machine that runs the server needs Node 22 or later for `headless/`; without it the server works
as before. There is no installer and no service file: copy the folder to the machine.
See [Use a server on another machine](#use-a-server-on-another-machine).

## Use a server on another machine

The app is the client of every AI Whiteboard server, the one on its own machine included. It can
use a server on another machine, a remote server, next to this computer's. Each server shows as a
section of the sidebar that holds everything on that machine: its groups, whiteboards and chats.
What is made in a section is made on that machine and runs there, with that machine's agents and
folders (see [Chats on a remote server](#chats-on-a-remote-server) and
[Whiteboards on a remote server](#whiteboards-on-a-remote-server)). Its
[prompt library](prompt-library.md) shows next to your own. The app connects over HTTPS with a
secret, and accepts one certificate by its fingerprint. The app never installs or starts a
remote server: you set it up and start it on that machine yourself.

A server is meant for a private network or a VPN. Its client port listens on every IPv4
address of the machine as soon as the server runs, on this computer's too; keeping the port off the
internet is up to that machine's network and firewall. HTTPS and the secret do not replace that.
The secret gives all or nothing: whoever has it reads and changes everything the server keeps on
that machine, the owner's own chats too. They read every thread and every unsent draft, send in any
chat, answer a permission request of an agent somebody else started, draw on every whiteboard, and
rename, move, archive and delete every chat, whiteboard and group. Nothing marks who made a thing,
and nothing limits an app to what it made. The secret does not give the server's settings, its
restart and update, or its data folder as files.

**A server never starts without its set-up.** Set-up makes the server's certificate and its secret
and says which names and port it serves; it is a command you run by hand, once, on the machine,
before the server's first start. A server that was never set up refuses to start, and its message
names the command. The same holds for this computer's server.

**On the other machine,** with the folder from `scripts/build-server.sh` (its `README.md` has the
same steps in full):

```sh
sh ai-whiteboard-server-linux-amd64/setup-remote.sh   # asks nothing
sh ai-whiteboard-server-linux-amd64/start-server.sh   # starts the server in the background
```

**On a Mac that has the app,** the app starts its own server, which needs the set-up once. The
script is in the bundle, and so is the server program:

```sh
sh ~/Applications/AI\ Whiteboard.app/Contents/Resources/remote/setup-remote.sh
~/Applications/AI\ Whiteboard.app/Contents/MacOS/ai-whiteboard relaunch   # restart the app's server
```

(`~/Applications/AI\ Whiteboard.app/Contents/MacOS/ai-whiteboard remote setup` does the same as the
script. `relaunch` is needed only to take up a changed set-up in a server that already runs; a
server that has not started yet is started by the app, which tries again by itself.) Set-up prints
the addresses (every name and address the machine has, with the client port, 4748), the
certificate's fingerprint and the secret, and how to restart the server. Run again, it
changes nothing and prints the same. A set-up takes effect at the server's next start, except a
new secret, which a running server takes at once. On macOS
with the firewall on, incoming connections to the server can be blocked: allow `ai-whiteboard`
when macOS asks, or add it in System Settings, Network, Firewall.

**In the app on your own machine,** open **Servers** at the foot of the sidebar, choose **Add
server** and enter a name, one of the addresses (`https://host:4748`) and the secret, and tick
**Self-signed certificate**. Compare the fingerprint the app shows with the one set-up printed
and accept it only when they are the same. **Test connection** says at which step a connection
fails. This computer's own server is not added: it is the first row of **Servers**, and nothing
of it is typed, edited or accepted. The address of this computer's server entered as a remote one
is refused as "This is this computer's server".

**On a phone,** the new app has no this-computer row, and **Add server** has two ways to fill the form beside typing it: paste the whole output of `setup-remote.sh` (or an address and the secret) into the box at the top, or choose **Scan code** and point the camera at the code that `scripts/server-code.sh` draws on the server's machine (`sh scripts/server-code.sh`, or `sh setup-remote.sh | sh scripts/server-code.sh -`; it draws with `qrencode` and says how to get it when it is missing, and writes the secret to no file). Either fills the address, the secret and **Self-signed certificate**; nothing is accepted for you: **Test connection** shows the fingerprint the server presents, the form says whether it is the one the text printed, and you accept it as above. Only https addresses are taken. On iOS the form says, before the first connection, why the system will ask to reach the local network; if it was refused, **Servers** says so in its words and **Open settings** goes to the phone's settings. The code holds the secret: clear the screen after the phone has scanned it.

**In the sidebar,** the first section is this computer. It is always there, with or without remote
servers, and it is no entry that can be removed or edited in **Servers**. Below it comes one
section per entry of the server list, in the order of the list. The sidebar is sections only. The
sections scroll with the rest of the tree. **Servers** is the one place where a remote server is
added, edited, tested and removed.

- **A section** stands for one server. Its head shows the server's name ("This computer" for the
  first), as the server list has it, and its state, in the words **Servers** uses. A click on the
  head collapses or expands the section. A section is not a group: it has no menu, it is not
  renamed, archived, deleted or dragged, nothing is dragged onto its head, and it is in no list of
  groups a row can be moved to. While the server is connected the head has a "+" for a new chat,
  whiteboard or group on that server, outside any group. **Show archived** is one switch for every
  section. The "+" of the sidebar's head makes things on this computer.
- **A connected server** shows its whole tree in its section, as that machine has it: the same
  groups, nested the same way and in the same order, with the whiteboards and chats in
  them, and what is in no group first. Everything on that machine is there, whoever made it: its
  owner on that machine, your app, or another app that is connected to it. A row does
  not say who made it and carries no server name. The rows are the same for every section and
  behave alike: a whiteboard with its chats, a chat with
  its working mark and its draft mark, a group with its "+" and its menu. A whiteboard's file is
  shown in the file manager for this computer's section only. A chat or a whiteboard opens in the
  same view in every section. A
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
  [Whiteboards on a remote server](#whiteboards-on-a-remote-server)). After a reload of the page
  during the outage, nothing of that server is known until it connects. The app keeps trying the
  connection, and **Servers** says at which step it fails. A server that is
  [too old](#a-server-that-is-too-old) says so in its section, with the version it reports, and
  shows nothing else. One server's outage touches no other section: when a remote server is down
  this computer's section goes on, and the other way round.
- **Where a thing is made decides where it lives.** A chat, a whiteboard or a group made
  in a section is made on that server at once, in the group it was made in, and shows in the
  section of every app connected to that server. The app asks nothing about the place, and the
  place is final: nothing is moved from one server to another, or between two sections, and no
  drop between them is offered.
- **Arranging a section** is arranging that server, for everyone. You make, rename, move, nest,
  archive and delete the groups of a section from your app, with the same rules in every section,
  deleting a group with everything in it among them. A whiteboard or a chat is
  moved between the groups of its own section, by menu and by drag, and is renamed, archived,
  unarchived and deleted from your app. Each of these changes is made on that server and shows
  to every connected app: a group you delete is deleted for all of them, with
  what is in it. What anyone deletes there leaves every section at once, and a window that has
  it open says that it is no longer on that server.
- **What the owner of that server sees** is the app on that machine, whose first section is that
  machine: the same tree. The owner is a client on the same machine, and a client of no other
  kind. What you make there is an ordinary chat or whiteboard of that server, in the group you made
  it in, or in no group. A server that the owner's machine itself connects to shows as a section in
  that machine's app only: your section never shows another machine's sections, and a server
  knows no other server.
- **What your machine keeps.** The app keeps the server list, with the secrets, and nothing else of
  any server: no record of a chat or a whiteboard, no last view, no draft, no image, no place in a
  group, no archive mark, no memory of what was made there, and no remembered choice for new
  chats. The list is a file in the app's folder (`~/Library/Application Support/AI Whiteboard/client/servers.json`,
  readable by you alone), kept by the app's main process; the page cannot read it, and no secret
  reaches the page. While the app is closed no connection is held, to any server: each section
  fills again when the app opens. In memory the page holds what it got from a connected server
  (its tree, what it offers for a new chat, its prompt library); closing the window loses all of
  it. Whether a section is collapsed, and whether each group inside it is, is kept in the page's
  storage, per app, as the sidebar's width is. It survives a restart of the app, and it is never
  sent to a server and never taken from one: collapsing a group changes nothing for the owner or
  for another app. A group that is new to the page shows expanded. The page's storage holds no
  content of a server.
- **Removing a server from the list** takes its section away and tells that server nothing:
  everything on it stays there. The question before the removal says so. What is open of that
  server in a window is closed with its section.

### This computer's section

This computer's server is the one server the app starts. It is a section like the others, with
the same head, states, rows, "+" and collapse; what sets it apart is that it is first, that the app
starts it and starts it again when it stops, and that the owner's things are offered for it.

- **The window opens at once.** It does not wait for any server. Until this computer's server
  answers, its section says that it is connecting. Then it fills.
- **The app finds the server or starts it,** with the server program it carries: `launch -json`
  gives the address and the certificate's fingerprint, and `secret` the secret. You type and accept
  nothing for this computer. The server is not a child of the app: quitting the app stops no server
  and no running chat.
- **A start that fails** shows in the section as **Not started**, with the reason the start gave, a
  **Retry** button and **Open server log** (the file `server.log` in the data folder). The other
  sections keep working, and the app tries again by itself, at growing intervals, as for a remote
  server. A server that was never set up is such a failure: the reason is the not-set-up message,
  which names the set-up command. Run it by hand, once, on the machine, and the app's next try, or
  **Retry**, starts the server.
- **A server that stops while the app is open** is started again by the app. Its section goes to
  not connected and back; the page is not loaded again for it.
- **A server of another build** than the app carries is found and kept: starting the app never
  restarts a running server. The section says that this computer's server runs another build and
  offers **Restart server**. A server that is [too old](#a-server-that-is-too-old) for the app says
  that it is older than the app and offers the restart that brings it to the app's build.
- **The owner's things** are done by the app itself, with the server program, and are no part of
  the client API: **Restart server** (also after the app was updated), **Open server log**, and
  the state of the server's MCP listener, which **Servers** shows on this computer's row. A restart
  halts and continues running work as it always did. After a restart the app reads the address, the
  fingerprint and the secret again.

### Updating from the version before

- **The old server list is not moved.** An earlier server held the list of remote servers and
  their secrets. This version's server deletes `servers.json` and its set-aside copies from its
  data folder, with the secrets in it, at its first start, and holds none from then on. Add the
  remote servers again in **Servers**; the list is the app's now.
- **Set-up comes before the first start.** A server that never had remote access refuses to start
  after the update until you run the set-up (see above); this computer's section shows the refusal
  until then. Once set up, the server is reachable on its network. A server that was set up before
  keeps its secret, its certificate, its names and its port, and its clients go on without
  accepting anything again.
- **What lives on this computer is untouched.** Its chats, boards, groups and prompt library are
  where they were and show in this computer's section.
- **A server of the old build that is still running** is not started a second time. The app says
  that this computer's server is older than the app and offers **Restart server**.
- **The page's own storage starts fresh.** The theme, the widths, what is collapsed, the last
  selection and unsent text that the page kept in the browser's storage are not carried over.
- **What is gone.** The app is no longer used in a browser tab, and the server serves no page.
  The local port 4747 is gone, and so is the server's `-port`, `-client` and `-server-port` flags.
  `remote off` is gone and has no replacement, and `remote status` is `status`. Whatever called the
  local port without a secret, a script or a bookmark, stops working.
- **An older app against this server** is refused with a reason it can show (see
  [The client API](#the-client-api)), and this version's app against an older
  server is [too old](#a-server-that-is-too-old) for it.
- **From a version without sections.** Before sections, the app filed the chats
  and whiteboards of a remote server in your own groups, kept a record of each in the
  folder `remote/` of its data folder, and reached only what it had made itself, which that
  server kept in a group named **Remote**. At its first start the updated server removes the folder
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
  chat, and had not been carried over to its server, is lost. The server looks for all of this at
  every start and changes nothing in a data folder that holds none of it.

### A server that is too old

A server says what it offers a client with one number, its feature level (`featureLevel` of
`/api/hello`): level 1 is chats, 2 adds
[whiteboards](#whiteboards-on-a-remote-server), 3 the [prompt library](prompt-library.md), 4
the chat's draft kept on the server (`PUT /api/chats/{id}/draft`) and the images of a message,
with their upload and fetch (`/api/chats/{id}/images`), 5 the server's whole tree: a client
is given every group, whiteboard and chat of the server and changes them with the calls of the
[client API](#the-client-api), and 6 the client API as the server's only API: it serves its
clients over HTTPS and nothing else, and answers the first question without the secret, and 7
the headless board: a board no page holds is written by the server's own writer, and a reader
follows a board live. A server of this version reports 7, and the app connects to no server below
7, this computer's included. A server of level 7 in turn serves no app below 7 (see
[The client API](#the-client-api)).

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
| `--port N`               | the client port (default: keep it, or 4748 at the first set-up)                    |
| `--new-cert`             | replaces the key and the certificate: every client must accept the new fingerprint |
| `--new-secret`           | replaces the secret: every client needs the new one; a running server takes it at once |
| `--home DIR`             | the data folder (default `~/.ai-whiteboard`)                                       |

`start-server.sh [--restart] [server flags]` runs `launch` (with `--restart`, `relaunch`); the
other arguments are the server's [flags](server-reference.md#flags). The scripts are called through
`sh` because a copy may lose its executable bit. They need no `openssl`.

### Chats on a remote server

A chat in a section lives on that server: its agent runs there, in a folder of that
machine, and its thread, its settings, its draft and its images are stored there. Your own
machine stores nothing of it. The app's main process makes every call on that server and hands the
answer to the page. What is said here of the calls, their
answers and the events holds for the groups and the
[whiteboards](#whiteboards-on-a-remote-server) of a section too, and for this computer's section.
What a server offers the apps that connect to it is in [The client API](#the-client-api).

- **A new chat** is made in a group of the section, outside any group from the section's head,
  or on a whiteboard of the section: a chat on a whiteboard is on the
  board's server. It is made on that server at once, before any message
  (`POST /api/chats` with `group` or `board`), and the answer is the chat,
  with `locked` false. It starts with what that server remembers for its group: agent, folder,
  model, effort and subagent settings. Those choices are that server's own, shared by every
  connected app: what one of them picked last in a group is what the next new chat of
  that group starts with, whoever makes it. Your app remembers none. The
  settings before the first message are changed there, and the first message is an ordinary
  message: the agent starts there. A make that the server cannot take is refused with that
  server's status, code and sentence, and makes nothing, here or there.
- **Several apps.** Every app connected to the server, the owner's included, can have
  the same chat open at the same time. Each sees the thread grow, and the draft and the working
  state as the others change them. Anyone who has the chat open sends, stops, answers a
  permission request and changes the settings before the first message, where the chat's own
  state allows it. A message to a branch that is working is refused (409, `busy`), whoever sent
  the one before. The first answer to a permission request decides, and a later one is refused
  (400). Of two changes of the settings the later one stands.
- **The draft** of a branch is one draft for all of them, kept on the chat's server with that
  server's counter. A save (`PUT /api/chats/{id}/draft?rev=N`) names the counter it
  was typed on, and the answer, `missing` too, is the server's. A save on another counter
  than the stored one is refused (409, `stale`, with the stored counter and draft), so nobody
  replaces what another typed without being told. The page gets the draft and its counter from
  that server's events. A save with `replace` is refused (400, `replace_refused`).
- **Images** are the chat's server's too (see [**Images in a message**](architecture.md)), and your app keeps none.
  - An upload (`POST /api/chats/{id}/images?name=`) is cut at the size limit by your
    app before it is read (413, `image_too_large`), and is then sent with its bytes, the
    type it states and its name. The answer is that server's: the image, or its refusal
    (`image_type`, `image_cap`). While the server is not connected, or is too old, the upload is
    refused unread (503, `server_unreachable`).
  - A picture is never shown as the server sent it. The page shows it from an address of the
    app's own scheme, which names the server, the chat and the image, and the app's main process
    answers it by fetching the image from that server. It takes the bytes of that server's answer
    alone, finds the type from them, and serves them under its own headers. Bytes that
    are not a PNG, JPEG, GIF or WebP image of at most 5 MB are not shown, whatever type that
    server claimed for them: no server of your list can have your app show HTML or SVG of its
    making. A refusal of that server reaches the page with its status, code and sentence, and
    nothing else of it.
  - An image id is checked for its form by your app before it is sent anywhere. A fetch with
    another is refused (400, `image_id`), and so is a message that names one, as for any chat,
    or whose `images` are no list. A draft save is sent without such an id,
    and the answer names it in `missing`, with what that server says the chat does not hold.
- **When the server drops,** its chats leave the sidebar with the rest of the section, and none
  can be opened, made or changed. A chat that is open in a window stays on screen as the page
  had it when the connection ended, read-only, under a warning that names the server and says
  that it is not connected. Nothing is sent, stopped or changed, and the composer says why: its
  box is read-only meanwhile, it keeps what it holds and takes no typing, and no image can be
  removed from the draft. Text that was typed before the connection ended and that the server
  has not taken stays in the open composer and is saved when the
  server is connected again, if the chat is still open then, on the counter the page has (a save
  that is refused as `stale` is handled as any). It is kept nowhere else: the page's storage
  holds no draft of a chat on a remote server, so it is lost when you leave the chat, reload or
  close the window before the server is back. A chat that was left cannot be opened until the
  server is back, and a reload of the page during the outage leaves the chat closed until then.
- **When the server is back,** its section shows its tree as it is then. An open chat
  is brought level with its server, the warning goes and the composer works again. One that
  was deleted there meanwhile says that it is no longer on that server.
- **A make whose answer was lost** (504, `no_answer`) can still have made the chat on that
  server. The chat then shows in the section as any other. Your app looks for none and deletes
  nothing on its account, so an empty chat can stay on that server, where every
  connected app sees it, until somebody deletes it.
- **The calls.** A thing of a section is named by two values: the id of its entry in the server
  list ("local" for this computer), and its own id on that server. An id is unique on one server
  only, so the same id can name a chat of this computer and a chat of a section. A call names its
  server as an argument, never in the path: `POST /api/chats/{id}/messages?branch=main` to the
  server `s_0123456789ab` sends a message to a chat of that section. Method, path, query and body
  are those of the [client API](#the-client-api), and every id in them is that server's own. The
  app checks what the page asks for: a call names a server of the list and a path of the client API
  and nothing else (anything else is 400, `not_client_api`; a server that is no entry of the list
  is 404, `no_server`), and a body over its limit is refused before it is sent (413). The
  answer is the server's own, status and JSON body, with that server's codes and sentences.
  The app answers a few calls itself: a picture, as above, and the end of a follow
  (`POST …/unfollow`) and the release of a whiteboard while the entry is not connected. A group's
  collapse is the page's own, and a `PATCH /api/groups/{id}` with `collapsed` is refused by every
  server (400, `collapsed_refused`). The folders and the usage of an agent of a
  server (`GET /api/dirs` and `GET /api/usage/{agent}`) are calls to that server like the rest, as
  are the answer to an agent's board tool (`POST /api/rpc-reply`) and the
  [prompt library](prompt-library.md).
- **The answer of a call** follows the entry's state. An entry that is not connected, or is
  [too old](#a-server-that-is-too-old), is 503 `server_unreachable` with a sentence that says
  which, and nothing was sent; an entry that waits for its next try is made to try at once.
  Connected, the answer is that server's own: for a chat, a whiteboard or a group that is
  not there it is 404 with the code `not_found`, which the page shows as no longer on that
  server. A 401 of that server is 503 `server_unreachable` (the secret is the entry's matter),
  an answer that is no JSON or is too long is 502 `bad_answer`, and a call that was sent and got
  no answer in time, or whose connection ended, is 504 `no_answer`; for a message that is 504
  `send_unknown`, since it is not known whether it arrived. While the entry is not connected,
  the end of a follow and the release of a whiteboard are answered 200 all the same. A call has
  15 seconds. A call that can wait for an agent's start has 45: a
  message, a fork, the opening of a branch, a read of a chat's context that asks the agent, and
  the archive of a group. A drawing and an image have 60, and the delete of a group with what is
  in it, 3 minutes.
- **The snapshot and the events.** Each server gives the app its own snapshot (`GET /api/state`,
  and the start of its event stream) and its own events, described in
  [The client API](#the-client-api), and the app hands them to the page tagged with the entry's id.
  The page builds the sections from them: a section has a tree only while the app's connection to
  that server is up and its snapshot was read. Besides the servers' events the app tells the page
  of the server list (`servers`, and `server_state` for each entry's state), and when a stream is
  down and back. A stream that is closed for good is an event of the page's transport, and the page
  opens it again. An event about a thing is the server's own event: `groups`, `defaults`, `board`,
  `board_removed`, `chat`, `chat_removed` and `branch_state` go to every connected app, in that
  server's order; `tree`, `chat_items`, `sub` and `sub_items` to the apps that follow the chat;
  `held`, `release_request`, `superseded` and `rpc` to the one app concerned; `scene` and `writer`
  to the apps that follow the board (`POST /api/boards/{id}/follow`, while it is on their screen).
  An app follows a chat
  from its first read of the thread, the tree or a subagent's thread until `…/unfollow`, and the
  app's connection follows the thing on its server for all its windows together. Every follow
  ends when the connection drops: after the snapshot that comes with the next one, the page reads
  again what it shows.

### Whiteboards on a remote server

A whiteboard in a section lives on that server. You draw on it in the app as on any
board; its drawing is stored on that server only, and its chats run there.

- **Creation.** A new whiteboard made in a section, from the "+" of one of its groups or of its
  head, is made on that server at once, in that group, and the window that made it draws on it.
  The app asks nothing about the place, and the place is final: a board is not moved to another
  server or between sections.
- **Where it lives.** The board, its drawing, its name, its group, its archive mark and its
  chats are on the server, and your own machine stores nothing of it. Every board of that
  server is in the section, whoever made it, and one an agent makes there with `create_board`
  shows there as the others do. Rename, move, archive, unarchive and delete are made on that
  server and show to every connected app. A chat made on such a board is on the
  board's server, and is made there at once.
- **Holding.** One window changes a board at a time, among the windows of every app connected to
  that server; to the server your app is one user of the board. Every other window that shows the
  board shows it read-only and follows it live, with the bar "View only." and the button **Edit here**.
  When another app presses its button, your window is asked to save and let go, and its bar says that
  another window took over the board; **Edit here** takes it back. The agents' board tools are
  answered by the window that holds the board; when no window of any app holds it, the server's
  headless writer answers them, if that machine can run it
  ([Who changes a board](architecture.md#who-changes-a-board)), and otherwise the agent is told that
  no board is open. A window that does not answer a call in time loses the board the same way, and
  the headless writer answers the next call.
- **Outage.** While the server is not connected you keep drawing in the window that has the
  board open: a save is answered 503 `server_unreachable`, the changes stay in that window and a
  banner says they are not saved. The board's row leaves the sidebar with the rest of its
  section, and the window stays. No other window gets the board, and a board that is not open in
  a window cannot be opened: a take and a read are answered 503 too. When the server is back,
  the window is a reader of the board and keeps the changes until you press **Edit here**: they are
  saved if nobody changed the board there meanwhile, and dropped, with a notice, if somebody did.
  Closing the window while changes are not saved asks first, and
  closing it anyway loses them. A board that was deleted there meanwhile says that it is no longer
  on that server.
- **The calls** are those of the [client API](#the-client-api), with the answers and the events of
  [Chats on a remote server](#chats-on-a-remote-server). The server alone decides which window
  holds the board, and holds the board for as long as one of them does. An agent's board tool on
  that server reaches the window that holds the board, or the headless writer when none does, as an
  `rpc` event, and it answers with `POST /api/rpc-reply`.
- **Limits.** A drawing saved on a server is at most 128 MB, images included; a larger one is
  refused (413, `too_large`) and stays in the window. Two people cannot draw on a board at the same
  time.

### The client API

What a client does on a server's client port. The client is the app, on the same machine or on
another. **Every client is served alike**: this computer's app as a remote one, with the secret,
over HTTPS. It is given the server's whole tree, whoever made what is in it, and it changes that
tree with the calls below. No mark of who made a thing decides who sees or changes it: whoever has
the secret reads and writes everything on the machine, the owner's own chats too. Nothing is added
to the API for this computer alone.

- **The snapshot** (`GET /api/state`, and the start of the client's event stream) holds every
  group of the server in its order (`groups`), what the server remembers per group for a new
  chat (`defaults`), and every whiteboard (`boards`) and chat (`chats`, with one entry of
  `states` for each branch), archived ones included; and the server's `agents`, `catalogs`, `home`,
  `defaultCwd` and its prompt `library`, with `libraryNotice` when the library file was set aside at
  the server's start. Each list has one order, the same at every read: the groups in the
  server's order, the whiteboards and the chats oldest first (two of the same moment by their id),
  and the branch states by their chat. A server keeps no server list and is a client of no other
  server, so nothing of that is in it, and neither is its data folder.
- **The events** keep that tree current for every client alike:
  `groups` and `defaults` (each whole, after every change), `board` and `board_removed`, `chat`,
  `chat_removed` and `branch_state`, in the order of the changes,
  whoever made them: the owner's app, this client, another client or an
  agent. The events of a thread go to whoever follows the chat: a read of the thread or the
  tree starts the follow, and `…/unfollow`, the end of the stream or the removal of the thing
  ends it.
- **There is no group named Remote.** What a client makes is in the group it names, or in no
  group. A server that is updated from before level 5 removes that group once, at its first
  start: the group its `state.json` remembers as `remoteGroup`, whatever its name is by then.
  The whiteboards and chats in it go to no group and keep their own archive marks (a chat
  on a whiteboard stays with it), and a group nested in it goes to the top level
  with what is in it. A group that is merely named "Remote" is an ordinary group and stays.

The calls that have something of their own:

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/hello` | | `{"app", "version", "featureLevel", "instanceId"}`, with no secret |
| `POST /api/client/flushed` | | `{"ok": true}`, a client's answer to `server_stopping` |
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

The first question, `GET /api/hello`, needs only a `Host` the server knows (a name of its set-up, or
`127.0.0.1` or `localhost` with its port); every other call needs the secret. The routes are listed
in `internal/server` (`ClientRoutes`).

- **A new chat** (`POST /api/chats`) is made in the group or on the whiteboard the
  body names (`group` is a group's id, or `__ungrouped__` for none), unstarted: no agent starts
  and nothing is sent. `id` is a UUID of the client's making, or absent. The chat starts with
  what the server remembers for its place (agent, folder, model, effort and subagent settings),
  and it feeds those choices as any chat of that server does: they are the server's own, the
  same for every client. Its settings are changed with `PATCH` until its first
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
  not have is 404 with `"code": "no_branch"`. Every client saves into
  the same draft, and the counter decides between them: nobody replaces what another typed
  without being told. A draft may name `images`: one the chat does not hold is left out of what
  is stored, and the answer names those left out in `missing` (absent when there are none). The
  chat's `chat` and `branch_state` events and the snapshot carry `draft` and `draftRev`, for a
  chat that has not started too. A save with `?replace=` is refused (400,
  `"code": "replace_refused"`) and stores nothing: a draft is no longer carried over from
  another server.
- **Images.** The upload and the fetch are described in
  [**Images in a message**](architecture.md): the upload is cut at the size limit before
  it is read, the type is found from the bytes, and a draft save and a message name images by
  id. The fetch is answered to every client with the secret.
- **Groups** are made, renamed, moved, nested, archived, unarchived and deleted by a client with
  the same rules everywhere: a group cannot go inside itself or into an
  archived one, and `contents=delete` deletes a group with everything in it, for everyone.
  Whether a group shows collapsed is each app's own matter: a `PATCH` whose
  body has `collapsed` is refused (400, `"code": "collapsed_refused"`), and a group has no
  `collapsed` field. The order of the groups as a whole (`PUT /api/groups/order`) is not offered.
- **Whiteboards.** A client makes a board in a group (`POST /api/boards`) and holds it at once
  if its stream is open. It takes, reads, draws on, renames, moves
  (`PATCH /api/boards/{id}` with `group`), archives and deletes every board of the server, the
  ones its owner made too. One window draws on a board at a time, across every client: to the
  server a client is one user of the board. A drawing a client saves is at most 128 MB (413,
  `"code": "too_large"`).
- **Several clients** may have the same chat open. Each gets its thread, its draft
  and its working state as the others change them. A permission request is answered by whoever
  follows the chat: the first answer decides, and a later one is refused (400). The settings of
  a chat that has not started are the last caller's. The chat's current branch is one for all of
  them: it is the branch the last message with `?branch=` or with a `target` went to, whoever
  sent it, and opening a branch (`POST /api/chats/{id}/open`) does not change it. Which branch a
  window shows is that window's own matter.
- **Refusals.** A body that names a `server` is refused on `POST /api/chats`,
  `POST /api/boards` and `PATCH /api/chats/{id}` (400,
  `"code": "server_refused"`): what a client makes lives on the server it called, and no server
  passes a call on to a third one. A `"run"` key in the body of `POST /api/chats` is
  ignored, so a body with only `agent` and `run` is answered 400 for the missing group, as one
  without `run` is.
  `GET /api/dirs` answers `{"path", "parent", "dirs"}`, `dirs` being the immediate subfolders whose
  names do not start with `.`; to a client that asks for the app's own folder or anything inside
  it, it answers 400.
- **What is gone.** A call that names a chat, a whiteboard or a group that is not there
  is answered 404 with `"code": "not_found"`. A 404 for a part that is missing
  keeps its own code or has none (a branch: `no_branch`; a subagent, an image).
- **A client that is too old.** A client states its own level in the header `X-AIWB-Level` of
  every request. A client that states none, or one below 6, is served nothing but `/api/hello`:
  every other request is answered 400 with `"code": "client_too_old"` and the sentence "This app
  is too old for this server: update AI Whiteboard on the machine that connects." An app of the
  version before this one is such a client. The sentence is in the log of the server it
  called, once a minute for each address that tries.
- **What a client cannot reach.** Every path outside the table of routes is answered 404 (401
  without the secret): there is no server list on a server, no call for another server's things,
  no restart or update, no page, and the data folder is not served as files. The owner's things
  (restart, the server log, the state of the MCP listener, showing a board's file in the file
  manager) are not routes: the app on that machine does them itself, with the server program.
