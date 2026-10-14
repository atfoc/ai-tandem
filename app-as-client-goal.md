# Goal: the app as the client of every server

This document defines an outcome: who talks to whom once the desktop app is the client of every server,
this computer's server included. It says what exists when the work is done, the decisions already made,
the bounds the work must stay inside, and how to confirm that it is done. It is not an implementation plan
and not an order of work. It names no files, functions or steps; how to build it is for whoever builds it.

The same change is drawn on the whiteboard "client-direct-connect-to-remote-server", in its last three
diagrams.

**It stands on another goal.** "Remote servers as sections of the sidebar" (here "the sections goal") is
built and taken as given: a server shows as a section with its whole tree, the same to everyone who
connects, and a client stores nothing of it. Its goal file is gone; what it said is now in the code and in
the architecture and remote-servers documents. This goal changes some of what that goal said (4.10). Where
the two differ, this one holds.

## 1. How to read this

**Marks.** A decision, bound or risk carries one mark. A statement with no mark is `[proposed]`.

- `[user]`: the user decided it.
- `[proposed]`: proposed while the change was planned. Not a decision of the user.
- `[not verified]`: a risk or an assumption nobody has checked yet.

**Terms.**

- **App**: the desktop app.
- **Page**: the web client, shown in the app's window. The same page as today.
- **Main process**: the part of the app outside the window. The page cannot read what it holds.
- **Server**: the AI Whiteboard server program, on any machine.
- **This computer's server**: the server on the machine the app runs on. Today "the local server".
- **Remote server**: a server on another machine.
- **Server list**: the servers the app connects to, each with its address, its secret and the certificate
  fingerprint the user accepted.
- **Client API**: what a server offers a client over HTTPS behind the secret. Today the API of the remote
  port.
- **Local API**: what the server offers its own page today on port 4747, without a secret. It goes away.
- **MCP listener**: the listener on port 6006 that a server's agents use for the board tools.
- **Owner's things**: what only the user of a machine may do with that machine's server: restart it, bring
  it to a newer build, read its log, see the state of its MCP listener, show a file of it in the file
  manager.
- **Section**: the part of the sidebar that stands for one server.
- **Transport**: the one interface through which the page reaches the network (4.6).
- **Mock**: the stand-in for a server that the browser checks of the page run on today.
- **Test host**: a program, used by tests only, that serves the page to a headless browser and does for it
  what the main process does in the app. It holds the server list and the secrets, makes the pinned
  connections and passes the page's calls, events and pictures on. The page talks to it over plain HTTP on
  this computer.

## 2. Goal

Today the app's window shows a page that this computer's server serves, and the page talks to that server
only. The server is two things at once: the home of this computer's chats, boards and runs, and the client
of every remote server, holding the server list and the secrets and passing the page's calls on. It has one
API for its own page and another for clients.

At the end the app is the client and every server is the same thing to it. The page ships inside the app.
The main process holds the server list and the secrets and keeps one connection per server, to this
computer's server as to any other. A server has one API for clients, serves no page and knows no other
server. This computer shows in the sidebar as the first section.

## 3. What the user gets

1. The app's window opens at once, whether or not this computer's server is running.
2. This computer is the first section of the sidebar. The other servers follow, and all behave alike.
3. When this computer's server is down, its section says so and the other sections keep working.
4. Nothing is typed in the app for this computer: no address, no secret, no fingerprint. The one thing the
   user types is the server's set-up command, once, on the machine, before the server's first start (4.5).
5. **Servers** is still the one place where a remote server is added, edited, tested and removed.
6. Restarting this computer's server, and bringing it to a newer build, are still offered in the app.
7. Quitting the app stops no server and no running chat, as today.
8. The app is no longer used in a browser tab.
9. A server folder for another machine is the program and its scripts, with no page beside it.
10. Nothing the user can do with this computer today is lost, except using it in a browser tab.

## 4. What exists at the end

### 4.1 Who talks to whom

- The page talks to the main process and to nothing else `[user]`. It reaches no server by itself.
- The main process keeps one connection per entry of the server list, this computer's server included
  `[user]`. Each is HTTPS, with the server's secret, to a certificate accepted by its fingerprint.
- No secret reaches the page `[user]`.
- A call and the live stream of a server's events cross between the page and the main process over IPC, the
  app's own channel between a window and the main process `[user]`.
- A picture of a chat is the third kind of thing and crosses another way: the page shows it from an address
  of a URL scheme of the app's own, which the main process answers (4.6) `[user]`. A page cannot load a
  picture from a server itself: the browser engine would refuse the certificate, which only the fingerprint
  accepts, and an image tag cannot carry the secret.
- The page knows the network through the transport alone (4.6) `[user]`.
- A server talks to no other server.

### 4.2 This computer in the sidebar

- The sidebar is sections only. The first is this computer `[user]`. It is always there, with or without
  remote servers, and it is no entry the user can remove or edit in **Servers**.
- It is a section as the sections goal describes one: the same head, the same states with the same words,
  the same rows, the same "+" of the head, the same collapse.
- Everything that lives on this computer shows in it, as it shows in the local part today.
- What sets it apart from another section:
  - it is first;
  - the app starts its server and starts it again when it stops (4.4);
  - the owner's things are offered for it (4.7);
  - showing a file in the file manager works for it, as it works for a local thing today.
- The "+" of the sidebar's head makes things on this computer.
- Nothing is moved between this computer's section and another, as nothing is moved between two sections.

### 4.3 The window and the page

- The page ships inside the app. The page and the app are one build: there is no notice that a newer page
  is waiting, and a difference between the app and a server is a matter of the feature level and nothing
  else.
- The window opens with the page from the app's own files and does not wait for any server.
- Closing the window or quitting still waits for unsaved drawing, as today. A link to another site still
  opens in the default browser, and the window never leaves the app's page.
- A second start of the app while it runs brings the open window forward, as today.
- While the app is closed no connection is held, to any server. Nothing is missed by that: the app stores
  nothing of a server, and each section fills again when the app opens.

### 4.4 Starting this computer's server

- Meanwhile the window is open, the app finds this computer's server or starts it, as it does today. The
  server is not a child of the app and outlives it.
- The app learns this computer's address and certificate fingerprint from the command that starts the
  server, and its secret from the command that prints the secret `[user]`. The user types none of them and
  accepts no fingerprint for this computer.
- Until the server answers, this computer's section says that it is connecting. Then it fills.
- **A start that fails** shows in this computer's section: that the server did not start, the reason the
  start gave, a way to try again and a way to open the server log. No dialog stands in front of the other
  sections, which keep working. The app tries again by itself, at growing intervals, as it does for a
  remote server `[user]`.
- **A server that was never set up** refuses to start (4.5). That is a start that fails, as above: the
  section shows the server's reason, which names the command that sets it up. The user runs that command by
  hand, once, on the machine `[user]`, and the next try of the app, or Retry, starts the server.
- **A server that stops while the app is open** is started again by the app, as today. Its section goes to
  not connected and back. The page is not loaded again for it.
- **A server of another build** than the app carries is found and kept, as today: starting the app never
  restarts a running server. The app says that this computer's server is of another build and offers to
  restart it (4.7).
- **A server that is too old** for the app shows in its section as any server that is too old does, and for
  this computer the app offers the restart that brings it to the app's build.

### 4.5 The server

- **One API for clients**, the client API `[user]`. The local API and its port are gone. Everything the page
  uses of the local API today is in the client API, over HTTPS, so nothing the page does today is lost
  `[user]`. The one exception is the owner's things (4.7), which the app does itself.
- **What the server no longer does** `[user]`: it serves no page file, keeps no server list, connects to no
  other server and passes no call on. Opening a server's address in a browser shows no app.
- **Two listeners**: the one for clients and the MCP listener. The MCP listener is unchanged.
- **The client listener** is the HTTPS listener the server has for remote access today, on the same port
  (4748 at first) `[user]`. It is the one listener for every client, this computer's app included.
- **Who can reach it**: the network, as soon as the server runs `[user]`. It listens on every IPv4 address
  of the machine, as the remote port does today, and every client needs the secret. A server runs only
  after its set-up, so every server that runs is reachable on its network. Keeping it off the internet is
  up to the machine's network and firewall, as today.
- **The secret is asked for from every client**, one on this computer included. HTTPS is always used.
- **The question a client asks first**, which server this is and what it offers, is answered without the
  secret, as today.
- **No start without set-up** `[user]`. The set-up of remote access stays as it is today: a command the
  user runs by hand, once, on the machine, before the server's first start. It makes the certificate and
  the secret and takes the options it takes today: the names and addresses in the certificate, the port,
  and replacing the certificate. A server that was never set up refuses to start, and its message names
  the command that sets it up. The client listener is therefore always HTTPS with a secret. There is no
  remote access to turn off, so the command that turned it off is removed.
- **A server already set up** for remote access keeps its secret, its certificate, its names and its port.
  Its clients go on without accepting anything again.
- **The commands** of the server program keep their meaning: run in the foreground, start in the background
  (it gives the app the address and the certificate fingerprint, not only the URL), restart, stop, print or
  replace the secret, and set remote access up. Each that starts a server refuses when the set-up was not
  made. What the commands show of a server's state, today `remote status`, is one command, `status`
  `[user]`. Each command that looks for a running server finds it. The option that named the folder of the
  page is gone.
- **The feature level** a server reports is raised from 5, where the sections work left it. The app
  connects to no server below it.
- **The server folder for another machine** holds the program and its scripts and no page. Making it needs
  no build of the page.

### 4.6 The app's connection to servers

- **The server list and the secrets are the app's** `[user]`. They are kept where the page cannot read
  them, in a file, no less protected than the server keeps them today `[user]`.
- **A connection** to a server behaves as the connection of today's local server to a remote one: the first
  question, the check of the fingerprint and of the feature level, the stream that starts with a snapshot,
  a silent stream that counts as ended, the retries at growing intervals, and a refused secret that ends
  the trying until the entry changes. **Servers** still says at which step a connection fails.
- **Every call has a defined answer** for the page in each state of the server: connected, not connected,
  too old, no answer in time, an answer that cannot be read, and a thing that is gone there. The page can
  tell these apart as it can today.
- **A picture** of a chat reaches the page only after the main process has looked at its bytes: it is one
  of the image types a message takes, within the size limit, whatever type the server claimed. No server
  can have the app show HTML or SVG of its making.
- **The transport** is the one interface the page has to the network `[user]`. It has three parts:
  - a call: a server of the list, a method, a path, a body that is JSON or bytes, with a way to cancel and
    a way to let a save finish while the page unloads, answering a status and a body;
  - the stream: a function for each event and one for a change of the stream's state, answering a way to
    close it;
  - the address of a picture, given from the server, the chat and the picture's id.
- **The server is an argument of the transport**, the entry's id, and is no part of the path. Today's
  `/api/on/<entry id>` relay path is not carried over, and each platform routes by the entry its own way
  `[user]`.
- **A state of the stream** that the page needs, such as "closed for good, open it again", is an event of
  the transport and not a reading of the browser's own stream `[user]`.
- **In the desktop app the transport is made over IPC.** The page gets a fixed set of functions from the
  window and no more; the main process answers them. It holds one stream per entry, passes each event to
  the page, opens the stream again after a break, and tells the page when a stream is down and back.
- **A picture in the desktop app** is shown from an address of the app's own URL scheme. The main process
  answers a request for it by fetching the picture over the pinned connection with the secret and looking
  at its bytes. The page keeps its plain image tags and the browser engine's lazy loading, and keeps no
  copy of the bytes to let go. The scheme is for pictures and for nothing else `[user]`. Another platform
  makes the address its own way.
- **In a headless browser for tests the transport is made over HTTP to the test host** `[user]`. The page
  sends a call with `fetch`, takes the stream with the browser's own `EventSource` (the host holds the
  secrets, so no header is needed and no library), and shows a picture from a plain address on the host.
  The server is an argument as everywhere, carried to the host in a way of the host's own. One stream
  carries the events of all servers, each with its entry's id, as over IPC.
- **The way is chosen when the page starts**: IPC when the window gave the page its functions, HTTP when
  the page was given the host's address.

### 4.7 The owner's things on this computer

- For this computer's section the app offers what the page offers for the local server today: restart the
  server, restart it on the app's build after the app was updated, open the server log, and see the state
  of the MCP listener.
- The app does these itself, with the server program it carries `[proposed]`. They are not part of the
  client API, and no client on another machine can do them. The page asks the main process for them over
  IPC. After a restart the app reads the address, the fingerprint and the secret again.
- A restart of this computer's server halts and continues running work exactly as it does today.

### 4.8 The page outside the app

- The app is not used in a browser tab `[user]`. No server serves the page, and the instructions for
  running it in a browser are gone.
- The page can still be opened in a headless browser, for tests `[user]`. An agent that builds a change to
  the page can see and check it there without the app, from any headless browser or the agent's own browser
  tool. Nothing is injected into the page by the test tool.
- The browser checks that run on the mock keep working, with the mock following the client API.
- Tests of the page against a real server go through the test host `[user]`. The mock can stand behind the
  same face as the host, so one transport serves the checks on the mock and the checks on a real server.
- The page run from a checkout during development works in the app without packaging it.

### 4.9 Changing over what exists

- **The old server list** of this computer's server is not moved `[user]`. This is a breaking change: the
  remote servers are added again in the app, in **Servers**. The new server deletes the old list from its
  data folder, with its secrets, and holds none from then on. Nothing reads it and hands it to the app.
- **What lives on this computer** is untouched: its chats, boards, runs, groups and prompt library are where
  they were and show in this computer's section.
- **A server that never had remote access** refuses to start after the change until the user runs the
  set-up by hand (4.5). This computer's section shows the refusal until then. Once set up, it is reachable
  on its network.
- **A running server of the old build**, found when the new app starts, is not started a second time. The
  app says that it must be restarted, and offers it.
- **An older app** that finds a server of the new build is refused with a reason it can show, as a client
  below the feature level is.
- **What the page kept in the browser's storage** (the theme, the widths, what is collapsed, the last
  selection, unsent text) is not carried over: it starts fresh `[user]`.
- **Documentation** says what is true at the end: how the app and the server are built and started, the
  server's commands and flags, the server folder for another machine, and remote access. What told the user
  to read the MCP listener's state on port 4747 is corrected.

### 4.10 What changes in the sections goal

- **"Local server"** there is this computer's server here, and **"client"** there is the app here.
- **The local part** of the sidebar becomes this computer's section. What that goal says of the local part
  holds for this section, and what it says of moving between the local part and a section holds between
  this section and another.
- **"The page talks to the local server only"** becomes: the page talks to the main process only.
- **What the local server keeps** becomes what the app keeps: the server list, and nothing else of any
  server.
- **The remote server's own page** becomes the app on that machine, whose first section is that machine.
  Owner and client are no longer two roles `[user]`: the owner is a client on the same machine.
- **Collapse** is kept by the app's page, per app.
- **An image of a remote chat** is checked by the main process, where that goal says the local server
  serves it.
- **"No chain"** holds by itself: a server has no server list.
- Everything else of that goal holds as written, for this computer's section as for any other.

## 5. Decisions

| # | Decision | Mark |
|---|---|---|
| D1 | The app is the client of every server. The page reaches a server only through the main process. | `[user]` |
| D2 | This computer's server is one of the servers: the first section, reached as any other, over HTTPS with a secret and a pinned certificate. | `[user]` |
| D3 | The main process holds the server list and the secrets. No secret reaches the page. The secrets are kept in a file, not in the system's keychain. | `[user]` |
| D4 | The server has one API for clients. It has no relay, no pass-through, no page files and no server list. Everything the page uses of the local API today is in it; only the owner's things (D13) are not. | `[user]` |
| D5 | The page ships inside the app. | `[user]` |
| D6 | The app outlives this computer's server: the window opens before any server answers, and with the server down its section is empty and the others work. A failed start shows in this computer's section, and the app tries again by itself at growing intervals. | `[user]` |
| D7 | The page and the main process talk over IPC for a call and the stream. A URL scheme of the app's own is used for pictures only (D9). | `[user]` |
| D8 | The page asks for a call, the stream and the address of a picture in one place, the transport. It has ways of working: IPC in the desktop app, HTTP in a headless browser for tests and in a later phone app. The server is an argument of it, by the entry's id; no path carries it. A change of a stream's state is an event of the transport. | `[user]` |
| D9 | In the desktop app a picture is shown from an address of the app's own URL scheme, which the main process answers by a fetch over the pinned connection and a look at the bytes. Not from a copy of the bytes held in the page. | `[user]` |
| D10 | The main process's way to a server does not change: HTTPS, the secret, the pinned fingerprint. Only the way between the page and the main process goes through the transport. | `[user]` |
| D11 | The app gets this computer's address and fingerprint from the command that starts the server, and the secret from the command that prints it. | `[user]` |
| D12 | The client listener is the HTTPS listener of remote access today, on the same port, open to the network as soon as the server runs. The set-up of remote access stays a command the user runs by hand, once; a server that was never set up refuses to start and names that command. There is no command that turns remote access off. `remote status` and the other status of a server are one command, `status`. | `[user]` |
| D13 | The owner's things are done by the app with the server program it carries, not through the client API. | `[proposed]` |
| D14 | The feature level is raised, and the app connects to no server below it. | `[user]` |
| D15 | The app is not used in a browser tab. The page can still be run in a headless browser, for tests. | `[user]` |
| D16 | Tests of the page against a real server use a test host that is never shipped, not a mode of the server or of the app. The tests do not drive the app, except the few in 7.3. | `[user]` |
| D17 | The main process and the test host use one module for the connection to a server: the server list and secrets, the pinned HTTPS, the secret, the checking of a picture's bytes, a stream per server and its opening again. The host adds only the HTTP face, the main process only the IPC face. | `[proposed]` |
| D18 | The server list is not moved from the server to the app. Remote servers are added again in the app, and the old list is deleted from the server's files. | `[user]` |
| D19 | What the page kept in the browser's storage is not carried over: it starts fresh. | `[user]` |
| D20 | A phone app for iOS and Android, with React Native, is a later task, and how a connection to a server behaves is not tied to the desktop app so that the phone app can use the same. Both are out of scope now. | `[user]` |

## 6. Bounds

**The parts.**

- **Three parts, as today.** The server stays the Go program, the app stays the Electron app, and the page
  stays the one web client. No part is replaced by this goal.
- **One page.** The page in the app and the page in a headless browser are the same build of the same code.
  There is no second user interface for tests. The HTTP way of the transport is part of that build and is
  not run in the app.
- **One API.** The app gets nothing from a server that another client does not get. Nothing is added to the
  client API for this computer alone.
- **The test host is no part of a shipped build, and no server serves it.** It holds secrets and passes
  calls on, so it listens on this computer's loopback address only, on a port it picks, and is started by a
  test or by an agent that checks a change. The app carries no code of it.
- **The server never depends on the app.** It is started detached, runs on without the app, and every
  command of it works on a machine that has no app.
- **The MCP listener is not touched**: its port, its being reachable from this computer only, and what the
  agents are told about it. An agent's board tools are still answered by the window that holds the board;
  a board that no window holds is answered as it is today with no page open `[user]`.

**The page and the main process.**

- **The page holds no secret and names no file.** What it asks the main process for is checked there: a
  call names a server of the list and nothing outside the client API, and a file is read only when the
  app's own dialog returned it.
- **Only the app's own page is answered.** A request to the main process from another window, from a frame
  inside the page, or from a page that has gone elsewhere is refused, as today. The same holds for a
  request for an address of the app's own URL scheme: it names a server of the list, a chat and a picture
  and nothing else, and it is answered only for the app's own page.
- **One place asks.** Nothing in the page reaches a server, the main process or the network except through
  the transport: no `fetch`, no `EventSource` and no address of a server outside it. The rest of the page
  does not know which way the transport is made.
- **Every way means the same.** A call, the stream and the address of a picture behave alike over IPC and
  over HTTP: the same answers, the same order of events, the same states of a server, and the same notice
  when a stream is closed for good.
- **The scheme is for pictures only.** The app's own URL scheme answers a request for a picture and nothing
  else: no page file, no call, no stream.
- **Not tied to the desktop app.** The behaviour of a connection, the server list's rules and what the page
  is told of a server's state are written so that an app on another platform can use them with its own way
  of making a connection.

**Between the app and a server.**

- **The fingerprint decides.** A certificate is accepted by the fingerprint the list holds and by nothing
  else, for this computer's server too. A changed certificate is a state the user is shown, as today.
- **No weaker path for this computer.** There is no listener without the secret, no plain HTTP and no
  skipped check because the server is on the same machine.
- **One connection per entry** carries everything of that server.
- **An id is unique on one server only**, this computer's included.
- **What a client cannot reach** on a server stays as the sections goal has it: its secrets, its restart
  and update, and its data folder as files.
- **A picture is taken from its bytes alone.**

**What goes away is removed**, not left unused: the local API and its port, the serving of the page, the
relay and the pass-through, the server's own server list and its connections to other servers, the notice
of a newer page, the window that says "Starting…" and the start error dialog, and the instructions for
using the app in a browser.

**Waits.** The time a call may take, the longer time an upload, a fetch of a picture and a drawing may
take, the silence after which a stream counts as ended, the intervals of the retries and the time a too-old
entry waits before it is asked again keep today's values. Each can be lowered by a test and keeps its value
otherwise.

**Tests follow the repository's testing rules.** No paid test is run unless the user asks.

## 7. How to confirm it is built

Every statement of section 4 and every bound of section 6 that a test can show has a test. Where a
statement cannot be shown by a test, it is checked by hand (7.4).

### 7.1 Tests that are easy to get wrong

- a server that was never set up refuses to start, with a message that names the set-up command, and starts
  once it is set up; this computer's section shows the refusal until then;
- a call without the secret is refused on this computer as from another machine, and the first question is
  answered without it;
- a server serves no page, at any address;
- setting remote access up and replacing the secret, each with a client connected, and `status` showing
  what the running server serves and what the next start will do;
- each command that looks for a running server finds one of this build, and one of the build before;
- the app with this computer's server running, not running, failing to start, stopping while the app is
  open, of another build, and too old;
- a remote server that is down does not hold up this computer's section, and the other way round;
- the page gets no secret and cannot ask for a server outside the list, a path outside the client API or a
  file;
- a request to the main process from anything but the app's own page is refused;
- a picture whose bytes are not an image of the taken types never reaches the page;
- a call, the stream and the address of a picture give the same results over IPC and over HTTP;
- the app's own scheme answers a picture of a server of the list and nothing else, and not for another
  window, a frame or a page that has gone elsewhere;
- a stream that is closed for good is reported by the transport, and the page opens it again;
- a stream that goes silent, a refused secret and a changed certificate, each for this computer's server
  too;
- every capability the page uses of the local API today has an answer in the client API, except the owner's
  things;
- the server list after the change-over: the app's list is empty of remote servers, one added in
  **Servers** connects, and the server's data folder holds no list;
- an older app against a new server, and the new app against an old running server;
- the owner's things work for this computer and cannot be reached by a client on another machine.

Code where several things happen at once (several connections, a server that stops in the middle of a call)
is also run under the race detector, or the like of it for the app's own code.

### 7.2 In a headless browser

The page on the mock, and the page against a real server through the test host. The host is checked once
for what it must not do: listen on an address other than the loopback one, hand a secret to the page, or
answer a server outside its list. The pinned connection, the secret and the check of a picture's bytes are
run by the module the main process uses too (D17), so they are tested here and not copied.

### 7.3 In the app itself

A few tests: the page over IPC, with a call, a stream that is cut and comes back, and a picture shown from
the app's own scheme, from a server whose certificate is self-signed. The IPC layer and the window's
functions are reached only by these.

### 7.4 By hand

- a first start on a machine that never ran AI Whiteboard, with the set-up run by hand;
- an update from the version before, with a remote server in the list and with a server still running;
- killing this computer's server while a chat is open and while a board is drawn on;
- two machines, each with the app, each a client of the other.

## 8. Accepted consequences

Each follows from a decision above and is accepted.

- **No browser tab.** A machine without the app cannot show AI Whiteboard, whatever server runs on it.
  Follows from D5 and D15.
- **A server on Linux has no screen of its own.** The app is built for macOS only, so such a server is used
  from a Mac. Follows from D5.
- **The app is needed to see anything.** With the app closed nothing is connected. Servers and their agents
  run on. Follows from D1.
- **Every server that runs is reachable on its network**, with the secret as the only check. A laptop that
  never used remote access is no longer closed to its network once it is set up. Follows from D12.
- **A first start needs one typed command.** On a machine whose server was never set up, this computer's
  section shows a failed start, with the reason, until the user runs the set-up by hand. Follows from D12.
- **Whatever used `remote off` or `remote status` stops working**: the first has no replacement, the second
  is now `status`. Follows from D12.
- **Whatever called the local API without a secret stops working**: a script, a bookmark of port 4747.
  Follows from D4.
- **This computer's secret can be read by any program of the same user**, as the command that prints it can
  be run by one. That is so today for a server that was set up. Follows from D11.
- **The page's way of asking is rewritten** to go through the transport. The page then has no
  `/api/on/<entry id>` path and no reading of the browser's own stream. Follows from D8.
- **More than one way of asking lives in the page**: IPC in the app, HTTP to the test host in a headless
  browser. The browser tests run only the HTTP one. Follows from D8 and D16.
- **The app and this computer's server can be of different builds** until the user restarts the server, as
  today. Follows from 4.4.

## 9. Risks and assumptions not verified

These do not change what is built. If one turns out false, the outcome above still holds and the way to it
changes.

| What | Mark |
|---|---|
| What happens at port 4747 after the change: a script or bookmark that called it stops working (accepted). A server of the old build that is still running holds the MCP port, so a second server cannot start beside it; the app has to find it by its old address. | `[not verified]` |
| Whether the browser engine's lazy loading and cancelling work with the app's URL scheme in the app's Electron version, and what the main process's fetch of many pictures at once costs. | `[not verified]` |
| The stream over IPC: the order of events and what happens when a server sends faster than the page takes. Today the browser's own stream does this. Accepted: it must behave as today. | `[not verified]` |
| That the stream of all servers over one HTTP connection behaves as over IPC. | `[not verified]` |
| How much of the main process's connection code can be shared with the test host without Electron (D17). | `[not verified]` |
| That a request to the app's own scheme can be told from another window's or frame's by what the main process is handed, as an IPC call is today. | `[not verified]` |
| That a board no window holds is answered the same way with the app as the only client as today with no page open. Accepted: the behaviour stays as it is today. | `[not verified]` |
| How far the app itself can be run by tests without a screen on macOS. | `[not verified]` |
| What a phone app needs (React Native and its web view, pinning a self-signed certificate by fingerprint with native code, an event-stream client since React Native has no `EventSource`) was reasoned from memory and not checked. Out of scope now. | `[not verified]` |

## 10. Not in this goal

- The phone app, and what only it needs: a connection behaviour shared with it, its native pinning of a
  self-signed certificate and its client for the event stream (D20).
- The app for Linux or Windows.
- Using the app in a browser.
- A URL scheme of the app's own for anything but pictures: the page's files, a call and the stream stay as
  they are (D7).
- Any change to the main process's way to a server: HTTPS, the secret and the pinned fingerprint stay
  (D10).
- Keeping a connection, or telling the user of anything, while the app is closed.
- Starting a server at login or after a reboot, an installer or a service file.
- Signing the app and updating it by itself.
- Limits per client, and anything else the sections goal leaves out.
- Changing the MCP listener or how the agents reach the board tools.
