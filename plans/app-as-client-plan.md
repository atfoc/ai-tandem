# App as client: architecture and split into workstreams

This is the design and the split of the work for `app-as-client-goal.md` (here "the goal"). The goal is the
authority: where this document and the goal differ, the goal holds, and the implementer reports the difference.
This document settles everything the goal leaves to the builder, so that an implementer makes no architectural
decision. It names files, functions, formats and tests.

Read first, in this order: the goal, `AGENTS.md`, this document's sections 1 to 4, then the section of your own
workstream (section 5). Sections 3 (contracts) are shared by several workstreams and are binding for all of them.

---

## 0. Rules for every workstream

- **Branch and worktree.** Each workstream works in its own git worktree on the branch `aac/<id>` (for example
  `aac/g1`), made from `no-server-to-server-proxy` as it is at the start of the workstream's wave. It commits only
  on its own branch. It does not merge, rebase or cherry-pick other workstreams' branches. After each wave the
  coordinator merges the wave's branches into `no-server-to-server-proxy`, and the next wave starts from there.
- **Ownership.** A workstream changes only the files its section lists under "Owns". A file it must read but does
  not own, it does not edit. A file that is in nobody's list and that you need to change: stop, and name it in
  your report.
- **Contracts.** Section 3 is binding. A workstream on one side of a contract builds to it even when the other
  side is not there yet (against a stub, a fake or the mock). If a contract cannot be met as written, implement
  the closest thing, write the difference into `plans/deviations/<id>.md` (create it; it is the only file outside
  your list you may add) and say so in your report. Do not change this document.
- **Tests.** Follow `AGENTS.md`: the default set while working, the full set of the packages you changed before
  you finish, `-race` where goroutines share state, no `-count=1` by habit, no paid tests
  (`AIWB_CLAUDE_E2E`, `AIWB_CURSOR_E2E`, `AIWB_PI_E2E`, `web/e2e/app.e2e.mjs`) ever. JavaScript: `cd web && npm test
  && npm run check`, `cd desktop && npm test`. A new Go test that starts server processes or needs a build of the
  binary goes to the full set with `testset.SkipUnlessFull` and a reason naming the default-set test that covers
  the same behaviour.
- **Style.** Match the surrounding code: its comment density, its naming, its idiom (the repository writes comments
  as plain declarative sentences). No new dependency anywhere (Go modules, npm packages) unless this document
  names it. Playwright stays what it is today: installed with `--no-save` by whoever runs a browser script.
- **Report.** End with: what was done, the tests run with their results (a load-sensitive failure named with its
  line, as `AGENTS.md` says), deviations, and anything left for the integration workstream.

---

## 1. The end state in one page

```
 ┌───────────────────────────── the app (Electron) ─────────────────────────────┐
 │  page (web/dist, loaded with loadFile)                                        │
 │    web/src/transport  ── IPC (window.aiwbApp) ──►  main process               │
 │    <img src="aiwb-picture://p/<entry>/<chat>/<image>"> ──► protocol handler   │
 │                                                     │                          │
 │                                   desktop/conn (the shared connection module) │
 │                                     server list + secrets (userData/client/)  │
 │                                     one HTTP/2 session per entry, pinned TLS  │
 │                                     this computer's starter (launch/secret)   │
 └──────────────────────────────────────┬──────────────────────────────┬─────────┘
                                         │ HTTPS + secret + pin          │ HTTPS + secret + pin
                          this computer's server :4748            a remote server :4748
                          (+ MCP 127.0.0.1:6006, + control socket in the data folder)

 tests only:  headless browser ── HTTP ──► web/dev/host.mjs (hostface + desktop/conn) ──► servers
              headless browser ── HTTP ──► web/dev/mock.mjs (hostface + a fake client)
```

- The page talks to the transport only. Over IPC in the app, over HTTP to the test host or the mock.
- The main process (and the test host) hold the server list, the secrets and one connection per entry, this
  computer's included, through one module, `desktop/conn`.
- A server has two listeners: the client listener (HTTPS, the secret, every IPv4 address, port 4748 at first) and
  the MCP listener (unchanged). Besides, an owner-only Unix socket in the data folder, the **control socket**,
  answers the server program's own commands (`status`, `stop`, `launch`, …) on the same machine. It is no
  listener on the network, no part of the client API, and the app never uses it directly: it runs the commands.
- Port 4747 is gone. Nothing serves the page.

---

## 2. Decisions taken by the architect

Each settles a `[proposed]` or `[not verified]` item of the goal, or a point the goal leaves open. The ones marked
**(user should know)** change something the user may notice.

| # | Decision |
|---|---|
| A1 | **The page file is loaded with `BrowserWindow.loadFile`** (`file://`), from `Contents/Resources/web/index.html` in the packaged app and from `web/dist/index.html` of the checkout in development. Checked on the installed Electron 44.4.5 (Chromium 152): an ES module script, `FontFace` with a relative `url()` and `fetch` of a sibling file all work from a `file://` page. `web/index.html` and the Excalidraw asset path are made relative (C6.1). No URL scheme serves the page (goal section 10). |
| A2 | **The picture scheme is `aiwb-picture`**, registered privileged `{standard: true, secure: true}`, handled with `protocol.handle` on the default session. URL form `aiwb-picture://p/<entry id>/<chat id>/<image id>`. Checked on Electron 44.4.5: `protocol.handle` gets no frame, but `session.webRequest.onBeforeRequest` fires for this scheme and its `details` carry `webContentsId` and `frame` (a `WebFrameMain`, identical to `webContents.mainFrame` for the main frame, `about:srcdoc` for an iframe). A request cancelled there never reaches the handler. So the check "only the app's own page" is made in `onBeforeRequest` (C4.4). |
| A3 | **Lazy loading works with the scheme**: an `<img loading="lazy">` below the fold was requested only after the page scrolled (checked). **Cancelling does not reach the handler**: an image removed while its request ran did not abort the handler's `request.signal` within 2 s (checked). So a picture fetch in the main process runs to its end or its time limit (60 s); the cost is bounded by a limit of 8 picture fetches at a time per entry, the rest queued (C3.8). |
| A4 | **The shared module (D17) is plain CommonJS JavaScript in `desktop/conn/`**, Node built-ins only (`node:http2`, `node:tls`, `node:crypto`, `node:fs`, `node:child_process`), no Electron import. It runs in the Electron main process and in plain Node (the test host, the tests). The page's transport types are TypeScript in `web/src/transport/`. |
| A5 | **One HTTP/2 session per entry** carries every request of that server: the stream, the calls and the pictures ("one connection per entry carries everything"). The TLS socket is opened and its certificate checked by the module before HTTP/2 starts on it, so nothing is sent to a certificate that the pin refused. A server that does not negotiate `h2` by ALPN is "Something else answers there" (`not_aiwb`): every AI Whiteboard server negotiates `h2` (Go's `ServeTLS` does by default). |
| A6 | **The test host is `web/dev/host.mjs`**, with the HTTP face in `web/dev/hostface.mjs`, shared with the mock (`web/dev/mock.mjs`). The host serves the page files itself; **the page is in the HTTP way when it has no `window.aiwbApp` and was loaded over `http:`**, and the host's address is the page's own origin. Nothing is injected into the page. |
| A7 | **The control socket**: the server listens on an owner-only Unix socket (`<data folder>/control.sock`, mode 0600, or a fallback path for a long data folder path as `pibridge.SocketPath` has), answering `GET /hello` and `GET /status` (C2.4). The commands (`launch`, `relaunch`, `stop`, `status`, `secret -new`, `serve`) find a running server of this build through it. It replaces what the commands read from the local API (`/api/hello` with the pid, `/api/remote/status`, `/api/mcp/status`, `/api/state`'s `dataDir`). |
| A8 | **A running server of the build before is found by its old loopback port**: the port of a `server.json` that has no `control` field, then 4747, asked `GET /api/hello` and `GET /api/state` as the commands do today. Only the commands do this (the "legacy probe"); the app reads the result from `launch -json` (`"state": "old_build"`). Nothing listens on 4747 after the change. |
| A9 | **The feature level is 6**, and so is the lowest client level a server serves (`MinClientLevel`). The app states level 6 in `X-AIWB-Level`. An app of before (level 5) is refused on every route but hello with today's `client_too_old`. |
| A10 | **(user should know) `GET /api/hello` is answered without the secret.** The goal (4.5, 7.1) says the first question is answered without the secret "as today"; today's code asks the secret on hello too. The goal holds: hello needs only a right `Host`; every other route needs the secret. Hello says `app`, `version`, `featureLevel`, `instanceId` and nothing else (no pid, no `webVersion`). Consequence for **Test connection**: a wrong name is found at hello (step 4, `bad_host`), a wrong secret at the state read right after it (step 4, `secret_refused`). |
| A11 | **The client listener accepts the `Host` values `127.0.0.1:<port>` and `localhost:<port>`** besides the set-up's names, so the app reaches this computer's server at `https://127.0.0.1:<port>` without a new set-up (a server set up before keeps its names, goal 4.5). The secret, HTTPS and the pin are required as for every client. |
| A12 | **The app's files**: `<userData>/client/` (on macOS `~/Library/Application Support/AI Whiteboard/client/`), mode 0700, holds `servers.json` (mode 0600, the format of today's server list file, version 1) and `client-id` (mode 0600, the app's lowercase UUID v4, made once, the `X-AIWB-Client` of every request of this app to every server). The test host takes the folder as an argument. No keychain (D3). |
| A13 | **This computer's entry** in every list the page gets has the id `"local"` (Go `model.LocalServer`, web `LOCAL_SERVER`), the name "This computer", `local: true`, and is first. It is never in `servers.json`. Its things keep the keys they have today (their bare ids), so the page's keys and its storage of this computer's drafts are unchanged. |
| A14 | **The owner's things** are app operations (`owner.*`, C3.10) done with the server program the app carries: restart = `relaunch -json`, then `secret`; retry a failed start = `launch -json`, then `secret`; the MCP listener's state = `status -json`; open the server log = `shell.openPath(<data folder>/server.log)`; reveal a board's file = `shell.showItemInFolder(<data folder>/boards/<id>/drawing.excalidraw)`. The data folder is the `home` that `launch -json` printed. |
| A15 | **(user should know) What only the local page had, and how it is closed** (the full table is C1.6): the order of the groups (`PUT /api/groups/order`) is gone with no replacement (the page never called it); a group's collapse of this computer is kept in the page's storage like a section's; the server log, restart and MCP state are owner's things; the reveal of a board's file is an owner's thing; `POST /api/client/flushed` is added to the client API; the snapshot gets `libraryNotice`; the size limit of a drawing written by a client is raised from 32 MB to 128 MB for every client, so that a large board of this computer that saves today still saves. |
| A16 | **(user should know) The board tool of an agent on a board that no window holds** is answered as today with no page open (goal 6, `[user]`): the server's "page that acted last" fallback goes with the pages. A chat's call about another board still goes to the window that holds the chat's board, as for an API client today. |
| A17 | **(user should know) A hand-over between two windows** of different apps now always has the API client's 10 s, also on this computer (today a page on the loopback port had 3 s). There is one window per app. |
| A18 | **This computer's server is restarted by the app when it stops**: the local entry's connection, when an attempt ends unreachable, runs `launch -json` again before its next attempt (launch finds a running server or starts one). The intervals are the remote ones (1, 2, 5, 10, 30 s, ±20 %). |
| A19 | **New state `not_started`** (label "Not started") for this computer's entry only: the last `launch` failed; `detail` is its stderr. Retried by itself at the same growing intervals and at once on Retry. |
| A20 | **The waits of the module** keep today's values and are lowered by tests through options, or in the app and the host through the environment variable `AIWB_APP_WAITS` (same syntax as `AIWB_TEST_WAITS`; names in C3.11). The Go server's `AIWB_TEST_WAITS` keeps `ping`, `agents` and `images`; its other names (`silence`, `backoff`, `start`, `tooold`, `imagecall`) went with the relay and are removed. |
| A21 | **Commands** (C2): `remote setup` stays as it is (flags `-port`, `-name`, `-new-cert`, `-home`); `remote status` becomes `status`; `remote off` is removed; `secret [-new]` stays; `launch`/`relaunch` print the address and the fingerprint, and with `-json` one JSON line for the app; the flags `-port` and `-client` of `serve`/`launch`/`relaunch`/`stop` and `-server-port` of `remote setup` go. |
| A22 | **The not-set-up message** is: `AI Whiteboard is not set up on this machine. Set it up once with: "<program>" remote setup` (with ` -home "<folder>"` when the data folder is not the default). `serve`, `launch` and `relaunch` refuse with it, exit 1. The app shows it in this computer's section. |
| A23 | **The old server list is deleted** at every start of `serve`, before any listener: `<data folder>/servers.json` and every `servers.json.unreadable-*` beside it; one log line when something was deleted. |
| A24 | **The app's version against this computer's server** is compared in the page: `__APP_VERSION__` (the page's build, which is the app's) against the local entry's `version`; when both are not `"dev"` and differ, this computer's section offers "Restart server". The "reload" notice and `version.json` go (one build). |
| A25 | **The page reacts to a transport stream that is closed for good** (HTTP way only in practice) by marking every entry not connected and calling `stream()` again after 1 s. |

---

## 3. Contracts

### C1. The server (Go)

#### C1.1 Listeners

- **Client listener**: HTTPS on every IPv4 address (`0.0.0.0`, or the hidden test override `AIWB_REMOTE_BIND`),
  the port of the set-up (`remote.json`, 4748 at first), the set-up's certificate pair. Go `http.Server` with
  `ServeTLS` (h2 and http/1.1). Handler: `(*Server).ClientHandler()`.
- **MCP listener**: unchanged (`127.0.0.1:6006`, `POST /mcp`, the loopback Host check). `MCPHandler` keeps its
  behaviour exactly; the known-client part of `guard` goes (it never applied to `/mcp`).
- **Control socket**: C2.4. Handler `(*Server).ControlHandler(dataDir string) http.Handler`.
- No loopback HTTP listener. No page files anywhere: every path that is not a route is 404 (with the secret) or 401
  (without).

#### C1.2 The client handler, in order

For `GET /api/hello`:
1. `Host` must be allowed (C1.3), else 403 `{"error":"bad host"}`.
2. 200 `{"app":"ai-whiteboard","version":"<v>","featureLevel":6,"instanceId":"<id>"}` (`instanceId` left out when
   there is none). No other check, no other field.

For every other request:
1. the secret in `X-AIWB-Secret`, else 401 `{"error":"unauthorized"}`;
2. `Host` allowed, else 403 `{"error":"bad host"}`;
3. `X-AIWB-Client` a lowercase UUID v4, else 400 code `bad_client`; the server's own id, else 400 code `own_client`;
4. `X-AIWB-Level` an integer ≥ 6, else 400 code `client_too_old` with today's sentence;
5. the route in `ClientRoutes`, else 404 `{"error":"not found"}`;
6. the route.

Logging of refusals as today (one line per source IP per minute).

#### C1.3 Host rule

Allowed: `<name>:<port>` for every name of the set-up (lower-cased), the bare name when the port is 443, and always
`127.0.0.1:<port>` and `localhost:<port>`.

#### C1.4 `ClientRoutes` (the client API), and `desktop/conn/routes.json`

The Go table `server.ClientRoutes` and the JSON file `desktop/conn/routes.json` hold exactly this list, in this
order (the integration workstream adds a Go test that compares them):

```json
[
  "GET /api/hello",
  "GET /api/events",
  "GET /api/state",
  "POST /api/client/flushed",
  "POST /api/groups",
  "PATCH /api/groups/{id}",
  "POST /api/groups/{id}/move",
  "DELETE /api/groups/{id}",
  "POST /api/groups/{id}/archive",
  "POST /api/groups/{id}/unarchive",
  "POST /api/chats",
  "GET /api/chats/{id}",
  "GET /api/chats/{id}/items",
  "GET /api/chats/{id}/tree",
  "GET /api/chats/{id}/context",
  "GET /api/chats/{id}/subagents/{sid}/items",
  "PATCH /api/chats/{id}",
  "POST /api/chats/{id}/messages",
  "POST /api/chats/{id}/interrupt",
  "POST /api/chats/{id}/permission",
  "PUT /api/chats/{id}/label",
  "PUT /api/chats/{id}/draft",
  "POST /api/chats/{id}/images",
  "GET /api/chats/{id}/images/{image}",
  "POST /api/chats/{id}/open",
  "POST /api/chats/{id}/fork",
  "POST /api/chats/{id}/archive",
  "POST /api/chats/{id}/unarchive",
  "DELETE /api/chats/{id}",
  "POST /api/chats/{id}/unfollow",
  "GET /api/dirs",
  "GET /api/usage/{agent}",
  "POST /api/boards",
  "GET /api/boards/{id}/scene",
  "PUT /api/boards/{id}/scene",
  "POST /api/boards/{id}/take",
  "POST /api/boards/{id}/release",
  "POST /api/boards/{id}/rename",
  "PATCH /api/boards/{id}",
  "POST /api/boards/{id}/archive",
  "POST /api/boards/{id}/unarchive",
  "POST /api/boards/{id}/seen",
  "DELETE /api/boards/{id}",
  "POST /api/rpc-reply",
  "GET /api/library",
  "POST /api/library/{server}/groups",
  "PATCH /api/library/{server}/groups/{id}",
  "DELETE /api/library/{server}/groups/{id}",
  "POST /api/library/{server}/prompts",
  "PATCH /api/library/{server}/prompts/{id}",
  "DELETE /api/library/{server}/prompts/{id}"
]
```

The library routes take `{server}` = `local` only, as today on the remote port (the page calls every server's
library as `local`: it is that server's own).

#### C1.5 What changes in answers and events

- `GET /api/state` and the stream's `snapshot`: today's API snapshot (`app.APISnapshot`) plus
  `"libraryNotice": "<sentence>"` when this server's library file was set aside at its start (left out
  otherwise). There is no other snapshot: `app.Snapshot` (the page's) goes, with `servers`, `lists`, `sections`,
  `libraries` and `dataDir`.
- A group has no `collapsed` field any more (`model.Group.Collapsed` goes; a stored value is dropped at the next
  write). `PATCH /api/groups/{id}` with `collapsed` in the body stays refused (400 `collapsed_refused`).
- `PUT /api/boards/{id}/scene`: the drawing is cut at `SceneMax` = 128 MiB for every client (413 `too_large`).
- `POST /api/client/flushed`: as on the loopback port today (the client's answer to `server_stopping`); answers
  `{"ok":true}`. `server_stopping` goes to every client that holds a board.
- The image fetch has no origin check (`ownPage` and code `image_origin` go): the server serves it to every client
  with the secret, under today's image headers.
- `GET /api/dirs` and `GET /api/usage/{agent}` take no `server` query any more.
- The bridge has one kind of client: the API client. `KindPage`, `Acted`, the "page that acted last" fallback,
  `ServeSSE` (the page's stream) and the page-only events (`servers`, `server_state`, `server_lists`, `section`,
  `library`, `library_removed`) go, and so do the relay's hooks (`OnUnfollowed`, `OnBoardFree`, `BoardOn`,
  `SplitBoard`, `BroadcastOn`, `SendChatOn`, `SendBoardOn`). `own_library` stays. The hand-over delay of an API
  client (10 s) is the only one. `CallBoard` asks the holder of the board, else the holder of the chat's board
  (a call about no board, as for an API client today), else fails with `ErrNoClient` at once.
- Every other route answers exactly as it answers an API client today.

#### C1.6 The gaps between the local API and the client API, route by route

| Local API today | Used by the page | Closed by |
|---|---|---|
| `GET /` and the page files | loads the page | the app ships the page (A1); the host serves it in tests |
| `GET /api/hello` (pid, webVersion) | version banner | hello of the client API (no pid, no webVersion); the pid comes from the control socket for the commands; the banner compares the page's version with the local entry's (A24) |
| `GET /api/state`, the page's `snapshot` (`servers`, `lists`, `sections`, `libraries`, `dataDir`) | the whole page | each entry's own API snapshot; `servers` from the module; `lists`, `sections`, `libraries` built by the page from each entry's snapshot (C6.5); `dataDir` dropped (only shown in the "restart failed" banner outside the app) |
| `GET /api/events?client=` (page stream) | the whole page | each entry's API stream, through the transport |
| `POST /api/client/flushed` | answer to `server_stopping` | added to the client API (C1.5) |
| `POST /api/restart` | Restart server | owner's thing `owner.restart` (A14) |
| `GET /api/remote/status` | not used by the page | `status` command via the control socket |
| `GET /api/mcp/status` | not used by the page (read with curl, docs) | `status` command; `owner.status` in the app |
| `GET/POST/PATCH/DELETE /api/servers…` | Servers dialog | the module's server list (`servers.*` app operations) |
| `/api/on/{server}/…` | every call of a section | the transport's server argument |
| `GET /api/library` (all servers) | library popups | each entry's snapshot `library` + `own_library` events |
| `/api/library/{server}/…` for another server | library changes | the same call to that server, as `local` |
| `PUT /api/groups/order` | not used | removed, no replacement |
| `PATCH /api/groups/{id}` with `collapsed` | group collapse of this computer | the page's storage (`store.collapsed`), as for a section |
| `POST /api/boards/{id}/reveal` | Reveal in Finder | owner's thing `owner.reveal` (A14) |
| `GET /api/dirs?server=`, `GET /api/usage/{agent}?server=` | folder picker, usage | the same route on that entry's server |
| `GET /api/chats/{id}/images/{image}` with the origin check | pictures | the picture address (C3.8, C4.4, C5.3) |
| page-only behaviour: no scene limit | saving a large board | `SceneMax` 128 MiB for every client (A15) |
| page-only behaviour: "acted last" fallback of board calls | an agent drawing on a board no window holds | goes (A16, goal 6 `[user]`) |
| page-only behaviour: 3 s hand-over | between windows | 10 s for all (A17) |

#### C1.7 Go names other workstreams rely on

```go
package server
const FeatureLevel = 6
const MinClientLevel = 6
const LevelHeader = "X-AIWB-Level"     // moved here from package servers
const SecretHeader = "X-AIWB-Secret"
const ClientHeader = "X-AIWB-Client"
const SceneMax = 128 << 20
var ClientRoutes []string              // C1.4
func (s *Server) ClientHandler() http.Handler
func (s *Server) ServeClients(ln net.Listener, pair tls.Certificate) error
func (s *Server) ReloadSecret(secret string) int
func (s *Server) ControlHandler(dataDir string) http.Handler   // C2.4
func (s *Server) MCPHandler(mcpPort int) http.Handler
type Server struct {
    App *app.App; Relay *boardapi.Relay; Bridge *editorbridge.Bridge
    MCPPort int; MCPURL string; MCPUp func() bool
    InstanceID string
    Clients *ClientListener              // renamed from Remote/*Remote; nil only in tests
    Usage map[model.AgentKind]func(bool) (model.PlanUsage, error)
}
func NewClientListener(port int, names []string, fingerprint, secret string) *ClientListener

package remote
func Check(root string, mcpPort int) Report     // not set up: Configured false and one Fatal of Kind NotSetUp
func (r Report) OK() bool
func (r Report) Message(exe, home string) string // the not-set-up message is A22's
// Off is removed.

package store
func RemoveServerList(p Paths) (removed bool, err error) // A23
func WriteServerFile(p Paths, port int, control string) error
func ReadServerFile(p Paths) (sf ServerFile, ok bool)      // ServerFile{PID, Port int; Control string; Started time.Time}
func ControlSocketPath(root string) string                 // <root>/control.sock, or the fallback (pibridge's rule)
```

### C2. The server program's commands

#### C2.1 Commands and flags (the end state)

```
ai-whiteboard [serve] [flags]        run in the foreground; refuses when not set up (A22)
ai-whiteboard launch [flags] [-json] start in the background unless running; print address and fingerprint
ai-whiteboard relaunch [flags] [-json]  stop the running server (this build or the one before), then launch
ai-whiteboard stop [-home DIR]       stop the running server (this build or the one before)
ai-whiteboard status [-home DIR] [-json]   what the running server serves, and what the next start will do
ai-whiteboard remote setup [-port N] [-name X]... [-new-cert] [-home DIR]
ai-whiteboard secret [-new] [-home DIR]
```

Flags of `serve`, `launch`, `relaunch`: `-home`, `-cwd`, `-claude`, `-cursor`, `-cursor-cost`, `-pi`,
`-pi-namer-model`. Gone: `-port`, `-client` (and `-server-port` of `remote setup`). `remote status` and
`remote off` answer exit 2 with: `"remote status" is now "status"; "remote off" is gone: a server always serves
its clients over HTTPS with the secret.`

#### C2.2 `launch` and `relaunch` output

Text (default), exit 0:

```
AI Whiteboard is running.
Address: https://127.0.0.1:4748
Fingerprint: AB:CD:…:EF
```

or, for a running server of the build before:

```
An AI Whiteboard server of an older build (version 0.9.0, pid 123) is running. Restart it with: "<program>" relaunch
```

With `-json`, exactly one line on stdout and nothing else, exit 0:

```json
{"state":"running","address":"https://127.0.0.1:4748","fingerprint":"AB:CD:…","version":"1.2.3","featureLevel":6,"instanceId":"<uuid>","pid":123,"home":"/Users/x/.ai-whiteboard"}
{"state":"old_build","version":"0.9.0","featureLevel":5,"pid":123,"home":"/Users/x/.ai-whiteboard"}
```

`address` is always `https://127.0.0.1:<client port>`. `fingerprint` is the running server's (from the control
socket's `/status`), uppercase hex pairs joined by `:`. `featureLevel` of an old build is what its hello said (0
when none).

Failure: exit 1, nothing on stdout, stderr `AI Whiteboard: <title>` and then the detail lines. Before starting a
server, `launch` runs the start's check (`remote.Check`) itself and fails with its message (A22 for a server never
set up), title `the server was not started`. Other titles as today (`the server stopped while starting` with the
log's last 8 lines, `the server did not answer within 30 seconds`). `relaunch` refuses before it stops anything
when the check fails (title `the server was not restarted`).

#### C2.3 `status`

Text: lines `Running: this build <version> (pid <n>)` | `Running: older build <version> (pid <n>)` |
`Running: no server`; for this build also `Address:`, `Port:`, `Names:`, `Fingerprint:`, `MCP listener: <url>
(up|down)`; then `Files: the next start will listen` | `Files: not set up` | `Files: the server will not start`,
with `Port:`, `Names:`, `Fingerprint:` of the files and `Note:` lines. Never the secret. Exit 1 when the next start
would fail (not set up included), with the check's message on stderr; else 0.

`-json`: one JSON object on stdout (also when exit is 1):

```json
{
  "running": null | {
    "build": "this" | "older",
    "version": "1.2.3", "pid": 123, "featureLevel": 6, "instanceId": "<uuid>",
    "client": null | {"listening": true, "address": "https://127.0.0.1:4748", "port": 4748,
                      "names": ["mac.local"], "fingerprint": "AB:…", "secretReloads": 0},
    "mcp": null | {"listener": {"port": 6006, "url": "http://localhost:6006/mcp", "up": true},
                   "chats": [ /* today's boardapi.Contact list */ ]}
  },
  "files": {"setUp": true, "ok": true, "port": 4748, "names": ["mac.local"], "fingerprint": "AB:…",
            "message": "<only when ok is false>", "notes": []}
}
```

`client` and `mcp` are null for an older build.

#### C2.4 The control socket and `server.json`

- Path: `store.ControlSocketPath(root)`: `<root>/control.sock` when that path has at most 100 bytes, else
  `<os.TempDir()>/aiwb-<16 hex of sha256(root)>/control.sock` (folder 0700), as `pibridge.SocketPath`.
- `serve` binds it after the MCP and client listeners, mode 0600. A socket file that is there and answers nobody
  is removed first; one that answers is another running server: `serve` says "already running" and exits 0.
- `server.json` (0600): `{"pid": <n>, "port": <client port>, "control": "<socket path>", "started": "<time>"}`;
  written after every bind, removed on shutdown with the socket.
- HTTP/1.1 over the socket. `GET /hello` → `{"app":"ai-whiteboard","version","featureLevel":6,"instanceId","pid",
  "dataDir"}`. `GET /status` → `{"client": {"listening","address","port","names","fingerprint","secretReloads"},
  "mcp": {"listener": {"port","url","up"}, "chats": [...]}}`. No secret, no other route (404).

#### C2.5 Finding a running server (every command that looks for one)

`findRunning(root)` answers none, this build or an older build, with the pid:

1. The control path from `server.json` (or the default path when the file has none): `GET /hello` within 1 s;
   this build when `app` is `ai-whiteboard`, `instanceId` equals the folder's `instance-id` file and the real path
   of `dataDir` equals the real path of the folder.
2. Else the legacy probe (A8): the ports `server.json.port` when the file has no `control` field, then 4747;
   `GET http://127.0.0.1:<port>/api/hello` within 1 s with `app` `ai-whiteboard`, `pid` > 0, its `instanceId`
   equal to the folder's (when the folder has one), and `GET /api/state` `dataDir` equal to the folder: an older
   build. `stop` and `relaunch` stop it by SIGTERM to its pid and wait up to 10 s for its hello to stop answering;
   `secret -new` signals it as today when its `/api/remote/status` says it listens.
3. Else none.

`serve` uses it too: a running server of either build means "AI Whiteboard is already running", exit 0, and no
bind is tried.

#### C2.6 The start's other steps

At every start of `serve`, before any listener: the old server list goes (A23), the change-overs of today run
(`localOnly`, `DropRemoteGroup`). The not-set-up refusal (A22) comes from `remote.Check` before any bind.

### C3. The shared connection module (`desktop/conn`)

#### C3.1 Files

```
desktop/conn/index.js       createClient (C3.2); re-exports parseAppWaits
desktop/conn/routes.json    C1.4
desktop/conn/address.js     parseAddress (port of internal/servers/address.go)
desktop/conn/list.js        the server list file (port of internal/servers/list.go): read, check, set aside, write
desktop/conn/tls.js         connectPinned / connectVerified, fingerprint helpers, error → outcome (port of dial.go)
desktop/conn/session.js     one HTTP/2 session per entry: request(), openStream(), close()
desktop/conn/outcomes.js    Outcome table and State mapping (port of outcome.go, view.go)
desktop/conn/conn.js        the connection of one entry: attempt, stream, silence, back-off, stops, retry (port of conn.go)
desktop/conn/test.js        Test connection, five steps (port of test.go)
desktop/conn/calls.js       call(): route check, body limits, time limits, answers in each state (port of remotes/calls.go)
desktop/conn/picture.js     picture(): the fetch and the check of the bytes (port of remotes/images.go Picture)
desktop/conn/local.js       this computer's starter and the owner's operations (C3.9, C3.10)
desktop/conn/timing.js      defaults and AIWB_APP_WAITS (C3.11)
```

#### C3.2 The JavaScript API

```js
const { createClient, parseAppWaits } = require('./conn');

const client = createClient({
  stateDir,            // string: holds servers.json and client-id; made 0700 when missing
  local,               // null (no local entry: a host of remote servers only) or
                       // { bin: string, home: string | null, env?: object, run?: RunFn }
  timing,              // optional Partial<Timing> (C3.11)
  log,                 // optional (line: string) => void; never given a secret
});

client.clientId                       // string, the app's id (A12)
client.subscribe(onEnvelope)          // → { close() }: opens the streams; at most one subscription (a new one ends the old)
client.call(req)                      // → Promise<CallAnswer>   (C3.7)
client.picture(req)                   // → Promise<PictureAnswer> (C3.8)
client.app(op, args)                  // → Promise<{ status: number, body: any }>   (C3.10)
client.localInfo()                    // → null | { home, address, version, pid }: what the last launch printed
client.close()                        // → Promise<void>: ends every stream, session and timer; stops no server

// RunFn: (args: string[], timeoutMs: number) => Promise<{ code: number, stdout: string, stderr: string }>
//        default: child_process.execFile(bin, args, { env, timeout }); code -1 when the program could not run
// CallRequest:  { server: string, method: string, path: string,
//                 body?: { json: string } | { bytes: Uint8Array, type: string }, signal?: AbortSignal }
// CallAnswer:   { status: number, text: string, sceneRev: number | null }
// PictureRequest: { server: string, chat: string, image: string, signal?: AbortSignal }
// PictureAnswer:  { ok: true, type: string, data: Uint8Array } | { ok: false, status: number, text: string }
// Envelope:     { server: string, event: object } | { app: AppEvent }
// AppEvent:     { type: "servers", servers: ServerView[], notice: string }
//             | { type: "server_state", server: ServerView }
```

`call`, `picture` and `app` never reject for anything a server or the module answers: those are statuses. They
reject only with an `AbortError` when `signal` aborted.

#### C3.3 ServerView, states, outcomes

`ServerView` is today's (`web/src/logic/servers.ts`), no secret ever:
`{ id, local?, name, address?, selfSigned?, pin?, instanceId?, state, detail?, fingerprint?, version?, agents? }`.

States: today's eleven (`connecting`, `connected`, `unreachable`, `secret_not_accepted`,
`fingerprint_not_accepted`, `certificate_changed`, `certificate_not_accepted`, `name_not_known`, `not_aiwb`,
`too_old`, `another_server`) and `not_started` (local entry only, A19). Outcomes and their steps and sentences:
today's table (`internal/servers/outcome.go`) with three sentences changed: `refused` "Nothing listens there: is
the server running on that machine?", `not_https` "Not HTTPS: is this the address of an AI Whiteboard server?",
`is_local` "This is this computer's server". `MinFeatureLevel` 6, `ClientLevel` 6.

The local entry's view: `{ id: "local", local: true, name: "This computer", address?, instanceId?, state,
detail?, version?, agents? }`; it is first in every list; `fingerprint` and `pin` are never shown for it.

#### C3.4 Events and their order

On `subscribe`, the module emits `{app: servers}` (the whole list), then `{app: server_state}` for each entry,
then for each entry independently, every time its stream opens:

1. `{server: X, event: <hello>}` and `{server: X, event: <snapshot>}` as the server sent them, after the
   snapshot was read whole;
2. `{app: server_state}` with X `connected`;
3. every later event of X's stream, as it came, in its order.

When X's stream ends for any reason: `{app: server_state}` with X's new state, and no event of X until its next
step 1. A change of the list (add, edit, remove, accept) is `{app: servers}`. A change of any shown field of an
entry is `{app: server_state}`. Events of different entries interleave in the order they were read. No event is
dropped or reordered; the module keeps no copy of a tree.

#### C3.5 The connection of an entry (port of `conn.go`, `dial.go`)

Exactly today's behaviour, with these settled points:

- TLS: `tls.connect({host, port, servername, ALPNProtocols: ['h2'], rejectUnauthorized})`. With `selfSigned` and a
  pin: `rejectUnauthorized: false`, then on `secureConnect` the leaf's `fingerprint256` must equal the pin
  (compared after normalising both to uppercase hex with `:`), else `cert_changed` with the presented fingerprint,
  and the socket is destroyed before anything is written. `selfSigned` without a pin: `fingerprint` (nothing
  sent). Without `selfSigned`: `rejectUnauthorized: true`, Node's error codes mapped as dial.go maps Go's:
  `ECONNREFUSED`→`refused`, `ENOTFOUND`/`EAI_AGAIN`→`name_not_found`, `EHOSTUNREACH`/`ENETUNREACH`/dial
  timeout→`no_route`, handshake timeout→`tls_timeout`, a non-TLS answer (`ERR_SSL_WRONG_VERSION_NUMBER`,
  `EPROTO` with "wrong version number" or "packet length too long")→`not_https`,
  `ERR_TLS_CERT_ALTNAME_INVALID`→`cert_name`, `CERT_HAS_EXPIRED`→`cert_expired`,
  `DEPTH_ZERO_SELF_SIGNED_CERT`/`SELF_SIGNED_CERT_IN_CHAIN`→`self_signed`, other certificate errors→
  `cert_untrusted`, anything else→`tls_error`. ALPN not `h2`→`not_aiwb`.
- Then `http2.connect(address, { createConnection: () => socket })`. Every request carries `X-AIWB-Secret`,
  `X-AIWB-Client: <clientId>`, `X-AIWB-Level: 6`, `Host`/`:authority` = the entry's `host:port`.
- Attempt: `GET /api/hello` (Hello limit) → 403 "bad host"→`bad_host`; not 200 / not JSON / `app` not
  `ai-whiteboard` / no valid `instanceId`→`not_aiwb`; level < 6→`too_old` (with `version`); the instance claim of
  today (`is_local` when it is the local entry's instance id, `duplicate`, `another_server`); then
  `GET /api/events?client=<clientId>` with `Accept: text/event-stream` → 401→`secret_refused`, 403 with "bad
  host"→`bad_host`, other non-200 or non-event-stream→unreachable "The server's event stream did not open"; read
  events until `snapshot` within FirstEvent; the snapshot must be JSON with `agents` readable, else `no_state`.
- Silence: no byte for `silence` (35 s) ends the stream ("The server went silent"). Back-off 1, 2, 5, 10, 30 s ±20 %,
  back to the first step after a stream that stayed open `stable` (30 s). States that stop wait for the user (an
  edit, an accept, a test, Retry) except `too_old`, asked again every `tooold` (5 min). A call answered 401 marks
  the entry for a new attempt, which then shows `secret_not_accepted`.
- Connections run only while a subscription exists; `close()` of the subscription ends them, and the next
  `subscribe` starts them again from their first attempt.
- Entries are independent: nothing of one entry waits for another (a black-holed remote never delays the local
  entry's events or calls, and the other way round).

#### C3.6 The server list (port of `list.go`, `manager.go`, `test.go`)

File `<stateDir>/servers.json` `{"version":1,"servers":[{id,name,address,secret,selfSigned,pin,instanceId}]}`,
written atomically (temp file + rename) with mode 0600. Ids `s_` + 12 lowercase hex. The rules of today's list
(name 1–80 characters, address `https://host:port`, secret 1–256 printable ASCII without spaces, pin a SHA-256
fingerprint, duplicates by address, set-aside of an unreadable file with the notice) are kept, and so are the
answers of the operations (C3.10). **Test connection** keeps today's five steps and `TestResult` shape; since hello
needs no secret (A10), step 4 reads hello and then `GET /api/state` with the secret (401 → `secret_refused`).
The local entry is never in the file and cannot be added, edited, removed,
tested or accepted (409 code `local_entry`). A fresh `stateDir` has no entry: the change-over moves nothing
(D18).

#### C3.7 Calls

`call({server, method, path, body, signal})`, in order:

1. `server` is the local entry (when there is one) or an entry of the list, else 404
   `{"error":"This server is not in the list.","code":"no_server"}`.
2. `method path` (the path before `?`) matches a row of `routes.json` other than `GET /api/events`; a
   `{name}` matches one non-empty segment that is not `.` or `..`; else 400 `{"error":"not a call of the client
   API","code":"not_client_api"}`. A path with `#` or without the `/api/` start fails here too.
3. Body: JSON bodies at most 2 MiB; `PUT /api/boards/{id}/scene` at most 128 MiB; `POST /api/chats/{id}/images`
   at most 5 MiB (413 code `image_too_large`, nothing sent); others 413 code `too_large`.
4. The entry not `connected`: `POST …/unfollow` answers 200 `{"ok":true}` and `POST /api/boards/{id}/release`
   answers 200 `{"state":"none"}`, nothing sent; every other call 503 code `server_unreachable` with "<name> is
   not connected." (or "<name> is too old: update the server on that machine." for `too_old`), nothing sent, and
   an entry that waits for its next attempt tries at once.
5. Send it with the limit of its route:

   | Route | Limit |
   |---|---|
   | `POST /api/chats/{id}/messages`, `POST /api/chats/{id}/fork`, `POST /api/chats/{id}/open`, `GET /api/chats/{id}/context`, `POST /api/groups/{id}/archive` | `start` 45 s |
   | `GET`/`PUT /api/boards/{id}/scene` | `scene` 60 s |
   | `POST /api/chats/{id}/images` | `imagecall` 60 s |
   | `DELETE /api/groups/{id}` with `contents=delete` | `delete` 3 min |
   | `GET /api/dirs` | `dirs` 10 s |
   | `GET /api/usage/{agent}` | `usage` 30 s |
   | `POST /api/chats/{id}/unfollow` | `unfollow` 5 s |
   | every other | `call` 15 s |

6. The answer: 401 → 503 `server_unreachable` (and the entry tries again); a body that is neither empty nor JSON,
   or one longer than 160 MiB → 502 code `bad_answer`
   "<name> gave an answer that cannot be read."; no answer within the limit, or the stream reset → 504 code
   `no_answer` "<name> did not answer." (for a message: code `send_unknown`, "<name> did not answer: it is not
   known whether the message arrived."). Else `{status, text: <body as UTF-8>, sceneRev: <X-AIWB-Scene-Rev as a
   number, or null>}`.

All synthesized answers are JSON `{"error": "<sentence>", "code": "<code>"}`.

#### C3.8 Pictures

`picture({server, chat, image, signal})`: checks 1 and 4 of C3.7 (404 `no_server`, 503 `server_unreachable`);
`chat` must match `^[A-Za-z0-9_-]{1,100}$` and `image` `^[0-9a-f]{64}$`, else 400 code `image_id`; then
`GET /api/chats/<chat>/images/<image>` with the `imagecall` limit, at most 8 at a time per entry (the rest wait in
order). A non-200 answer is passed as `{ok:false, status, text}` (401 as in C3.7). A 200 is taken from its bytes
alone, whatever its `Content-Type`: PNG (`89 50 4E 47 0D 0A 1A 0A`), JPEG (`FF D8 FF`), GIF (`GIF87a`/`GIF89a`) or
WebP (`RIFF` … `WEBP` at offset 8), at most 5 MiB (`model.ImageMaxBytes`); else `{ok:false, status: 502, text:
<bad_answer JSON>}`. The answer's type is the one found from the bytes.

#### C3.9 This computer's starter (`local.js`)

Present when `createClient` got `local`. Arguments: `-home <home>` is appended to every command when `home` is
not null.

- **Start** (on the first `subscribe`, on Retry, and before each attempt after an attempt that ended unreachable):
  view `connecting` (the first time) or kept as it is (later), run `launch -json` (40 s).
  - exit 0, `state: "running"`: run `secret` (10 s), take its first line; the local connection's target becomes
    `{address, selfSigned: true, pin: fingerprint, secret}`; when the target changed, the connection ends what it
    had and attempts at once.
  - exit 0, `state: "old_build"`: view `too_old` with `version` and detail "A server of an older build is
    running: restart it."; no connection; start again every `tooold` (5 min), on Retry and on restart.
  - anything else (exit ≠ 0, a time-out, output that is not one JSON line of that form, `secret` failing): view
    `not_started`, `detail` = the stderr text trimmed (or a sentence saying what was wrong with the output); start
    again after the back-off steps, at once on Retry.
- **The local connection's own outcomes**: `secret_refused` → run `secret` once; a different secret → attempt at
  once; the same → stay `secret_not_accepted` until Retry. `cert_changed` → run `launch -json` once; a different
  fingerprint → attempt at once; the same → stay `certificate_changed` until Retry. `too_old` (hello level < 6) →
  view `too_old`, asked again every `tooold`. Unreachable outcomes → Start before the next attempt.
- The user never types or accepts anything for this entry.

#### C3.10 App operations (`client.app(op, args)`)

Answers `{status, body}`; the bodies of the `servers.*` operations are today's `/api/servers` bodies and refusals
(`internal/server/servers.go`: `serverSaved`, the codes `local_entry`, `bad_name`, `bad_address`, `bad_secret`,
`bad_pin`, `duplicate`, 404 for an unknown id).

| op | args | answer body |
|---|---|---|
| `servers.list` | – | `{servers, notice}` |
| `servers.add` | `{form, force}` | `{saved, server?, result?}` |
| `servers.edit` | `{id, patch, force}` | `{saved, server?, result?}` |
| `servers.remove` | `{id}` | `{ok: true}` |
| `servers.test` | `{form}` | TestResult |
| `servers.testSaved` | `{id, over?}` | TestResult |
| `servers.accept` | `{id, fingerprint}` | `{server}` |
| `owner.restart` | – | `{ok: true}` once `relaunch -json` and `secret` succeeded; 500 `{error: <stderr>, code: "restart_failed"}` otherwise. Meanwhile the local view is `connecting` with detail "Restarting…". |
| `owner.retry` | – | `{ok: true}`: Start now (C3.9), or a new attempt of the local connection |
| `owner.status` | – | the parsed `status -json` object; 500 code `status_failed` when it cannot be read |
| `owner.openLog` | – | 501 `{code: "not_here"}` in the module; the Electron face answers it itself (C4.3) |
| `owner.reveal` | `{board}` | 501 `{code: "not_here"}` in the module; the Electron face answers it itself |

Without `local`, every `owner.*` answers 404 code `no_owner`. An unknown op answers 404 code `no_op`.

#### C3.11 Timing and `AIWB_APP_WAITS`

`Timing` fields (ms) and defaults: `dial` 3000, `handshake` 3000, `headers` 3000, `hello` 10000, `firstEvent`
10000, `testStep` 5000, `silence` 35000, `backoff` [1000, 2000, 5000, 10000, 30000], `jitter` 0.2, `stable` 30000,
`tooOld` 300000, `call` 15000, `start` 45000, `scene` 60000, `imageCall` 60000, `delete` 180000, `dirs` 10000,
`usage` 30000, `unfollow` 5000, `launch` 40000, `relaunch` 60000, `secret` 10000. `parseAppWaits(string)` reads
`name=duration` pairs separated by commas with the names `silence`, `backoff` (the last step; the others keep
their share, and `stable` follows it, as `testwaits.go` does today), `tooold`, `call`, `start`, `scene`,
`imagecall`, `delete`, `firstevent`, `hello`; a bad value throws. Durations in Go's syntax (`3.5s`, `500ms`,
`2m`).

### C4. The app: IPC face, preload, picture scheme, window

#### C4.1 The preload surface (`window.aiwbApp`, nothing else)

```ts
interface AiwbApp {
  call(req: { id: string; server: string; method: string; path: string;
              body?: { json: string } | { bytes: Uint8Array; type: string } }): Promise<{ status: number; text: string; sceneRev: number | null }>;
  cancel(id: string): void;
  stream(open: boolean): Promise<{ ok: true }>;
  onEvents(cb: (batch: Envelope[]) => void): () => void;            // returns an unsubscribe
  onStreamState(cb: (state: "open" | "closed") => void): () => void;
  app(op: string, args?: unknown): Promise<{ status: number; text: string }>;   // text: JSON of the body
  pickImages(): Promise<DesktopPick>;                               // today's answer shape
}
```

`window.aiwbDesktop` goes. `window.aiwbFlush` stays (the page defines it).

#### C4.2 IPC channels

| Channel | Kind | Payload → answer |
|---|---|---|
| `aiwb:call` | invoke | `{id, server, method, path, body?}` → CallAnswer |
| `aiwb:cancel` | send | `{id}` |
| `aiwb:stream` | invoke | `{open: boolean}` → `{ok: true}`; opening ends the window's previous subscription |
| `aiwb:events` | main → page | `Envelope[]`, in order, batched per turn of the main process's event loop (at most 500 per batch) |
| `aiwb:stream-state` | main → page | `"open"` after the subscription started, `"closed"` when the main process ended it (only at quit) |
| `aiwb:app` | invoke | `{op, args}` → `{status, text}` |
| `aiwb:pick-images` | invoke | none → DesktopPick |

Every handler first checks the sender (C4.3); a refused sender gets a rejected promise (invoke) or nothing (send).
A call goes on in the main process to its end when the page unloads (that is how a save finishes while the page
unloads); only `aiwb:cancel` stops it. When the main window's main frame starts a cross-document navigation, is
reloaded, crashes or closes, its subscription ends.

#### C4.3 The checks of the main process

- **The sender**: `event.sender === mainWindow.webContents`, `event.senderFrame === mainWindow.webContents.mainFrame`,
  and `senderFrame.url` without its hash equals the page's URL (`pathToFileURL(pagePath).href`).
- **A call**: the module's checks (C3.7). **An app op**: the op is one of C3.10's.
- `owner.openLog`: `shell.openPath(<home>/server.log)` with `home` from `client.localInfo()` (else
  `~/.ai-whiteboard`, or `AIWB_HOME`). `owner.reveal`: `board` must match `^b_[0-9a-z]{8}$`, the file
  `<home>/boards/<board>/drawing.excalidraw` must exist (else 404 code `not_found`), then
  `shell.showItemInFolder(file)`; answers `{ok: true}`.
- `pickImages`: today's code, with the sender check of this section.

#### C4.4 The picture scheme

- `protocol.registerSchemesAsPrivileged([{scheme: 'aiwb-picture', privileges: {standard: true, secure: true}}])`
  before `ready`; `session.defaultSession.protocol.handle('aiwb-picture', handler)`.
- `session.defaultSession.webRequest.onBeforeRequest({urls: ['aiwb-picture://*/*']}, …)` cancels every request
  whose `details.webContentsId` is not the main window's, whose `details.frame` is not its main frame, or whose
  frame URL without hash is not the page's URL. (Pure decision function `pictureAllowed` in `desktop/lib.js`.)
- The handler parses `aiwb-picture://p/<entry>/<chat>/<image>` (three segments, each `decodeURIComponent`d; host
  `p`; `entry` `^(local|s_[0-9a-f]{12})$`), else 400. Then `client.picture(...)`. OK: `new Response(data,
  {headers: {'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private,
  max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'; sandbox"}})`. Not OK: a response
  with that status and no body.
- The scheme answers nothing else: no other host, no other path form, no method but GET.

#### C4.5 The window and the start

- On `ready`: create the client (C3.2) with `stateDir = <userData>/client`, `local = {bin, home: AIWB_HOME ||
  null, env: process.env}`, `timing = parseAppWaits(AIWB_APP_WAITS)`; create the main window at once and
  `loadFile` the page. No "Starting…" window, no start error dialog, no reconnector.
- `bin`: `AIWB_SERVER_BIN`, else in the packaged app `Contents/MacOS/ai-whiteboard`, else `../bin/ai-whiteboard`
  of the checkout (today's `serverBin`). Page path: `AIWB_PAGE` (tests), else packaged
  `<resourcesPath>/web/index.html`, else `../web/dist/index.html` of the checkout. `AIWB_USER_DATA`, when set, is
  given to `app.setPath('userData', …)` before `ready` (tests).
- Links: the window never leaves the page: a navigation to the page's own URL (another hash) stays; an http(s) or
  mailto URL goes to the default browser; anything else is dropped (`linkAction` with the page URL in place of an
  origin). Close, quit and reload still wait for unsaved drawing (`attachCloseFlush`, unchanged). A second start
  brings the window forward; with no window (macOS), it makes one. Quit closes the client (no server is stopped).

### C5. The HTTP face (`web/dev/hostface.mjs`), the test host and the mock

#### C5.1 `hostface.mjs`

```js
import { createHostFace } from './hostface.mjs';
const face = createHostFace({ client, distDir, log });   // client: C3.2's API, or the mock's fake with the same API
const server = http.createServer(face.handle);           // the caller listens; the face never does
```

Routes (every other GET is a file of `distDir`, `/` being `index.html`; anything else 404):

| Route | Does |
|---|---|
| `GET /host/events` | an SSE stream: `subscribe` on the client (ending the previous subscription of this face); each envelope as `data: <JSON>\n\n`; `: ping` every 20 s; the subscription ends when the request closes |
| `POST /host/call?server=<id>&method=<M>&path=<urlencoded path with query>` | `client.call` with the body (JSON when `Content-Type` is `application/json`, else bytes with that type); aborting the request aborts the call; answer: the status, `Content-Type: application/json; charset=utf-8`, the text, and `X-AIWB-Scene-Rev` when `sceneRev` is not null |
| `GET /host/picture/<entry>/<chat>/<image>` | `client.picture`; OK: the bytes with the headers of C4.4; else the status with the text as JSON |
| `POST /host/app/<op>` | `client.app(op, <JSON body or undefined>)`; answer: the status and the body as JSON |

#### C5.2 `host.mjs` (tests only, never shipped)

```
node web/dev/host.mjs --state-dir DIR [--local-bin PATH --local-home DIR] [--dist DIR] [--port N]
```

Binds `127.0.0.1` only, port `N` or 0; prints `Host: http://127.0.0.1:<port>/` as its first stdout line; uses
`createClient` of `desktop/conn` (via `createRequire`) with `local` when `--local-bin` is given; reads
`AIWB_APP_WAITS`; `--dist` defaults to `web/dist`. It answers `owner.openLog` and `owner.reveal` with the module's
501. It also exports `startHost(options) → {url, close()}` for scripts.

#### C5.3 The mock

`web/dev/mock.mjs` keeps its worlds, seeds, flags and `/mock/*` controls, and stands behind the same face: it
implements a fake client with C3.2's API (`subscribe`, `call`, `picture`, `app`, `localInfo`, `close`), where
`server` picks the world (`local` or an entry id), each world answers the client API as a server does (C1), and
the list and states are the mock's (`addServer`, `setServerState`, `removeServer` emit `{app: servers}` /
`{app: server_state}` and open or end that world's "stream": hello and snapshot, then its events). Every
`/api/…` and `/api/on/…` route of the mock goes.

### C6. The page's transport (`web/src/transport/`)

#### C6.1 Files and the build

```
web/src/transport/types.ts   the types below
web/src/transport/index.ts   transport(): the one Transport, chosen once; useTransport(t) for tests
web/src/transport/ipc.ts     the IPC way over window.aiwbApp
web/src/transport/http.ts    the HTTP way over fetch and EventSource to location.origin
```

`web/index.html`: `href="./main.css"`, `src="./main.js"`, `./favicon.ico`, … (relative). `main.tsx`:
`window.EXCALIDRAW_ASSET_PATH = new URL("./", location.href).href`. `build.mjs` writes no `version.json`.

#### C6.2 Types

```ts
export type ServerId = string;                         // "local" or "s_" + 12 hex
export type CallBody = { json: string } | { bytes: Uint8Array | Blob; type: string };
export type CallRequest = { server: ServerId; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string;
  body?: CallBody; signal?: AbortSignal; keepalive?: boolean };
export type CallAnswer = { status: number; text: string; sceneRev: number | null };
export type Envelope = { server: ServerId; event: any } | { app: AppEvent };
export type AppEvent = { type: "servers"; servers: ServerView[]; notice: string } | { type: "server_state"; server: ServerView };
export type StreamState = "open" | "closed";
export type AppAnswer = { status: number; text: string };
export interface Transport {
  readonly way: "ipc" | "http";
  call(req: CallRequest): Promise<CallAnswer>;   // rejects only on abort, or when the way itself failed (TransportError)
  stream(onEnvelope: (e: Envelope) => void, onState: (s: StreamState) => void): { close(): void };
  pictureURL(server: ServerId, chat: string, image: string): string;
  app(op: string, args?: unknown): Promise<AppAnswer>;
  pickImages?(): Promise<DesktopPick>;           // the IPC way only
}
```

- IPC: `call` makes an id (`crypto.randomUUID()`), turns a Blob into a `Uint8Array`, and calls
  `aiwbApp.cancel(id)` when `signal` aborts; `keepalive` needs nothing (C4.2). `pictureURL` =
  `aiwb-picture://p/${enc(server)}/${enc(chat)}/${enc(image)}`.
- HTTP: `call` = `fetch("/host/call?…", {method: "POST", body, keepalive, signal, cache: "no-store"})`;
  `stream` = one `EventSource("/host/events")`: `onState("open")` on open, `onState("closed")` when its
  `readyState` is `CLOSED`; `pictureURL` = `/host/picture/${enc(server)}/${enc(chat)}/${enc(image)}`; `app` =
  `fetch("/host/app/<op>")`. `pickImages` is absent: the composer uses the browser's file picker, as in a tab today.
- Choice (A6): `window.aiwbApp` present → IPC; else `location.protocol` is `http:` → HTTP; else a fixed screen
  "AI Whiteboard runs in its app".

#### C6.3 The one place

Nothing in `web/src` outside `web/src/transport/` calls `fetch`, makes an `EventSource`, names `/api/` as a URL
to load, names `/host/`, or touches `window.aiwbApp`. `api.ts`, `libraryapi.ts`, `serversapi.ts`, `uploads.ts`,
`logic/chatimage.ts`, `conn.ts`, `version.ts`, `ComposerImages.tsx` go through `transport()`. The answer of a call
becomes an `ApiError` exactly as `send()` makes one today (status, the JSON `error`, `code`, `rev`/`draft` of a
stale draft, `images` of a refused Send). The page has no client id of its own (`clientId` goes) and no
`unknown_client` handling (`logic/unknownclient.ts` goes).

#### C6.4 Calls in the page

A thing is named by its key as today (`logic/keys.ts`). `pathOf(kind, key)` answers `{server, path}` with the
path `/api/<kind>/<own id>`; `apiRoot` goes. Every `api.*` function calls `transport().call({server:
serverOfKey(key) …})`. `dirs(path, server)` and `usage(agent, fresh, server)` call that server's own route.
`rpcReply` and `flushed` take the server whose event they answer. `reveal(id)` is `app("owner.reveal", {board:
ownId(id)})` for a board of this computer. `collapseGroup` goes. Library calls go to the library's server with
`/api/library/local/…`.

#### C6.5 Events in the page

For `{server: X, event}`: `on = X === "local" ? "" : X`, and the event is handled as today's event with that
`server` (the field is no longer in the event). In particular:

- `hello`: for `local`, today's handling; for any X, the board roles of X's boards are reset (`streamOpened`
  scoped to X).
- `snapshot`: for `local`, `applySnapshot` of this computer's own fields (groups, boards, chats, states, defaults,
  agents, catalogs, home, defaultCwd), leaving servers, sections, lists and the other libraries as they are; for X,
  `onSection(X, {groups (without collapsed), boards, chats, states, defaults})`, `lists[X] = {agents, catalogs,
  home, defaultCwd}`. For every entry, its library (from `library`, with `notice` = `libraryNotice`) is upserted
  as `{server: X, name: <entry's name>, connected: true, …}`; local first, then in list order.
- `own_library`: upsert that entry's library. `catalog`, `agents`: `lists[X]` for X, today's fields for `local`.
- `server_stopping` from X: flush the boards of X, then `POST /api/client/flushed` to X.
- `rpc`, `held`, `release_request`, `superseded`: today's, with the key on X; the reply goes to X.

For `{app: servers}`: `setServers` + `dropRemoved` (an entry gone takes its section, lists and library). For
`{app: server_state}` of X: `upsertServer`; when X leaves `connected`, `onSection(X, null)` and X's library becomes
`connected: false` (for `local`: C7). For `onState("closed")`: A25.

### C7. This computer's section (page)

- The sidebar is sections only. The first is `local`, always there: its head is the entry's name, its state in the
  words of **Servers** (`stateLabel`, with `not_started` → "Not started"), its "+" while connected, and its
  collapse (key `local` in `store.collapsed`). No menu, not removable, not editable.
- Rows: today's local part, while the local entry is `connected`. Not connected: no rows and the section's one line
  ("Its chats show when the server is back"), as every section.
- `not_started`: the reason (`detail`, as preformatted text, at most 12 lines shown), **Retry**
  (`owner.retry`) and, in the app, **Open server log** (`owner.openLog`). `too_old` of the local entry:
  its version and **Restart server**. Connected with `version` ≠ `__APP_VERSION__` (neither `dev`): one line "This
  computer's server runs another build (<version>)" and **Restart server**. Restarting: "Restarting…"; failed:
  "Restart failed", the reason, **Retry** and **Open server log**. These replace the update banner.
- Restart: confirm when agents of this computer run (today's `restartConfirmText`), `aiwbFlush`, then
  `owner.restart`. The page is not reloaded: the local entry goes `connecting` and comes back with a new snapshot.
- Outage of the local entry is a section's outage: an open chat stays read-only under the warning naming "This
  computer", an open board can be drawn on under the banner, and both are brought level when the entry is back.
  What the sections goal and today's code say only of the local part stays for it: its unsaved drafts are kept in
  the browser's storage and saved when it is back, its recent folders are kept there, its boards can be revealed.
- The sidebar's head "+" makes things on this computer; it is disabled while the local entry is not connected.
- **Servers** lists "This computer" first, with its state, version and address, and, for it only: **Restart
  server**, **Open server log**, the MCP listener's state (`owner.status` → `running.mcp.listener`: URL and up or
  down, read when the dialog opens) and, when not started, **Retry**. Its other rows are as today.

---

## 4. Waves

| Wave | Workstreams (in parallel) | Starts from |
|---|---|---|
| 1 | **G1** server internals · **J1** connection module · **W1** page transport · **M1** HTTP face and mock | the branch as it is now |
| 2 | **G2** commands · **D1** Electron app · **W2** this computer's section | wave 1 merged |
| 3 | **H1** test host and end-to-end scripts | wave 2 merged |
| 4 | **I** integration | wave 3 merged |

Dependencies: G2 needs G1's Go API (C1.7). D1 needs J1's module. W2 needs W1's transport and M1's mock for its
browser checks. H1 needs J1, W1/W2 (the page), M1's face and G1/G2 (real servers, `launch -json`). I needs all.
Within a wave the file sets are disjoint (section 5 "Owns").

---

## 5. The workstreams

### G1. Server internals (wave 1)

**Goal sections**: 4.1 (last bullet), 4.5 (one API, what the server no longer does, two listeners, client listener,
the secret, the first question, the feature level), 4.6 (the server side of every call's answers), 4.9 (the old
list is deleted: the store function), 4.10 ("no chain"), 6 (one API; the MCP listener; what a client cannot reach;
what goes away: local API, page serving, relay, pass-through, server list, connections to other servers), 7.1 (a
call without the secret refused and hello answered without it; no page at any address; older app refused;
owner's things not reachable by a client; every capability of the local API has an answer).

**Owns**: `internal/**` (all packages), and, for compilation only, `cmd/ai-whiteboard/main.go`,
`cmd/ai-whiteboard/remoteserve.go`, `cmd/ai-whiteboard/serverlist.go` (deleted), `cmd/ai-whiteboard/testwaits.go`.
**Must not touch**: other files of `cmd/`, `cmd/**/*_test.go`, `web/`, `desktop/`, `scripts/`, docs.

**Do**:
1. Delete `internal/servers` (with `linksim`, `standin`) and `internal/remotes`. Move `LevelHeader` to
   `internal/server`.
2. `internal/server`: implement C1 and C1.7. Delete `section.go`, `servers.go`, `client.go` (page files); in
   `server.go` delete `Handler`, `routes`' page-only routes (`/api/remote/status`, `/api/restart`,
   `/api/mcp/status`, `PUT /api/groups/order`, `POST /api/boards/{id}/reveal`, `/` files) and every `fromRemote`
   branch (all requests are clients now; `fromRemote`, `kindOf` and `remoteKey` go or collapse), `webVersion`,
   `failRPC`'s relay branch, `onAskedEntry`; `guard.go` keeps only what `MCPHandler` needs (the Host check);
   `remote.go` becomes the client listener (rename to `clients.go` is allowed) with C1.2/C1.3 and hello as A10;
   `images.go` without `ownPage` and `sectionImageRoutes`; `library.go` serves this server's library only;
   `apiboards.go` with `SceneMax` 128 MiB for all; add `POST /api/client/flushed` to the client routes; add
   `ControlHandler` (C2.4) with `/hello` and `/status` (the MCP status moves here). Keep `routeMux` if useful.
3. `internal/editorbridge`: one kind (C1.5). Remove `KindPage`, `Acted`, `ServeSSE`, the page-only events and the
   relay hooks and helpers. Keep `ServeAPI`, `CloseKind` (or a `CloseAll`), `FlushedBy`, `StopAndFlush`.
4. `internal/app`: remove `Snapshot`, `Servers`, `Remotes`, `Libraries`, the `library`/`library_removed`
   broadcasts (keep `own_library`); `APISnapshot` gains `LibraryNotice`; `UpdateGroup` loses `collapsed`.
   `internal/model`: `Group.Collapsed` goes.
5. `internal/remote`: `Check(root, mcpPort)` (C1.7) with the not-set-up refusal (A22) and message; `Off` goes;
   `PortEqual` with the server's own port goes (MCP stays).
6. `internal/store`: `RemoveServerList`, `ControlSocketPath`, `ServerFile` with `Control`.
7. `cmd/ai-whiteboard` (compile only): delete `serverlist.go` (move `localOnly` into `main.go`); in `serve` remove
   the loopback listener and `startServers`, call `store.RemoveServerList` and log, construct `server.Server` with
   C1.7's fields, serve `ClientHandler` via `ServeClients`; `remoteserve.go` adapted to `remote.Check(root,
   mcpPort)` (not set up is now fatal); `testwaits.go` keeps `ping`, `agents`, `images` only. Commands may misbehave
   until G2; `go build ./cmd/...` must pass.

**Tests** (in `internal/**`):
- Delete: `internal/server/{boardpair,both_clients,both_drop,both_ids,both_reach,both_remove,both_rig,both_shared,
  level5_chain,libraryremote,remotedraft,remoteimages,section_board,section_drop,section_everystate,section_ids,
  section_images,section_local,section_rig,section_routes,section_states,section_tree,servers}_test.go`,
  `internal/app/{section,servers}_test.go`, `internal/editorbridge/{section,unfollowed}_test.go`, every test of
  the deleted packages.
- Rewrite to the client handler (one harness: an `httptest` TLS server or the handler with the secret, a valid
  Host, a client id and level 6 put on by a helper; `bridgetest.ConnectWith` with those headers): `server_test.go`,
  `clients_test.go` (drop the known-client guard and the acted-last cases; keep holds and revisions),
  `targeting_test.go`, `forkflow_test.go`, `images_test.go` (no origin check), `library_test.go`,
  `branchroutes_test.go`, `cap_test.go`, `subsettings_test.go`, `smallfixes_test.go`, `acgaps_test.go`,
  `agents_test.go`, `noruns_test.go`, `rpcreply_test.go`, `apiclient_test.go`, `apiboards_test.go` (drop
  `OnBoardFree` cases), `apimake_test.go`, `remote_test.go`, `remotefixes_test.go`, `level5_*_test.go` (the
  "owner's page" becomes a second API client; level 6), `internal/app/{library,apiclient,app,hold,agents}_test.go`,
  `internal/editorbridge/{bridge,apikind,apiboards,level5_events}_test.go`.
- Add: hello without the secret (200, fields of A10, no pid) and with a wrong Host (403); every other route
  without the secret 401, for paths in and outside the table (`/`, `/index.html`, `/api/servers`, `/api/on/x/…`,
  `/api/restart`, `/api/mcp/status`, `/api/remote/status`, `/api/groups/order`, `/api/boards/b/reveal`): with the
  secret 404; `127.0.0.1:<port>` and `localhost:<port>` Hosts accepted; a client at level 5 refused
  `client_too_old` on `/api/events` while hello answers; `POST /api/client/flushed` ends `StopAndFlush`'s wait for
  an API client; `libraryNotice` in the snapshot; a 100 MB scene saves and a 129 MiB one is 413; `ControlHandler`
  `/hello` and `/status` (no secret in either); `remote.Check` not set up → not OK with the message of A22;
  `store.RemoveServerList` removes the list and its set-aside copies and nothing else; a board call with no holder
  fails at once with `ErrNoClient`; a table test that `ClientRoutes` equals C1.4.
- Run: `go test ./internal/...` (default), `AIWB_TEST_FULL=1 go test` of each changed package, `go test -race
  ./internal/server ./internal/editorbridge ./internal/app`, `go build ./...`, `go vet ./internal/...`.

**Done when**: the above pass; `grep -rn "internal/servers\|internal/remotes\|KindPage\|ServeSSE\|/api/on/"
internal cmd --include=*.go` finds nothing outside `cmd/**/*_test.go`.

### J1. The shared connection module (wave 1)

**Goal sections**: 4.1 (one connection per entry, HTTPS, secret, pin; no secret to the page), 4.4 (address,
fingerprint and secret from the commands; connecting; failed start with reason; tries again; never set up; stops
while open; other build/too old as states), 4.6 (all), 4.7 (owner's operations, re-reading after restart), 4.9
(the old list is not moved), 6 (the page and the main process: checks of a call; not tied to the desktop app;
between the app and a server: all; waits), 7.1 (the module's share of: the app with this computer's server in
each state, a remote down does not hold up the local and the other way round, no server outside the list / path
outside the client API, a picture's bytes, silent stream / refused secret / changed certificate also for this
computer, the server list after the change-over, the new app against an old running server), 7.2 (the pinned
connection, the secret and the picture check are tested here once).

**Owns**: `desktop/conn/**`, `desktop/test/conn/**` (new), `desktop/test/fixtures/**` (new),
`desktop/package.json` (only the `test` script, to include `test/conn/*.test.js`).
**Must not touch**: `desktop/main.js`, `desktop/preload.js`, `desktop/lib.js`, other `desktop/test/*`, `web/`, Go.

**Do**: C3 entirely, porting the Go code named in C3.1 (read `internal/servers/*.go` and
`internal/remotes/{calls,images}.go` on this branch before G1 deletes them; they are the reference behaviour).
`routes.json` exactly as C1.4.

**Tests** (`node --test`, no Electron, no Go build):
- Fixtures: `desktop/test/fixtures/tls/make.go` (`//go:build ignore`, run with `go run`) writes committed PEMs:
  two self-signed localhost/127.0.0.1 pairs (A, B), an expired self-signed pair, a CA with a leaf for
  `127.0.0.1`, a leaf for another name. Record the command in the file's comment.
- A stand-in server `desktop/test/conn/standin.js` (node:http2 `createSecureServer` with a fixture pair, `allowHTTP1:
  false`): hello, state, events (hello, snapshot, scripted events, pings), scripted routes, a way to cut, to go
  silent, to answer 401/403/not-JSON/slow, to change secret, to present another certificate, to hang.
- Cover: the list file (create 0700/0600, set aside, ids, duplicates, local entry refused); every outcome of
  C3.5 that a stand-in can produce (refused, name not found with an unresolvable `.invalid` name, tls timeout with
  a TCP server that never answers, not https with a plain TCP/HTTP server, fingerprint, cert changed, cert name,
  expired, self signed, untrusted, secret refused, bad host, not aiwb, too old at level 5, is_local, duplicate,
  no answer, no state); the event order of C3.4 across a cut and a return; silence; back-off and Retry; stops;
  calls in each state (C3.7, each row of the limits table with the lowered waits, `send_unknown`, 401 → 503,
  not JSON → 502, unknown server 404, path outside the client API 400, `GET /api/events` refused, body limits);
  pictures (each type accepted, SVG/HTML/text/oversize refused whatever the claimed type, bad ids, 8 at a time);
  two entries where one hangs and the other answers calls and events at once; a stand-in that dies in the middle
  of a call and of a picture; the local starter with a fake `run` (running, old_build, exit 1 with the not-set-up
  message → `not_started` with that detail, malformed output, Retry, start again after an unreachable attempt,
  secret refused → re-read, cert changed → launch again, restart, status); a fresh `stateDir` → only the local
  entry; secrets never in an envelope, an app answer or a log line (scan everything the tests saw).
- Run: `cd desktop && npm test`.

**Done when**: `cd desktop && npm test` passes; the module imports no Electron and no npm package.

### W1. The page's transport (wave 1)

**Goal sections**: 4.1 (the page talks to the main process only; no secret; IPC; the page knows the network
through the transport), 4.6 (the transport, the server as argument, a stream's state as an event, IPC way, HTTP
way, the choice at start), 4.8 (the page in a headless browser; one transport for mock and host), 4.9 (storage
starts fresh: nothing to carry over), 4.10 (collapse kept by the page), 6 (one page; one place asks; every way
means the same, page side), 7.1 (a stream closed for good is reported and reopened, page side).

**Owns**: `web/src/**` (all of it, in wave 1), `web/test/**`, `web/index.html`, `web/build.mjs`,
`web/package.json`, `web/tsconfig.json`. **Must not touch**: `web/dev/**`, `web/e2e/**`, `desktop/`, Go.

**Do**:
1. C6.1–C6.5. Rewrite `api.ts`, `libraryapi.ts`, `serversapi.ts` (its functions call `transport().app("servers.*",
   …)` and parse as today), `uploads.ts`, `logic/chatimage.ts` (picture addresses via `pictureURL`),
   `ComposerImages.tsx` (`pickImages` of the transport when present), `conn.ts` (envelopes, C6.5), `store.ts`
   (sections, lists and libraries filled per entry; the collapse of every group in `store.collapsed`), `keys.ts`
   (`pathOf`), `version.ts` (no `api.hello`: the local entry's version; restart through `owner.restart`, waiting
   for the local entry to be connected again; no `location.reload`), `logic/version.ts` (no "reload" banner).
   Delete `logic/unknownclient.ts`. Remove every `/api/on`, `apiRoot`, `clientId`, `collapseGroup`, `api.state`,
   `api.hello`, `api.restart`.
2. Interim behaviour for the local entry (W2 replaces it): `connected` in the store is true while the local entry is
   `connected`; the rest of the page works as today.
3. A test seam: `useTransport(fake)`; a helper `web/test/fixtures/faketransport.ts` that answers calls by
   `(server, method, path, body)` and pushes envelopes, so the tests that replaced `globalThis.fetch` and
   `EventSource` move to it.

**Tests**: rewrite every `web/test` file that fakes `fetch`, `EventSource` or `/api/on` (`api`, `actions`,
`chatimage`, `chatchoices`, `conn`, `forkbase`, `keptpage`, `keys`, `library`, `librarypopups`, `newchat`,
`remotechat`, `sectionapi`, `sectioncalls`, `sectionviews`, `serversapi`, `serversdialog`, `sidebar`, `waitflows`,
`version`, and any other that fails) to the fake transport. Add: `transport.test.ts` (IPC way against a fake
`window.aiwbApp`, HTTP way against fake `fetch`/`EventSource`: the same requests produce the same `CallAnswer`s,
the same envelope order, the same `closed` notice; Blob → bytes; cancel; picture URLs); a test that no file of
`web/src` outside `transport/` contains `fetch(`, `EventSource`, `"/api/` used as a URL, `/host/` or `aiwbApp`
(a source scan); C6.5's per-entry derivations (snapshot of X → section, lists, library; X leaving connected →
section null, library disconnected; entry removed → all gone; `server_stopping` → flush then `client/flushed` to
X; `rpc` reply to X).
Run: `cd web && npm test && npm run check && npm run build`.

**Done when**: those pass and `grep -rn "fetch(\|EventSource\|/api/on\|aiwbDesktop" web/src` finds only
`web/src/transport/`.

### M1. The HTTP face and the mock (wave 1)

**Goal sections**: 4.8 (the browser checks on the mock keep working with the mock following the client API; the
mock behind the host's face), 6 (every way means the same, the HTTP face side), 7.2 (the page on the mock).

**Owns**: `web/dev/**` except `web/dev/host.mjs` (H1, wave 3) and `web/dev/checks/**` files that only W2 adds.
In wave 1 M1 owns `web/dev/checks/**` too, for the mechanical changes below. **Must not touch**: `web/src`,
`web/test`, `web/e2e`, `desktop/`, Go.

**Do**: `hostface.mjs` (C5.1); the mock as C5.3 (`createMockClient()` with C3.2's API, served through
`hostface`); its header comment rewritten to what it is now; `shot.mjs`, `uicheck.mjs`, `readme-*.mjs` and every
check in `dev/checks` changed where they call the mock's old `/api/…` routes or build `/api/on/…` paths (they
use `/mock/*` controls and the face). `dev/checks/*` keep their assertions.

**Tests**: `web/dev/hostface.test.mjs` (run with `node --test web/dev/hostface.test.mjs`, add it to
`web/package.json`'s `test` script only in wave 2 by W2 — M1 does not touch `package.json`): every route of C5.1
against a fake client (call with JSON and bytes and abort; SSE envelopes and pings; picture OK and refusals; app
ops; static files; 404s); the mock's fake client: a call per world, `addServer`/`setServerState`/`removeServer`
envelopes in C3.4's order.
Run: `node --test web/dev/hostface.test.mjs`; `node --check` on every changed script. The browser checks need
W1's page: run `npm run uicheck` against a build of W1's branch if it is available to you
(`DIST=/path/to/w1/web/dist`); otherwise leave it to W2 and say so.

**Done when**: the face tests pass and no file of `web/dev` serves or calls `/api/` or `/api/on/` over HTTP (the
mock's worlds still answer client-API paths internally).

### G2. The server program's commands (wave 2)

**Goal sections**: 3.9, 4.4 (the start command gives address and fingerprint; the secret command), 4.5 (no start
without set-up; a server set up keeps everything; the commands; status; the option of the page folder gone;
the server folder for another machine), 4.9 (the old list deleted by the new server; a server that never had
remote access refuses; a running server of the old build is found), 6 (the server never depends on the app;
every command works without the app), 7.1 (never set up refuses and names the command, then starts; setting up
and replacing the secret with a client connected and `status`; each command finds this build and the one before;
the data folder holds no list).

**Owns**: `cmd/**` (all, tests included), `scripts/build-server.sh`, `scripts/remote/**`.
**Must not touch**: `internal/**` (ask in your report for anything you need there), `web/`, `desktop/`,
`scripts/build-app.sh`, docs.

**Do**: C2 entirely on G1's API: `serve` (A22, A23, control socket, `server.json`), `launch`/`relaunch` (text and
`-json`, the check before starting, `findRunning`), `stop`, `status` (text and `-json`), `remote setup` (no
`-server-port`, no "Server port" line), `secret`/`secret -new` (signals this build via the control socket's
`secretReloads`, the build before as today), the removed commands' message, `remote off` removed; the legacy probe
(C2.5) as the only code that speaks HTTP to 127.0.0.1. `scripts/remote/start-server.sh` without the web client
check and `-client`; `setup-remote.sh` without `--server-port`; `scripts/remote/README.md` and
`scripts/build-server.sh` (no web build, no `web/` in the folder) to match.

**Tests**: the harness (`main_test.go`, `relaunch_test.go`, `testwaits_test.go`) sets every instance up with
`remote setup -port <free> -name 127.0.0.1` and `AIWB_REMOTE_BIND=127.0.0.1`, and talks HTTPS with the pin, the
secret, a client id and level 6 (reuse `apiclient_test.go`'s helpers).
- Delete: `remotechat_test.go`, `remoteboard_test.go`, `remoteimages_test.go`, `remotelibrary_test.go`,
  `serverlist_test.go`, `section_changeover_test.go`, `section_disk_test.go`, `section_process_test.go`,
  `section_rig_test.go`, `section_states_test.go`, `both_changeover_test.go` (keep from it, moved to
  `olddata_test.go`, the part where a data folder of before level 5 changes over on the remote side).
- Rewrite: `apiclient_test.go`, `remoteserve_test.go` (the client listener), `remotecmd_test.go` (setup, status,
  secret; `remote off`/`remote status` messages), `scripts_test.go`, `relaunch_test.go`, `launch_race_test.go`
  (same address and exactly one server), `agents_path_test.go`, `agents_stop_test.go`, `images_test.go`,
  `mcp_endpoint_test.go`, `olddata_test.go`, `level5_changeover_test.go`, `level5_oldapp_test.go` (level 6;
  rename to `oldapp_test.go` allowed), `scriptedserver_test.go` (if still used).
- Add: `serve`/`launch` on a folder never set up → exit 1, the message of A22 with the program's path, no
  listener bound, no `server.json`; then `remote setup` and `launch -json` → a running server whose fingerprint
  matches the files; `launch -json` output schema; a server data folder with a `servers.json` → gone after start;
  `status` and `status -json` of: no server, this build, an older build (a stand-in old server: a Go HTTP server on
  127.0.0.1 answering `/api/hello` with `app`, `version`, `pid` of a sleeping child process, `featureLevel` 5,
  the folder's `instanceId`, and `/api/state` with `dataDir`, its port in a `server.json` without `control`),
  not set up, broken files; `stop` and `relaunch` of the older build (SIGTERM to that pid); `launch -json` →
  `old_build`; `secret -new` with an API client connected → its stream ends and the new secret works, the old is
  refused; `remote setup` while a client is connected changes nothing for it until the next start, and `status`
  says what the next start does; the control socket is 0600; a stale socket file is replaced; nothing answers on
  the old loopback port of the test; `remote off` exit 2 with the message.
- Run: default and full set of `./cmd/ai-whiteboard`, `go test -race ./cmd/ai-whiteboard`, then `go test ./...`.

**Done when**: those pass; `grep -rn '"-port"\|-client\|remote off\|remote status\|4747' cmd scripts` finds only
the legacy probe and the removed commands' message.

### D1. The Electron app (wave 2)

**Goal sections**: 3.1–3.8, 4.1 (IPC; the picture scheme), 4.2 (first section: the app starts its server), 4.3
(all), 4.4 (the window opens, finds or starts; a failed start shows and is retried), 4.6 (the IPC way; the
picture in the app), 4.7 (open log, reveal, the IPC side of the owner's things), 6 (the page holds no secret and
names no file; only the app's own page; the scheme for pictures only; the app carries no code of the host), 7.1
(a request from anything but the app's own page refused; the scheme only for the list and not for another window,
a frame or a page gone elsewhere; the app's share of "this computer's server in each state"), 7.3.

**Owns**: `desktop/main.js`, `desktop/preload.js`, `desktop/lib.js`, `desktop/ipcface.js` (new),
`desktop/test/*.test.js` (not `desktop/test/conn/**`), `desktop/e2e/**` (new), `desktop/package.json`,
`desktop/electron-builder.yml`, `scripts/build-app.sh`, `scripts/install-app.sh`.
**Must not touch**: `desktop/conn/**` (J1's; report needed changes), `web/`, Go.

**Do**: C4 entirely. `desktop/ipcface.js`: `createIpcFace({ipcMain, client, getWindow, pageURL, shell, dialog,
home})` registers C4.2's handlers with C4.3's checks; pure enough to test with fakes. `lib.js`: keep
`serverBin`, `serverLogPath`, `linkAction`/`attachLinkHandlers` (page URL), `attachCloseFlush`, `fromAppWindow`
(page URL instead of origin), `pickImages`; add `pictureAllowed`, `parsePictureURL`, `pagePath`; delete
`launchArgs`, `parseLaunchOutput`, `createStartUp`, `runLaunch`, `findServer`, `checkServer`,
`createReconnector`, `resumeAfterCancelledQuit`, `errorDetail`, `StartError` and their tests. `main.js`: C4.5;
no "Starting…" window, no error dialog, no reconnector. `electron-builder.yml`: add `conn/**` (with
`routes.json`) and `ipcface.js` to `files`; `web/dist` stays an extra resource (the page); comments updated.
`scripts/build-app.sh`: no version stamping into `version.json`; the Go binary and the web build as today.

**Tests**:
- `desktop/test/*.test.js` (node, no Electron): `fromAppWindow` (file URL page, other window, iframe, navigated
  frame, hash allowed); `pictureAllowed` (main frame of the main window on the page: yes; iframe, other
  webContents, other URL: no); `parsePictureURL` (good form; other host, extra or missing segment, bad entry, bad
  ids: refused); `linkAction` with a page URL; the IPC face with a fake client: each channel, refused senders get
  nothing, `cancel` aborts, `stream` replaces the subscription and batches in order, `owner.openLog`/`reveal`
  paths and refusals, ops outside C3.10 refused; `pickImages` as today.
- `desktop/e2e/app.e2e.mjs` (not in `npm test`; `npm run e2e`; Playwright's `_electron`, installed with
  `--no-save`): a temp `AIWB_USER_DATA`, `AIWB_SERVER_BIN` = a small Node script that prints `launch -json` for
  J1's stand-in (fixture certificate, self-signed) and answers `secret`; then in the app: the window opens and the
  local section connects; a call (make a group) answers; the stand-in cuts the stream and comes back, and the page
  shows not connected then connected; a picture is shown from `aiwb-picture://` (its `naturalWidth` > 0); an iframe
  the test adds to the page cannot load a picture; a launch script that fails shows "Not started" with its reason
  and Retry works. If `_electron` cannot drive Electron 44 headless on this Mac, drive it through
  `--remote-debugging-port` and CDP, and record that in the file's header (goal 9: how far the app can be run by
  tests without a screen).
- Run: `cd desktop && npm test`, `npm run e2e`.

**Done when**: both pass; `npm start` in development opens the page from `web/dist` at once. (That it connects
to this computer's server needs G2's binary, of the same wave: the integration workstream checks it.)

### W2. This computer's section (wave 2)

**Goal sections**: 3.2, 3.3, 3.4, 3.5, 3.6, 3.10, 4.2 (all), 4.4 (connecting; the failed start shown with reason,
Retry and log; a server that stops goes not connected and back; other build; too old), 4.7 (restart, restart on
the app's build, open log, MCP state, in the page), 4.9 (storage starts fresh), 4.10 (all, page side), 7.1 (this
computer's section shows the refusal; a remote down does not hold up this computer's section and the other way
round, page side; the stream closed for good is reopened), 7.2 (the page on the mock, new checks).

**Owns**: `web/src/**`, `web/test/**`, `web/package.json` (add `dev/hostface.test.mjs` to `test`),
`web/dev/checks/**` (new and changed checks), `web/dev/mock-ui.js` (seeds for the new states only).
**Must not touch**: `web/dev/mock.mjs` and `web/dev/hostface.mjs` beyond what a new seed needs (report it),
`web/e2e`, `desktop/`, Go.

**Do**: C7 entirely. Replace the interim `connected` of W1 by per-entry reachability: classify each `inSection`
use (there are 25) as either "another machine" (keep `inSection`: `TakeoverPanel` text, `ChatView` server name,
`boardrow` reveal, `logic/version` running chats, `store` draft storage and copies, `Sidebar` `there`) or "may be
not connected" (use the entry's state, the local entry included: `reachable`, `saveOutage`, `waitsForServer`,
`saveRefusal`, `remoteView`/`boardView` `connected`, `markGone` on `not_found`, `afterSnapshot`'s
section rule, `sections.ts` `stale`). This computer's things gone at its return (deleted elsewhere) say so as a
section's do. The "+" of the sidebar's head disabled while the local entry is not connected. Servers dialog per
C7. The update banner goes; `logic/version.ts` keeps `restartConfirmText` and `runningChats`.

**Tests**: unit tests for the local section's head in every state, the outage of the local entry with a remote
connected and the other way round, the restart flow (confirm, flush, `owner.restart`, connecting, back, no
reload), the other-build line, `not_started` with Retry and log, the Servers dialog's local row and MCP line. New
browser checks in `web/dev/checks/` (names `AAC.n-<word>.mjs`): this computer first and its states (connecting,
not started with reason and Retry, too old with Restart, other build), local outage with a remote section working,
remote outage with the local section working. Run `npm test && npm run check && npm run build && npm run uicheck`
(all checks must pass, the old ones included).

**Done when**: all of that passes.

### H1. Test host and end-to-end scripts (wave 3)

**Goal sections**: 4.8 (tests against a real server through the host; the host serves the page; an agent can check
a change there), 6 (the test host is no part of a shipped build, listens on loopback, is started by a test; every
way means the same), 7.1 (a call, the stream and a picture the same over IPC and HTTP; real-process cases: the app
side of each local state through the host with `--local-bin`, a never-set-up server shown and then started, the
list after the change-over, a remote down not holding up the local), 7.2 (the host's three checks; the page against
a real server).

**Owns**: `web/dev/host.mjs` (new), `web/dev/host.test.mjs` (new), `web/e2e/**`, `web/dev/reallibrary.mjs` and
any other `web/dev` script that starts a real Go server, `desktop/test/faces.test.js` (new).
**Must not touch**: `web/src`, `desktop/conn`, `desktop/main.js`, Go.

**Do**: C5.2. Rewrite `web/e2e/newchat.e2e.mjs`, `twopages.e2e.mjs` (two hosts, one state folder each, both with
the same remote servers) and `remotechat.e2e.mjs` (a local server through `--local-bin`/`--local-home` and a
remote one, the outage and the return) to the host; delete `apiclient.e2e.mjs` (its subject, the owner's page
beside an API client, is now two API clients: the Go tests cover it); adapt the start-up code of `app.e2e.mjs` to
the host **without running it** (paid): `node --check` only.

**Tests**:
- `web/dev/host.test.mjs`: the host binds only 127.0.0.1 (its address, and a connection to the machine's other
  IPv4 addresses on that port fails); no response body or SSE envelope it produces contains a secret (add an
  entry with a known secret, run calls, tests, a picture, list ops, scan everything); a call or a picture for an id
  that is no entry is 404 `no_server`; a path outside the client API is 400.
- `desktop/test/faces.test.js`: one fake client behind the IPC face (with fake `ipcMain` and window) and the HTTP
  face; the same sequence (calls of every kind, a stream with a cut, a picture good and bad, app ops) gives the same
  statuses, texts, `sceneRev`s, envelope order and stream-state notices through both.
- The e2e scripts above, run once each (they build the binary, start real servers with the stand-in agent, spend
  no money).
- Run: `node --test web/dev/host.test.mjs`, `cd desktop && npm test`, each e2e script.

**Done when**: all pass.

### I. Integration (wave 4)

**Goal sections**: 4.9 (documentation), 6 ("What goes away is removed"; tests follow the repository's rules), 7
(the full run; 7.4 written down for the user), 2 and 8 (nothing contradicts them).

**Owns**: everything, for small fixes; specifically `README.md`, `docs/**`, `AGENTS.md`, `CLAUDE.md`,
`internal/server/routes_file_test.go` (new).

**Do**:
1. Add `TestClientRoutesFile` in `internal/server`: `desktop/conn/routes.json` equals `ClientRoutes`.
2. Removal checklist, each with its grep, all must come back empty outside the noted exceptions:
   `/api/on/`, `api/servers`, `serverlist`, `internal/servers`, `internal/remotes`, `KindPage`, `ServeSSE`,
   `webVersion`, `version.json`, `-client`, `clientFiles`, `aiwbDesktop`, `showStarting`, `Starting…`,
   `showError`, `createReconnector`, `checkServer`, `AIWB_URL`, `remote off`, `remote status`,
   `server-port`, `4747` (exception: the legacy probe in `cmd/` and its tests), `browser tab` (docs),
   `localhost:4747`, `api/mcp/status`, `api/remote/status`, `api/restart`, `groups/order`, `unknown_client` in
   `web/src`, `EventSource`/`fetch(` in `web/src` outside `transport/`.
3. Documentation (goal 4.9): README (the app as client, this computer as the first section, no browser tab, the
   diagram), `docs/architecture.md` (server: client listener, MCP listener, control socket; web client shipped in
   the app; desktop app holds the list; the transport; pictures), `docs/server-reference.md` (C2: commands, flags,
   outputs), `docs/remote-servers.md` (the server folder without a page; set-up required before the first start;
   the app's list; the client API is the one API, level 6; the sections text updated per goal 4.10: this
   computer's section, collapse per app, images checked by the main process, no `/api/on`; the update notes:
   the old list is not moved), `docs/development.md` (build and run the app, run the page in a headless browser
   through `web/dev/host.mjs` and on the mock, no "run it in the browser"), `docs/troubleshooting.md` (the MCP
   listener's state with `ai-whiteboard status`, not port 4747), `AGENTS.md` (the `AIWB_TEST_WAITS` names `ping`,
   `agents`, `images`; `AIWB_APP_WAITS`; the cmd test counts; the new JS test commands), `scripts/remote/README.md`
   checked.
4. Run once, alone on the machine: `AIWB_TEST_FULL=1 go test -timeout 20m ./...`, `go test -race ./...`,
   `cd web && npm test && npm run check && npm run build && npm run uicheck`, `cd desktop && npm test && npm run
   e2e`, `node --test web/dev/host.test.mjs`, the three free e2e scripts of `web/e2e`. Fix what fails, or name it.
5. Write `plans/app-as-client-manual-checks.md` with goal 7.4's four checks as steps for the user.

**Done when**: all of the above pass and the checklist is empty.

---

## 6. Coverage: every statement of goal sections 4, 6 and 7

| Goal | Owner(s) |
|---|---|
| 4.1 page talks to main only; no secret to page; IPC; transport only | W1 (page), D1 (IPC), J1 (no secret) |
| 4.1 one connection per entry, HTTPS, secret, pin | J1 |
| 4.1 pictures via the app's scheme | D1, J1 (check), W1 (address) |
| 4.1 a server talks to no other server | G1 |
| 4.2 sections only, this computer first, same head/states/rows/+/collapse | W2 |
| 4.2 everything of this computer in it; what sets it apart; reveal | W2, D1 (reveal) |
| 4.2 the head's "+" makes local things; nothing moved across | W2 (W1 keeps the across rule) |
| 4.3 page ships inside the app; one build; no newer-page notice | D1, W1 (A24), W2 |
| 4.3 window opens from app files, waits for no server | D1 |
| 4.3 close/quit waits for drawing; links; never leaves the page | D1 |
| 4.3 second start brings window forward | D1 |
| 4.3 no connection while closed; sections fill again | J1, D1 |
| 4.4 find or start; not a child | J1 (starter), G2 (launch) |
| 4.4 address/fingerprint from start command, secret from secret command | G2, J1 |
| 4.4 connecting until it answers | J1, W2 |
| 4.4 failed start in the section, reason, retry, log, no dialog, tries again | J1, W2, D1 |
| 4.4 never set up refuses, names command; next try starts | G2, J1, W2 |
| 4.4 stops while open → started again, not connected and back, no reload | J1, W2 |
| 4.4 other build kept, notice and restart offered | J1, W2 |
| 4.4 too old shown, restart offered | J1, W2 |
| 4.5 one API; everything of the local API in it but owner's things | G1 (C1.6) |
| 4.5 no page, no list, no relay, no pass-through | G1 |
| 4.5 two listeners; client listener port; reachable on all IPv4; secret always; HTTPS | G1, G2 |
| 4.5 first question without the secret | G1 (A10) |
| 4.5 no start without set-up; set-up command and its options; no remote off | G1 (check), G2 |
| 4.5 set-up kept by a server set up before | G1 (A11), G2 |
| 4.5 commands keep meaning; launch gives address + fingerprint; `status`; each finds the running server; page-folder option gone | G2 |
| 4.5 feature level raised; app connects to none below | G1, J1 |
| 4.5 server folder without page, no web build | G2 |
| 4.6 list and secrets in the app's file, protected | J1 |
| 4.6 connection behaviour as today; Servers says the step | J1, W2 (dialog) |
| 4.6 every call has a defined answer in every state | J1 |
| 4.6 picture checked from bytes; no HTML/SVG | J1, D1 |
| 4.6 transport's three parts; server as argument; no `/api/on` | W1 |
| 4.6 stream state as a transport event | W1, J1, D1, M1/H1 |
| 4.6 IPC way: fixed functions; one stream per entry; reopen; down/back | D1, J1, W1 |
| 4.6 picture in the app: scheme, fetch with pin and secret, lazy loading, no copy in page, scheme pictures only | D1, J1, W1 |
| 4.6 HTTP way to the host: fetch, EventSource, plain picture address, server carried host's way, one stream of all servers | W1, M1 (face), H1 (host) |
| 4.6 way chosen at start | W1 |
| 4.7 owner's things offered for this computer | W2, D1, J1 |
| 4.7 done by the app with its program; not in client API; via IPC; re-read after restart | J1, D1, G1 |
| 4.7 restart halts and continues work as today | G2 (relaunch unchanged), W2 (confirm) |
| 4.8 no browser tab; no server serves the page; instructions gone | G1, I (docs) |
| 4.8 page in a headless browser; nothing injected | W1, M1, H1 |
| 4.8 checks on the mock keep working | M1, W2 |
| 4.8 tests against a real server via the host; mock behind the same face | H1, M1 |
| 4.8 page from a checkout works in the app unpackaged | D1 |
| 4.9 old list not moved; new server deletes it | J1 (empty list), G1/G2 (deletion) |
| 4.9 what lives on this computer untouched | G1/G2 (no data migration), W2 (shown) |
| 4.9 never had remote access refuses until set up | G2, W2 |
| 4.9 old-build server found, not started twice, restart offered | G2 (legacy probe), J1, W2 |
| 4.9 older app refused with a reason | G1 |
| 4.9 browser storage starts fresh | W1 (file:// origin; nothing carried) |
| 4.9 documentation; MCP state on 4747 corrected | I |
| 4.10 all | W1, W2 (page), G1 (no chain), J1 (images checked by main) |
| 6 three parts; one page; HTTP way not run in the app | W1, D1 |
| 6 one API; nothing for this computer alone | G1 |
| 6 test host not shipped, loopback, started by a test; app carries no host code | H1, D1 (builder files) |
| 6 server never depends on the app | G2 |
| 6 MCP listener not touched; board tools as today with no page open | G1 |
| 6 page holds no secret, names no file; calls checked; files only from the dialog | J1, D1 |
| 6 only the app's own page answered; scheme request checks | D1 |
| 6 one place asks | W1 |
| 6 every way means the same | W1, H1 (faces), M1 |
| 6 scheme for pictures only | D1 |
| 6 not tied to the desktop app | J1 (no Electron), W1 |
| 6 fingerprint decides, also for this computer; changed certificate shown | J1 |
| 6 no weaker path for this computer | G1, J1 |
| 6 one connection per entry | J1 |
| 6 id unique per server, this computer's included | W1 (keys) |
| 6 what a client cannot reach | G1 |
| 6 picture from its bytes alone | J1 |
| 6 what goes away is removed | G1, G2, D1, W1, M1, I (checklist) |
| 6 waits keep values; lowerable by tests | J1, G1/G2 (testwaits) |
| 6 tests follow the rules; no paid test | all |
| 7.1 never set up refuses / starts / section shows it | G2, J1, W2, H1 |
| 7.1 call without secret refused here as elsewhere; first question without it | G1 |
| 7.1 no page at any address | G1, G2 |
| 7.1 set-up and new secret with a client connected; `status` | G2 |
| 7.1 each command finds this build and the one before | G2 |
| 7.1 the app with the local server running / not / failing / stopping / other build / too old | J1, D1 (e2e), H1 (real processes), W2 |
| 7.1 remote down does not hold up local, and the other way round | J1, W2, H1 |
| 7.1 page gets no secret; no server outside the list, path outside the API, file | J1, D1, H1 |
| 7.1 request to main from anything but the app's page refused | D1 |
| 7.1 bad picture bytes never reach the page | J1, D1, H1 |
| 7.1 call, stream, picture same over IPC and HTTP | H1 (faces), W1 (transports) |
| 7.1 scheme answers list pictures only, not other window/frame/page gone | D1 |
| 7.1 stream closed for good reported and reopened | W1, H1 |
| 7.1 silent stream, refused secret, changed certificate, also for this computer | J1 |
| 7.1 every local-API capability answered by the client API but owner's | G1, I (routes file) |
| 7.1 list after change-over: empty, add connects, no list on the server | J1, G2, H1 |
| 7.1 older app vs new server; new app vs old running server | G1, G2, J1 |
| 7.1 owner's things work here and not for a remote client | J1, D1, G1 |
| 7.1 concurrency under the race detector / the like | G1, G2 (`-race`), J1 (concurrent entries, mid-call deaths) |
| 7.2 page on the mock; page against a real server through the host; host's three checks; module tested once | M1, W2, H1, J1 |
| 7.3 app tests: call, cut stream, picture from a self-signed server | D1 |
| 7.4 by hand | I (writes the steps for the user) |

---

## 7. Tests deleted or rewritten, in one list

- **Go, deleted**: all of `internal/servers/**` and `internal/remotes/**`; `internal/server/{boardpair,
  both_clients, both_drop, both_ids, both_reach, both_remove, both_rig, both_shared, level5_chain, libraryremote,
  remotedraft, remoteimages, section_board, section_drop, section_everystate, section_ids, section_images,
  section_local, section_rig, section_routes, section_states, section_tree, servers}_test.go`;
  `internal/app/{section,servers}_test.go`; `internal/editorbridge/{section,unfollowed}_test.go`;
  `cmd/ai-whiteboard/{remotechat, remoteboard, remoteimages, remotelibrary, serverlist, section_changeover,
  section_disk, section_process, section_rig, section_states, both_changeover}_test.go`.
- **Go, rewritten**: the rest of `internal/server`, `internal/app`, `internal/editorbridge` tests named in G1;
  the rest of `cmd/ai-whiteboard` tests named in G2.
- **Desktop, deleted**: `desktop/test/reconnect.test.js`; the start-up and launch-output parts of
  `desktop/test/lib.test.js`. **Rewritten**: `lib.test.js`, `links.test.js`, `closeflush.test.js` (unchanged
  behaviour, adapted imports), `pickimages.test.js` (sender check with the page URL).
- **Web unit tests, rewritten** to the fake transport: those named in W1.
- **Web browser checks**: kept, adapted by M1, run and extended by W2.
- **Web e2e**: `apiclient.e2e.mjs` deleted; `newchat`, `twopages`, `remotechat` rewritten to the host; `app.e2e.mjs`
  adapted, not run.
