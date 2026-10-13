# The app as the client of every server

A goal document for changing who talks to whom: the desktop app becomes the client of every server, the
server on this computer included, and the server becomes a program with one API for clients that serves no
page. Nothing in it is built yet. It says what is built, what is expected at the end, and the decisions and
bounds the work has to keep. It does not say how to build it: no files, no functions, no steps and no order
of work.

The same change is drawn on the whiteboard "client-direct-connect-to-remote-server", in its last three
diagrams.

**It stands on another goal.** "Remote servers as sections of the sidebar"
(`plans/remote-server-sections-goal.md`, here "the sections goal") is taken as given: a server shows as a
section with its whole tree, the same to everyone who connects, and a client stores nothing of it. This goal
changes some of what that goal says. Section 3.9 lists each such place. Where the two differ, this one holds.

## How to read this

**Marks.** A decision, bound or risk carries one mark:

- `[user]`: the user decided it.
- `[proposed]`: proposed while the change was planned. Not a decision of the user.
- `[not verified]`: a stated risk or an assumption nobody has checked yet.

A statement in section 3 with no mark is `[proposed]`.

**Terms.**

- **App**: the desktop app.
- **Page**: the web client, shown in the app's window. It is the same page as today.
- **Main process**: the part of the app outside the window. The page cannot read what it holds.
- **Server**: the AI Whiteboard server program, on any machine.
- **This computer's server**: the server on the machine the app runs on. Today "the local server".
- **Remote server**: a server on another machine.
- **Server list**: the servers the app connects to, each with its address, its secret and the certificate
  fingerprint the user accepted.
- **Client API**: what a server offers a client over HTTPS behind the secret. Today the API of the remote
  port, as the sections goal leaves it.
- **Local API**: what the server offers its own page today on port 4747, without a secret. It goes away.
- **MCP listener**: the listener on port 6006 that the agents of a server use for the board tools.
- **Owner's things**: what only the user of a machine may do with that machine's server: restart it, bring
  it to a newer build, read its log, see the state of its MCP listener, show a file of it in the file
  manager.
- **Section**: the part of the sidebar that stands for one server.
- **Mock**: the stand-in for a server that the browser checks of the page run on today.
- **Test host**: a program, used by tests only, that shows the page in a browser and does for it what the
  main process does in the app.

## 1. Goal

Today the app's window shows a page that this computer's server serves, and that page talks to that server
only. The server is two things at once: the home of this computer's chats, boards and runs, and the client
of every remote server, which holds the server list and the secrets and passes the page's calls on. It has
one API for its own page and another for clients.

The goal is that the app is the client and every server is the same thing to it. The page ships inside the
app. The main process holds the server list and the secrets and makes one connection per server, to this
computer's server as to any other. A server has one API for clients, serves no page and knows no other
server. This computer shows in the sidebar as the first section.

## 2. What the user gets

1. The app's window opens at once, whether or not this computer's server is running.
2. This computer is the first section of the sidebar. The other servers follow, and all behave alike.
3. When this computer's server is down, its section says so and the other sections keep working.
4. Nothing is typed for this computer: no address, no secret, no fingerprint.
5. **Servers** is still the one place where a remote server is added, edited, tested and removed.
6. Restarting this computer's server, and bringing it to a newer build, are still offered in the app.
7. Quitting the app stops no server and no running chat, as today.
8. The app is no longer used in a browser tab.
9. A server for another machine is the program and its scripts, with no page beside it.

## 3. What is expected at the end

### 3.1 Who talks to whom

- The page talks to the main process and to nothing else `[user]`. It reaches no server by itself.
- The main process makes one connection per entry of the server list, this computer's server included
  `[user]`. Each is HTTPS, with the server's secret, to a certificate accepted by its fingerprint. This
  holds for this computer's server too `[user]`.
- No secret reaches the page `[user]`.
- The page and the main process talk over the app's own channel between a window and the main process
  (IPC) `[user]`. Three kinds of things cross it: a call with its answer, the live stream of a server's
  events, and a picture.
- A server talks to no other server.

### 3.2 This computer in the sidebar

- The sidebar is sections only. The first is this computer `[user]`. It is always there, with or without
  remote servers, and it is no entry the user can remove or edit in **Servers**.
- It is a section as the sections goal describes one: the same head, the same states with the same words,
  the same rows, the same "+" of the head, the same collapse.
- Everything that lives on this computer shows in it, as it shows in the local part today.
- What sets it apart from another section:
  - it is first;
  - the app starts its server and starts it again when it stops (3.3);
  - the owner's things are offered for it (3.6);
  - showing a file in the file manager works for it, as it works for a local thing today.
- The "+" of the sidebar's head makes things on this computer.
- Nothing is moved between this computer's section and another, as nothing is moved between two sections.

### 3.3 Starting

- The window opens with the page from the app's own files. It does not wait for any server.
- Meanwhile the app finds this computer's server or starts it, as it does today. The server is not a child
  of the app and outlives it.
- The app learns this computer's address and certificate fingerprint from the command that starts the
  server, and its secret from the command that prints the secret `[user]`. The user types none of them and
  accepts no fingerprint for this computer.
- Until the server answers, this computer's section says that it is connecting. Then it fills.
- **A start that fails** shows in this computer's section: that the server did not start, the reason the
  start gave, a way to try again and a way to open the server log. No dialog stands in front of the other
  sections, which work meanwhile.
- **A server that stops while the app is open** is started again by the app, as today. Its section goes to
  not connected and back. The page is not loaded again for it.
- **A server of another build** than the app carries is found and kept, as today: starting the app never
  restarts a running server. The app says that this computer's server is of another build and offers to
  restart it (3.6).
- **A server that is too old** for the app shows in its section as any server that is too old, and for
  this computer the app offers the restart that brings it to the app's build.
- A second start of the app while it runs brings the open window forward, as today.

### 3.4 The server

- **One API for clients**, the client API `[user]`. The local API is gone.
- **What the server no longer does** `[user]`: it serves no page file, keeps no server list, connects to no
  other server and passes no call on.
- **Two listeners**: the one for clients and the MCP listener. The MCP listener is unchanged.
- **Who can reach the client listener.** By default only this computer. Setting remote access up opens it
  to the network, with the names and the port that set-up takes today. Turning remote access off closes it
  to the network again. This computer still reaches it either way.
- **The secret is asked for from every client**, one on this computer included. HTTPS is used always.
- **Certificate and secret exist from the first start.** A server that was never set up makes both by
  itself. No set-up step is needed before the app can use this computer's server.
- A server that was set up for remote access before this change keeps its secret, its certificate, its
  names and its port. Its clients go on without accepting anything again.
- The question a client asks first, which server this is and what it offers, is answered without the
  secret, as today.
- **The commands** of the server program keep their meaning: run in the foreground, start in the
  background, restart, stop, set remote access up, show its status, turn it off, print or replace the
  secret. Each that looks for a running server finds it. The option that named the folder of the page is
  gone.
- **The server folder for another machine** holds the program and its scripts and no page. Making it needs
  no build of the page.
- Opening a server's address in a browser shows no app.

### 3.5 The app

- **The server list and the secrets are the app's** `[user]`. They are kept where the page cannot read
  them, no less protected than the server keeps them today.
- **The connection** to a server behaves as the connection of today's local server to a remote one: the
  first question, the check of the fingerprint and of the feature level, the stream that starts with a
  snapshot, a silent stream that counts as ended, the retries at growing intervals, and a refused secret
  that ends the trying until the entry changes. **Servers** still says at which step a connection fails.
- **Every call has a defined answer** for the page, in each state of the server: connected, not connected,
  too old, no answer in time, an answer that cannot be read, and a thing that is gone there. The page can
  tell these apart as it can today.
- **A picture** of a chat reaches the page only after the main process has looked at its bytes: it is one
  of the image types a message takes, within the size limit, whatever type the server claimed. No server
  can have the app show HTML or SVG of its making.
- **While the app is closed** no connection is held, to any server. Nothing is missed by that: the app
  stores nothing of a server, and each section fills again when the app opens.
- **The page and the app are one build.** There is no notice that a newer page is waiting. A difference
  between the app and a server is the feature level's matter and nothing else's.
- This change raises the feature level a server reports. The app connects to no server below it.
- Closing the window or quitting still waits for unsaved drawing, as today. A link to another site still
  opens in the default browser, and the window never leaves the app's page.

### 3.6 The owner's things on this computer

- For this computer's section the app offers what the page offers for the local server today: restart the
  server, restart it on the app's build after the app was updated, open the server log, and the state of
  the MCP listener.
- The app does these itself, with the server program it carries. They are not part of the client API, and
  no client on another machine can do them.
- A restart of this computer's server halts and continues running work exactly as it does today.

### 3.7 The page outside the app

- The app is not used in a browser tab `[user]`. No server serves the page, and the instructions for
  running it in a browser go.
- The page can still be opened in a headless browser, for tests `[user]`. An agent that builds a change to
  the page can see and check it there without the app.
- The browser checks that run on the mock keep working, with the mock following the client API.
- Tests of the page against a real server, in a headless browser, go through the test host. The test host
  is used by tests only and is in no build that is shipped.
- The page run from a checkout during development works in the app without packaging it.

### 3.8 Changing over what exists

- **The server list** of this computer's server moves to the app once: every entry with its name, its
  address, its secret and its accepted fingerprint. The user enters nothing again. Afterwards the server's
  data folder holds no server list.
- **What lives on this computer** is untouched: its chats, boards, runs, groups and prompt library are
  where they were and show in this computer's section.
- **A server that never had remote access** gets its certificate and its secret at its first start after
  the change and is reachable from this computer only.
- **A running server of the old build**, found when the new app starts, is not started a second time. The
  app says that it must be restarted, and offers it.
- **An older app** that finds a server of the new build is refused with a reason it can show, as a client
  below the feature level is.
- **What the page kept in the browser's storage** (the theme, the widths, what is collapsed, the last
  selection, unsent text) is carried over or starts fresh. Which of the two is not decided (V2).

### 3.9 What changes in the sections goal

- **"Local server"** there is this computer's server here, and **"client"** there is the app here.
- **The local part** of the sidebar (its 3.1) becomes this computer's section. What that goal says of the
  local part holds for this section, and what it says of moving between the local part and a section holds
  between this section and another.
- **"The page talks to the local server only"** (its bounds) becomes: the page talks to the main process
  only.
- **What the local server keeps** (its 3.12) becomes what the app keeps: the server list, and nothing else
  of any server.
- **The remote server's own page** (its 3.11) becomes the app on that machine, whose first section is that
  machine. Owner and client are no longer two roles `[user]`: the owner is a client on the same machine.
- **Collapse** (its 3.13) is kept by the app's page, per app.
- **An image of a remote chat** is checked by the main process, where that goal says the local server
  serves it.
- **"No chain"** holds by itself: a server has no server list.
- Everything else of that goal holds as written, for this computer's section as for any other.

## 4. Decisions

| # | Decision | Mark |
|---|---|---|
| D1 | The app is the client of every server. The page reaches a server only through the main process. | `[user]` |
| D2 | This computer's server is one of the servers: the first section, reached as any other, over HTTPS with a secret and a pinned certificate. | `[user]` |
| D3 | The main process holds the server list and the secrets. No secret reaches the page. | `[user]` |
| D4 | The server has one API for clients. It has no relay, no pass-through, no page files and no server list. | `[user]` |
| D5 | The page ships inside the app. | `[user]` |
| D6 | The app outlives this computer's server: with it down its section is empty and the others work. | `[user]` |
| D7 | The page and the main process talk over IPC, for now. A URL scheme of the app's own is not used. | `[user]` |
| D8 | The app gets this computer's address and fingerprint from the command that starts the server, and the secret from the command that prints it. | `[user]` |
| D9 | The app is not used in a browser tab. | `[user]` |
| D10 | The page can still be run in a headless browser, for tests. | `[user]` |
| D11 | A phone app for iOS and Android, with React Native, is a later task. | `[user]` |
| D12 | The page asks for a call, the stream and a picture in one place, which has two ways of working: over IPC in the app, over HTTP in a browser for tests. | `[proposed]` |
| D13 | How a connection to a server behaves is not tied to the desktop app, so that the phone app can use the same. | `[proposed]` |
| D14 | The client listener is open to this computer only, until remote access is set up. | `[proposed]` |
| D15 | A server makes its certificate and its secret at its first start. | `[proposed]` |
| D16 | The owner's things are done by the app with the server program it carries, not through the client API. | `[proposed]` |
| D17 | Tests of the page against a real server use a test host that is never shipped, not a mode of the server or of the app. | `[proposed]` |
| D18 | The window opens before any server answers, and a failed start shows in this computer's section. | `[proposed]` |
| D19 | The server list moves from the server to the app once, with nothing for the user to enter again. | `[proposed]` |
| D20 | The feature level is raised, and the app connects to no server below it. | `[proposed]` |

## 5. Bounds

**The parts.**

- **Three parts, as today.** The server stays the Go program, the app stays the Electron app, and the page
  stays the one web client. No part is replaced by this goal.
- **One page.** The page in the app and the page in a headless browser are the same build of the same
  code. There is no second user interface for tests.
- **One API.** The app gets nothing from a server that another client does not get. Nothing is added to
  the client API for this computer alone.
- **The server never depends on the app.** It is started detached, runs on without the app, and every
  command of it works on a machine that has no app.
- **The MCP listener is not touched**: its port, its being reachable from this computer only, and what the
  agents are told about it.

**The page and the main process.**

- **The page holds no secret and names no file.** What it asks the main process for is checked there: a
  call names a server of the list and nothing outside the client API, and a file is read only when the
  app's own dialog returned it.
- **Only the app's own page is answered.** A request to the main process from another window, from a frame
  inside the page, or from a page that has gone elsewhere is refused, as today.
- **One place asks.** Nothing in the page reaches a server, the main process or the network except through
  the one place of D12. The rest of the page does not know which of the two ways is in use.
- **Both ways mean the same.** A call, the stream and a picture behave alike over IPC and over HTTP: the
  same answers, the same order of events, the same states of a server.
- **Not tied to the desktop app.** The behaviour of a connection, the server list's rules and what the
  page is told of a server's state are written so that an app on another platform can use them with its
  own way of making a connection.

**Between the app and a server.**

- **The fingerprint decides.** A certificate is accepted by the fingerprint the list holds and by nothing
  else, for this computer's server too. A changed certificate is a state the user is shown, as today.
- **No weaker path for this computer.** There is no listener without the secret, no plain HTTP and no
  skipped check because the server is on the same machine.
- **One connection per entry** carries everything of that server.
- **An id is unique on one server only**, this computer's included.
- **What a client cannot reach** on a server stays as the sections goal has it: its secrets, its restart
  and update, and its data folder as files.
- **A picture is taken from its bytes alone**, as in 3.5.

**What goes away is removed**, not left unused: the local API and its port, the serving of the page, the
relay and the pass-through, the server's own server list and its connections to other servers, the notice
of a newer page, the window that says "Starting…" and the start error dialog, and the instructions for
using the app in a browser.

**Waits.** The time a call may take, the longer time an upload, a fetch of a picture and a drawing may
take, the silence after which a stream counts as ended, the intervals of the retries and the time a too-old
entry waits before it is asked again keep today's values. Each can be lowered by a test and keeps its value
otherwise.

**The README says what is true at the end**: how the app and the server are built and started, the server's
commands and flags, the server folder for another machine, and remote access.

**Tests follow `AGENTS.md`.** No paid test is run unless the user asks.

## 6. Consequences to know

Each follows from a decision above and is accepted.

- **No browser tab.** A machine without the app cannot show AI Whiteboard, whatever server runs on it.
  Follows from D5 and D9.
- **A server on Linux has no screen of its own.** The app is built for macOS only, so such a server is
  used from a Mac. Follows from D5.
- **The app is needed to see anything.** With the app closed nothing is connected. Servers and their
  agents run on. Follows from D1.
- **Whatever called the local API without a secret stops working**: a script, a bookmark of port 4747.
  Follows from D4.
- **This computer's secret can be read by any program of the same user**, as the command that prints it
  can be run by one. That is so today for a server that was set up. Follows from D8.
- **Three things cross between the page and the main process, each in its own way.** The stream is no
  longer the browser's own kind of stream, and a picture is no longer a plain address. Follows from D7.
- **Two ways of asking live in the page**, and the browser tests run only one of them. Follows from D10
  and D12.
- **The app and this computer's server can be of different builds** until the user restarts the server, as
  today. Follows from 3.3.

## 7. How it is checked

**By tests.** Every statement of section 3 and every bound of section 5 that a test can show has one. Among
them, because they are easy to get wrong:

- a server that was never set up starts, has a certificate and a secret, and is reachable from this
  computer only;
- a call without the secret is refused on this computer as from another machine, and the first question is
  answered without it;
- a server serves no page, at any address;
- setting remote access up, turning it off and replacing the secret, each with a client connected;
- each command that looks for a running server finds one of this build, and one of the build before;
- the app with this computer's server running, not running, failing to start, stopping while the app is
  open, of another build, and too old;
- a remote server that is down does not hold up this computer's section, and the other way round;
- the page gets no secret and cannot ask for a server outside the list, a path outside the client API or a
  file;
- a request to the main process from anything but the app's own page is refused;
- a picture whose bytes are not an image of the taken types never reaches the page;
- a call, the stream and a picture give the same results over IPC and over HTTP;
- a stream that goes silent, a refused secret and a changed certificate, each for this computer's server
  too;
- the server list after the change-over: every entry connects with nothing entered, and the server's data
  folder holds no list;
- an older app against a new server, and the new app against an old running server;
- the owner's things work for this computer and cannot be reached by a client on another machine.

Code where several things happen at once (several connections, a server that stops in the middle of a call)
is also run under the race detector, or the like of it for the app's own code.

**In a headless browser**: the page on the mock, and the page against a real server through the test host.

**In the app itself**, by a few tests: the page over IPC, with a call, a stream that is cut and comes back,
and a picture.

**By hand**:

- a first start on a machine that never ran AI Whiteboard;
- an update from the version before, with a remote server in the list and with a server still running;
- killing this computer's server while a chat is open and while a board is drawn on;
- two machines, each with the app, each a client of the other.

## 8. Risks and what is not verified

| # | What | Mark |
|---|---|---|
| V1 | The owner's things are listed from what the local API has today that the client API has not: the restart, the state of the MCP listener, showing a board's file in the file manager, and the server list itself. Whether that list is complete has not been checked route by route. Nothing the user can do with this computer today may be lost except using it in a browser tab. | `[not verified]` |
| V2 | The page's storage in the app belongs to the address the page is loaded from, and that address changes. Whether the theme, the widths, what is collapsed and unsent text can be carried over, or start fresh, is not decided. | `[not verified]` |
| V3 | Where the app keeps the secrets: a file as the server has it today, or the system's keychain. | `[not verified]` |
| V4 | The port of the one client listener, and what happens at port 4747 after the change. A server of the old build that is still running holds the MCP port, so a second server cannot start beside it: the app has to find it by its old address. | `[not verified]` |
| V5 | The sections goal is not on the main branch: its file and the work on it are on other branches. This goal needs it there first, or is built together with it; which is not decided. Built together, the feature level is raised once. | `[not verified]` |
| V6 | A picture over IPC is held in the page's memory until it is let go. What that costs in a long chat with many pictures has not been measured. | `[not verified]` |
| V7 | The stream over IPC: the order of events and what happens when a server sends faster than the page takes. Today the browser's own stream does this. | `[not verified]` |
| V8 | How far the app itself can be run by tests without a screen on macOS. | `[not verified]` |
| V9 | Whether the tests of the page against a real server use the test host (D17) or drive the app. The user has not decided. | `[not verified]` |
| V10 | What a phone app needs of D12 and D13 was reasoned from memory of React Native and its web view, not checked against current versions. | `[not verified]` |
| V11 | An agent's board tools are answered by the window that holds the board. With the app as the only client, a board that no window holds is answered as it is today with no page open. That this is the same case has not been traced. | `[not verified]` |

## 9. Not in this goal

- The phone app.
- The app for Linux or Windows.
- Using the app in a browser.
- A URL scheme of the app's own between the page and the main process.
- Keeping a connection, or telling the user of anything, while the app is closed.
- Starting a server at login or after a reboot, an installer or a service file.
- Signing the app and updating it by itself.
- Limits per client, and anything else the sections goal leaves out.
- Changing the MCP listener or how the agents reach the board tools.
