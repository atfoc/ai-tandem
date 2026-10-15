# Goal: the client rewritten in React Native, for iOS, iPadOS, Android and the desktop app

This document defines an outcome: what exists when the web client has been rewritten in React Native, the
decisions already made, the bounds the work must stay inside, and how to confirm that it is done. It is not
an implementation plan and not an order of work. It names no files, functions or steps; how to build it is
for whoever builds it.

The same change is drawn on the whiteboard "plan". This document holds everything on that board. Where the
board suggests a way of building, it is kept here as a decision or a bound with its mark (1), not as a step.

It has two parts. **Part A** is the rewrite. **Part B** is a second goal that starts only when Part A is done
(11).

**It stands on another goal.** "The app as the client of every server" (`app-as-client-goal.md`, here "the
client goal") is built and taken as given: the desktop app is the client of every server, the main process
holds the server list and the secrets, the page reaches the network through the transport alone, and a phone
app was named there as a later task (its D20). This is that task. Where the two differ, this one holds, and
4.10 says where.

## 1. How to read this

**Marks.** A decision, bound or risk carries one mark. A statement with no mark is `[proposed]`.

- `[user]`: the user decided it.
- `[proposed]`: proposed while the change was planned. Not a decision of the user.
- `[not verified]`: a risk or an assumption nobody has checked yet.

**Terms.**

- **Page**: the web client as it is today: React for the browser, with Excalidraw for the board, built into
  the desktop app's window.
- **The app**: the one new client this goal builds, from one codebase, on every target below.
- **Target**: a platform the app runs on. There are four: the desktop app (Electron), iPhone (iOS), iPad
  (iPadOS) and Android. Android tablets are an Android target, not a fifth.
- **Desktop app**: the Electron app of today. Its window shows the app's web build.
- **Web build**: the app built for the web, with react-native-web. The desktop app's window and the headless
  browser of tests run it.
- **Phone, tablet**: the layouts of the app for a narrow and for a wide screen (4.4). Not a platform check.
- **Server, this computer's server, remote server, client API, section, transport, mock, test host, feature
  level**: as in the client goal.
- **Client, Manager, Conn**: the parts that make a connection to a server and keep it up: the Client is what
  the transport talks to; the Manager holds one Conn per server; a Conn does hello, events and retry.
- **Port**: an interface that a platform fills in for the shared connection code (4.6): the Session, the
  Connector and the Store.
- **Trust hook**: native code (Swift, Kotlin) that accepts a server's self-signed certificate by its
  fingerprint and by nothing else.
- **Install script**: the script of 4.9 that puts the app on a device.

## 2. Goal

Today the client is a web page in React for the browser. It cannot run on a phone or a tablet, and it is
bound to the desktop app's window.

At the end there is one React Native codebase, built with Expo, that is the client on four targets: iPhone,
iPad, Android and the desktop app. It does what the page does today, it connects to every server as the
desktop app does today, and it shows the same chats, boards and prompt library. On the desktop app it runs
as a web build, loaded by the Electron window; on the other three it runs natively. The Go server and the
client API do not change. The old page is retired once the desktop app runs the new build.

## 3. What the user gets

1. On iPhone, iPad and Android the user adds a remote server, and it shows as a section of the sidebar with
   its chats, boards and runs, as in the desktop app.
2. A chat streams live, on every target: the answer, tool cards, subagents, markdown and code.
3. The user writes a message with text, images, board references and quotes, sends it, and changes the
   subagent settings and uses the prompt library, on every target.
4. The user opens a board, draws on it, sees what the agent draws, and refers to a selection from a chat, on
   every target.
5. On iPad the board and the chat can be side by side; on a phone they are one screen each.
6. A self-signed server is trusted by its fingerprint, as in the desktop app. Nothing weaker is offered on a
   phone.
7. The desktop app looks and works as it does today, from the new build.
8. The user installs the app on an Android or an iOS device by running one script (4.9).
9. Nothing the user can do in the page today is lost, except what a phone cannot have (4.2).

## 4. What exists at the end

### 4.1 Targets and what they run

- **One codebase for all four targets** `[proposed]`: React Native with Expo, and react-native-web for the
  web build.
- **The desktop app's window loads the web build** `[proposed]`. The main process, its IPC face and its
  connection to servers are the client goal's, unchanged. The page it loaded before is retired once the
  desktop app runs the web build (6).
- **iPhone, iPad and Android run natively.** Each makes its own connections to servers from the device
  (4.6). There is no server in between, and no phone is the client of a server through another machine.
- **A plain browser tab is not a target** `[proposed]`: a page cannot pin a self-signed certificate. "Web"
  means the desktop app's window, and the headless browser of tests.
- **Phones and tablets have no "This computer" section** `[proposed]`. They list remote servers only, since
  no server runs on the device.
- **The Go server is not touched** `[user]`. The client API, its HTTPS, the secret header and the feature
  level are what they are when this work starts.

### 4.2 What carries over, and what does not

**Carried over as it is.**

- The logic that has no screen in it: the page's non-visual logic and its tests, the store, the api module,
  the connection types. It moves into the app unchanged and keeps its tests.
- The transport interface and its ways, `ipc` and `http`. The desktop app keeps its connection code.
- The test host and the mock. They keep driving the web build.

**Carried over with new parts underneath.**

- Storage is kept in the device's fast key-value storage instead of the browser's, through the one place the
  page already stores through.
- Markdown with highlighted code is shown with a renderer made for React Native.
- The sidebar, the chat view, tool cards, **Servers**, the prompt library and the subagent settings are
  rebuilt from the same parts of the screen in native primitives, with the same behaviour.
- The layout is a stack on a phone and a split view on a tablet; the resizable panes of the desktop become
  width breakpoints.
- The colour themes (the Catppuccin flavours) are the same colours, held as tokens instead of style sheets.

**Rewritten, because the old one is bound to the browser.**

- The composer and its input with inline board-reference chips.
- Quotes: the user quotes a part of a message by the platform's own selection action or by a long press, not
  by the browser's selection.
- The board canvas and its link to the board: Excalidraw runs only in the browser, so on phones and tablets
  it runs in a web view and is controlled through a bridge (4.5).
- Popups, drops, drag and the resizing handle: they become sheets, gestures and the share sheet.
- Images: picking an image uses the device's picker, and showing one uses a native fetch with a cache, since
  a picture is shown from the connection that pins the certificate (4.6).

**New.**

- The Expo project that the web client becomes: its router, its development client, its native plugins.
- The trust hooks and the connection layer written in the app (4.6).
- The Excalidraw web-view bundle and the bridge to it.
- The add-server flow for a phone (4.7).
- The install script (4.9).

**Does not carry over.** What the page kept in the browser's storage (theme, widths, collapse, last
selection, unsent text) starts fresh in the app, as the client goal did for the page `[proposed]`.

### 4.3 Parity

- **Everything the page does, the app does**, on every target, except what 4.1 and 4.2 name `[proposed]`:
  no "This computer" on a phone or a tablet, no browser tab, and the owner's things of the client goal (4.7
  there), which exist for this computer only.
- **What the page tells the user** (the states of a server, the words, the errors, a closed stream) are the
  same in the app. The same logic produces them.
- **The desktop app is not worse for the move** `[proposed]`: no feature, shortcut or behaviour of today's
  desktop page is lost, nor made slower to a degree the user notices.

### 4.4 Layout

- **Layout follows the width of the window, not the platform** `[proposed]`. A narrow window is the phone
  layout and a wide one the tablet or desktop layout, on every target. A narrow browser window in a test is
  therefore really the phone layout.
- **Phone**: a stack of screens. **Tablet and desktop**: a split view with the sidebar, the chat and the
  board. On iPad the board and the chat can be on the screen at once.
- **Touch and keyboard both work.** A tablet with a hardware keyboard has the shortcuts the desktop page has
  where they make sense; the touch layout needs no keyboard.
- Part B (11) redesigns these layouts further. This part only makes them work.

### 4.5 The board

- **Excalidraw in a web view on phones and tablets** `[proposed]`, with a bundle that ships inside the app
  and a bridge between it and the app: scene, selection, export and the changes an agent applies. The
  messages of the bridge are typed once and shared by the app and the web view.
- On the desktop app's web build the board is Excalidraw in the page itself.
- **What the board does today, it does**: the scene stays in step with the server's board, a change an agent
  makes appears, a selection can be referred to from a chat, and a drawing is saved before the window
  closes or the screen goes away.
- Drawing with a finger or a pencil works; the size of the bundle and the memory of the web view stay within
  what a phone has `[not verified]`.

### 4.6 The connection to servers

- **A connection behaves as the client goal says**: the first question, the check of the fingerprint and of
  the feature level, the stream that starts with a snapshot, a silent stream counted as ended, retries at
  growing intervals, a refused secret that ends the trying, and **Servers** saying at which step it fails.
- **One transport per platform, and nothing between the page and the Client** `[proposed]`. On a phone and a
  tablet the transport (call it the native transport) calls the Client inside the app. The three layers that
  would sit between them in a port of today's shape, the app interface, the mobile adapter and the face with
  its checks, do not exist: nothing untrusted crosses an in-process call, so there is nothing to parse, to
  allow or to batch.
- **On the desktop app the window's bridge builds the transport** `[proposed]`: the translation from the
  page's calls to the IPC messages is made there, and the main process and its IPC face keep their checks.
  The page keeps calling the one transport the same way.
- **The transport interface is unchanged** `[proposed]`: a call, the stream, the address of a picture, the
  app's own operations and the image picker. The test host's HTTP transport is not part of any shipped app.
- **Reconnect, back-off and silence detection live in the connection code**, shared by the desktop app and
  the mobile app, and in no transport `[proposed]`. The shared part is the Client, the Manager and the Conn.
  What differs per platform are the three ports:
  - the **Session** (one session per server; send a request, get a status, headers and a stream; fetch with
    limits; close): Node's HTTP/2 on the desktop and in the test host; a thin wrapper of the system's network
    stack on the phone, with the stream read as text chunks;
  - the **Connector** (open a session to a host with a trust rule; read a server's certificate): Node's TLS
    with a pin by SHA-256 fingerprint on the desktop; a Swift and a Kotlin trust hook on the phone, with the
    same pin rule and the same errors, exposed as a native module;
  - the **Store** (the server list, its notice, the client id made once): the app's file on the desktop; on
    the phone secrets in the platform's secure storage, the rest of the list in the key-value storage, and
    a generated id.
- **The same rules on both**: the trust is judged before anything is written, a certificate is accepted by
  its fingerprint and by nothing else, and the checks of a stored entry are the shared ones.
- **A picture on the phone** is fetched by the app's own code over the pinned connection and shown from the
  result, since the platform's image view cannot pin a certificate. Its address is therefore given
  asynchronously on the phone `[proposed]`. The picture's bytes are looked at before they are shown, as in
  the client goal.
- **The platforms' network stacks may differ** from Node's; the behaviour seen by the page does not. Where
  they cannot be made to agree, the page is told the same states and the difference is a risk (9).
- **Cancelling a call** works on every target. On the desktop app the cancel is carried across the bridge as
  an identifier, since a cancel signal cannot cross it `[proposed]`.

### 4.7 Adding a server on a phone

- **A server is added by pasting its address and secret, or by scanning a code** `[proposed]`. The user
  accepts the fingerprint as in **Servers** today.
- **The device may ask for permission to reach the local network**, and the app explains why when it does
  `[proposed]`. A refused permission is a state the user is shown, not a silent failure.
- **Nothing is typed for "This computer"**, because there is none (4.1).

### 4.8 Streaming and long use

- **A long chat stays smooth**: long lists, markdown that re-renders as the answer grows, and the scroll
  staying where the user put it while the answer streams `[proposed]`.
- **A stream held for hours does not grow in memory without bound** `[not verified]`.
- **Background**: when the system suspends the app, the streams may end. When the app returns, the sections
  fill again, as the client goal does when the app opens `[proposed]`. Nothing is promised while the app is
  suspended.

### 4.9 Installing on a device

- **A script installs the app on a device**, Android or iOS, that the user has connected or named
  `[user]`. This is all that is delivered for getting the app onto a device.
- **No store distribution** `[user]`: not TestFlight, not the Play Store, no store signing and no store
  upload are part of this goal.
- **Desktop app signing and updating by itself** stay out, as in the client goal.
- **What the user must provide is told at the end** `[user]`. When the work is finished, the builder says
  exactly what is needed from the user's Apple developer account for the script to install on an iPhone and
  an iPad: nothing is asked for before that, and nothing in the repository holds a credential. An Android
  install needs no account of the user's, and the builder says what it needs, if anything, in the same
  report.
- **The script is repeatable**: run again, it builds and installs the current state of the code on the
  device. It says what it did and why it stopped, if it stops.

### 4.10 What changes in the client goal

- Its **D20** is this goal. The phone app is no longer a later task.
- **"The page"** is the new app on every target, and the old page until the desktop app runs the web build.
- **The transport's third way**, "HTTP in a later phone app", is replaced: the phone does not use HTTP to a
  host. It has the native transport, in-process. HTTP stays for the test host `[proposed]`.
- **The desktop bridge** builds the transport instead of forwarding calls to a page-side translator (4.6).
- Everything else of the client goal holds, for the desktop app as written, and for the phone as 4.6 says.

## 5. Decisions

| # | Decision | Mark |
|---|---|---|
| D1 | One React Native codebase, built with Expo, is the client on iPhone, iPad, Android and the desktop app. | `[proposed]` |
| D2 | The desktop app's window loads the app's web build. The main process, its IPC face and its connection code stay. | `[proposed]` |
| D3 | A plain browser tab is not a target. Phones and tablets have remote servers only. | `[proposed]` |
| D4 | The Go server and the client API do not change. | `[user]` |
| D5 | The logic with no screen, the store, the api module, the transport interface and the test host are kept as they are. | `[proposed]` |
| D6 | Layout follows width breakpoints, not the platform: phone is a stack, tablet and desktop a split view. | `[proposed]` |
| D7 | Excalidraw runs in a web view on phones and tablets, through a typed bridge; in the page itself on the web build. | `[proposed]` |
| D8 | One transport per platform with nothing between it and the Client: the native transport is in-process, the desktop bridge builds the IPC transport. The app interface, the mobile adapter and the in-process face are not built. | `[proposed]` |
| D9 | The connection code (Client, Manager, Conn) is shared by the desktop and the mobile app, with three ports per platform: Session, Connector, Store. Reconnect, back-off and silence detection live there and nowhere else. | `[proposed]` |
| D10 | The phone's certificate trust is native code that pins by fingerprint with the same rule and the same errors as the desktop's. | `[proposed]` |
| D11 | Secrets are kept in the platform's secure storage on a phone; the rest of the server list in the key-value storage. | `[proposed]` |
| D12 | A picture on the phone is fetched by the app's own code over the pinned connection; its address is asynchronous. | `[proposed]` |
| D13 | Nothing is done for a store. The delivery for devices is a script that installs the app, and the builder reports at the end what the user must give from the Apple developer account. | `[user]` |
| D14 | The user-interface redesign for phone and tablet is a second goal, started after this one is done (11). This goal makes the app work; it does not redesign it. | `[user]` |
| D15 | The old page keeps building until the desktop app runs the web build, so desktop users are never without an app. | `[proposed]` |
| D16 | Almost every test runs in a browser; a test runs on a device only if a browser cannot show the behaviour (7). | `[proposed]` |

## 6. Bounds

**The parts.**

- **The server is not touched.** No change is made to it for the app's sake `[user]`.
- **One codebase.** There is no second user interface for a platform, and no copy of a screen per
  platform. A difference between platforms lives in a port, a native module or a layout breakpoint, not in
  a fork of a screen.
- **The client goal's bounds hold for every target**: the fingerprint decides; no weaker path; one
  connection per entry; no secret reaches the part that draws; the transport is the only place that reaches
  a server or the network.
- **Native code is small and does one thing** `[proposed]`: trust a certificate by its fingerprint, and
  whatever else the platform forces. Nothing of what the app decides lives in Swift or Kotlin.
- **The old page is retired only after** the desktop app runs the web build and the browser checks pass on
  it `[proposed]`.
- **The desktop app is released from the web build only when** the desktop app's own tests pass with it
  (7.3).

**The page and the app.**

- **A screen does not know which transport it has.** It asks the one transport, as today.
- **The bridge to the web view has typed messages**, shared by the app and the web view, and the web view
  holds no secret, reaches no server and can ask for nothing but the board's own operations.
- **A native module has a contract**, and the contract is tested against a fake `[proposed]`.
- **A test is on a device only if a browser cannot show the behaviour** (7).

**Between a phone and a server.**

- The same as the client goal's: HTTPS, the secret, the pinned fingerprint; no plain HTTP; no skipped check.
- **A secret never leaves secure storage except to be sent to its server.**

**What is not built, because the proposal drops it**: the app interface between the page and the Client, the
mobile adapter for it, and the in-process face with its parsing and batching `[proposed]`.

**Tests follow the repository's testing rules.** No paid test is run unless the user asks.

## 7. How to confirm it is built

Every statement of section 4 and every bound of section 6 that a test can show has a test, in the cheapest
place that can show it. **A test runs on a device only if the browser cannot show the behaviour**, and the
layout follows width, so a narrow browser window is the phone layout.

### 7.1 In a browser (almost all feature tests)

- Playwright on the mock and on the test host.
- **Three viewports**: desktop, tablet and phone. The tablet and phone ones force the iPad and the iOS
  layouts, with touch emulation on.
- The browser checks that exist are extended to the new build. **Every behaviour the checks cover today is
  covered on the new build**, at each viewport where it applies.
- The desktop app's checks on the web build, with the old page's checks as the reference for parity.

### 7.2 Unit tests

- The logic, the store and the non-visual code keep their fast tests with no screen.
- The bridge messages are tested as shared types.
- Each native module's contract is tested against a fake.
- The type check passes for every target.
- The shared connection code runs against fake ports with the same cases as on the desktop today: retry
  intervals, silence, a refused secret, a changed certificate.

### 7.3 In the desktop app

The client goal's few tests of the app itself (the page over IPC, a stream that is cut, a picture from the
app's own scheme, from a self-signed server) pass with the new build. The window's bridge is tested with a
fake IPC renderer, not by the page's tests.

### 7.4 On a device or a simulator (a short list)

Tests that a browser cannot show:

- the pinned certificate and the stream, against a real Go server;
- the Excalidraw web view bridge: it loads, applies a change and exports;
- the composer: keyboard, selection, board-reference chips;
- the secure storage, the image picker and the local network permission;
- on a simulator or emulator, driven by a UI test tool; the local network on a real device.

### 7.5 By hand

- the install script, on a real iPhone, a real iPad and a real Android device (the script is the product of
  4.9);
- a stream held open for hours on a phone, and the memory it uses;
- drawing on the board with a finger and with a pencil;
- reaching a server on the local network from a phone, with a self-signed certificate;
- a suspended and resumed app: the sections fill again;
- the desktop app from the web build, used as it is used today.

## 8. Accepted consequences

- **Two kinds of Excalidraw host**: a web view on phones and tablets, the page on the web build. Follows
  from D7.
- **The connection translation exists twice**: the bytes and the cancel plumbing in the desktop bridge and in
  the native transport. Follows from D8.
- **The desktop translation leaves TypeScript**: it is written in the window's bridge, which is plain,
  sandboxed JavaScript, and tested in the desktop app's tests. Follows from D8.
- **A phone cannot reach "This computer"** and can use a server only if it can reach it on a network.
  Follows from D3.
- **No store build**: nobody installs the app without the script and a device that accepts it. Follows from
  D13.
- **The app is not tested on a device for everything**: what a browser shows is not tested again on a
  device. Follows from D16.
- **The first look of the app on a phone is the desktop's, made to fit**, not a new design. Follows from D14.

## 9. Risks and assumptions not verified

These do not change what is built. If one turns out false, the outcome above still holds and the way to it
changes. The first is large enough that it is settled before the rest is built: a **go or no-go** on the
rewrite rests on it.

| What | Mark |
|---|---|
| **Proof before commitment.** That these work on a real device before the rest is built: a trust hook in the system's network stack that pins a self-signed certificate; HTTP/2 over it; a long stream read as text chunks with memory that holds over hours; Excalidraw in a web view with touch drawing; a text input that carries inline board-reference chips. If one does not, the rewrite is reconsidered, not worked around quietly. | `[not verified]` |
| The system's network stack accepts a trust hook of this shape, and reads a server-sent event stream with HTTP/2 from the OS. | `[not verified]` |
| Memory over hours of a stream read as chunks. | `[not verified]` |
| The composer: React Native has no editable rich text with inline elements, and board-reference chips in text are the hardest part of the experience to match. | `[not verified]` |
| Excalidraw in a web view: touch drawing, memory, and the file size of its bundle. | `[not verified]` |
| A streaming chat in React Native: long lists, markdown that re-renders, scroll anchoring. | `[not verified]` |
| Reaching servers from a phone: the local network permission, a self-signed certificate, and the limits on streams in the background. | `[not verified]` |
| A cancel signal cannot cross the window's bridge, so an identifier and a listener carry it. A short spike in Electron confirms this before it is built on. | `[not verified]` |
| The system's image view cannot pin a certificate, so a picture is fetched by the app and its address is asynchronous. This is a cost on the phone, not a new one. | `[not verified]` |
| What the Apple developer account needs to provide for the install script to put the app on an iPhone and an iPad. Reported at the end. | `[not verified]` |

## 10. Not in this goal

- Anything for a store: TestFlight, the Play Store, store signing and upload `[user]`.
- Signing the desktop app and updating it by itself.
- The app for Linux or Windows.
- Using the app in a browser tab.
- Any change to the Go server, the client API or the MCP listener.
- A "This computer" section on a phone or a tablet.
- Keeping a connection, or telling the user of anything, while the app is closed or suspended.
- A redesign of the user interface (that is Part B).
- Starting a server from a phone.

## 11. Part B: the goal after the rewrite: a user interface for desktop, phone and tablet

**This part starts only when Part A is done** `[user]`. It is stated here so that Part A does not close the
door on it. It is defined further, with the user, when it starts.

### 11.1 Goal

After the rewrite the app works on desktop, phone and tablet, but the interface is the desktop's, made to
fit. At the end of this goal the interface is **redesigned where it needs to be** so that each kind of
device gets the best use of AI Whiteboard that its size and its input allow: desktop with a mouse and a
keyboard, a phone in one hand, and a tablet that may have a keyboard, a pencil, or both.

The target kinds are **desktop, mobile (iOS and Android) and tablet (iPadOS)** `[user]`. An Android tablet
gets the tablet layout by its width.

### 11.2 What the user gets

1. On each kind of device the tasks the user does most are done in the way natural to that device, not in
   the way of another.
2. Where one design fits all three, it stays one design. Nothing is redesigned for the sake of it:
   **only where it is needed** `[user]`.
3. A phone is comfortable in one hand and with a thumb: reach, size of targets and the place of the main
   actions are considered.
4. A tablet uses its space: chat and board side by side, and uses its keyboard, its pointer and its pencil
   when it has them `[proposed]`.
5. The desktop is not made worse for the others.
6. Moving a device between orientations, or a window between sizes, gives a layout that is right for the new
   size.

### 11.3 What exists at the end

- **A review of every screen of the app, on each kind of device**, that says where the design is right as it
  is and where it is not, and why. It is the base of the work and is kept `[proposed]`.
- **A redesign of the screens that the review says need it**: navigation, the composer, the chat, the board,
  **Servers**, the prompt library, the subagent settings, popups and sheets, as far as the review finds a
  need.
- **The input of each kind of device is used**: touch, mouse and keyboard, pencil.
- **The three kinds of layout are the three width breakpoints** of Part A, now designed on purpose.
- **The look is one look**: the themes and the identity stay, and the redesign changes arrangement, size and
  gesture, not the identity `[proposed]`.

### 11.4 Bounds

- **No feature is added or taken away.** It is the same product with a better interface.
- **The logic, the connection code and the server are not touched** to make a screen different.
- **One codebase, width-based layout**, as in Part A: a design for a device is a layout at a width, not a
  fork by platform.
- **The desktop keeps what it has** unless the review shows something that is better for all.
- **The Part A tests keep passing**, and the three viewports gain the checks for the changes.

### 11.5 How to confirm it

- The review is done, and every change in the redesign is traced to a finding in it.
- The three viewports in a browser show each redesigned screen, and the checks for them pass.
- The user judges the result on a real iPhone, a real Android phone, a real iPad and the desktop. A good
  interface cannot be proved by a test: **the user's judgment on the devices decides**.

### 11.6 Not in Part B

- New features or a new product direction.
- A new theme or a new identity.
- Anything for a store, or for another platform.
