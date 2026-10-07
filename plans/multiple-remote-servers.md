# Multiple remote servers

A plan for letting the app work with AI Whiteboard servers that run on other machines, next to the local one,
and for the new way a chat is started that goes with it. Nothing in it is built yet. It stays at the level of
parts, flows and order of work: no code.

## How to read this

**Marks.** Every statement about behaviour ends with one mark, in running text and in table cells:

- `[run: N01 S5]`: verified by run. A research task observed it. What Go's TLS code, a browser, Electron or an
  agent CLI does at runtime counts as verified only this way. A Go test with stand-in agents is a run; where
  that limits what was shown, the text says "in Go tests with stand-in agents".
- `[code: path:line]`: read from code at commit `be7e469`.
- `[design]`: proposed design, the behaviour of code this feature will write. A reference after "for" is the
  evidence for the problem it solves.
- `[estimate]`: computed, not run.
- `[not verified]`: a stated risk. Section 8 says where it is first checked.
- `[user: Q15]`: a decision only the user can make (section 9). The plan is written for the default.

A mark on a lead-in or on a table header covers everything under it that has no mark of its own. The
requirement, phase and test tables state intent and carry marks only for facts. A report section in round
brackets beside a mark only says where the matter is written up; the mark carries the statement. A conclusion
that follows from a marked fact and was not itself observed is worded "it follows that" and stands after that
mark.

**Citations.** `N01 S5` is section S5 of `plans/multiple-remote-servers-research/N01.md`. The reports hold the
evidence; this plan states a fact once and points there. `T01` to `T12` were written for the first version of
this plan, at the older commit `8722065`. `N01` to `N05` were written for this version, at `be7e469`. `N06`
and `N07` are prototypes of this version's design, run at commit `9337940`, whose tree outside `plans/` is the
same as `be7e469`. Both ran Go tests in a scratch copy with stand-in agents: no server was started and no
agent CLI ran. `N08` was written for the second update (section 1): one Go program, standard library only, run
on macOS at commit `5a289ec`, whose tree outside `plans/` is the same as `be7e469`. The program reads nothing
from the repository and stood outside it; nothing of the app was started. The design for points 4 and 7 of the
second update (section 4, "Clients, holders and events" and "Remote boards") rests on code read at `be7e469`
and on T09 and T11. No report was written for it and nothing of it was run. The design for points 1, 2 and 3
(runs on a remote server, agents per server, the remote group) rests on code read at `be7e469`. No report was
written for it either, and nothing of it was run.

**Terms.**

- **Server**: the Go program (`cmd/ai-whiteboard`). It keeps boards, chats and runs and runs the agents.
- **Local server**: the server on the user's own machine, the one the app starts and the page talks to.
- **Remote server**: a server on another machine that the local server uses for chats and runs.
- **Web client**: the browser code in `web/`, which a server serves.
- **Page**: the web client as one server serves it. One page talks to exactly one server. It shows remote
  chats and runs through its local server.
- **Instance id**: a random id a server makes once and keeps in its data folder; hello reports it.
- **Remote listener**: an added listener of a server, HTTPS on `0.0.0.0`: every IPv4 address of its machine.
  Off unless set up.
- **API client**: a caller on the remote listener, identified by its client id. It follows and acts on chats
  and runs. In this release it holds no board `[user: Q23]`. In this plan the API clients are other machines'
  local servers.
- **Client**: what holds an event stream on a server and calls its routes: a page on the loopback listener, or
  an API client on the remote listener. Seen from a remote server, the user's side (the local server with its
  pages) is one client.
- **Client id**: what a client states on every request: a page a random id per page load, an API client the
  instance id of the local server it is. It identifies; it is not a credential.
- **Known client**: on the loopback listener, a client id with an open event stream.
- **User** and **owner**: the person at the client, and the person who controls a remote machine. They are one
  person (section 8); the word says at which machine they act.
- **Shell**: the desktop app's own code, as opposed to the page it shows.
- **Active client**: today a server has one active client, the one page it takes changes from and sends events
  and agents' board edits to `[code: internal/editorbridge/bridge.go:33-34]`. The word stands only for today's
  behaviour; the plan has no such role.
- **Holder** (of a board): the one client whose scene writes a server accepts for a board and which gets that
  board's tool calls. A client that lost a board to another is **superseded** for that board.
- **Take** and **take if free**: the call by which a client asks for a board. A take of a board that another
  client holds starts the hand-off; take if free grants only a board nobody holds.
- **Hand-off**: the steps by which a held board goes from its holder to the client that takes it (section 4).
- **Take-over panel**: what a page shows in place of the canvas of a board that another client holds, with
  "Use here".
- **Scene revision**: a counter per board that a server raises at every scene write it accepts.
- **Draft counter**: a counter per draft that a server raises at every draft write it accepts.
- **Follow**: a client follows a chat or a run from the moment it reads that item's content with its client id
  on the request, until its stream ends or it unfollows.
- **Client mark**: the client id of the API client that made an item, kept on the item by the server and
  copied to its forks. It decides lists and gives no right; the one use beyond lists is that a creation or
  start call refuses an id that another client's item has.
- **Role event**, **list event**, **content event**: the three classes of a server's events. A role event is
  about a client's stream or a board's holder. A list event changes what a sidebar lists: an item's view, or
  its removal. A content event carries what is inside one chat or run. Section 4's event table says who gets
  each type.
- **Allow-list**: the event types a server sends to one kind of client at all. There is one per kind of
  client.
- **Bridge** and **guard**: two parts of the server's code. The bridge holds the event streams and a record of
  every client; the guard checks every request before its route.
- **Hello**: `GET /api/hello`, the request by which a server says what it is.
- **Feature level**: an integer in hello that says what a server can do for an API client.
- **Remote configuration**: the file set-up writes last: the port and the names a client may call the server
  by.
- **Set-up**: `remote setup`, `remote setup -new-cert` and `secret -new`, run by the owner. Only they create a
  secret, key or certificate.
- **API snapshot**: the state an API client gets: the chats and runs that carry its client mark, the chats
  with their branch states, and the server's catalogs, usable agents, home and default folder. It holds no
  group. "State", said of an API client, always means this.
- **Catalog**: the models and efforts one agent program offers on one server.
- **Usable agents**: the agents whose programs a server finds on its machine, looked up again while it runs.
- **Secret**: the value an API client sends in the `X-AIWB-Secret` header of every request.
- **Pin**: the SHA-256 fingerprint of one certificate, stored by the client; only that certificate is accepted.
- **Server entry**: one line of the local server's server list: a name, an address, a secret, the
  "self-signed certificate" choice with its pin, and the server's instance id. The **local entry** stands for
  the local server itself.
- **Place**: where a new item goes in the sidebar: the ungrouped group, a group, a board or a run.
- **Run**: the third sidebar type next to boards and chats: a goal worked on by a team of agents.
- **Tiers** (of a run): its three pairs of a model and an effort, called deep, standard and light
  `[code: internal/model/run.go:91-104]`.
- **Set-up command** (of a run): one of a run's settings, a shell command the run executes in each of its
  checkouts. It has nothing to do with set-up, the owner's commands above.
- **Run defaults**: the agent, limits, set-up command and tiers a group's next run on one server starts with,
  kept per server with the group's defaults.
- **Draft run**: a run that has not started. It is a run of the local server, whatever server is chosen in it.
- **Remote run**: a started run whose journal, agents and folder are on a remote server.
- **Run record**: what the local server keeps of a remote run: its id, entry, place and archived mark, a
  pending change if there is one, and the last run view it received. No journal.
- **Start call**: the one repeatable call that makes and starts a run on a remote server.
- **Draft check**: a read call by which a server tells the facts of its machine that a draft run shows for an
  agent and a folder. It writes nothing.
- **Remote group**: the group on a server that takes what its API clients make.
- **Unstarted chat**: a chat that has had no message yet and is neither a fork nor a branch. Its server,
  agent, folder, model and effort can still be changed. It is a chat of the local server, whatever server is
  chosen in it. Until its first message is tried, nothing of it is on a remote server; 5.3 says what a failed
  first message can leave there, and names the state "start not confirmed", in which server and agent are
  fixed. A draft run whose start call got no answer is in the same state, with all its choices fixed (5.8).
- **Remote chat**: a started chat whose thread and agent are on a remote server.
- **Chat record**: what the local server keeps of a remote chat: its id, entry, place, archived mark and
  drafts, a pending change if there is one, and the last chat view and branch states it received. No thread.
- **Pending change**: an archive or unarchive of a remote chat or run that the user made and the remote
  server has not yet confirmed (5.2).
- **Remote board**: a board whose scene is kept by a remote server. Designed in section 4 and not built in
  this release `[user: Q23]`.

## 1. Summary and reading of the goal

**The first request:** "create a plan how to build a feature that allows this app to have multiple remote
servers".

**The update** (the user's words, shortened only by leaving lines out):

- "add https to server", "we will be using selfsigned certificats for now", "only server (api) is exposed on
  https".
- "add some sort of authentication": "header with some secret on all endpoitns. Secret is generated on server
  start and has command to regen. When remote client is adding a host it adds secret and host (url and port).
  Check box for self signed certificates."
- "Even with this remote will not expose the server to public ip it will still stay behind vpn but we are
  adding https as added securtiy".
- "add scripts for easier gen of certificats and things needed for https, and update build script to include
  what needed in app distribution", "also add sciprt for only build server it should also add in that dst
  folder a scripts for setup of sertficates".
- "new chat is just started with + there is no longer option to choose agent there (you still chose board and
  chat, and run)", "then in chat you will have to choose server, agent, folder, model, and effort", "when chat
  is started those things are locked as they are so far", "all things are sticky defaults like they worked so
  far", "there is no last used anymore. New groups get defauls from ungrouped group now", "local server is
  always at least one server".
- "Some ui for adding servers and their secrets with a test connection button".

**The second update** (the user's words, in full):

1. Runs on a remote server. A run started from the client can run on a remote server, not only a chat.
2. Agents per server. A server offers only the agents installed on its machine; the client never shows an
   agent the chosen server lacks.
3. A "remote" group. A chat created by a remote client is not left in the ungrouped group on the server; it
   goes into a dedicated remote group.
4. One active client per board, replacing one active client per server. One client at a time works on a board
   and hands it off as today; different clients can hold different boards at once. This makes remote boards
   possible, and must not rule out two clients on the same chat (not a target).
5. Bind address. The remote listener binds 0.0.0.0 for now; the rule that refuses a wildcard address goes.
6. Boot only checks. At start the server checks its remote config and starts HTTPS. It never creates the
   secret or the certificate; if the config is there and either is missing, that is fatal. Only set-up creates
   them.
7. Client identity and targeted events. The server identifies each client and sends it only the events it
   needs, not everything that happens.

Where the second update and the first disagree, the second holds.

**How it is read here** (an interpretation; reject it if it is wrong):

- "The app" is the Electron desktop app with the web client it shows. "Server" is the Go program, as the
  README uses the word `[code: README.md:14-33]`. Today there is exactly one server, on the same machine,
  bound to loopback `[code: cmd/ai-whiteboard/main.go:129]`.
- **The server is a property of a chat and of a run.** It is chosen in the chat, next to agent, folder, model
  and effort, and in a draft run, next to agent, tiers, folder and settings. There is one sidebar: the local
  server's. A remote chat runs on its server's machine, with that machine's folders, agents and logins. A
  remote run works in a folder of its server's machine and leaves its result there `[design]`.
- **The local server, not the page, is the client of a remote server.** The page keeps talking to its own server
  only; the local server passes the calls of a remote chat or run on, with the secret, and relays its events.
  The user types a secret into the page when adding or editing an entry; it is never stored in the page or the
  shell and is never sent back to them. A browser tab on the local server gets remote chats and runs too
  `[design]`.
- **"only server (api) is exposed on https":** the remote listener serves only the API routes an API client
  needs. The web client's files, the MCP endpoint and every other route answer 404 there `[user: Q20]`.
- **"on all endpoitns":** all endpoints of the remote listener. Loopback keeps today's trust and needs no
  secret `[user: Q15]`. A page cannot send a header on navigation or for a static file: `GET /` without the
  header got 401 on a prototype that asked for it everywhere `[run: N01 S3]`. An `EventSource` cannot send one
  either: it reached the server with no secret `[run: N02 S3]`.
- **"generated on server start":** made by the server's own program. By the second update only set-up makes
  it; it is kept across restarts and replaced only by `secret -new` `[design]`. With a new secret at every
  start the old one got 401 after a restart `[run: N01 S4]`; it follows that every restart, the page's own
  "Restart server" included, would lock all clients out.
- **"Check box for self signed certificates":** ticked means a pin, not "skip verification". The user accepts
  one certificate by its fingerprint and only that one connects afterwards `[user: Q16]`.
- **"New groups get defauls from ungrouped group":** a new top-level group copies the ungrouped group's
  values. A subgroup copies its parent's, as it does today `[code: internal/defaults/defaults.go:64-75]`. Both
  were run in a Go test `[run: N07 S3]`. The sentence can also be read as "every new group" `[user: Q21]`.
- **The VPN stays.** A remote server is not meant for a public address. The server does not enforce that: its
  remote listener binds `0.0.0.0`, as the second update asks `[design]`. Staying behind the VPN rests on the
  machine's network and firewall; HTTPS and the secret are added protection behind that and do not replace it
  (section 6) `[design]`.
- **"A run started from the client can run on a remote server, not only a chat":** a draft run has a server
  choice, and its start makes the run on the chosen server. From then on the run lives wholly there: its
  journal, its agents, its folder and its result (section 4, "Runs for an API client"; 5.8) `[design]`.
  Nothing of the result comes to the user's machine `[user: Q27]`. A run gives whoever holds the secret more
  than a chat did, a shell command of the caller's own (section 6); a server with remote access on serves
  chats and runs alike `[user: Q28]`.
- **"offers only the agents installed on its machine":** installed means that the server finds the agent's
  program on its machine. It looks again while it runs, and it refuses an agent it lacks, in the tools by
  which its agents start subagents too (section 4, "Usable agents") `[design]`. Installed does not mean logged
  in (section 8) `[design]`.
- **"the client never shows an agent the chosen server lacks":** every agent list is the chosen server's: in
  an unstarted chat, in a chat on a run and in a draft run, and on the local server's own page too `[design]`.
- **"a dedicated remote group":** one ordinary top-level group per server, named "Remote", which the server
  makes when an API client first creates something there. "A chat created by a remote client" is read as
  everything an API client makes: chats, their forks and runs `[design]`. There is one such group for all
  clients of a server, and its owner can rename, archive and delete it `[user: Q26]`.
- **"One active client per board, replacing one active client per server":** the role moves from the server to
  the board, for every kind of client. A server keeps a record of each connected client, and a board has one
  holder; connecting to a server takes nothing (section 4, "Clients, holders and events") `[design]`.
- **"hands it off as today":** today's steps, each with a board id: the holder is asked to release, a timer of
  3 s runs, the board is granted `[design]`. Today the same steps move the whole server
  `[code: internal/editorbridge/bridge.go:104-114, 167-173, 286-302]`.
- **"different clients can hold different boards at once":** two pages on one server each work on another
  board, and neither is shown a take-over (5.5) `[design]`.
- **"This makes remote boards possible":** read as: the design must allow a board on a remote server, not: it
  is built now. Section 4 holds the design of a remote board; the role is built for every kind of client, and
  the remote board itself is not built in this release `[user: Q23]`.
- **"must not rule out two clients on the same chat (not a target)":** not built, and nothing in the design
  stands in its way; section 4 lists what is avoided for that reason `[design]`.
- **"Bind address":** `0.0.0.0` is read as every IPv4 address of the machine, and no IPv6 `[user: Q22]`. The
  remote configuration holds a port and the names a client may call the server by, and no address; set-up
  asks nothing (section 4) `[design]`. "for now" is read as: a later change may name one address; this plan
  builds none `[design]`.
- **"Boot only checks":** "its remote config" is the remote configuration, the file set-up writes last. Without
  it a start is today's start, and nothing of remote use is read or made. With it, a missing or bad secret,
  certificate or key ends the start, and so does a remote port that cannot be bound; the message names the file
  or the port and the command that repairs it (section 4, "The start's check"). "Only set-up creates them":
  `remote setup`, `remote setup -new-cert` and `secret -new`, and nothing else `[design]`.
- **"The server identifies each client":** a client states an id on every request: a page a random id per page
  load, as today, and an API client the instance id of the local server it is `[design]`. The id tells clients
  apart and is not a credential: there is still one secret per server `[user: Q25]`.
- **"only the events it needs, not everything that happens":** by list and by follow. A client gets the list
  events of the items in its list and the content events of the items it follows; a role event goes to the one
  client concerned (section 4) `[design]`.
- Nothing of the design for points 1 to 4 and 7 was run; section 8 has its risks `[not verified]`.

**Readings not chosen:**

- *A window area and a page per server, each reached through an SSH tunnel* (the first version of this plan).
  It gives no single sidebar, and "server" would be a choice of window area, not of a chat
  `[design, for N04 S9]`. The user asked for HTTPS and a secret in its place.
- *The page talks to remote servers itself.* The server would have to answer CORS preflights, which it
  refuses today `[run: N01 S6]`. The stream would have to be read with `fetch` in place of `EventSource`, and
  the secret would sit in page JavaScript or be put in by the shell `[run: N02 S3]`.
- *The shell's main process talks to them.* Browser-only use would get nothing, and Electron keeps a
  certificate verdict for 30 minutes `[run: N02 S1]`.
- *The local server keeps a full copy of each remote chat.* That is two histories of one chat that must agree
  across outages and restarts `[design, for N04 S6]`.

**What is built.**

1. **A remote listener in the server,** opt-in: HTTPS on `0.0.0.0`. The loopback and MCP listeners are bound
   as today and keep today's Host rule, and `launch` and `stop` stay as today; `relaunch` gains one check
   `[design, for N01 S1, S5]`.
2. **API only, behind the secret.** A caller there is an API client: identified by its client id, it takes
   nothing from another client `[design]`. In this release it holds no board `[user: Q23]`. In Go tests with
   stand-in agents, in a prototype that kept one active page and gave API clients a role that is never active, a
   stand-in page stayed active while an API client created a chat, sent, answered a permission ask and stopped
   `[run: N06 S3]`.
3. **Secret and self-signed certificate** are made by set-up and by nothing else. A start only checks them.
   `ai-whiteboard secret -new` replaces the secret in a running server `[design, for N01 S2, S4]`.
4. **The client side in the local server:** the server list with the secrets, a pin per self-signed
   certificate, one event stream per remote server `[design, for N01 S7]`.
5. **No change to the shell's code.** The page stays "one page, one server"; the app bundle gains one script
   `[design]`.
6. **"+" without an agent.** It makes an unstarted chat in a place; board, chat and run are still offered
   `[design]`.
7. **Five choices in the chat:** server, agent, folder, model, effort. A new server sets the other four again;
   a new agent sets model and effort again `[design]`. Changing the agent of an unstarted chat any number of
   times, with only the last one started, ran in Go tests with stand-in agents `[run: N07 S1]`.
8. **At the first message** the chat starts on the chosen server and all five are locked. To a remote server
   the first message is one call, which finds or makes the chat there by its id and sends the message. From
   then on the local server keeps a chat record and no thread `[design]`.
9. **Sticky defaults** stay on the local server, per group: the server, and per server the agent, the folder,
   model and effort per agent, and the run defaults. `Defaults.Last` goes; the ungrouped group takes its place
   `[design]`. Defaults without `Last`, with a sticky agent and the migration of an old state file, ran in Go
   tests `[run: N07 S3, S4]`.
10. **A "Servers" dialog** in the web client: add, edit, remove, test connection `[design]`.
11. **Scripts:** `scripts/remote/setup-remote.sh`, `scripts/remote/start-server.sh`, a new
    `scripts/build-server.sh`, and one more entry in the app bundle `[design]`.
12. **Limits of the first release:** boards and chats on a board are local `[user: Q23]`; a remote run's
    result stays on its machine `[user: Q27]`; chats and runs made on a remote server from elsewhere do not
    appear locally (section 8) `[user: Q19]`.
13. **A role per board and targeted events in every server,** for the local app too: client records, one
    holder per board with today's hand-off, a scene revision, and events sent by list and by follow
    `[design]`.
14. **Runs on a remote server:** a server choice in a draft run, one start call that makes and starts the run
    there, and a run record on the local server `[design]`.
15. **Agents per server:** every server keeps its usable agents current and refuses the others, and every
    agent choice lists the chosen server's `[design]`.
16. **A remote group** on every server, for what its API clients make `[design]`.

**What the user does.** On the other machine: copy the server-only folder there (or use the installed app),
run `setup-remote.sh`, which asks nothing and prints the names with the port, the fingerprint and the secret,
and start the server. In the app: Servers, Add, enter name, address and secret, tick the box, press "Test
connection", compare the fingerprint, save. From then on that server can be chosen in any unstarted chat
and any draft run `[design]`.

## 2. Scope

### Requirements and acceptance criteria

Requirement *n* is met when acceptance criterion AC*n* holds. Section 7 gives each criterion its test. The
numbers of the first version are kept. Dropped, because nothing they describe is built any more: 2 (no local
port leads to a remote server); 3 and 19 (no other server's page runs in the app); 7, 8 and 9 (one page, no
page per server); 10 and 11 (no SSH tunnel, no remote start by the app); 14 and 21 (no remote page to load or
save). Requirements 22 to 45 are new; 37 to 45 came with the second update, which also gave 13 and 34 their
present wording.

| # | Requirement | Accepted when |
|---|---|---|
| 1 | With no remote entry and no remote listener the app behaves as today with one page, apart from the new chat start, the Servers dialog, the role per board and agent lists that hold usable agents only | **AC1** The existing Go and web suites pass apart from the tests section 3 names as changed, the desktop suite unchanged. A server with no remote configuration opens no added listener and reads and writes no secret, key or certificate, also when such files lie in its data folder |
| 4 | Every server has a stable identity | **AC4** Hello reports the same id across restarts. Adding the local server, or one server twice, is refused with its message. An entry whose address answers with another id shows "another server" and gets no further request |
| 5 | A remote server below the minimum feature level is recognised and refused | **AC5** A hello with a lower or missing level gives "too old"; no chat and no run can be started there; there is no "connect anyway" |
| 6 | The local server keeps the server list across restarts. The local entry is always there. No secret is returned to the page | **AC6** Add, edit and remove survive a restart. The local entry cannot be edited or removed, and a missing or empty list file gives the local entry. No API answer and no event holds a secret. The list file has mode 0600. A file that cannot be read is set aside, and the server starts with the local entry only |
| 12 | A remote outage is visible, bounded, and recovers without user action | **AC12** With a remote server stopped for 60 s: its entry shows "unreachable" within two ping intervals, its chats and runs stay listed, a send is refused with the text kept. Once it is back the thread on screen is current again with no action, and so is every other chat of that server when it is opened next. The same holds after the remote server was restarted. Local chats work throughout |
| 13 | Connecting to a server and acting on chats takes nothing from another client of it | **AC13** While a page on the remote server holds a board and follows a chat, an API client connects, creates a chat, sends, answers a permission ask and stops: the page keeps and saves its board, gets no `release_request` or `superseded`, and gets the events of the chat it follows; the API client gets no `rpc`; two API clients follow one chat at once. A page that follows a run agent's chat still gets that chat's events after an API client connects |
| 15 | On a good link a remote chat is as usable as a local one | **AC15** On T10's "good" profile (40 ms round trip) a send that does not wait for an agent's handshake (section 4) is acknowledged within 1 s, and streamed text is shown within 1 s of the remote server sending it `[estimate]` |
| 16 | On a poor or faulty link nothing is sent twice or lost silently | **AC16** On T10's "poor" profile (200 ms round trip) and under a cut. (a) A send in a started chat whose answer was lost is reported as unknown, and the thread shows the truth after the reconnect. (b) A first message whose answer was lost is sent once, however often it is repeated: the chat is "start not confirmed", its server and agent cannot be changed, and it takes "started" from the remote chat after the reconnect. (c) A first message refused before the agent started leaves the chat unstarted on both sides, with the reason shown and the text kept, and a retry with a changed folder, model or agent works; one that the agent refused after its start leaves the chat started on both sides, with the failed turn shown. (d) A change of server after a failed start deletes what the failed start left on the first server. (e) A cut in the middle of a turn loses no thread content |
| 17 | The sidebar shows state for remote chats, remote runs and servers | **AC17** A remote chat that waits for approval, works or has finished shows as a local one does. A remote run's row shows status, counts and attention as a local one's. A server that is not connected shows on its chats and runs and in the Servers dialog |
| 18 | What describes the server's machine is named as such | **AC18** Folder choice and plan usage of a remote chat or run name the server. `~` in the folder of a remote chat or run stands for that server's home. The folder listing, plan usage, catalogs, usable agents, home and default folder shown in a chat or a draft run whose server is that one are that server's. A remote run names its server beside its folder. Recent folders are kept per server |
| 20 | A server-only build exists for macOS and Linux | **AC20** `scripts/build-server.sh` gives the folder of section 4 for the four targets. Its README, carried out on a clean macOS and a clean Linux machine, gives a server the client connects to |
| 22 | A server can serve HTTPS on every IPv4 address of its machine. The loopback and MCP listeners are bound as today and keep today's Host rule | **AC22** Once set up, the remote listener is bound to `0.0.0.0` on the configured port, IPv4 only. A request whose Host is one of the names is answered; any other Host gets 403 with the right secret. No bind is tried again. The tests N01 S8 lists as unchanged pass. Plain HTTP on that port gets 400 `[run: N01 S2]` |
| 23 | Only the API is served on HTTPS | **AC23** `GET /`, a static file and `POST /mcp` answer 404 there with the right secret. So does every route outside the named set of section 4 |
| 24 | Every request there needs the secret. The secret is kept, and can be regenerated | **AC24** Without the secret or with a wrong one every route answers 401. The secret survives a restart. After `secret -new` the old one gets 401, the new one 200, and open streams of API clients end. Against a running server that has no reload the command signals nothing and says that the secret takes effect at the next start. No log line holds a secret. No start makes or changes the secret. `secret -new` with no configuration is refused and writes nothing |
| 25 | Set-up makes the certificate, and the server shows it | **AC25** `remote setup` makes the key (0600) and a certificate with the names when both are missing, and replaces neither. `remote setup -new-cert` replaces both. No start makes either. The printed fingerprint equals the one `openssl x509 -fingerprint -sha256` prints. An owner's own key and certificate are served from the next start |
| 26 | The checkbox pins. Without it normal verification applies | **AC26** Box on: the pinned certificate connects, another one is refused before any request, an expired pinned one connects, and an entry saved without a pin sends no request until a fingerprint is accepted. Box off: a self-signed certificate is refused with its message |
| 27 | Servers can be added, edited, tested and removed in the client | **AC27** Every row of the table in 5.1 gives its message against a stand-in server. Removal names the number of chats and runs and deletes nothing on the server |
| 28 | "+" starts a chat with no agent choice | **AC28** All seven places that make a chat do so without an agent menu. Board, chat and run are still offered |
| 29 | In an unstarted chat the user chooses server, agent, folder, model and effort | **AC29** A change of server sets the other four to that server's defaults and lists. A change of agent sets model and effort, any number of times; the first message starts only the agent chosen last. An agent the server cannot run is not offered |
| 30 | The first message locks all five | **AC30** After it a change of server or agent is refused (409). So is one in a fork or a branch that has had no message of its own. Folder, model and effort keep today's two exceptions. A chat is created with a given id only when that id is a lowercase version 4 UUID; any other id is refused |
| 31 | All five are sticky per group | **AC31** A second "+" in the same group starts with the first chat's five values. A group that has a value of its own is not affected by a change in another group; a group that has none takes the ungrouped group's values. Agent, folder, model and effort are kept per server. "New run" in the group starts with the same server |
| 32 | There is no "last used" | **AC32** A new top-level group starts with a copy of the ungrouped group's values, its run defaults for every server included; a subgroup with a copy of its parent's. A group that lacks a value gets the ungrouped group's. The `last` of an old state file is merged into the ungrouped group once, in the per-server shape, run defaults too, and is then gone from the file; no later phase changes the shape again |
| 33 | A remote chat lives in the local sidebar | **AC33** Move, archive, unarchive, rename, fork, branch, delete, the delete of a group with its contents, subagents and the automatic name behave as the table in 5.2 says, against a second scratch server. An archive or unarchive made on the remote server's own page shows at the client and is still there after a reconnect; one the user made while the server was unreachable is passed on at the connect. The delete of a group checks its remote runs as it checks its remote chats |
| 34 | Boards, and chats on a board, are on the local server `[user: Q23]`. A chat on a run is on the run's server | **AC34** On a board the server choice shows only the local server, with the reason; creating a chat there with a remote server is refused; a chat there starts on the local server when the group's sticky server is a remote one, and leaves it as it was. On a run the choice shows only the run's server; a chat on a remote run starts on that server, on that run, in the run's folder, and records no sticky server |
| 35 | The app bundle carries the set-up script | **AC35** The built bundle holds it. Run through `sh` from the bundle, it sets the app's own server up as a remote server |
| 36 | The set-up scripts and the `remote` commands do what the README says | **AC36** `setup-remote.sh` asks nothing and prints the names with the port, the fingerprint and the secret; a second run changes nothing and prints the same; after the secret was deleted it makes a new one and keeps the rest. `--new-cert` and `--new-secret` each replace that one thing. `start-server.sh` works when called from another folder. `remote status` shows off or listening, the port, the names and the fingerprint, says from the start's check whether the next start will work and why not, and never the secret. `remote off` removes the configuration only and takes effect at the next start |
| 37 | A start only checks. A set-up server that cannot serve HTTPS does not start | **AC37** With a configuration present, each "fatal" row of the table of "The start's check" ends `serve` with exit code 1: the file rows and the equal-port row before any listener is bound, the bind row before `server.json` is written. The message has at most six lines and names the file or the port, the repair command and `remote off`. The start has made or changed no secret, key, certificate or configuration. Through `launch` the whole message is in the text the app's start dialog shows. `relaunch` against a running server refuses for the file rows and the equal-port row and leaves it running |
| 38 | Every client of a server is identified | **AC38** A page states an id per page load, an API client its instance id, on the stream and on every call. On loopback a non-GET call without the id of an open stream in its `X-AIWB-Client` header is refused, and a call from a page of another origin reaches no route; a page that has only opened a stream is given no board and no tool call. On the remote listener a missing or malformed id is refused, and on every route but hello the server's own. A second stream with a connected id replaces the first |
| 39 | One client at a time works on a board; different clients hold different boards at once | **AC39** Two pages on one server each edit and save another board at once, and neither is shown a take-over. A take of a held board puts the holder's pending save on disk before the grant; the old holder shows the take-over for that board only and goes on with its other boards and chats; "Use here" shows the scene as stored. A scene write by a non-holder is refused. A page load and a reconnect take only free boards |
| 40 | An agent's board tools reach the client that holds the board | **AC40** A call goes to the holder of its target, `args.board` or the chat's board. With one page connected every board tool works on every board, on screen or not. With no page connected it is refused at once. A client that loses board B has its calls on B failed and its calls on C answered. A reply from another client is refused. `list_boards` and `create_board` answer with no page |
| 41 | A client is sent only the events it needs | **AC41** Every type goes as section 4's event table says. A client gets an item's content events only after it read that content, and again after a reconnect once it reads again. An API client gets nothing of an item without its client mark that it does not follow. Two clients that follow one chat get the same events |
| 42 | No whole-state write silently replaces a newer one | **AC42** A scene write based on an older revision is refused, and the steps of T11 X1, X3 (b) and X5 leave the newer scene on disk. A draft write based on an older draft is refused; the composer shows the stored draft unless the user typed since |
| 43 | A run can be started on a remote server and used from the local sidebar | **AC43** A draft run offers the server choice; a new server sets agent, tiers, folder and set-up command from that server's values and lists, and shows that machine's folder and git facts. A start on a remote server makes the run there. A start whose answer was lost, repeated any number of times, starts one run; a refused start leaves the draft local with the reason, and nothing there. The run's row, detail, texts and agents' transcripts show as a local run's. Every row of the run table of 5.2 holds. With the remote server stopped for 60 s or restarted, the run's state is current again with no action. A run id of another form is refused |
| 44 | A server offers only the agents installed on its machine, and the client never shows an agent the chosen server lacks | **AC44** A server's state lists exactly the agents whose programs it finds; one installed or removed while it runs changes the list in every connected client with no restart. A chat's creation or configuration, a draft run's agent, a start call and a first message with an agent outside the list are refused with the reason. `spawn_subagent` and `list_subagent_models` name no other agent, and a spawn of one is refused. On the local server's own page and for a remote server, the agent choice of an unstarted chat, of a chat on a run and of a draft run lists only the chosen server's usable agents; the empty state, the page with nothing open, offers no fixed agent. A stored agent the server lacks is replaced by its first usable one. With none usable, or the server unreachable, no agent is shown, the reason is, and send and start are refused |
| 45 | What a remote client makes on a server is kept in a dedicated remote group there | **AC45** The first creation by an API client makes a top-level group "Remote"; every client's chats, forks and runs sit in it and none in the ungrouped group. The owner's page shows the group; no API client gets a group. A call that names a group is refused. After the owner deletes or archives the group, the next creation makes a new one. An item with a client mark changes no defaults of that server, also after the owner moved it |

### What was asked, and where it is met

| Asked | Requirements | Where |
|---|---|---|
| "add https to server"; "we will be using selfsigned certificats for now" | 22, 25 | Section 4 "as a remote server"; 5.1; section 6 |
| "only server (api) is exposed on https" | 23 | Section 1, the reading; section 4; Q20 |
| "add some sort of authentication": "header with some secret on all endpoitns. Secret is generated on server start and has command to regen" | 24, 37 | Section 4; 5.6; section 6; Q15 |
| "When remote client is adding a host it adds secret and host (url and port). Check box for self signed certificates." | 26, 27 | 5.1; section 6; Q16 |
| "Even with this remote will not expose the server to public ip it will still stay behind vpn but we are adding https as added securtiy" | None by the server: the listener binds `0.0.0.0` (second update, point 5). An assumption of section 8 | Section 6, the first paragraph; section 1; non-goals |
| "add scripts for easier gen of certificats and things needed for https" | 25, 35, 36 | Section 4 "Scripts and packaging"; 5.1 |
| "update build script to include what needed in app distribution" | 35 | Sections 3 and 4, packaging |
| "add sciprt for only build server it should also add in that dst folder a scripts for setup of sertficates" | 20 | Section 4 "Scripts and packaging"; 5.1 |
| "new chat is just started with + there is no longer option to choose agent there (you still chose board and chat, and run)" | 28 | 5.3 |
| "then in chat you will have to choose server, agent, folder, model, and effort" | 29 | 5.3 |
| "when chat is started those things are locked as they are so far" | 30 | 5.3 |
| "all things are sticky defaults like they worked so far" | 31 | Section 4 "Sticky defaults"; 5.3 |
| "there is no last used anymore. New groups get defauls from ungrouped group now" | 32 | Section 1, the reading; section 4 "Sticky defaults"; Q21 |
| "local server is always at least one server" | 6 | Section 4 "Server list" and "Sticky defaults"; 5.3, the server choice |
| "Some ui for adding servers and their secrets with a test connection button" | 27 | 5.1 |
| The second update, 1: "Runs on a remote server. A run started from the client can run on a remote server, not only a chat." | 43, 34 | Section 4 "Runs for an API client", "Run records" and "Passing on and relay for runs"; 5.2, the run table; 5.8; section 6; Q27, Q28 |
| The second update, 2: "Agents per server. A server offers only the agents installed on its machine; the client never shows an agent the chosen server lacks." | 44 | Section 4 "Usable agents"; 5.3; 5.8 |
| The second update, 3: "A "remote" group. A chat created by a remote client is not left in the ungrouped group on the server; it goes into a dedicated remote group." | 45 | Section 4 "The remote group" and "Chats made by an API client"; 5.5; Q26 |
| The second update, 4: "One active client per board, replacing one active client per server. One client at a time works on a board and hands it off as today; different clients can hold different boards at once. This makes remote boards possible, and must not rule out two clients on the same chat (not a target)." | 13, 39, 40, 42 | Section 4 "Clients, holders and events" and "Remote boards (designed, not built)"; 5.5; Q23 |
| The second update, 5: "Bind address. The remote listener binds 0.0.0.0 for now; the rule that refuses a wildcard address goes." | 22 | Section 4 "Remote listener" and "Host rule there"; section 6; Q22 |
| The second update, 6: "Boot only checks. At start the server checks its remote config and starts HTTPS. It never creates the secret or the certificate; if the config is there and either is missing, that is fatal. Only set-up creates them." | 37, 24, 25, 36 | Section 4 "The start's check" and "Set-up: who creates what"; 5.6 |
| The second update, 7: "Client identity and targeted events. The server identifies each client and sends it only the events it needs, not everything that happens." | 38, 41 | Section 4 "Clients, holders and events" and "Passing on and relay"; 5.2; section 6; Q25 |

The plan is one document for both requests: what the update overturns is rewritten, or named once as dropped
(the readings not chosen in section 1, the dropped requirements above, the non-goals, the closed questions).

### Non-goals

- Use over a public address: nothing is built for it, and nothing in the server prevents it (section 6)
  `[design]`. Accounts, one secret per client, or a check of the id a client states `[user: Q25]`. A certificate
  authority.
- Boards on a remote server, and chats on them: designed in section 4, not built in this release
  `[user: Q23]`.
- Bringing a remote run's result to the user's machine `[user: Q27]`. Checking that an installed agent is
  logged in. A switch by which an owner allows API clients chats and not runs `[user: Q28]`.
- Two clients working in one chat at once: not built, not ruled out (sections 1 and 4) `[design]`.
- Listing or adopting chats and runs a remote server already has; moving a chat or a run between servers
  `[user: Q19]`.
- An SSH transport next to HTTPS: a second transport would bring back a page per server and the work to
  hand a server over between pages `[design, for N04 S9]`.
- The remote server's page over HTTPS. A Dock badge for remote chats.
- Windows as a remote host: the server does not compile there `[run: T07 R3]`.
- Installing, updating or starting the remote server automatically.
- Several OS users each running a server on one remote machine. The fixed MCP port 6006 allows one server per
  machine `[code: internal/boardapi/endpoint.go:5-7]`.
- The performance follow-ups of section 8, and a route that serves the remote log `[user: Q10]`.

### Constraints

What must stay as it is: T01 §9 (server), T02 §12 (desktop shell), T03 §10 (web client), and no new Go
dependency `[design]`; `go.mod` has none today `[code: go.mod:1-3]`. The Host rule of the loopback listener,
the shell's recovery of the local server, its flush before close and the link rules are all unchanged
`[design]`. T01 §9 item 7 and T03 §10 items 1, 3 and 9, which describe the one active client, its take-over
between pages, the board tools that go to it and its header rule, are replaced by the role per board and the
known client `[design]`. Five things are changed on purpose:

- **Chat creation and configuration.** Creating a chat takes no agent, and the configure route takes agent and
  server `[design]`. Today the agent is required at creation and no route changes it
  `[code: internal/chats/manager.go:764-766, internal/server/server.go:705-738]`.
- **The active-client rule** becomes a role per board, for every client, and its header rule becomes "a
  non-GET call names a known client" (section 4, 5.5) `[design]`.
- **`Defaults.Last`** is removed (section 4) `[design]`.
- **A run's start by an API client** is one call with a given id `[design]`; today the server makes the id and
  the start is a call of its own `[code: internal/runs/service.go:490, 788-797]`.
- **An agent the server lacks is refused** `[design]`; today all three kinds pass
  `[code: internal/runs/service.go:457-459]`.

## 3. Fit with the existing app

| Part | Touched | Reused as is | Behaviour that changes |
|---|---|---|---|
| Server, for every client | The bridge: client records, holds and follows, and a targeted send in place of the one broadcast `[code: internal/editorbridge/bridge.go:190-200]`; the guard, for the known client; the relay of board tool calls; the boards store, for the scene revision; the chat manager, for the watch set, which becomes the follow, and for the draft counter; every place that sends an event, which names its item; the look-up of usable agents, the refusal of an agent the server lacks, and the agent list of the subagent tools `[design]` | Every route's handler; the steps of the hand-off `[code: internal/editorbridge/bridge.go:104-114, 167-173, 286-302]` | Two pages on one server work at once, each on other boards and on any chat. A take-over is of one board, not of the server. A client gets the events of what it lists and follows, where today the active client gets all `[design]`. An agent whose program the server does not find is neither offered nor accepted `[design]`; today all three kinds pass `[code: internal/runs/service.go:457-459]` |
| Server, as a remote server | `serve`, for an added listener and for the start's check; `relaunch`, for the check before its stop; the guard, whose allowed Host values become a list; hello; the bridge and the guard, for API clients; one table of the routes an API client may call; chat creation; a snapshot of its own for API clients; a handler for the reload signal; a new loopback `GET` route that `remote status` reads; new commands, each with its own flags; the run service, for the start call, the draft check and the client mark; the remote group `[design]` | Both listeners as they are bound today `[code: cmd/ai-whiteboard/main.go:129, 138]`; the MCP handler `[code: internal/server/server.go:234-238]`; every route's handler, the run routes' among them; a run's engine and its git work; the agents. With a second listener added in a prototype, `launch`, `stop`, the MCP listener and the loopback Host rule behaved as before, and the Go tests of both packages passed unchanged `[run: N01 S1, S5]`. With the API-client role added in another prototype, the tests of the bridge, the server and the chat manager passed unchanged `[run: N06 S8]`; the plan does not adopt that role, and with the role per board the tests of the bridge and the guard change (the Tests row) `[design]` | Nothing until the owner sets it up. Then: the remote listener exists; a start, and `relaunch` before its stop, can refuse because of the set-up (section 4); a second kind of client can follow chats and runs and start both, where today every new stream of another client id takes the server over `[code: internal/editorbridge/bridge.go:92-116]`; a group "Remote" appears when such a client first makes something `[design]`; hello has two more fields than today's four `[code: internal/server/server.go:246-249]` |
| Server, as the local server | Chat creation and the configure route; the defaults package, where `defaults.Resolve` loses its local-disk check for a remote server, and the four places that read `Defaults.Last` `[code: internal/defaults/defaults.go:21, 29, 70, internal/runs/tiers.go:92]`; `ConfigureOf`, for the agent, the server and the checks it skips for a remote server; state loading, for the migration; the chat manager, for chat records and the relay; the run service, for a draft run's server, run records and the relay; run defaults per server; archive, unarchive and the delete of a group, for remote chats and runs; `GET /api/dirs` and `GET /api/usage/{agent}`, which take the entry; a new store and routes for the server list; a new HTTPS client `[design]` | The store's atomic write, called with mode 0600 for the state file `[code: internal/store/store.go:17-37, 106]`; the lock set by the first message `[code: internal/chats/manager.go:1247]`; the pattern of a draft run, whose agent is changed until the start and whose models are then resolved again `[code: internal/runs/service.go:691-698]`; local chats and boards, and the engine and git work of local runs | "+" takes no agent and the agent can be changed until the first message `[design]`. A draft run has a server, and a started run can be one of which this server keeps only a record `[design]`. The server makes requests to other machines, where today its only outbound request is the hello probe of its own port `[code: cmd/ai-whiteboard/main.go:316-345]` (N04 S6). The snapshot stops carrying `last` `[design]`, which it copies for the page today `[code: internal/app/app.go:100-102]` |
| Web client | The seven places that make a chat; the composer's choices; sidebar rows of remote chats and runs; the draft run's composer, for the server choice and for the agent picker, a fixed list today `[code: web/src/run/RunComposer.tsx:165-168]`; the empty state, whose "New chat" names a fixed agent today `[code: web/src/App.tsx:182]`; a new Servers dialog; recent folders; `conn.ts` and `store.ts`, for the "server back" event and for a role per board; `App.tsx`, where the take-over becomes a panel in the canvas area; `board.ts`, for the hold, the flush of one board, the read on a grant and the revision in a save; the composer, which takes a server's draft when the user typed nothing since; every place that reads a catalog, the home, the default folder, a folder listing or plan usage, which reads it through the chat's or the run's server (section 4 lists them); a "server unreachable" view of a chat and of a run; the `last` field of the defaults' type `[design]` | "One page, one server": one `fetch` call site and one `EventSource`, both root-relative `[code: web/src/api.ts:39-44, web/src/conn.ts:27]`; the store's keys; the version banner, which compares the page with its own server only `[code: web/src/version.ts:28-32]`; the pieces that load a chat again, `afterSnapshot` and `refreshChat` `[code: web/src/conn.ts:70-90, 334-341]` | No agent menu at "+". Server and agent are chosen in the chat, and a draft run has a server choice. No agent list shows an agent the chosen server lacks. The Servers dialog is the client's first form: today its only dialog is a confirm with buttons `[code: web/src/Dialogs.tsx:13-18]` |
| Desktop shell | No code `[design]` | Everything: start-up, the recovery of the local server, the flush before close, quit and reload, the link rules. The flush before close writes the boards the page holds `[code: desktop/lib.js:346-391, web/src/main.tsx:12-17]`, and a reload is a new client `[code: web/src/api.ts:27]`. The page still talks to the local server only | The app's window is no longer replaced by the take-over screen when a browser tab opens on the same server `[design]` |
| Packaging and scripts | One more `extraResources` entry in `desktop/electron-builder.yml`; nothing new under `files:`, since the shell gets no new file `[code: desktop/electron-builder.yml:10-24]`. Two new scripts under `scripts/remote/`, a new `scripts/build-server.sh`, the README `[design]` | The one version stamp of `scripts/build-app.sh` `[code: scripts/build-app.sh:15-30]`; `scripts/install-app.sh` | None for the app. A server-only folder exists for the first time |
| Tests | New Go tests: listener, secret, certificate, API clients, server list, every row of the test-connection table, the relay, client records, the hand-off per board, the targeting of every event type, the start call, the remote group, the look-up of usable agents. New web unit tests: the choices in the chat and in a draft run, the dialog. A scripted test of the set-up script and the commands `[design]` | The tests N01 S8 lists: Host rule, MCP handler, hello, static files, `TestFindRunning*`, `TestLaunch*`, `TestRelaunch*`. They passed unchanged on the prototype with a second listener `[run: N01 S5]`. The 400 for an empty group and for an unknown agent at creation `[code: internal/server/server_test.go:619-620]` and the refusal of an unknown agent in the manager `[code: internal/chats/manager_test.go:800-803]`: both passed unchanged with creation that takes no agent, since only an empty agent gets the default `[run: N07 S5]` | 21 existing Go tests and one test helper, all because they name `Defaults.Last`; N07 S5 is the list, by file and line `[run: N07 S5]`. Among them `TestSeedGroup` and `TestCreateGroupSeedsDefaultsFromLast` `[code: internal/defaults/defaults_test.go:99, internal/app/app_test.go:390]`, and the run defaults' tests `[code: internal/store/runpaths_test.go:95, 106, internal/runs/service_test.go:96, 636, internal/runs/tiers_test.go:246-247, internal/app/runs_test.go:111-121]`. In the end-to-end suite: the two assertions on `defaults.last` `[code: web/e2e/app.e2e.mjs:2283, 2302]`, and the helper `newChatVia`, which clicks an agent item in a "+" menu, with its 13 call sites `[code: web/e2e/app.e2e.mjs:649]` (N03 S8). For the role per board, three places change `[design]`: the 16 tests of the bridge `[code: internal/editorbridge/bridge_test.go:126-416]`, `TestMutationsNeedTheActiveClient` `[code: internal/server/server_test.go:420]` and step 9 of the end-to-end suite `[code: web/e2e/app.e2e.mjs:1096]`. For usable agents: existing tests that create a chat or a run with an agent whose program is not on the test's `PATH`; not counted `[not verified]` |

Closing the window, quitting and reloading stay as they are: the flush before close writes the boards the page
holds, a reload is a new client, and nothing of a remote chat or run lives in the page that a local one does
not have too `[design]`.

## 4. Components and responsibilities

**In every server: clients, holders and events**

What this part states is `[design]`, for the local server and for a remote server alike. None of it was run:
the whole part is a risk of section 8 `[not verified]`. A statement about today's code or about a run carries
its own mark.

- **Why.** Today a server has one role for all of its state. Every new event stream of another client id
  becomes the active client after 3 s at most `[code: internal/editorbridge/bridge.go:24, 92-116]`, and events
  go to the active client only `[code: internal/editorbridge/bridge.go:189-200]`. The second update moves the
  role to the board, and asks that each client be identified and sent only what it needs (section 1).
- **Clients and their ids.** A server keeps a record of each connected client. There are two kinds of client,
  and one shape of record.
  - *A page* states a random id made at page load, in the `X-AIWB-Client` header of every call and in the
    stream's address, as today `[code: web/src/api.ts:27, 42, web/src/conn.ts:27]`. The id is not made stable
    across reloads: a reload was the one safe way back for a page that had lost the role, because a new page
    keeps nothing `[run: T11 X2]`.
  - *An API client* states the instance id of the local server it is, in the same header, on every request of
    the remote listener. The id is the same for the life of an install, so a server can keep it on items (the
    client mark, below).
  - *The checks.* On loopback a non-GET call under `/api` must name a known client. The id is taken from the
    `X-AIWB-Client` header only, on every non-GET route, also on the client routes and the reply route
    `[design]`. Today those routes take it from the body first and from the header second
    `[code: internal/server/guard.go:21-23, 48, internal/server/server.go:186-193]`, and the page sends the
    header on all its calls `[code: web/src/api.ts:38-45, 67-69]`. On the remote listener, after the secret
    and the Host, every request needs a well-formed id: a missing or malformed one gets 400 on every route,
    hello included. Hello is answered whatever well-formed id is stated, the server's own too, because a local
    server that is given its own address states its own instance id and recognises itself by the id in
    hello's answer (5.1). Every other route there refuses the server's own id with 400 `[design]`. A chat or
    run call there needs no open stream; a read without an open stream starts no follow.
  - *One id twice.* A newer stream with a connected id replaces the older one, whose record ends. The newer
    one starts with nothing held and nothing followed. Today the role carries over to the new stream
    `[code: internal/editorbridge/bridge.go:98-102]`. That is dropped: the client declares again what it
    follows, and the scene revision makes a new take safe (below). Two installs with one instance id, as after
    a copied data folder, cut each other's stream (section 8).
- **What a server keeps per client,** in memory and for the life of its stream: the stream
  `[code: internal/editorbridge/bridge.go:44-49]`, the kind, the id, the boards it holds and those it waits
  for, the items it follows, and its open tool calls. Nothing of it survives a restart. The one durable trace
  of a client is the client mark on the items it made.
- **Holding a board.** One client at a time holds a board. The hold covers the scene write and the tool calls
  whose target is that board, and nothing else.
  - *How a client gets one.* By an explicit call, in two forms. **Take:** on a user's action on that board, a
    click on it in the sidebar or "Use here"; if another client holds the board, the hand-off runs. **Take if
    free:** for the board shown at page load and after a reconnect, and for an agent's `show_board`. When the
    board is not free, the page shows the take-over panel with "Use here" in place of its canvas. The client
    that creates a board holds it. A hold is not taken at the first edit, because a tool call needs a holder
    before any edit. It is not taken at every opening either: a reconnect would then take a board from a
    client at work `[design]`; today a page's reconnect takes the role back `[run: T11 X5]`.
  - *How long.* Until the client's stream ends, the board is handed off, deleted or archived, or the client
    releases it. The page does not release a board when it leaves it, so an agent reaches boards that are off
    screen, as today `[code: web/src/board.ts:207-216]`.
  - *What needs no hold:* rename, move, the "seen" mark, reveal, archive, delete, and a new chat on the board.
    They are commands, open to every client that passes the checks of its listener ("The checks", above).
    Archive and delete first ask a holder elsewhere to flush and release.
  - *A client that does not hold a board* still sees it in its list, reads its scene, since a `GET` is open
    today `[code: internal/server/guard.go:41-52]`, and uses its chats fully.
- **The hand-off, per board.** Today's steps
  `[code: internal/editorbridge/bridge.go:104-114, 167-173, 286-302]`, each with a board id:
  1. Client N takes board B. If B is free, N holds it. If client H holds it, N waits, one waiter per board; H
     gets `release_request` for B, and a timer of 3 s starts for B.
  2. H flushes the pending save of B only, where today it flushes all `[code: web/src/board.ts:119]`, and
     releases B.
  3. On the release or at the timer's end: H gets `superseded` for B, H's open tool calls on B fail, and N
     gets `held` for B with B's scene revision.

  What goes with the steps:
  - *The scene revision.* A counter per board, raised at each accepted scene write. A read of the scene
    returns it. A write names the revision it is based on and is refused when that is not the stored one;
    today a write overwrites `[code: internal/boards/boards.go:194-208]`. A client that gets a board keeps its
    cached scene only when it has it at the granted revision; otherwise it reads the scene again. Today a page
    that comes back uses the scene it cached `[code: web/src/board.ts:28-30]` and wrote it over the other
    page's newer one `[run: T11 X1]`. The revision is meant to close this path `[design]`.
  - *The client that lost B* shows a take-over panel in place of B's canvas only; today the whole window is
    replaced `[code: web/src/App.tsx:40]`. An edit it could not flush within the 3 s is dropped, and the panel
    says so; today such an edit overwrote the newer work when the page took the role back `[run: T11 X3]`.
    "Use here" in the panel is a take.
  - *A cut stream.* The server frees that client's boards and fails its open tool calls, as it does today for
    the one role `[code: internal/editorbridge/bridge.go:118-127]`. After the reconnect the page takes, if
    free, the board on screen and the boards with a pending save. There are two cases `[design]`. A board
    that is not free shows the take-over panel. A board that is free is granted: at the same revision its
    pending edit is saved; at another revision the pending edit is dropped, and a notice on that board's
    canvas says so. Today the page takes the role back unasked `[run: T11 X5]`.
  - *A stopping server* sends `server_stopping` to every client that holds a board, and waits for all holders
    or for its limit, 2 s at shutdown today `[code: cmd/ai-whiteboard/main.go:224]`. No hold survives a
    restart.
- **Routes that are not about one board.** On loopback, one rule: a non-GET route under `/api` needs a known
  client. It covers groups, chats, runs, archive, creation, restart and the server list. None of them needs a
  holder. On the remote listener the rule is the secret, the Host and a client id ("The checks", above).
  - *The protection against a page of another origin stays.* It rests on the custom header, which forces a
    preflight that the server does not answer `[run: T09 Part A]`. It gets stronger. Today a foreign page's
    `EventSource` takes the role `[run: T09 Part A]`. With the role per board a stream takes nothing, a take
    needs the header, and the reply to a tool call is taken only from the client that was asked, named by the
    header `[design]`; today a reply is taken from the active or the waiting client, not only from the client
    that was asked `[code: internal/server/server.go:294-307, internal/server/guard.go:55-57,
    internal/editorbridge/bridge.go:236-243]`.
  - *Drafts.* A counter per draft. A write names the counter it is based on; a stale write is refused and
    answered with the stored draft. The composer takes a draft from the server when the user typed nothing
    since its last save, and keeps the user's text otherwise. Today it takes none
    `[code: web/src/Composer.tsx:179-184]`, and an old draft overwrote a newer one `[run: T11 X4]`.
  - *Group order.* No new rule: the write must list every group once `[code: internal/app/app.go:240-265]`.
- **Board tool calls.**
  - *The server resolves the target:* the board the call names, else the calling chat's board. Today the page
    does that `[code: web/src/board.ts:286-297]`, and the server passes on the chat's board only
    `[code: internal/boardapi/mcp.go:73-78]`.
  - *Who is asked:* the holder of the target. A target that nobody holds is first given to the holder of the
    calling chat's board, else to the page that last made a call with the header; a page that only opened a
    stream is never chosen `[design]`. With no page the call is refused at once, as today
    `[code: internal/editorbridge/bridge.go:210-215, internal/boardapi/mcp.go:39-40, 79-80]`; the prototype,
    which kept one active page, got that refusal `[run: N06 S4]`. It follows that with one page connected
    every tool works on every board.
  - *Calls about no single board.* `list_boards` and `create_board` are answered by the server itself; today
    the page answers them from its copy `[code: web/src/board.ts:311-313, 370-376]`. A board made so is in the
    group of the calling chat's board, and is free.
  - *Calls about one screen.* `get_view` and `show_board` go to the holder of the calling chat's board, else
    to the page that last made a call with the header.
  - *Failing.* An open call records its client and its target. A client that loses board B has its calls on B
    failed and no others; a stream's end fails all calls of that client. Today calls fail by client only
    `[code: internal/editorbridge/bridge.go:353-365]`.
- **Two pages on one server** result from these rules; 5.5 says what the user gets and what stays limited.
- **Events: the rule.** A role event goes to the one client concerned. A list event goes to every client that
  has the item in its list: a page has every item of its server, an API client the items that carry its client
  mark. A content event goes to the clients that follow the item. A run agent's chat is in nobody's list: all
  its events go by follow. An API client gets a list or content type only when the type is also on its
  allow-list (below).

  | Event | Class | Sent to `[design]` |
  |---|---|---|
  | `hello`, `snapshot` | role | the connecting client |
  | `release_request`, `superseded`, `held` (new), each with a board | role | the holder asked; the client that lost or got the board |
  | `rpc` | role | the holder of the target board ("Board tool calls") |
  | `server_stopping` | role | every client that holds a board |
  | `groups`, `defaults` | list | every page; no API client |
  | `catalog`, `agents` (new) | list | every client |
  | `board`, `board_removed` | list | every page; no API client in this release `[user: Q23]` |
  | `chat`, `chat_removed`, `branch_state` | list | every page; an API client for chats with its client mark. A run agent's `chat`: its followers only |
  | `tree`, `chat_items`, `sub`, `sub_items` | content | the clients that follow that chat |
  | `run`, `run_removed` | list | every page; an API client for runs with its client mark |
  | `run_detail`, `run_activity` | content | the clients that follow that run |
  | "server back", an entry's state, an entry's lists (new, local server only) | list | every page of the local server; no API client |

  Today every list and content event goes to the active client's stream only
  `[code: internal/editorbridge/bridge.go:190-200]`. The classes go by what the page does with an event: it
  drops the six content types for an item it has not loaded
  `[code: web/src/conn.ts:117-129, 134-139, 280-292, 361-370]`.
- **How a server knows what a client needs.** One way per class.
  - *Recorded: the client mark.* It is set when an API client makes an item and copied to the item's forks. It
    decides an API client's list and its snapshot, and outlasts every reconnect and restart. It gives no
    right: the routes take any item's id. The one use beyond lists is that a creation or start call refuses
    an id that another client's item has.
  - *Declared: the follow.* A follow starts when a client reads an item's content with its client id on the
    request: a chat's items or tree, a run's detail. The server notes the follow first and reads second, so that
    no event falls between, as `Watch` does today `[code: internal/chats/owned.go:733-742]`. A follow ends with
    the client's stream or by an unfollow call. The page reads its open chat and run again after each snapshot
    `[code: web/src/conn.ts:70-90]`, so it declares again after a reconnect. The page unfollows a run agent's
    thread when it drops it, soon after that agent's transcript closes
    `[code: web/src/conn.ts:427-428, 464-473, 475-484]`, and it unfollows no other chat (section 9, U6). A local
    server unfollows on a remote server ("Passing on and relay").
  - *The watch.* Today one set per server says which run agents' chats send events
    `[code: internal/chats/manager.go:66-69, 239, 252]`, and in `serve` the page's snapshot function empties
    it `[code: cmd/ai-whiteboard/main.go:150-152]`. The set becomes the follow per client, and the snapshot
    function loses that side effect.
- **Snapshots and allow-lists.** A page gets today's snapshot `[code: internal/app/app.go:54-84]`. An API
  client gets the API snapshot: the items that carry its client mark, the catalogs, the usable agents, home
  and default folder. The allow-list by type stays, one per kind of client, with the targeting behind it. In
  the prototype, which kept one active page, the types outside the list did not reach an API stream
  `[run: N06 S5]`; it follows that a type added later reaches no API client until it is listed. The API
  client's allow-list is under "API clients" below.
- **Avoided, so that two clients on one chat stay possible.** Two clients that work in one chat at once are
  not a target of the second update and are not built (section 1). So that nothing rules them out, the design
  avoids six things `[design]`:
  1. No chat event is keyed to one client; any number of clients may follow one chat.
  2. Holding a board is no condition for acting on its chats or for getting their events.
  3. There is no hold, lock or owner on a chat; the client mark decides lists, never rights.
  4. The page does not assume that it alone writes a draft ("Drafts", above).
  5. A follow is never exclusive, and one client's snapshot changes nothing for another client.
  6. The fallback of a tool call uses the holder of the chat's board, never "the chat's client".

**In the server, as a remote server**

- **Remote listener.** An added listener next to the loopback one and the MCP one. It is switched on by the
  remote configuration, a file in the data folder (port, names) that `ai-whiteboard remote setup` writes and
  the server reads when it starts `[design]`. A flag would not do: the app starts its server with a fixed
  `launch` `[code: desktop/lib.js:20-23]`, and a running server ignores `launch`'s flags `[run: T07 R2]`. The
  command restarts nothing, because a stop ends the running agents
  `[code: cmd/ai-whiteboard/main.go:222-230]`.
  - *What is bound.* `0.0.0.0:<port>` on network `tcp4`: every IPv4 address of the machine, and no IPv6
    `[user: Q22]`. With `tcp4` a dial to `[::1]` was refused; with `tcp` the listener answered IPv6 too
    `[run: N08 S1]`. IPv4 alone is chosen because the user wrote `0.0.0.0`, because it gives one behaviour on
    macOS and Linux, and because IPv6 is not opened before it is tested `[design]`. The configuration holds
    the port, 4748 by default, and the names, and no address. `remote setup` takes `-port` and `-name`, which
    can be repeated; it and the script ask nothing `[design]`.
  - *A port that cannot be bound* ends the start `[design]`, as a failure of either of today's two binds does
    `[code: cmd/ai-whiteboard/main.go:129-141]`. No bind is tried again `[design]`. A second wildcard listen
    on a port that a wildcard listener held failed with "address already in use" `[run: N08 S2]`. A named
    address that is not on the machine could not be bound `[run: N08 S3]`; it follows that a wildcard listener
    has no such case, and nothing is left to wait for. The start's check (below) refuses a remote port equal
    to the server's own port or to the MCP port `[design]`: a wildcard listen on a port held on `127.0.0.1`
    gave no error, and loopback dials then went to the loopback listener `[run: N08 S2]`. The binds N08 did
    not run, a port held by another process among them, are a risk of section 8 `[not verified]`.
  - *Not run.* With the macOS firewall on, dials to the machine's own address connected and were never
    accepted `[run: N08 S1, S5]`. A request from another machine was not run `[not verified]`.
- **The start's check.** One check, made on the files and on the configured port. `serve` runs it, and so do
  `relaunch`, `remote setup` and `remote status` `[design]`. In `serve` it runs after the "already running"
  return `[code: cmd/ai-whiteboard/main.go:124-127]` and before any bind. A remote port equal to the server's
  own port or to the MCP port is found there by comparing the numbers, with the file rows and before any bind,
  since a bind does not report it ("Remote listener", above) `[design]`. The remote port is bound after the
  MCP port and before `server.json` is written `[design]`; today the MCP port is bound and then the file is
  written `[code: cmd/ai-whiteboard/main.go:138-141, 219]`. Without a configuration nothing more is read or
  created: the start is today's, and stray secret or certificate files are ignored and kept `[design]`. With
  one:

  | Found | Start | Repair the message names `[design]` |
  |---|---|---|
  | Configuration unreadable or not valid | fatal | `remote setup` |
  | Secret missing; certificate and key both missing | fatal | `remote setup` |
  | Secret empty or not in set-up's form | fatal | `secret -new` |
  | Certificate or key missing or without PEM data, or they do not fit | fatal | `remote setup -new-cert`, or the owner's pair put right |
  | Remote port equals the server's own port or the MCP port | fatal | `remote setup -port` |
  | Remote port cannot be bound | fatal | free the port, or `remote setup -port` |
  | Certificate expired, or its names differ from the list | starts | |

  Go's loader gave an error of its own for a pair that does not fit, for a missing file, with its path, and
  for an empty file `[run: N08 S4]`. The start loads the pair once and serves what it loaded `[design]`:
  served from the file names, the error came back at once but the listener stayed open `[run: N08 S5]`. An
  expired certificate was served without complaint `[run: N01 S2]`. The file cases N08 did not run are a risk
  of section 8 `[not verified]`.

  *The message* has at most six lines: one per wrong file, with its path, or one that names the port; "The start
  creates nothing"; the table's repair command; and `remote off` "to start without remote access". Commands
  carry the binary's full path `[design]`, as the install script prints it today
  `[code: scripts/install-app.sh:26]`. `launch` passes on the last 8 lines of the log
  `[code: cmd/ai-whiteboard/launch.go:79, 246-248]`; it follows that the message arrives whole. What the user
  then sees is in 5.6.
- **Set-up: who creates what** `[design]`. Set-up is `remote setup` and the two commands that replace:
  `remote setup -new-cert`, which the script calls for `--new-cert`, and `secret -new`, which it calls for
  `--new-secret`. Nothing else writes a secret, key or certificate.
  - `remote setup` makes what is missing and replaces nothing: the secret; key and certificate when both are
    missing; the configuration last, so an interrupted first set-up leaves a server that starts as today. It
    ends with the check and prints the result. A second run repairs a missing file and keeps the secret
    `[design]`: after a new secret the old one got 401 `[run: N01 S4]`.
  - `secret -new` and `remote setup -new-cert` need the configuration; without it they refuse and write
    nothing.
  - `remote setup -new-cert` writes the key, then the certificate, each atomically, with the store's write of
    today `[code: internal/store/store.go:40-53]`. A start between the two is fatal; the command run again
    repairs it.
  - `remote off` removes the configuration only; set-up after it gives the same secret and fingerprint.
  - An owner's own key and certificate are put in place by hand; `remote status` checks them before the
    restart.
- **Routes there.** A named set, kept as one table that both the listener and its test read `[design]`:
  - hello;
  - the event stream and the state, which for an API client both give the API snapshot (below);
  - the chat routes: create, also on a run; read a chat, its items, its tree, its context split and a
    subagent's items; configure, without a group; send; stop; permission answer; label; open; fork; archive
    and unarchive; delete;
  - the run routes: the start call; the draft check; read a run, its detail, goal, brief, report, changes,
    notes and delivery preview; rename, which is today's patch route with a name alone; stop; resume; apply;
    archive and unarchive; delete;
  - the unfollow call, for a chat or a run;
  - folder listing and plan usage.

  Everything else answers 404 there, with the right secret too: the web client's files, the MCP endpoint, the
  draft routes of chats and runs, every group route, a run's plain creation and today's start route, and
  restart. A run's patch route with any field but the name is refused there with 400 `[design]`. In this release
  every board route answers 404 there as well, the calls that hold and release a board among them `[user: Q23]`.
  The table is needed because routes are registered one by one, with nothing that lists them
  `[code: internal/server/server.go:246-812]`. A prototype with an API-only switch answered 404 for `GET /` on
  that port while the loopback page still loaded; `POST /mcp` is 404 there with or without the switch, since the
  MCP route is not on that handler `[run: N01 S1]`. The API-client prototype did this differently, and the plan
  does not adopt it: its guard let an API client through to every `GET` under `/api`, so that the page's full
  state answered 200, and answered 403 for what was outside its list `[run: N06 S2]`. The named set, with 404
  for an API client outside it, was not run `[not verified]`.
- **Host rule there.** The configuration's list of names, with the listener's port, is what the rule accepts
  `[design]`; the rule does not look at the address a listener is bound to
  `[code: internal/server/guard.go:24-31]`. At the first set-up the list is the host name, every non-loopback
  IPv4 address of that moment, and each `-name`. A later `remote setup -name X` adds X; a run without flags
  changes nothing `[design]`. A listed name got 200; any other got 403 "bad host", with the right secret too
  `[run: N01 S5]`. A certificate made by set-up carries the list of that moment, and a name added later does
  not remake it: a new certificate would change the fingerprint for every client `[design]`. A pinned client
  connected under a name that is not in the certificate `[run: N01 S7]` and to a certificate with no names
  `[run: N08 S5]`. So the list and the certificate's names can differ, and a start does not stop for it
  (the start's check) `[design]`.
- **Secret.** 32 random bytes, written as hex to a file of mode 0600 in the data folder `[design]`.
  - *When it is made.* By set-up only; no start makes it, and a server that was never set up has none. It is
    kept across restarts and replaced only by `secret -new` ("Set-up: who creates what", above) `[design]`.
  - *Reading and replacing.* `ai-whiteboard secret` prints it. `ai-whiteboard secret -new` writes a new one;
    with no configuration it refuses and writes nothing. The command then asks hello on loopback and signals
    the running server only when hello reports a feature level that has the reload; otherwise it signals
    nothing and says that the new secret takes effect at the next start `[design]`. The check is needed
    because the server of an older build can be the one running after a new app was installed
    `[code: scripts/install-app.sh:20-27]`, and such a server has no handler for a reload signal: it handles
    the two stop signals only `[code: cmd/ai-whiteboard/main.go:222-230]`. The gate itself was not run
    `[not verified]`.
  - *In the running server.* It reads the file again. In the prototype, which sent SIGHUP to the pid in
    `server.json`, the old secret then got 401 and the new one 200 `[run: N01 S4]`. The server then closes the
    streams of its API clients, in this order: the new secret first, then the close, so that no client
    reconnects in between with the old one `[design, for N06 S7]`. Without the close a stream opened with the
    old secret went on receiving events `[run: N01 S4]`. Closing every API client's stream on one call ran in
    a Go test: both streams ended, the page's stayed open and active, and a new API stream opened normally
    `[run: N06 S7]`. Over TLS with HTTP/2, and set off by the secret's change, the close was not run
    `[not verified]`.
  - *The check.* A wrong or missing secret gets 401 with one fixed body `[run: N01 S5]`. The comparison takes
    constant time `[design, for N01 S4]`; an empty secret ends the start (the start's check) `[design]`. There
    is one secret per server, shared by all its clients; a client id tells them apart and gives no right
    `[design]`.
- **Certificate.** Made by the server binary itself, with the standard library: by `remote setup` when key and
  certificate are both missing, and by `remote setup -new-cert`. No start makes one. There is one generator on
  every platform and no dependency `[design]`. A prototype made and served such a certificate, and its SHA-256
  fingerprint was the one `openssl x509 -fingerprint -sha256` printed `[run: N01 S2]`. Its names are the
  configuration's list at the moment it is made (the Host rule, above); it lasts ten years `[design]`. The
  fingerprint is shown by `remote setup`, by `remote status` and in the server log at start `[design]`. An
  owner may put a certificate and key of their own in place; the README says where `[design]`. A certificate
  replaced while the server runs, by `remote setup -new-cert` or by hand, is served from the server's next
  start, as the set-up is: a start loads the pair once `[design]`.
- **API clients.** Today there is no way to listen to a server without taking it over: every new event stream
  of another client id becomes the active client after 3 s at most
  `[code: internal/editorbridge/bridge.go:24, 92-116]`, events go to the active client only
  `[code: internal/editorbridge/bridge.go:189-200]`, and a page that opened a second server's stream
  superseded that server's user `[run: N02 S4]`. So the role moves to the board and every client gets a record
  ("Clients, holders and events"); a caller on the remote listener is one kind of client `[design]`.
  - *The role.* An API client connects without taking anything, and any number may be connected `[design]`. It
    holds no board in this release, so it gets no `release_request`, `superseded`, `held` or `rpc`
    `[user: Q23]`.
  - *What was run,* in Go tests with stand-in agents, in the prototype, which kept one active page and gave
    API clients a role that is never active. With a stand-in page active, an API client created a chat, sent,
    answered a permission ask and stopped: the page was never superseded and got no `release_request`; its
    scene, draft and group-order saves were accepted; a board tool's `rpc` went to the page only; the page and
    two API clients saw the same chat events `[run: N06 S3]`. With no page at all, create, send, permission
    answer, stop and the turn's events worked `[run: N06 S4]`. The plan does not adopt that role. Its own
    variant, with client records and no role for a whole server, was not run `[not verified]`.
  - *Why it holds.* Chat routes are commands on state the server holds, and so are the run routes of the
    named set: none of them needs a holder `[design]`. What two writers lose today is whole-scene saves and
    drafts `[run: T11 X1, X4]`; a scene write needs the holder and the scene revision, and a draft write its
    counter `[design]`. Today the role check of every other non-GET route is in one place
    `[code: internal/server/guard.go:32, 41-52]`; the client routes and the reply route check the sender
    themselves `[code: internal/server/server.go:269-307]`. Three of today's role events, `release_request`,
    `superseded` and `rpc`, are sent to the active or waiting client directly, never through the broadcast
    `[code: internal/editorbridge/bridge.go:105-110, 204-220, 295]`.
  - *Its stream* begins with `hello` and the API snapshot: a snapshot of its own, holding the chats and runs
    that carry its client mark, built by a function with no side effect and trimmed to those items, the chats'
    branch states, catalogs, usable agents, home and default folder. It holds no group and no defaults
    `[design]`. The prototype sent the page's whole snapshot, with boards, groups, runs, defaults and the data
    folder's path `[run: N06 S5]`; the plan does not adopt that. A snapshot of its own was not built
    `[not verified]`.
  - *Its events* are an allow-list by type, one per kind of client, with the targeting behind it: an event of a
    listed type reaches an API client only when the rule of "Clients, holders and events" sends it there. The
    API client's allow-list: `chat`, `chat_items`, `chat_removed`, `branch_state`, `tree`, `sub`, `sub_items`,
    `catalog`, `agents`, `run`, `run_removed`, `run_detail` and `run_activity`. A type added later reaches no
    API client unless it is put on the list `[design]`. With the chat types and `catalog` on the list, kept in
    the prototype in its one broadcast, the API streams got no `board` and no `groups` event while the page got
    one of each; the page got no `defaults` event in that run either, so the run shows nothing for that type,
    which is not on the list `[run: N06 S3, S5]`. A `catalog` event on such a stream was not seen in a run, and
    the four run types and `agents` were not on the prototype's list `[not verified]`.
  - *Not run:* an API client over the real HTTPS listener with the secret, since the listener and the
    prototype's role were each run alone; two clients that follow one chat under the targeting; and two
    answers to one permission ask, one from the page and one from an API client `[not verified]`.
- **Chats made by an API client.**
  - *One call starts a chat.* The creation call carries the chat's id, its values (agent, folder, model and
    effort; the fifth, the server, is the one being called), its name, with the "named by the user" mark as
    it stands, and the first message. The server finds or makes the chat by the id. If the chat is unstarted
    there, it applies the values and sends the message. If it is already started, it sends nothing. These
    three (find or make the chat, apply the values, send) are one step under the creation lock, the lock a
    creation with a given id holds, so a repeat that arrives meanwhile waits and then finds the chat as the
    first call left it. Every answer of the call, an error too, carries the chat's state, started or
    unstarted `[design]`. The state is in every answer because a refused send can leave a chat started: a
    send sets the lock and writes the user's message into the thread before it hands the message to the
    agent, and a refusal by the agent leaves the message there as a turn that failed
    `[code: internal/chats/manager.go:1176-1177, 1247, 1286, 1320-1324]`. The name is in the call because
    that server's namer names a chat at its first message when the chat has no name and is not marked as
    named by the user `[code: internal/chats/manager.go:1309-1319]`; a name the user gave, sent with its
    mark, prevents that.
  - *What was run,* in Go tests with stand-in agents: creation with a given id and the full configuration; a
    repeat with the same id returned the existing chat, started or not, and made and started nothing; 24
    creates at once made one chat; a refused create (a missing folder, an unknown model, an unknown agent)
    left nothing behind `[run: N07 S2]`. Not run: the message in the same call, the chat's state in an answer
    that is an error, and new values applied to an unstarted chat that the id finds `[not verified]`. A send
    by itself is not repeatable: a second one while the turn runs is refused as busy
    `[code: internal/server/server.go:128, 156-157]`, which is why the message travels in the repeatable
    call.
  - *Not adopted from the prototype:* it answered 409 to a repeated create whose values differ
    `[run: N07 S2]`. This call does not: on an unstarted chat the values of the latest call are applied, so a
    retry after the user changed something works (5.3) `[design]`.
  - *The id* must be a lowercase version 4 UUID, the form a server makes itself
    `[code: internal/chats/manager.go:2032-2038]`. It is checked at the route `[design]`, because it becomes
    a folder name `[code: internal/store/paths.go:29]`. With that check, ids such as `../../etc`, `a/b` and
    upper case were refused `[run: N07 S2]`. An id that a chat there has without the caller's client mark is
    refused with 409, as a clash of ids `[design]`.
  - *Where.* In the server's remote group ("The remote group", below): an ordinary top-level group named
    "Remote", which the server makes at the first creation by an API client, remembers by id, and makes again
    when it is gone or archived `[design]`. A call that names a group is refused `[design]`. A chat on a run
    is accepted and sits on that run `[design]`. A chat on a board is refused in this release `[user: Q23]`.
    The prototype let an API client create a chat on a board `[run: N06 S2]`; the plan does not adopt that,
    and the group and the refusals were not run `[not verified]`.
  - *The client mark, and no sticky defaults.* A chat made by an API client is marked with the id of the API
    client that made it, and the mark is copied to its forks ("Clients, holders and events"). An item that
    carries a client mark records no defaults on that server, whoever configures it and whatever group it is
    in `[design]`, as a chat on a run records none today `[code: internal/chats/manager.go:1243, 1401]`. The
    rule goes by the mark, not the group, because the owner can move the item
    `[code: internal/chats/manager.go:1794-1820]`. Such an item reads nothing from that server's defaults
    either: every value is in the call `[design]`. On a chat the rule was run, as one condition on the chat
    and with a mark that did not say which client: the defaults were unchanged after such a chat was
    configured and started `[run: N06 S6]`. The copy to a fork and the rule for a run's start were not run
    `[not verified]`.
  - *A model is checked only when that agent's catalog has loaded.* The catalogs of Cursor and pi are empty
    until the CLI has reported, and until then any model is accepted
    `[code: internal/chats/choice.go:37-67, internal/chats/manager.go:1470-1473]` (N07 S2). A model that
    pi's program does not know then fails in its handshake, and that error comes out of the send, not out of
    the start of the program `[code: internal/pi/pi.go:260-263, 307-317, 458-459]`; Cursor applies the model
    in its handshake and reports the handshake's error from the send in the same way
    `[code: internal/cursor/cursor.go:205-211, 289-291, 320-324]`. It follows that "the model is unknown"
    may show only after the agent has started, as a refusal of the first message that leaves the chat
    started (5.3, the second failure path).
- **The remote group.** Where a server keeps what its API clients make. What follows is `[design]`, and none
  of it was run `[not verified]`.
  - *What it is.* A top-level group record like any other, named "Remote". The server makes it at the first
    creation by an API client and remembers it by its id; it makes none at its start or at set-up. At every
    such creation the server looks the id up, and a group that is gone or archived is replaced by a new one.
  - *What goes in.* Plain chats made by an API client; their forks, which copy the source's group
    `[code: internal/chats/fork.go:225-227]`; runs made by an API client, with the chats on them; and boards
    with their chats, once an API client can make one `[user: Q23]`. There is one group for all clients of a
    server: the user named one group, and a client has an id but no name to show `[user: Q26]`.
  - *What the owner can do with it.* Everything a group allows: rename, collapse and move it, create in it, and
    move items in and out. An item moved out keeps its client mark. Archiving the group archives every item in
    it and stops their agents and runs `[code: internal/app/app.go:419-459]`; each client is shown the archive
    of each of its items, because the archived mark of a remote item is the remote server's (5.2). Deleting it
    with its contents deletes the clients' items, and their records on the clients become "gone there", the mark
    of a record whose item its server no longer has (5.4). Deleting it alone moves them to that server's
    ungrouped group `[code: internal/app/app.go:646-709]`. The next creation by an API client makes a new group
    "Remote".
  - *Why an ordinary group.* The owner can already archive or delete any chat on that server, so a group the
    owner can remove adds no power, and it needs no change in the web client. A group with a fixed key, which
    nobody can remove, would change three validators and about six places of the web client `[estimate]`.
  - *Its defaults.* The group is seeded like any new top-level group ("Sticky defaults"), for what the owner
    creates in it. An item with a client mark neither reads nor records defaults there ("Chats made by an API
    client").
  - *The client sees nothing of it.* The creation call and the start call carry no group, and one that names a
    group is refused with 400. No group list and no `groups` event reaches an API client. The local server
    sets the local place in every view it hands to its pages ("Passing on and relay").
  - *On the owner's page* the group shows like any other, with the clients' items in it. What a failed start
    left behind sits there too (section 8).
- **Runs for an API client.** A run is made and started on a remote server by one call, and from then on it
  lives wholly there. What follows is `[design]`, and none of it was run `[not verified]`.
  - *One call starts a run: the start call.* It carries the run's id, its name with the "named by the user"
    mark, the agent, the tiers, the folder, the settings, the set-up command among them, and the goal. Under a
    creation lock the server looks the run up by the id. If the run is started, the call does nothing. If
    there is no such run, the server makes it in the remote group with the caller's client mark, applies the
    values with today's checks and starts it; a refusal removes what the call made. Every answer says
    "started" or "not there". Today the server makes the id, and the start is a call of its own
    `[code: internal/runs/service.go:490, 788-797]`.
  - *Why it is safe to repeat:* the id; the creation lock; and the commit point of today's start, the run's
    `started` mark, which is written behind a lock per run and after which a second start is refused
    `[code: internal/runs/service.go:778-779, 793-797]`.
  - *The id* is made by the local server, in today's form: `r_` and 8 characters of 0-9a-z
    `[code: internal/runs/service.go:490, internal/model/model.go:27-41]`. The route checks that form, because
    the id becomes a folder name `[code: internal/store/paths.go:33]`. A start call with the id of a run that
    exists and does not carry the caller's client mark is refused with 409, as a clash of ids; every other run
    route takes any run's id.
  - *Why no draft is kept there.* A draft on the remote server would need that server reachable to be
    configured, and would leave drafts behind. A chat goes the same way: its creation with a given id, safe to
    repeat and leaving nothing after a refusal, ran in Go tests `[run: N07 S2]`.
  - *The draft check.* A read call: an agent and a folder in, the facts of that machine out, nothing written.
    The facts are those a draft's view carries today: a missing folder, git, uncommitted changes, and what
    blocks a start `[code: internal/runs/types.go:499-506]`. The start call checks again.
  - *The other run routes* of the named set ("Routes there") are today's handlers. They need a client id and
    no holder, and nothing new.
  - *Its events,* by the rule of "Clients, holders and events": `run` and `run_removed` go to the client whose
    mark the run carries, `run_detail` and `run_activity` to the clients that read its detail, and the events
    of a run agent's chat to the clients that follow that chat. The API snapshot holds the runs with the
    caller's mark.
  - *A chat on a run.* The chat's creation call may name a run. The server refuses a missing or an archived
    run `[code: internal/chats/owned.go:239-249]`, and such a chat records no defaults, as today
    `[code: internal/chats/manager.go:1243, 1401]`.
  - *No defaults.* A run with a client mark writes neither run defaults nor a folder into that server's
    defaults; today a start writes both `[code: internal/runs/service.go:884-898]`. The client records them
    itself, at the confirmed start, that is, when an answer of the start call says "started" ("Sticky
    defaults").
  - *With no client.* A run's engine drives its agents through calls inside the server, not over the API
    `[code: internal/runs/host.go:20-36]`, and its agents ask no permission
    `[code: internal/chats/owned.go:179]`. It follows that a run goes on while no client is connected. A
    server that is restarted halts its runs and continues them at its next start
    `[code: cmd/ai-whiteboard/main.go:223, 234-237]`.
  - *The result stays there.* "Apply" fast-forwards the run's folder on the remote machine
    `[code: internal/rungit/deliver.go:80-88]`, by default at the run's end
    `[code: internal/runs/deliver.go:24-30, 45-47]`, with no client connected. No route sends a repository or
    a file, so nothing comes to the user's machine `[user: Q27]`.
  - *What a run gives whoever holds the secret* is in section 6 `[user: Q28]`.
- **Identity and feature level.** Hello gains a stable instance id, kept in the data folder, and an integer
  feature level. Level 1 is what the first server release offers an API client: the remote listener, the chat
  routes and the run routes. Hello reports it from the phase that builds API clients; the run routes come with
  phase 8, before any server is released (section 7). On the remote listener hello is behind the secret like
  every route and leaves out the pid `[design]`. An API client states its own instance id as its client id on
  every request there `[design]`.
- **Usable agents, in every server.** The page's snapshot and the API snapshot gain the list of usable agents
  `[design]`. No server reports such a list today: the snapshot has no field for it
  `[code: internal/app/app.go:34-45]` (N03 S7). What follows is `[design]`, and none of it was run
  `[not verified]`.
  - *The look-up.* Of the agent programs the server was started with
    `[code: cmd/ai-whiteboard/main.go:102-105, 154-155]`, the usable ones are those found on `PATH`, the check
    a run's start makes today `[code: internal/runs/service.go:341-345]`. The server looks at its start, on a
    timer (section 9, U7) and at every refusal below. A change of the list goes to every client as a new list
    event, `agents`, which is on the API client's allow-list too.
  - *Refusals.* A server refuses an agent it lacks: at a chat's creation or configuration, as a draft run's
    agent, in the start call and at a first message. Today any of the three kinds passes
    `[code: internal/runs/service.go:457-459]`.
  - *The subagent tools.* "Offers only" is read to cover what a server offers its own agents: `spawn_subagent`
    and `list_subagent_models` name usable agents only, and a spawn of another is refused. Today their list is
    fixed `[code: internal/boardtools/tools.go:130-134, internal/boardapi/models.go:29-36]`.
  - *Where an agent is offered to the user:* in the agent choice of an unstarted chat, plain, on a board or on
    a run, and in a draft run's agent picker. Each lists the usable agents of the item's server. The empty
    state's "New chat" names no fixed agent (section 9, U9). An existing item keeps showing its own agent.
  - *A stored agent the server lacks* falls back to the first usable agent of the fixed order ("Sticky
    defaults"). Run defaults fall back the same way, with the tiers a new run of that agent gets
    `[code: internal/runs/service.go:691-698]`.
  - *No usable agent.* The chat or the draft run has no agent, the choice says why, and send and start are
    refused. "+" still works: the user may choose another server.
  - *An unreachable server* has no list, so no agent is shown. The stored value is kept and checked at the
    return.
  - *Installed is not logged in.* The look-up finds a program and does not start it. A program outside the
    server's `PATH` is found only after a restart with a `PATH` that has it (section 8).
- **Remote status.** A new loopback `GET` route gives what the running server does: off, or listening with the
  port, the names and the fingerprint of the certificate it serves. `remote status` reads it from a running
  server. From the files it says, always, one of three things: "not set up", "the next start will listen", or
  "the server will not start" with the message of the start's check. It never shows the secret. When the
  running server has no such route, as the server of an older build has none, the command reports from the
  files alone and says so `[design]`. A command reaches a running server only by hello and a stop signal today
  `[code: cmd/ai-whiteboard/main.go:222-230, 316-345]` (N01 S4). The route stays although no bind is left to
  report: only the running server knows whether it listens and which certificate it serves `[design]`.
- **Commands.** `remote setup`, `remote setup -new-cert`, `remote status`, `remote off`, `secret` and
  `secret -new` `[design]`, next to the four the binary has today `[code: cmd/ai-whiteboard/main.go:64-80]`.
  Each new command has its own flags `[design]`: today one flag set is parsed for every command, before the
  command is looked at `[code: cmd/ai-whiteboard/main.go:64-66, 96-108]`, and it knows neither `-new` nor a
  second word.

**In the server, as the local server**

- **Server list.** Kept in a file of its own, mode 0600, in the data folder, written atomically; not in
  `state.json`, which goes to the page `[design]`. An entry holds a name, an address (`https://host:port`),
  the secret, the "self-signed certificate" choice with its pin, and the server's instance id. The secret is
  there in clear, and no route returns it `[user: Q17]`. The **local entry** is first and can be neither
  edited nor removed, so there is always at least one server; a missing or empty file gives the local entry
  `[design]`. A file that cannot be read is set aside, and the server starts with the local entry only and
  says so `[design]`. The list's add, edit, remove and test routes are non-GET routes under `/api`, so the
  rule that a non-GET call names a known client covers them `[design]`. Today's rule with its header covers
  such routes `[code: internal/server/guard.go:41-53]` and keeps a page of another origin from the routes that
  create chats `[run: T09 Part A]`; the new rule keeps the header ("Clients, holders and events"). The list's
  `GET` returns no secret `[design]`.
- **Connection to a remote server.** One per entry. It connects with the pin or with normal verification,
  sends the secret and, as its client id, the local server's instance id, holds one event stream and
  reconnects it, puts time limits on calls and none on the stream, and keeps the entry's state (5.2)
  `[design]`. A Go program with the standard library connected with a pin, and with the server's certificate
  as its own root, sent the header and read the stream, with a ping after 20 s `[run: N01 S7]`. Reconnecting
  and the entry's state are `[design]`. The pin is checked at every handshake `[design]`.
- **Identity and level checks.** At every connect and reconnect the id decides "this is the local server",
  "already added as …" and "another server answers at this address". A level below the minimum is refused
  with "update the server on that machine" and no "connect anyway". Within a level, changes are additions only
  `[design]`. The id plays no part in `launch`, `relaunch` or `stop` `[design]`.
- **Chat records.**
  - *Before the first message* a chat is a chat of the local server, whatever server is chosen in it: a local
    chat object with its folder and token, as creation makes it today
    `[code: internal/chats/manager.go:783-796]`. When its first message starts it on a remote server, that
    folder and token are removed and a chat record takes the object's place, under the same id `[design]`.
    Not built `[not verified]`.
  - *The id.* A remote chat has one record on each side, with the same id. The local server makes it at "+"
    `[code: internal/chats/manager.go:783, 2032-2038]` and gives it to the remote server in the first-message
    call. A fork is the exception: the remote server makes its id
    `[code: internal/server/server.go:615-636]`, and the local record takes it from the answer `[design]`.
  - *What it holds:* the id, the entry, the place, the archived mark, a pending change if there is one, the
    last full chat view, the last state of every branch, and the draft of every branch. It holds no thread
    `[design]`. A name and a status are not enough: the page replaces a chat's view and each branch's state
    as a whole on every event `[code: web/src/store.ts:229-232, 275-278]`, and while a server is unreachable
    the sidebar still needs the creation time it sorts by, the fork source, usage and waiting approvals, all
    fields of the view
    `[code: internal/model/model.go:334-376, 379-394]`.
  - *No board record* is kept in this release; "Remote boards" says what one would hold `[user: Q23]`.
- **Passing on and relay.** For a remote chat the local server passes the page's call on to the chat's server
  with the secret and its client id, and returns the answer. It passes a record's list events on to all its
  pages and its content events to the pages that follow the chat, by the rule of "Clients, holders and
  events". An event for an id with no record is dropped and logged; a run agent's chat, which has no record,
  is the exception ("Passing on and relay for runs") `[design]`. The drop is a safety net now, since the
  remote server sends the local server only the list events of its own items and the content events of what it
  follows; it still happens for the first events of a fork and of a first message `[design]`. What the relay
  does besides `[design]`:
  - It follows a remote chat exactly while one of its pages does. The first page's follow is its read on the
    remote server; the end of the last page's follow is its unfollow there. After a reconnect it reads again
    what its pages follow.
  - In every chat view it hands to the page it sets the local group, the draft and the "has a draft" mark,
    and the archived mark only while a change is pending; in every branch state it sets that branch's draft.
    It does so in an event (`chat`, `branch_state`) and in an answer alike: reading a chat, the thread's
    state, the answer of a fork and of the first message. These live in the record, a relayed event or answer
    carries the remote server's values, and the page takes each event as the whole truth
    `[code: web/src/store.ts:229-232, 275-278]`. It takes the answers so too. The thread's answer carries
    the branch's state `[code: internal/server/server.go:558]`, the page stores that state whole
    `[code: web/src/conn.ts:200]`, and the composer's draft comes from it
    `[code: web/src/Composer.tsx:93, 135]`. After a refused send the page reads the chat and stores the
    view it gets whole
    `[code: web/src/Composer.tsx:289, web/src/conn.ts:253-256, 334-336, internal/server/server.go:533-540]`.
    It follows that, with answers passed on unchanged, opening a remote chat would wipe the draft shown and
    a refused send would take the chat out of its local group: the view names the group the chat has on the
    remote server, its remote group, which the local sidebar does not have.
  - The archived mark of a remote chat is the remote server's (5.2). The local server takes it into the
    record from every view of the chat, in an event, in an answer and in the API snapshot, and hands it on
    as it came unless a change is pending. A mark taken so belongs to no local group archive: it has no
    local operation id, so the unarchive of a local group does not bring the item back, and the user
    unarchives the item itself.
  - A `chat_removed` from the remote server is not passed on. The page would forget the chat and drop its
    later events `[code: web/src/conn.ts:54, 115]` while the record still exists. The record is marked "gone
    there" instead (5.4).
  - It clears a branch's draft when a send on that branch is accepted, as a server does for its own chats
    today `[code: internal/model/model.go:294-295]`.
  - It refuses send and configure for an archived record itself.
  - After a fork it reads the new chat once from the remote server, because the fork's first list events
    arrive before its record exists and are dropped.
  - After a first message it does the same, for the same reason. The remote server sends the user's item and
    the chat's new state before the call returns `[code: internal/chats/manager.go:1304-1308, 1320]`, while
    the local chat is not yet a record and the local server does not follow it yet. So the item is not sent to
    it, and the relay drops the state. The page adds no sent message itself: it shows what `chat_items` events
    bring `[code: web/src/Composer.tsx:267-276, web/src/conn.ts:57]`, and it applies later events past a gap
    `[code: web/src/logic/threads.ts:16-20]`. So whenever the outcome of a first-message call is settled (by
    its answer, by a repeat, or by the read after a reconnect or a time-out) and the local chat becomes a
    record, the local server reads the chat once from the remote server and has the page load its thread
    again, as after a fork `[design]`. Not run `[not verified]`. A send returns only after the agent's
    handshake, for which pi allows 30 s `[code: internal/pi/pi.go:47, 270-278, 449-453]` and on which Cursor's
    send waits too `[code: internal/cursor/cursor.go:320-321]`. It follows that, for an agent whose start
    waits for a handshake, the user's own message appears in the thread only when the call answers.

  That the page shows a live remote thread through this relay has not been run `[not verified]`.
- **Run records.** What follows is `[design]`, and it is not built `[not verified]`.
  - *Before the start* a run is a draft run of the local server, whatever server is chosen in it. It is made
    as today `[code: internal/runs/service.go:480-527]`, now with a server (5.8). At a confirmed start on a
    remote server the local draft's folder is removed and a run record takes its place, under the same id.
  - *What it holds:* the id, the entry, the place, the archived mark, a pending change if there is one, and
    the last full run view, which the sidebar row needs while the server is away
    `[code: internal/model/run.go:227-262]`. It holds no journal and no detail.
  - *What the local server sets.* In every run view it hands to the page, in an event or in an answer, it sets
    the local group, and the archived mark only while a change is pending. Otherwise the archived mark is the
    remote server's, taken into the record from every view of the run, as for a chat ("Passing on and relay").
    A started run has no goal draft `[code: internal/runs/service.go:877]`, so nothing else is rewritten.
  - *Chats the user makes on a remote run* have chat records, with the run as their place. They are archived
    and brought back with the run on the remote server, and their records take the mark from there (5.2). A
    run agent's chat has none (below).
- **Passing on and relay for runs.** What follows is `[design]`, and none of it was run `[not verified]`.
  - *Passing on.* For a remote run the local server passes the page's calls on to the run's server, with the
    secret and its client id, and returns the answer (5.2, the run table).
  - *Events.* The local server gets `run` and `run_removed` for the runs that carry its client mark, and
    passes a record's `run` on to all its pages. It gets `run_detail` and `run_activity` while it follows the
    run, and passes them to the pages that follow it. It follows a remote run exactly while one of its pages
    does: the first page's read of the detail is its read on the remote server, and the end of the last page's
    follow is its unfollow there.
  - *A run agent's chat* has no record on the local server. A run's detail names each agent's chat
    `[code: internal/model/run.go:277-278]`, and from the details it passed on the local server knows which
    server such a chat is on. It passes the page's read of the transcript on, which is the follow there, and
    relays the chat's events to the pages that follow it. The page unfollows a run agent's thread when it
    drops it (section 9, U6); when the last page has, the local server unfollows there. Otherwise it would
    follow every agent that was ever opened.
  - *A `run_removed`* from the remote server is not passed on: the record is marked "gone there", as for a
    chat (5.4).
  - *Archive, delete, outage and return* are in 5.2 and 5.4.
- **"Server back".** A new event from the local server to its pages, for one entry. It is sent when the entry
  is connected again after an outage, and so also after the remote server was restarted `[design]`. The page
  needs it because a thread's version is a counter in memory that starts again at a restart
  `[code: internal/transcript/transcript.go:25, 569, 575]`; what the page does with it is under "In the web
  client".
- **Lists by server.** For a connected remote server the local server keeps, in memory only, its catalogs, its
  usable agents, its home and its default folder, read from that server's API snapshot and from its `catalog`
  and `agents` events. It sends them to its pages per entry: in the page's snapshot, and in a new event when
  they change `[design]`. Folder listings and plan usage for a chat, a run or a draft run of that server are
  asked of that server: the local server's `GET /api/dirs` and `GET /api/usage/{agent}` take the entry
  `[design]`. All of them are facts of one machine `[code: internal/server/server.go:771-806]` (N03
  S7).
- **"+" and configure.** Creation takes only the place; the configure route takes server and agent as well
  (5.3) `[design]`. For a remote server, resolving the defaults and configuring skip every check against the
  local machine `[design]`. Today a stored folder that the local disk lacks is replaced by the default folder
  `[code: internal/defaults/defaults.go:21-24]`, and configure expands `~` with the local home, looks at the
  local disk and checks the model against the local catalog
  `[code: internal/chats/manager.go:1367-1385, 1483-1497]`. It follows that, unchanged, a remote folder
  would be replaced without a word and a remote model refused. For a remote server the folder is checked
  with that server's folder listing, the model against that server's catalog in memory, and the agent
  against its usable agents `[design]`. Not built `[not verified]`.

  A draft run is configured in the same way `[design]`. Its server is a value of the draft. A new server sets
  agent, tiers, folder, limits and set-up command from the place's run defaults for that server. For a remote
  server the local server skips its own checks of folder and model `[design]`; today a draft's configuration
  makes both `[code: internal/runs/service.go:700-713]`. It uses that server's usable agents, catalog, folder
  listing and home. The facts of the machine in a draft's view come from the draft check there. The local
  server asks it when it answers a change of the draft `[design]`, and when the page refreshes the draft: on
  opening and when the window gets the focus `[code: web/src/run/actions.ts:7-21]`. Not built
  `[not verified]`.
- **Sticky defaults.** Today a group's entry holds a folder, a model and effort per agent, and run defaults
  `[code: internal/model/model.go:108-117]`; there is no agent and nothing per server. It becomes `[design]`:
  - *Per group:* the **server**; and **per server** the **agent**, the **folder**, **model and effort per
    agent**, and the **run defaults**: agent, limits, set-up command with its folder, and tiers
    `[code: internal/model/run.go:180-190]`. Run defaults move into the per-server part because all of them
    but the limits are valid on one machine only `[design]`.
  - *The server* is one value per group, read at "New run" and at "+" alike. A chat records it at its first
    message and a run at its confirmed start `[design]`.
  - *The key of the per-server part:* a fixed word for the local entry, and the instance id for a remote
    one. So an entry that is removed and added again finds its defaults, and a new name or address of an
    entry changes nothing. A removed entry's part is kept `[design]`.
  - *One shape, from the start.* The phase that ends `Last` already writes this shape, run defaults included,
    with the local server as the only key, so that the state file and the page's types change once (section 7)
    `[design]`. The prototype ran the flat shape of today with an agent added, not the per-server one
    `[not verified]`.
  - *Which group:* unchanged. A chat's own group; a board's group; a run's group `[design]`.
  - *Recorded* at the moments of today `[code: internal/chats/manager.go:1242-1246, 1401-1403]` (N03 S4), now
    with server and agent: the changed value at each change in an unstarted chat, all five at the first
    message, nothing at "+", nothing for a chat on a run, and nothing at a fork's first message `[design]`. In
    Go tests a second "+" in a group, before any message, already started with the first chat's changed
    agent, folder, model and effort, and agents passed through on the way left no model entry
    `[run: N07 S4]`. A run's start writes the group's folder and run defaults today
    `[code: internal/runs/service.go:884-898]`; in the new shape both go to the part of the run's server,
    beside the sticky server, and a remote run writes them on the local server only, at its confirmed start
    `[design]`.
  - *On a board* the server is the local one whatever the group's sticky server says, in this release
    `[user: Q23]`; the chat's other values come from the local server's part `[design]`. *On a run* the server
    is the run's, the folder comes from the run, and model and effort from the run's deep tier or, for another
    agent, from the defaults of the run's group for that server and agent (5.3) `[design]`. Neither chat reads
    or records the sticky server `[design]`.
  - *With nothing stored:* the local server; the first agent of the fixed order claude, cursor, pi
    `[code: web/src/types.ts:13]` that the server can run; that server's default folder; the catalog's
    default model. A stored server that is gone, or a stored agent the server cannot run, falls back the same
    way, and so do run defaults whose agent the server lacks. A server with no usable agent gives none
    ("Usable agents") `[design]`.
  - *The end of `Defaults.Last`.* Its two writers stop
    `[code: internal/defaults/defaults.go:61, internal/runs/service.go:895]`, and each of its four readers
    gets the ungrouped group in its place. Folder: the group's, then the ungrouped group's for that server,
    then the server's default folder. Model and effort: the group's, then the ungrouped group's for that
    server and agent, then the catalog's default. Agent: the group's, then the ungrouped group's, then the
    order above. Run defaults: the group's for that server, then the ungrouped group's for that server, then
    the built-in ones `[design]`.
    With the field removed and each reader on the ungrouped group, the Go tests of the seven packages that
    touch the defaults passed `[run: N07 S3, S5]`.
  - *A new group, and a group without a value.* A new top-level group is a copy of the ungrouped group's whole
    entry, the run defaults included, where today it is a copy of `last` without the run defaults
    `[code: internal/defaults/defaults.go:64-81]`. A subgroup is a copy of its parent's entry `[user: Q21]`, as
    today `[code: internal/defaults/defaults.go:64-75]`. A seeded group is a copy: a later change in the
    ungrouped group does not reach it. A group that has no value of its own is different: it takes the ungrouped
    group's values live, through the fallback, until it gets its own. Both are true at once, and the user will
    see both `[run: N07 S3]`.
  - *Migration,* once, when the state is loaded: `last` fills what the ungrouped group's entry lacks and is
    then dropped, and the file is written at that load, so that the disk holds what runs `[design]`. A Go
    test loaded an old file so: the ungrouped group kept its own values and took the missing ones
    `[run: N07 S3]`. That prototype wrote the file only at the next save; the plan does not adopt that, and
    the write at the load was not run `[not verified]`.
    Without the merge the values would vanish at the next write, since the store's loading is not strict and
    a field the program no longer knows is dropped `[code: internal/store/store.go:63-88]`. An old `last`
    holds no agent `[code: internal/model/model.go:108-117]`, so after the upgrade "+" starts with the first
    usable agent of the fixed order, Claude where it is installed, until an agent is chosen `[design]`.

**In the web client**

- **"+".** No agent items in the seven places that make a chat today: six menus with the three agents and one
  button with a fixed agent `[code: web/src/Sidebar.tsx:252-260, 497-503, 563-565, 626-628,
  web/src/App.tsx:162-168, 182, web/src/run/RunBar.tsx:51-56]`. Forks, branches, subagents and a run's agents
  take their agent from what exists, as today `[design]`.
- **The choices in the chat.** Server and agent join folder, model and effort in the composer. The lists are
  those of the chat's server; the agent list is that server's usable agents, and says why when it is empty.
  The choices of server and agent are open in an unstarted chat, that is, one with no message that is neither
  a fork nor a branch: the condition the server checks (5.3) `[design]`. The page reads no defaults for this;
  every value arrives in the chat the server answers with `[design]`. The `last` field leaves the page's types
  and its initial state `[code: web/src/types.ts:59, web/src/store.ts:83, 133]`.
- **The draft run's composer** gains the server choice, with the entries and their state (5.8) `[design]`. Its
  agent picker lists the chosen server's usable agents; today it lists the three kinds
  `[code: web/src/run/RunComposer.tsx:165-168]`. Tiers, folder and the facts of the machine are that server's.
  With no usable agent, or with the server unreachable, the draft says why and cannot be started `[design]`.
  Not built `[not verified]`.
- **Remote chats and runs in the sidebar.** Drawn like any chat or run in its group, with the server's name on
  the row and a mark while that server is not connected `[design]`.
- **Servers dialog.** Opened from the foot of the sidebar and from the server choice of a chat or a draft
  run. It lists the entries with state, version, fingerprint and usable agents, and holds add, edit, remove
  and "Test connection" (5.1) `[design]`. It is in the web client so that browser-only use has it too
  `[design]`.
- **"Server back".** On that event the page drops what it kept for that entry's chats (items, subagent lists,
  trees and branch states) and for its runs (details and agents' threads), and loads the chat or the run on
  screen again, taking the answer whatever its version `[design]`. Nothing in the page does this today:
  - It loads again only on a `snapshot` event, which drops the threads, lists and trees of every chat
    `[code: web/src/conn.ts:41, 70-90, web/src/store.ts:130-141]`.
  - It keeps the thread of every chat opened since the last snapshot, not only the one on screen
    `[code: web/src/conn.ts:105-109]`.
  - It drops an event whose version is not above the kept one, and a fetch without "replace" keeps the older
    thread `[code: web/src/logic/threads.ts:16-28]`.

  It follows that, with the page unchanged, every kept thread of a restarted remote server would ignore new
  items until the page reloads. `refreshChat` is the existing piece to build on
  `[code: web/src/conn.ts:334-341]`. Not built `[not verified]`.
- **Lists by server in the page.** The snapshot and a new event carry catalogs, usable agents, home and
  default folder per entry, and every place that reads one of them reads it through the chat's or the run's
  server `[design]`. Today each reads the page's own server:
  - the catalog, looked up by agent alone `[code: web/src/Composer.tsx:388, 442, web/src/Sidebar.tsx:645,
    web/src/Subagents.tsx:84, web/src/fork/actions.ts:252, web/src/fork/TreePopup.tsx:53]` and stored by
    agent alone `[code: web/src/conn.ts:61]`, so a relayed `catalog` event must not be stored as it comes;
  - the one home that stands for `~`
    `[code: web/src/Composer.tsx:50, 654, 686-689, web/src/ChatView.tsx:88]`;
  - the default folder `[code: web/src/Composer.tsx:661]`;
  - the folder listing and plan usage, whose calls name no chat and no server
    `[code: web/src/api.ts:147, 149]`, with a usage cache by agent alone
    `[code: web/src/Composer.tsx:776]`.

  Not built `[not verified]`.
- **The role per board in the page** ("Clients, holders and events") `[design]`. The page keeps a role per
  board in place of one for the server. It takes a board on the user's action on it, and takes it only if free
  at page load, after a reconnect and for an agent's `show_board`. On a hand-off it flushes the pending save
  of that one board. On a grant it keeps its cached scene only at the granted revision, and reads the scene
  again otherwise. Every save names the revision it is based on. A board it lost, and a board on screen that
  it could not take because another client holds it, shows the take-over panel in place of that board's
  canvas, with "Use here"; the sidebar, the chats and the other boards go on. Today the
  take-over screen replaces the whole window `[code: web/src/App.tsx:40]`. Not built `[not verified]`.
- **The composer and drafts** `[design]`. A draft save names the counter it is based on. When a save is
  refused as stale, or a newer draft arrives, the composer shows the server's draft if the user typed nothing
  since its last save, and keeps the user's text otherwise. Today it takes no draft from the server while it
  is open `[code: web/src/Composer.tsx:179-184]`. Not built `[not verified]`.
- **A chat whose thread cannot load** shows "server unreachable" in place of the thread `[design]`; today a
  failed load is only logged `[code: web/src/conn.ts:185-191]`. A remote run whose detail cannot load shows
  the same in place of the detail `[design]`.
- **Recent folders** become one list per server `[design]`; today they are one list in the browser's storage
  `[code: web/src/Composer.tsx:48-49]`.

**Remote boards (designed, not built)**

A board on a remote server is designed here and is not built in this release `[user: Q23]`. The user's words
are "This makes remote boards possible", while a run on a remote server is asked for outright (section 1).
What this part states is `[design]`. Nothing of it was run; Q23 names what building it adds and the risks it
brings `[user: Q23]`.

- **What is built anyway.** The role per board, for every kind of client: nothing in "Clients, holders and
  events" ties a hold to a page or to the loopback listener. In this release the remote listener serves no
  board route, so the holders of a board are pages of the board's own server.
- **The server of a board** is chosen at "+", in the board item. The default is the local server, and the
  choice is not sticky. A board has no unstarted state, so it is made on its server at once.
- **Creation** is one repeatable call with an id the local server makes `[design]`, as for a chat, whose
  creation with a given id ran in Go tests `[run: N07 S2]`. Ids are then unique on the local server, and the
  page's scene cache keeps its bare keys `[code: web/src/board.ts:20]`.
- **A board record** on the local server holds the id, the entry, the local group, the archived mark and the
  last board view. It holds no scene.
- **The chain of holds.** The local server holds a board on the remote server exactly while one of its pages
  holds it locally. A page's take is passed on. `release_request`, `superseded`, `held` and `rpc` arrive on
  the local server's stream and go to that page, and the page's reply goes back the same way.
- **The scene** travels whole through the local server `[design]`; a scene holds its images
  `[code: web/src/Canvas.tsx:70-72]`. The remote server guards it by holder and scene revision.
- **Tool calls.** The remote server's wait for the reply, 30 s, is the one wait; the local server's limit for
  the passed-on call is shorter (N04 S3).
- **The board's chats** are on the board's server. An API client may then create a chat on a board, which this
  release refuses.
- **Events and snapshot.** `board` and `board_removed` go on the API client's allow-list, and reach it for the
  boards that carry its client mark; the API snapshot gains those boards. A board an agent makes with
  `create_board` takes the group and the client mark of the calling chat's board.
- **Where it sits there.** A board made by an API client sits in that server's remote group, with its chats
  ("The remote group").
- **An outage** ends the local server's holds on that server. The canvas stays editable and is marked "not
  saved". At the return the scene revision decides whether the pending edit is saved or dropped with a notice.
- **In the page:** the server's name on the board's row, an "unreachable" view of a board, and no reveal,
  which shows a file on the server's own machine `[code: internal/boards/boards.go:287-292]`.

**Desktop shell.** No code change. Its bundle gains one script `[design]`.

**Scripts and packaging** `[design]`

- **`scripts/remote/setup-remote.sh`.** Finds the server binary in its own folder or in the app bundle. Asks
  nothing: one machine has several names and addresses, and no script can know which one a client will use
  `[run: N05 S5]`, so set-up takes them all. Calls `remote setup`, passing `--name` on. Prints the names with
  the port, the fingerprint, the secret and how to restart; on macOS, that the firewall can block the server.
  Run again, it changes nothing and prints the same; `--new-cert` and `--new-secret` replace, through
  `remote setup -new-cert` and `secret -new`. It needs no `openssl`: only LibreSSL 3.3.6 was run, and OpenSSL
  3 on Linux was not `[run: N05 S4]`.
- **`scripts/remote/start-server.sh`.** Runs `launch` with the absolute path of the web client's folder. The
  relative default fails without a message when the server is started from another folder `[run: T07 R1]`.
- **`scripts/build-app.sh`.** Unchanged in its steps. One more `extraResources` entry puts `setup-remote.sh`
  into `Contents/Resources/remote/`, outside `app.asar`, next to where the web client already goes
  `[code: desktop/electron-builder.yml:20-24]`. Whether the copy keeps its executable bit was not run
  `[not verified]`, so the README calls it through `sh`.
- **`scripts/build-server.sh`** (new). Builds the web client and the server for one target, by default the
  host's, with the one version stamp, into `bin/ai-whiteboard-server-<os>-<arch>/`: the binary, `web/`,
  `setup-remote.sh`, `start-server.sh` and a README. macOS and Linux on amd64 and arm64 all compile, without
  cgo `[run: N05 S3]`. No installer and no service file.
- **README.** The build and install sections, the command table, and a new section "Use a server on another
  machine" `[code: README.md:136, 157, 164]`. The app never installs or starts a remote server.

**Data and where it lives**

| Where | What `[design]` |
|---|---|
| The remote server's data folder | The remote configuration (port, names); the secret and the key, mode 0600; the certificate; the instance id; the remote chats and runs themselves, in its remote group, each marked with the id of the client that made it; the remote group's id |
| The local server's data folder | The server list with secrets and pins, in its own 0600 file, never sent to the page; the chat records, each with its last chat view, branch states and drafts; the run records, each with its last run view; draft runs, each with its server; the sticky defaults in `state.json`, per server, run defaults among them, and without `last` |
| The local server's memory | A connected remote server's catalogs, usable agents, home and default folder; each entry's state; which of its pages follow which remote chat or run; which server each agent's chat of a followed remote run is on |
| Every server's data folder | With every board's scene its scene revision; with every draft its counter |
| Every server's memory | A record per connected client: its stream, kind and id, the boards it holds or waits for, the items it follows, its open tool calls. Nothing of it outlasts the stream |

## 5. Flows

### 5.1 Adding a server

- **On the other machine** `[design]`:
  1. Get the server there: `scripts/build-server.sh <os> <arch>` on a machine with the repository, then copy
     the folder; or use the app installed on that machine, whose bundle holds the same set-up script.
  2. Run `setup-remote.sh`. It prints the names with the port; `--name` adds a DNS name.
  3. Start the server with `start-server.sh`. A server that already runs takes the set-up at its next start;
     the owner restarts it when no turn is running.
  4. The script has printed the names with the port, the fingerprint and the secret.
- **In the client** `[design]`:
  1. Servers, Add: a name, the address (`https://host:port`), the secret, the "self-signed certificate" box.
  2. "Test connection" (the table below).
  3. With the box on, the fingerprint is shown; the user compares it with the one from the other machine and
     accepts it.
  4. Save. The entry connects (5.2) and shows the server's version and its usable agents.
- **Rules** `[design]`:
  - Add and edit save after a successful test, or with an explicit "save anyway".
  - The local server runs the test, with a limit of 5 s per step.
  - The secret is sent from step 4 on, and only after the certificate was accepted. An entry saved with the
    box on and no accepted fingerprint has the state "fingerprint not accepted" (5.2): the local server sends
    it no request, and so no secret, until the user accepts a fingerprint.
  - Text that comes from the other server is shown as plain text.

| Step | What the local server observes | Message to the user `[design]` |
|---|---|---|
| 1 Address | Not of the form `https://host:port` `[design]` | Not a valid https address |
| 2 Connect | The connection is refused `[run: N01 S7]` | Nothing listens there: is remote access set up on that machine? |
| 2 Connect | The name does not resolve, or there is no route or no answer to the dial; neither was run with the Go program that N01 used as the client `[not verified]` | Name not found; or: no answer, is the VPN up? |
| 3 TLS | The port accepts and never answers: the handshake ended at its time limit `[run: N01 S7]` | No answer: is the VPN up, and does a firewall on the server's machine let the port through? |
| 3 TLS | The port answers in plain HTTP `[run: N01 S7]` | Not HTTPS: this may be the server's local port |
| 3 TLS | Box on, no pin yet: the certificate is read in a handshake that sends no request `[design]` | The fingerprint, to compare and accept |
| 3 TLS | Box on, and the certificate is not the pinned one: the client refused it with both fingerprints `[run: N01 S7]`. It follows that the request is not sent (N02 S2) | Certificate changed, with both fingerprints |
| 3 TLS | Box off: the certificate is not for this name, or expired. Go reported each with its own text, in a run with the server's certificate as its own root `[run: N01 S7]` | One text for each |
| 3 TLS | Box off: the certificate is self-signed. Verification against the system's roots, and a text of its own for this case, were not run `[not verified]` | Self-signed certificate: tick the box |
| 4 Hello | 401 `[run: N01 S5]` | Secret not accepted |
| 4 Hello | 403 "bad host": the name used is not in that server's list `[run: N01 S7]` | The server does not know this name: run set-up there with it |
| 4 Hello | 200, but not an AI Whiteboard hello `[design, for N02 S6]` | Something else answers there |
| 4 Hello | The feature level is too low or missing `[design]` | Server too old: update it on that machine |
| 4 Hello | The id is the local server's, or another entry's `[design]` | This is the local server; or: already added as … |
| 4 Hello | All good: the version, the id and the level are read `[design]` | (goes on to step 5) |
| 5 Snapshot | The state route there answers with the API snapshot, which holds the usable agents `[design]` | Connected, with the version and the usable agents |
| 5 Snapshot | No snapshot, or one without the expected parts `[design]` | Connected, but the server's state could not be read |

### 5.2 Connecting, and following a remote chat

- **Trigger:** the local server starts; an entry is saved; a retry after an outage. No action of the user is
  needed, nothing depends on the page being open, and connecting takes nothing from any client of that server
  `[user: Q13]`.
- **Steps** `[design]`, per entry: TLS with the pin or with normal verification; hello with the secret and the
  client id; the identity and level checks; open the event stream and take the API snapshot it begins with,
  for catalogs, usable agents, home, default folder and its own chats and runs there, of which it uses those
  it has a record for.
- **Why the stream comes first.** There is no separate read of the state before the stream `[design]`. A
  server sends nothing to a client that is not connected `[code: internal/editorbridge/bridge.go:189-200]`,
  so events between such a read and the opening of the stream would be lost. A snapshot on the stream is sent
  under the bridge's lock, as the page's is today `[code: internal/editorbridge/bridge.go:93-102]`.
- **Entry states** `[design]`, held by the local server and sent to its pages:

| State | Meaning `[design]` | Next `[design]` |
|---|---|---|
| connecting | A first attempt is running | |
| connected | The stream is open | |
| unreachable | No connection, or the stream ended | Retried with back-off, without end |
| secret not accepted | 401 | Waits for an edit or a test |
| fingerprint not accepted | Box on, and no fingerprint was accepted yet | Sends nothing; waits for the user to accept one |
| certificate changed | The pin refused the certificate | Waits for the user to accept or leave it (5.6) |
| certificate not accepted | Box off, and verification failed: not trusted, expired, or not for this name. Shown with Go's text | Retried with back-off, since the cure may be on the other machine; an edit or a test at any time |
| name not known there | 403 "bad host" | Waits for an edit, or for a test after set-up there |
| not an AI Whiteboard server | Something else answers at the address | Waits for an edit |
| too old | Level below the minimum | Waits for a test after the update |
| another server | Another id answers at the address | Waits for an edit |

- **Following** `[design]`: the remote server sends the local server the list events of its own chats and runs
  and the content events of those it follows. The local server follows a chat or a run exactly while one of
  its pages does, and hands the events on with the local place and the local drafts: list events to all its
  pages, content events to the pages that follow the item (section 4). Opening a remote chat loads its items
  through the local server, and that read is the follow; for a remote run it is the read of its detail. The
  remote server's own page, if one is open, loses nothing, and shows the item in its remote group.
- **What each action on a remote chat does** `[design]`:

| Action | Where it happens `[design]` |
|---|---|
| Move between groups | Local only: the record's place. Nothing is sent to the remote server |
| Archive, unarchive | Recorded locally and passed on to the chat's server. There, archiving also stops the chat's agent and no message is accepted from then on, as for a local chat `[code: internal/app/app.go:325-332]`. The local server itself refuses send and configure for an archived record. The archived mark of a remote chat is the remote server's: the record keeps the last mark it received, and the local server takes it into the record from every view of the chat, in an event, in an answer and in the API snapshot. An archive or unarchive by the user is a pending change until the remote server has confirmed it. With the server unreachable the pending change shows at once and is passed on at the next connect. A pending change wins over the mark in the API snapshot; once passed on it is no longer pending. Nothing else is passed on at a connect. So an archive or unarchive made on the remote server's own page shows in the client's sidebar and survives a connect, and a second client's connect undoes nothing `[design]`. Not built `[not verified]` |
| Rename | Passed on, as a name given by the user. Before the first message it is local, and the name travels in the first-message call |
| Send, stop, permission answer, label, open; reading the items, the tree, the context split and a subagent's items | Passed on to the chat's server |
| Configure | Before the first message: local only (5.3); nothing of the chat is on the remote server, apart from what a failed first message left there (5.3). After it: passed on, and only today's two exceptions are accepted |
| Draft | Kept in the record, per branch, on the local server |
| Delete | Passed on; the record goes when the server confirms. When the server is unreachable or no longer has the chat, "remove from this sidebar only" is offered |
| Delete of a group with its contents | First the local server checks that every remote chat and run in the group can be deleted, that is, that its server is connected. If one cannot, nothing is deleted and the reason names the server. Otherwise the remote chats and runs are deleted on their servers with the rest. Without the check the delete would stop half-way: today it goes through the group's boards and chats one by one and returns at the first error `[code: internal/app/app.go:646-680]`. Not built `[not verified]` |
| Fork | Passed on. The new chat stays on the same server, because the source's agent session is on that machine `[code: internal/agent/agent.go:86-116]` (N04 S2). Its id is made there; the local server takes it from the answer, makes a record in the same local group and reads the new chat once, since its first events came before the record. "Fork and edit" leaves the message as the new chat's draft on the remote server `[code: internal/server/server.go:612-614]`; the local server copies it from the answer into the record |
| Branches | The same routes with their branch parameter |
| Subagents, the automatic name | They run on the remote server, where the name is made after the first message unless the chat was named by the user `[code: internal/chats/manager.go:1309-1319]`, and reach the page as relayed events |

- **What each action on a remote run does** `[design]`:

| Action | Where it happens `[design]` |
|---|---|
| Move between groups | Local only: the record's place. Nothing is sent to the remote server |
| Rename, stop, resume, apply; reading the detail, the goal, a brief, a report, changes, notes and the delivery preview | Passed on to the run's server |
| Reading an agent's transcript | Passed on to the run's server, which the local server knows from the run's detail (section 4). The read is the follow of that agent's chat |
| Archive, unarchive | As for a chat: the archived mark is the remote server's, and the user's archive or unarchive is recorded locally and passed on, as a pending change until that server has confirmed it. There a live run is stopped first, for which the call waits up to 30 s, and the chats people have on the run are archived with it and brought back with it `[code: internal/runs/service.go:55-56, 1039-1043, 1086-1088]`. The records of those chats take the mark from that server's `chat` list events and from the API snapshot, since the chats carry the client mark; the local server passes nothing on for them `[design]`. The passed-on call has a longer time limit for that (section 9, U8) |
| Delete | Passed on; the records of the run and of the chats on it go when the server confirms. When the server is unreachable or no longer has the run, "remove from this sidebar only" is offered |
| Delete of a group with its contents | The check of the chat table covers the group's remote runs: with the server of one of them not connected, nothing is deleted |
| "+" on the run | A local unstarted chat whose server is the run's; its first message is the creation call, naming the run (5.3) |
| The draft: its choices and its goal | Local only, until the start (5.8) |

The actions on a remote run were not run `[not verified]`.

### 5.3 Starting a chat

- **"+"** `[design]`. In a place it offers what it offers today without the agents: chat, board and run, and
  a group where it does now. The local server makes the chat with the place's defaults (section 4), so all
  five values are set. The chat opens with the five choices and an empty thread. Nothing is made on a remote
  server before the first message, so "+" works while that server is unreachable. A run chosen at "+" is a
  draft run, made on the local server in the same way (5.8).
- **Why the agent is always set.** Today creation refuses an empty agent
  `[code: internal/chats/manager.go:764-766]` and looks the model and effort up for the agent it is given
  `[code: internal/chats/manager.go:781]`; so creation without an agent fills in the place's sticky agent
  `[design]`. The one chat without an agent is a chat whose server has no usable agent: it says why, and a
  send is refused (section 4, "Usable agents") `[design]`. Before the first message nothing exists per agent
  but the model, the effort and a session id: no process is started
  `[code: internal/chats/manager.go:762, 791-793]`. A draft run already works this way
  `[code: internal/runs/service.go:691-698]`.
- **The agent change was run,** in Go tests with stand-in agents: a chat created with no agent, with
  nothing stored, got the fallback, Claude, and a second "+" in a group took the agent recorded there; the
  first chat was changed to Cursor and then to pi, each time with that agent's model and effort; no agent
  was started before the message; the message started pi alone, once, with its model, effort and a session id
  of its own; after it a change of agent answered 409 `[run: N07 S1, S4]`. With a real agent CLI this was
  not run `[not verified]`.
- **Choosing** `[design]`. Each change is one call of the existing configure route; the local server sets the
  values that depend on it again and answers with the chat.
  1. *Server:* the entries with their state. A new server sets agent, folder, model and effort from the
     group's defaults for that server.
  2. *Agent:* the chosen server's usable agents, and no other. A new agent sets model and effort, and clears
     the error a failed first start left on the chat `[design]`; the prototype's agent change did both in Go
     tests `[run: N07 S1]`.
  3. *Folder:* that server's folders. *Model and effort:* that server's catalog for the agent.
  4. Each change is recorded as the place's default (section 4).
  5. While the chosen server is not connected its lists are not there and no agent is shown; the chat says
     why, another server can be chosen, and a send is refused with the text kept.
- **The first message.** On the local server: as today. On a remote server `[design]`:
  1. The local server makes one call to the remote server. It carries the chat's id, its values, its name,
     with the "named by the user" mark as it stands, and the message. The remote server finds or makes the
     chat by the id; it applies the values and sends the message if the chat is unstarted there, and sends
     nothing if the chat is already started. Every answer, an error too, carries the chat's state, started or
     unstarted (section 4). The call's time limit covers an agent's start, which waits for the handshake,
     for pi up to 30 s `[code: internal/pi/pi.go:47, 270-278]`; it is not the short limit of the other calls
     passed on (section 9, U3).
  2. Whenever an answer says "started", the local chat becomes a chat record, all five values are locked,
     and the defaults are recorded. The local server then reads the chat once from the remote server and has
     the page load its thread again (section 4, "Passing on and relay").
  3. Events arrive through the relay (5.2).
- **When that fails** `[design]`. The local server takes "started" or "unstarted" from the state in the
  answer, whatever else the answer says.
  - *Refused before the agent started:* the folder is missing there, that server lacks the agent or could not
    start its program, a loaded catalog does not know the model, or a limit on running chats is reached. The
    chat is unstarted on both sides, with the reason shown and the text kept. The user can change folder,
    model or agent and send again: the call finds the unstarted chat there, if the failed start left one, and
    applies the new values.
  - *The agent started and then refused the message:* its handshake failed, for example on a model its
    program does not know while its catalog had not loaded (section 4). The chat is started on both sides.
    On the remote server it is locked, with the message in its thread as a turn that failed, as a local chat
    is today `[code: internal/chats/manager.go:1176-1177, 1247]`. The local chat becomes a chat record,
    locked, and shows that failed turn. Its server and agent are fixed, and configure is passed on, where
    only today's two exceptions are accepted (5.2); the user can send again or delete the chat.
  - *No answer:* the call was cut or ran into its time limit. The chat is "start not confirmed": the text is
    kept, and server and agent cannot be changed. A repeat of the send is safe: if the first call did start
    the chat, the repeat sends nothing and the local chat takes "started" from the answer. Without a repeat,
    the local server reads the chat there and takes "started" or "unstarted" from it: at once after a
    time-out while the entry is still connected, without waiting for a reconnect, and after the reconnect
    otherwise.
  - *A change of server* in an unstarted chat that a failed start left on a remote server: the local server
    deletes it there. Deleting a local chat that is unstarted after a failed first message, or "start not
    confirmed", also deletes the chat on that server when it is connected. When that server cannot be
    reached, or its entry is removed while the chat is in that state, what is there stays; after a start
    that was not confirmed it may be a started chat with its agent running (section 8).

  None of this was run `[not verified]`. What was run is the half it rests on: find-or-make by id, repeatable,
  starting nothing twice `[run: N07 S2]`.
- **The lock.** Set by the first message that gets as far as the agent, also one the agent then refuses (the
  second failure path above), as today `[code: internal/chats/manager.go:1247, 1320-1324]`. Server and agent
  can be changed in an unstarted chat that is neither a fork nor a branch, and nowhere else; a change is
  refused with 409 `[design]`. "Not locked" alone is not the condition: a fork at its start is not locked
  `[code: internal/chats/fork.go:270-280]`, yet its agent and server are its source's. With the condition
  worded so, an agent change in such a fork was refused while its model could still be changed
  `[run: N07 S1]`. Folder, model and effort keep today's two exceptions: the folder of a started chat whose
  folder is missing, and the model and effort of a fork that has had no message of its own
  `[code: internal/chats/manager.go:1356-1366]`.
- **On a board** `[design]`: the server is the local one whatever the group's sticky server is, in this
  release `[user: Q23]`. The choice shows only the local server and says why (section 8), and such a chat
  neither reads nor records the sticky server. Creating a chat there with a remote server is refused. A board
  itself is made on the local server, and "+" offers no server for it in this release `[user: Q23]`.
- **On a run** `[design]`: a chat on a run is on the run's server. "+" on a run makes a local unstarted chat
  whose server is the run's and cannot be changed: the choice shows only that server and says why. The agent is
  the run's kind, or another usable agent of that server. The folder is the run's. With the run's kind, model
  and effort are those of the run's deep tier, as today `[code: internal/chats/owned.go:251-261]`; for a remote
  run the local server takes them from the run record. With another agent they are the defaults of the run's
  group for that server and agent. On a remote run the first message is the creation call (above), naming the
  run; that server refuses a run that is missing or archived `[code: internal/chats/owned.go:239-249]`. A chat
  on a run neither reads nor records the sticky server and records no defaults, as today
  `[code: internal/chats/manager.go:1243, 1401]`. A chat on a remote run was not run `[not verified]`.
- **Before the server list exists** (section 7, phase 3) the server choice shows one item, "This computer",
  which stands for the local server, and no way to add another `[design]`.

### 5.4 A server becomes unreachable and comes back

- **Trigger:** the remote server stops, the VPN drops, the laptop sleeps, or the link stalls `[design]`.
- **How it is found** `[design]`: a stream that ends, or pings that stop. A server sends a ping on an idle
  stream every 20 s `[code: internal/editorbridge/bridge.go:27, 159]`, and they arrived over TLS
  `[run: N01 S5, S7]`. Calls passed on have time limits; the stream has none.
- **What the local server does** `[design]`: sets the entry to "unreachable" and retries with back-off,
  without end. Local chats are not affected.
- **What the user sees** `[design]`: that server's chats and runs stay in the sidebar with the mark, a chat
  with its last name and a run with its last view. An opened one shows "server unreachable" in place of the
  thread or the detail. A send is refused at once and the text stays in the composer; stop, resume and apply
  of a run are refused at once. A draft run for that server cannot be checked or started (5.8).
- **Meanwhile on the remote server.** A running turn and a running run go on: the agents are its children, and
  events for a client that is not there are dropped, not queued
  `[code: internal/editorbridge/bridge.go:189-200]` (T01 §3). A run needs no client, and applies its result at
  its end as it would with one (section 4, "Runs for an API client") `[design]`. A permission ask waits there
  and can be answered later `[run: T06 §1]`. The stream's end ends what that client followed there, and
  nothing else of it: its chats and runs keep their client mark `[design]`.
- **Coming back** `[design]`: the local server opens the stream and takes the API snapshot. It reads again the
  chats and runs its pages follow, which follows them again there. From the snapshot it refreshes its chat and
  run records, the archived marks among them, marks chats and runs that are gone there, settles every "start not
  confirmed" (5.3, 5.8) and passes on pending archive changes (5.2). Then it sends its pages "server back" for
  the entry, and then the refreshed chat views, branch states and run views. A page drops what it kept for
  that entry's chats and runs and loads the chat or the run on screen again (section 4); another one of that
  server is loaded when it is opened next. A send whose answer was lost is shown as "not known whether it
  arrived", and the reloaded thread shows the truth.
- **A remote server that was restarted** shows a chat whose turn was running as stopped
  `[code: internal/chats/manager.go:617]`. It halted its runs when it stopped, and continues them at its start
  `[code: cmd/ai-whiteboard/main.go:223, 234-237]`. Its threads' versions start again
  `[code: internal/transcript/transcript.go:25, 569, 575]`, which is why the page must drop what it kept and
  not only add to it `[design]`.
- **A local server that was restarted** connects to every entry again at its start; the remote turns and runs
  were never its own to stop `[design]`.
- Sleep, wake and a change of network under the long stream were not run `[not verified]`.

### 5.5 Several clients on one server

- **Clients** `[design]`: the clients of a server are its pages and its API clients. Each is identified by its
  client id, and none takes anything from another by connecting. Several machines can use one remote server at
  once, each with its own sidebar and its own records `[user: Q6]`. On that server the items of all of them
  share the one remote group, where its owner's page shows them `[user: Q26]`. In Go tests, in the prototype
  with its one active page, two API clients and a stand-in page received one chat's events and saw the same
  ones `[run: N06 S3]`.
- **A board** has one holder and changes hands by the hand-off of section 4 `[design]`. In this release the
  holders of a board are pages of the board's own server `[user: Q23]`. Board tools of a server's chats go to
  the holder of the target board (section 4) `[design]`; today they go to the one active client
  `[code: internal/editorbridge/bridge.go:204-216]`.
- **A chat** has no holder. Any client may follow it, act on it and answer its permission asks `[design]`; two
  answers to one ask were not run `[not verified]`. Two clients that work in one chat at once are not a
  target (section 1): nothing is built for it, and section 4 lists what is avoided so that it stays possible
  `[design]`.
- **Two pages on one server** `[design]`, for example the app's window and a browser tab on the local server:
  - *New:* both work at once, each on other boards and on any chat, run or group. A page load or a reconnect
    takes nothing from the other page.
  - *Still limited:* one board is worked on in one page at a time. An edit the old holder cannot flush within
    the 3 s of the hand-off is lost, with a notice. In one chat's composer one text wins.
  - *Today* the second page takes the server over, and coming back can write old scenes and drafts over newer
    ones `[run: T11 X1, X4]`. With the scene revision and the draft counter a stale write is refused
    (requirement 42) `[design]`.

  None of this was run `[not verified]`.

### 5.6 A new secret, a changed certificate, editing and removing

- **A new secret** `[design]`: the owner runs `ai-whiteboard secret -new` on the remote machine. A running
  server that has the reload takes the new secret first and then closes its API clients' streams; a running
  server of an older build takes it at its next start, and the command says so (section 4). A stream's end
  ends what that client followed. Each client's entry shows "secret not accepted" and stops retrying. The user
  edits the entry, enters the new secret, tests and saves; at the return the local server reads again what its
  pages follow. Running turns and runs are not affected.
- **A changed certificate.** The next connection is refused by the pin in the handshake `[run: N01 S7]`. It
  follows that no request, and so no secret, is sent (N02 S2). The entry shows "certificate changed" with
  both fingerprints. The user compares with `ai-whiteboard remote status` on that machine and accepts, or
  leaves it `[design]`.
- **Edit** `[design]`: keeps the entry's chats and runs. An address that answers with another identity is
  refused.
- **Remove** `[design]`: after a confirmation that names the number of chats and runs, the entry, its secret
  and its chat and run records go. A chat or a run of that entry that is open closes. An unstarted chat or a
  draft run that has the removed server chosen, also one that is "start not confirmed", goes back to the
  fallback of section 4, the local server, and is an ordinary unstarted chat or draft run again. Nothing is
  deleted or stopped on that server: a turn that runs there goes on, unseen, and so does a run, which still
  applies its result. Nothing brings the records back (section 8). The entry's part of the sticky defaults is
  kept under its instance id. There is no "disconnect": an entry is in the list or it is not.
- **Switching remote use off** on a machine: `ai-whiteboard remote off` removes the configuration and nothing
  else; like the set-up, it takes effect at the server's next start. The secret, the key and the certificate
  stay, so a set-up after it gives the same secret and fingerprint `[design]`.
- **A set-up server that does not start** (section 4, "The start's check"). The shell's code does not change
  `[design]`.
  - *At app start:* the dialog "AI Whiteboard could not start its server" shows the text `launch` passes on
    `[code: desktop/main.js:142-160, desktop/lib.js:46-52]`; it follows that it shows the check's message.
    Retry fails until the named command was run in a terminal `[design]`.
  - *"Restart server" in the page, or `relaunch`:* `relaunch` runs the check before it stops the running server,
    and refuses when a file row or the equal-port row of the table fails `[design]`; today it stops first
    `[code: cmd/ai-whiteboard/launch.go:122-127]`. Server and agents keep running. The page shows "Restart
    failed" with Open log `[code: web/src/version.ts:53-72, web/src/Sidebar.tsx:312-321]`.
  - *The same when only the bind fails,* and *a server that died and cannot start:* the check passes, the
    running server is stopped and the new one does not come up, so there is no server `[design]`.
    The shell tries again every 5 s with no dialog `[code: desktop/lib.js:129-132, 192-239]`. The dialog
    returns at the next app start `[code: desktop/main.js:193-198]`. This is a known limit, as for any failed
    start today (section 8).

### 5.7 What describes the server's machine

- **Read through the item's server** `[design]`: the folder listing, plan usage, the catalogs, the usable
  agents, the home and the default folder for a chat, a run or a draft run of that server are that server's
  (section 4, "Lists by server"). The folder choice lists that machine's folders, and `~` in
  such a folder stands for that server's home, as it stands for the local home today
  `[code: internal/server/server.go:196-201, 771-791]`. Plan usage is asked of the agent program there
  `[code: internal/server/server.go:794-806]`. A draft run's folder and git facts are that machine's (5.8).
- **Named as that server's** `[design]`: the folder choice and plan usage of a remote chat or run carry the
  server's name; a remote run names its server beside its folder, because its result stays there; recent
  folders are one list per server.
- **A loopback link printed by a remote agent** means the remote machine. Opened in the client it reaches the
  user's own machine: a stated limit (section 8) `[design]`.
- **Local server only, as today:** "Open log", "Restart server" and the version banner
  `[code: web/src/Sidebar.tsx:300, 318]`. A remote server's log is not readable from the app; connection
  messages say where it is on that machine `[user: Q10]`.

### 5.8 Starting a run on a remote server

- **"New run"** `[design]`: in a place, as today. The local server makes a draft run, as it does today
  `[code: internal/runs/service.go:480-527]`, now with the place's sticky server and the place's run defaults
  for that server (section 4). Nothing is made on a remote server before the start.
- **Choosing** `[design]`. A draft run's choices are the server, the agent, the three tiers, the folder, the
  limits and the set-up command, beside the goal. Each change is one call to the local server.
  1. *Server:* the entries with their state. A new server sets the other choices from the place's run defaults
     for that server.
  2. *Agent:* the chosen server's usable agents. *Tiers:* that server's catalog for the agent. *Folder:* that
     server's folders.
  3. *The facts of the machine* that a draft shows (a missing folder, git, uncommitted changes, what blocks
     the start) come from the draft check on that server, asked at a change, on opening and when the window
     gets the focus (section 4).
  4. While the chosen server is not connected there are no lists and no check: the draft says why, another
     server can be chosen, and a start is refused with the goal kept.
- **The start.** On the local server: as today. On a remote server `[design]`:
  1. The local server makes the start call, with the run's id, name, agent, tiers, folder, settings and goal.
     The remote server makes the run in its remote group, with the local server's client mark, checks what a
     start checks today, and starts it (section 4).
  2. When the answer says "started", the draft's folder on the local server is removed and a run record takes
     its place under the same id. The choices are fixed. The local server records the place's sticky server,
     and the folder and the run defaults for that server; the remote server records none.
  3. The local server reads the run once, and the page shows it. Events arrive through the relay (5.2).
- **When that fails** `[design]`.
  - *Refused:* the folder is missing there, something blocks the start, that server lacks the agent, or a
    model is unknown. The call removes what it made, so nothing is on the remote server. The draft stays a
    local draft, with the reason shown and the goal kept.
  - *No answer:* the call was cut or ran into its time limit (section 9, U8). The draft is "start not
    confirmed", and its choices are fixed. A repeat of the start is safe: if the first call did start the run,
    the repeat starts nothing and its answer says "started". Without a repeat the local server reads the run
    there, at once while the entry is connected and after the reconnect otherwise: a run that is found is
    started, and a 404 means that the draft is still a draft.
  - *A delete in that state* also deletes the run on that server when it is connected. When that server cannot
    be reached, or its entry is removed in that state, what is there stays: it may be a started run, which
    goes on and applies its result (section 8).
- **The run itself** `[design]` works in the folder on the remote machine, with that machine's agents and
  logins, and goes on with no client connected. Its row, its detail, its texts and its agents' transcripts
  show in the local page as a local run's (5.2).
- **The result** stays on that machine. "Apply", by default at the run's end, fast-forwards the run's folder
  there `[code: internal/rungit/deliver.go:80-88, internal/runs/deliver.go:24-30, 45-47]`. Nothing comes to
  the user's machine, and the page names the server beside the folder `[user: Q27]`.

None of this was run `[not verified]`. What was run is the shape it copies from a chat: find-or-make by id,
repeatable, starting nothing twice `[run: N07 S2]`.

## 6. Security and access

**The network.** A remote server is not meant for a public address, and both machines are meant to be on one
VPN. The server enforces neither: its remote listener answers on every IPv4 address of the machine, a public
one too `[design]`. Staying behind the VPN rests on the machine's network and firewall, which the owner
arranges and the server cannot check; TLS and the secret are behind that, and do not replace it `[design]`.

**What they protect against.**

- **Reading or changing the traffic** by another party on the way: TLS `[design]`.
- **Another machine on any network the server's machine is on driving the server:** every request on the
  remote listener needs the secret. Without it or with a wrong one every route tried, hello included, answered
  401 `[run: N01 S5]`.
- **Another machine taking the server's place** after the entry was added: the pin. A different certificate
  is refused in the handshake `[run: N01 S7]`. It follows that no request, and so no secret, is sent (N02 S2).

**What they do not protect against.**

- **Any account or process on the remote machine.** Its loopback listener has no login: a caller there reads
  all state `[run: T04 Q5]` and, with a stream and one call, takes any board `[design]`. A remote host must be
  one on which all accounts are trusted, as the local machine is today `[design]`.
- **The client's own processes and agents.** The list file is within reach of every process of the user, an
  agent's tools included `[design, for N04 S8]`, and the local server passes calls on for any local caller
  `[design]`.
- **Whoever holds the secret.** Within the named set of routes (section 4) whoever holds it can do all of this
  on that server `[design]`:
  - start chats, which run agents as that server's user; pi chats run their tools with no permission card
    `[code: README.md:26-28]`;
  - start a run: agents of any kind that ask no permission `[code: internal/chats/owned.go:179]`, in a folder
    the caller names, and a set-up command of the caller's own, which goes through `/bin/sh` in every checkout
    `[code: internal/rungit/setup.go:60]`. That is command execution as that server's user with no agent in
    between; a pi chat gave that reach only where pi is logged in. A run also makes branches in that user's
    repositories and fast-forwards the folder at its end. A server with remote access on serves runs as it
    serves chats; its owner has no switch for chats alone `[user: Q28]`;
  - read, stop, resume, apply, archive and delete any run by its id, the owner's own runs included, with its
    goal, reports, changes and agents' transcripts;
  - read the thread of any chat there by its id, the owner's own chats included, and answer its permission
    asks, send into it, rename it, archive it and delete it: the chat routes take any chat's id
    `[code: internal/server/server.go:545-767]`, and in the prototype an API client was let through to them
    without the role `[run: N06 S2]`;
  - get, in the API snapshot and on the stream, the items of the client id it states, with names, folders and
    the draft text a view carries `[code: internal/model/model.go:334-376]`, and the server's home and default
    folder. The id is checked against nothing, so whoever holds the secret can state another client's id and
    get that client's list `[user: Q25]`;
  - list the folders of any directory that server's user can read
    `[code: internal/server/server.go:771-791]`;
  - make the server run an agent CLI for plan usage `[code: internal/server/server.go:794-806]`;
  - follow any chat by reading it by its id, a run agent's chat too
    `[code: internal/server/server.go:545-546]`, and any run by reading its detail; a follow changes nothing
    for other clients `[design]`.

  Such a caller cannot reach groups, the draft routes or the page's full state with its data folder path, and
  cannot name a group for what it makes `[design]`. In this release it cannot reach boards or the calls that
  hold and release one, and cannot create a chat on a board `[user: Q23]`. "A message is sent, an agent runs"
  was not run through an open port `[not verified]`. There is one secret for all clients, so taking access
  away from one means a new secret for all `[design]`. Targeting is not access control: it decides what a
  client is sent, not what a caller with the secret may ask for `[design]`.
- **A fingerprint nobody compared.** At adding, the pin is only as good as the comparison with what the other
  machine printed `[design]`.
- **A public address.** The server does not tell a VPN address from a public one. On a machine with a public
  address and no firewall rule the remote port is open to the internet, behind TLS and the secret alone
  `[design]`.

**How the parts work.**

- **Order of checks on the remote listener:** secret, then Host, then the route `[design, for N01 S5]`. In the
  prototype, which had that order in its code, a wrong secret with a good Host got 401 and the right secret
  with a bad Host got 403 `[run: N01 S5]`; a wrong secret with a bad Host was not among the cases, and AC24's
  test adds it. The client id is checked after both and before the route: a missing or malformed id is
  refused on every route, hello included, and the server's own id on every route but hello (section 4, "The
  checks") `[design]`.
- **No guessing protection is built** `[design]`: the secret has 256 bits, and a lock-out would let anyone who
  reaches the port lock the owner out. A refused request is logged at most once a minute per source address;
  the secret is never logged.
- **"Box on" is a pin, not "skip verification"** `[user: Q16]`. With verification skipped, a client accepted
  a certificate with the wrong names `[run: N02 S2]`, and the secret travels in every request; it follows
  that whoever answers at the address would get the first request, and with it the secret. Under a pin names
  and dates are not checked: an expired pinned certificate connected `[run: N01 S7]`, so a lifetime of ten
  years is safe.
- **"Box off" is normal verification** against the system's trusted roots and the name; a self-signed
  certificate is refused with "tick the box" `[design]`. Neither that refusal against the system's roots nor
  the passing of a certificate the system trusts was run with Go as the client `[not verified]`.
- **No browser page can use the remote listener:** it answers no CORS preflight `[design]`. A preflight
  carries no secret and got 401 `[run: N01 S6]`.
- **The secret on the client** is in the server list file, mode 0600, in the data folder, which is made with
  mode 0700 today `[code: internal/store/store.go:66, 70]`. The page can send a secret in and never gets one
  back: it is never stored in the page or the shell `[user: Q17]`.
- **The server list's own routes** on the local server are covered by the rule that a non-GET call names a
  known client, and the list's `GET` returns no secret (section 4) `[design]`.
- **Loopback needs no secret** `[user: Q15]`. It keeps today's Host rule
  `[code: internal/server/guard.go:24-38]`, and today's active-client rule becomes the rule of the known
  client (section 4) `[design]`.
- **A client id is stated, not proven** `[user: Q25]`. It tells clients apart for holds, lists and follows. On
  the remote listener the secret is the only credential; on loopback there is none.

**Not built: a same-origin check on `/api`.** The first version of this plan needed it because other servers'
pages ran inside the app. Now none does, and the remote listener answers no preflight `[design]`. Today a page
at another loopback origin can take the active role with one `EventSource` and, while it holds the role, post
a forged answer to an agent's board tool call and release the role; it cannot read answers or reach the routes
that create chats `[run: T09 Part A]`. With the role per board what remains is less: such a page can open a
stream. It holds nothing, cannot read what it is sent, is never chosen for a tool call, and cannot take a
board, forge a tool's answer or release anything: those need the custom header `[design, for T09 Part A]`.
Not run `[not verified]`.

## 7. How to build it

### Phases

Each phase is a slice that can be tested by itself. The next table maps every criterion to its test.

| Phase | Builds | Needs | Verified by |
|---|---|---|---|
| 1. Remote listener | The remote configuration (port, names) and the `remote` commands with their own flags, `remote setup -new-cert` among them; the start's check and the start that only checks; `relaunch`'s check before its stop; the `0.0.0.0` listener; the loopback route `remote status` reads; the certificate; the secret with `secret` and `secret -new`, which until phase 2 takes effect at the next start; the Host list and the secret check of the remote listener; the table of the named routes, at first with hello alone open (the stream and the chat routes come with phase 2: a stream there needs the client records of phases 7 and 2; in the prototype, on today's bridge, it took the active role `[run: N01 S5]`); the instance id in hello | Nothing | New Go tests; curl on loopback as in N01 S5; a request from a second machine, on macOS with the firewall on (AC22, AC23, AC25, AC37, AC24 without its reload and stream clauses, the first clause of AC4, the second clause of AC1) |
| 2. API clients | The API client as a kind of client in the bridge and the guard: its client id, the client mark, its stream with the API snapshot of its own items, its allow-list of events with the targeting behind it, the unfollow call; the named routes for it; creation by an API client: the first message in the call, the remote group, the refusal of a board and of a named group, the client mark with its "no defaults" rule and its copy to forks; the feature level in hello; the reload of the secret in a running server, its gate on that level, and the close of API clients' streams. **First step:** an API client over the real HTTPS listener with the secret, which no run has shown | Phases 7, 1 and 3 | Go tests with a stand-in page that holds a board on loopback and two API clients, as in N06 S3 and S4; the same against a scratch server over HTTPS with the real page open and following a run agent's chat (AC13, AC45 for chats and forks, the API client's clauses of AC38 and AC41, the reload and stream clauses of AC24) |
| 3. Starting a chat, local server only | "+" without an agent; the agent in the configure route, with the condition "unstarted, and neither a fork nor a branch"; creation with a given id, checked as a UUID; the choices in the chat, with the server choice showing "This computer" alone (5.3); usable agents: the look-up, the list in the state, the `agents` event, the refusal of an agent the server lacks, the subagent tools' list, and the agent lists of the chat, of the draft run and of the empty state; the sticky agent; the defaults in their final per-server shape, run defaults included, with the local server as the only key; the end of `Defaults.Last`, and the one migration | Nothing; it may come first | Go and web unit tests; the end-to-end suite with `newChatVia` changed; one manual run with the real agent CLIs (AC28 to AC32 and AC44 for the local server, AC1) |
| 4. Server list | The list's store and routes; the connection to a remote server, with pin and secret; test connection with its five steps; the entry states; the identity and level checks; the Servers dialog | Phase 1. Its tests use stand-in servers; against a real server the fifth step and the stream need phase 2 | Go tests against a stand-in server for every row of the table in 5.1; web unit tests for the dialog (AC5 and AC27 without their clauses on chats and runs, AC6, AC26, the rest of AC4) |
| 5. Remote chats | **First step, before the rest:** a spike with two scratch servers, in which the local one passes one chat's routes on and relays its events to the page. Then: the server choice with remote entries; the first message as one call, with its failure paths; passing on; the relay and what it rewrites; chat records; the local server's follows on the remote server and its handing on of events to the pages that list and follow; the "server back" event and what the page does on it; lists by server in the local server and in the page, with `GET /api/dirs` and `GET /api/usage/{agent}` taking the entry; `defaults.Resolve` and `ConfigureOf` without local checks for a remote server; a remote entry's part of the defaults; archive, unarchive and the delete of a group; the "server unreachable" view; outage and return; removal; the limit for boards; a chat on a run kept on the run's server, which until phase 9 is the local one | Phases 2, 3 and 4 | The spike's run (section 8 says what passes); then two scratch servers, a stand-in agent and the link simulator (AC12, AC15 to AC18, AC33, the board half of AC34, AC29 to AC32 in full, AC44 for a remote server, the removal clause of AC27, the server-choice clause of AC5, AC1; the clauses of these on runs come with phase 9) |
| 6. Scripts and packaging | `setup-remote.sh`, `start-server.sh`, `build-server.sh`, the bundle entry, the README; a run of the server on Linux | Phases 1, 2 and 4 | The four builds; a look into the built bundle; the scripted test of the scripts and commands on a scratch data folder, set up with `--name 127.0.0.1`; an install by the README on a clean macOS and a clean Linux machine (AC20, AC35, AC36) |
| 7. Clients, holders and events | Built before phase 2, although its number is higher. Client records and the known-client guard; the calls that hold and release a board and the hand-off per board; the scene revision; board tool calls by target, with `list_boards` and `create_board` answered by the server; targeted events for pages, with the follow in place of the watch set; the draft counter; in the page: the role per board, the take-over panel, the read on a grant, the composer's rule for drafts. **First step:** a prototype in Go tests, as N06 was: client records with a role per board in the bridge, with the existing chat tests green | Nothing | Go tests of the bridge, the guard, the boards store and the tool relay; T09 Part A's and T11's steps run again; the end-to-end suite with two real pages (AC39, AC40, AC42, the pages' clauses of AC38 and AC41, AC1) |
| 8. Runs for an API client | The remote server's half of a run, built before the server release is cut: the start call, with its id check and its creation lock; the draft check; the run routes of the named set; a run's client mark, its place in the remote group and its "no defaults" rule; the run events on the API client's allow-list, sent by mark and by follow, and the runs in the API snapshot; creation of a chat on a run by an API client. **First step:** a prototype of the start call in Go tests | Phases 2 and 7 | Go tests with the scripted stand-in and two API clients; a run to its end with no client connected (the server's half of AC43, the start-call clause of AC44, the run clauses of AC45, AC41 and AC13) |
| 9. Remote runs | The local server's half and the page's: a draft run's server choice, with that server's lists and the draft check; the start through the start call, with its failure paths; run records; passing on and the relay for runs, with the follows and the run agents' chats; chats on a remote run; a remote entry's run defaults; archive, delete, the delete of a group, outage, return and removal for runs; in the page the draft run's composer, the rows of remote runs and the "server unreachable" view of a run. **First step:** two scratch servers, the remote one with the scripted stand-in as its Claude program, and one run through the local page | Phases 5 and 8 | The first step's run; then two scratch servers and the link simulator (AC43, the run half of AC34, the draft run clause of AC44, the run clauses of AC5, AC12, AC17, AC18, AC27, AC31 and AC33) |

**Order** `[design]`. 1, 3 and 7 can be built side by side; 7 and 8 have high numbers only because existing
numbers are kept. 2 comes after all three: it changes the same creation and configure code as 3, and the same
bridge and guard as 7, so it is built at the same time as neither. 4 comes after 1; 6 comes after 2 and 4; 5
comes after 2, 3 and 4. 8 comes after 2 and 7 and before the server release is cut, so that feature level 1
includes the run routes. 9 comes after 5 and 8 and is last. The order 3 before 2 is a fact of the code: the two
prototypes both changed chat creation, the recording of defaults and the create route, and N07 also rewrote the
configure route `[run: N06 S9, N07 S6]`. Phases 3 and 7 are useful with no remote server at all. The server
release is cut after phase 8 and the server parts of phase 6, the build script and the run on Linux, since only
they bring a server to another machine.

### Acceptance criteria and their verification

| AC | Verified by |
|---|---|
| AC1 | The existing Go, web and desktop suites, after phase 3, after phase 7 and again after phase 5, apart from the tests section 3 names as changed. A Go test that a server with no remote configuration binds its two listeners of today only and reads and writes no secret, key or certificate, also with such files laid into its data folder (phase 1) |
| AC4 | A Go test that hello's id is the same after a restart on the same data folder (phase 1). Go tests of the connection to a remote server against stand-in servers: the local server's id, one id under two addresses, another id at a reconnect (phase 4) |
| AC5 | Go tests of the connection with a stand-in hello of a lower level and of no level; a web unit test that such an entry is not offered in a chat's server choice (phase 5) or in a draft run's (phase 9) |
| AC6 | Go tests for the list's store: add, edit, remove, a restart, the file's mode, a file that cannot be read, a missing and an empty file, and the refusal to edit or remove the local entry. A test that searches every answer of the list's routes, the state and the events for the secret's value |
| AC12 | Two scratch servers: the remote one is stopped for 60 s during a turn of the stand-in agent, and in a second run restarted. The entry's state is read with its times; a local chat is used meanwhile; after the return the thread on screen and a second chat of that server, opened before the outage and again after it, are compared with the remote server's own (phase 5). A remote run stays listed through both, and its state is current after the return (phase 9) |
| AC13 | Go tests with a stand-in page that holds a board and two API clients, as in N06 S3. A run against a scratch server with the real page open: it is shown no take-over, and its board is saved during the API client's create, send, permission answer and stop. A test in which the page follows a run agent's chat, an API client connects, and the page still gets that chat's events. A Go test that an API client's create on a board, or one that names a group, is refused (section 4) (phase 2), and that one on a run is accepted (phase 8) |
| AC15 | T10's link simulator between the two scratch servers, "good" profile: the times of a send's acknowledgement and of streamed text |
| AC16 | The same on the "poor" profile, one case for each letter of the criterion. (a) A cut after a send's body left and before its answer. (b) The same cut at a first message, then the send repeated twice: the remote thread holds the message once and the local chat is started; and the cut with no repeat, settled at the reconnect. (c) A stand-in agent that fails to start, and a folder that is missing there: the chat is unstarted on both sides, the reason is shown, the text kept, and a retry with another agent and folder starts the chat. And a stand-in agent that starts and then refuses the message: the chat is started and locked on both sides, and the thread shows the failed turn. (d) After the first case of (c), a change of server: the first server no longer has the chat. (e) A cut in the middle of a turn. In each the thread is compared item by item with the remote server's own |
| AC17 | A Go test in which the stand-in agent raises a permission ask on the remote scratch server and the record's state is updated from it; web unit tests for the sidebar row and the dialog's states. A Go test that a run record's view is updated from the remote run's status, counts and attention, and a web unit test for a remote run's row (phase 9) |
| AC18 | Web unit tests: the texts of the folder choice and of plan usage in a remote chat; `~` shown for a folder under that server's home and not under the local one; catalog, usable agents and default folder read through the chat's server; recent folders per server. Go tests that the local server's folder listing and plan usage routes, given an entry, ask that server. The same texts and lists in a draft run with a remote server and in a remote run (phase 9) |
| AC20 | The four builds and the file list of each folder; an install by the README on a clean macOS and a clean Linux machine, ending in a connected entry |
| AC22 | Go tests of AC22's clauses, with a dial to `[::1]` refused; the unchanged tests of N01 S8; a request from a second machine (phase 1) |
| AC23 | A Go test that takes the one table of named routes, calls every route the server registers on the remote listener with the right secret, and expects 404 for each that is not in the table. Nothing lists the routes a server registers (section 4), so the test takes them from a helper that records each pattern at registration, or from a list of its own |
| AC24 | Go tests that repeat N01 S5's table, with the case it lacks: a wrong secret with a bad Host. One for a restart, and one for `secret -new` and then a restart; one that the secret file is the same after a start, and one that `secret -new` with no configuration is refused and writes nothing (phase 1). One for `secret -new` on a running server with an open stream, which checks that the old secret is refused before the stream ends, and one for `secret -new` against a stand-in hello without the reload (phase 2); a search of the test server's log for the secret |
| AC25 | Go tests for the files, their modes and the names in the certificate: `remote setup` with both missing and with both present, `remote setup -new-cert`, and a start, after which key and certificate are the same; a scripted comparison of the printed fingerprint with `openssl`'s; a start with an owner's key and certificate in place |
| AC26 | Go tests of the connection against stand-in TLS servers: the pinned certificate, another one, an expired pinned one, an entry with the box on and no pin, and a self-signed one with the box off. A certificate the system trusts: a manual run in phase 4 |
| AC27 | Go tests for each row of the table in 5.1; web unit tests for the dialog; a removal with chats (phase 5) and with a run (phase 9), after which the remote scratch server still has them |
| AC28 | Web unit tests for the seven places; the end-to-end suite with `newChatVia` changed |
| AC29 | Go tests for the configure route with a server and with an agent, as in N07 S1; web unit tests for the choices. With a second scratch server in phase 5 |
| AC30 | Go tests: 409 for server and agent after the first message, and in a fork and a branch at their start; today's lock tests unchanged. A Go test of creation with a given id: a lowercase version 4 UUID is taken, and ids of other forms, among them `../../etc`, `a/b` and upper case, are refused |
| AC31 | Go tests of the defaults package and of chat creation, for a group with a value of its own and for one without; the end-to-end check of the defaults, rewritten. A Go test that "New run" in a group starts with the group's sticky server (phase 9) |
| AC32 | The rewritten tests of the defaults package, of group creation (top-level and subgroup) and of run defaults, now per server. A migration test that loads a state file with `last` and checks the file written at that load: the per-server shape, no `last`. The same file loaded by the build of phase 5 is unchanged |
| AC33 | Runs against a second scratch server, one for each row of the table in 5.2; Go tests of the same against a stand-in remote server. For archive: the remote chat's agent has stopped; an archive made on the remote server's page shows at the client and is still there after a reconnect; an archive made while the server was unreachable is passed on at the connect; a second client's connect changes no mark. For the delete of a group: with one chat's server stopped, nothing is deleted; the same with a remote run in the group (phase 9) |
| AC34 | Go tests: creating a chat on a board with a remote server is refused; in a group whose sticky server is a remote one, a chat on a board starts on the local server and the sticky server is unchanged after its first message (phase 5). With two scratch servers: a chat on a remote run starts on the run's server, on that run, in the run's folder, and the sticky server is unchanged (phase 9). Web unit tests for the server choice on a board and on a run |
| AC35 | A listing of the built bundle; a run of the script through `sh` from the bundle on a scratch data folder, then a test connection to it |
| AC36 | A scripted test on a scratch data folder with its own ports: `setup-remote.sh` run twice with no input, with the output and the files compared; a run after the secret was deleted, checked to make a new secret and keep the rest; `--new-cert` and `--new-secret`, each checked to change one file; `start-server.sh` called from another folder, then hello; `remote status` against the running scratch server and from the files alone, with a good set-up and with the key removed, and a search of its output for the secret; `remote off`, checked to remove the configuration only, then a restart, after which the port is closed (phase 6) |
| AC37 | Go tests, one for each fatal row of the table of "The start's check", the equal-port row and the bind row among them: the exit code, the message with the file or the port, no listener for the file rows and the equal-port row, no `server.json`, and secret, key, certificate and configuration unchanged. One through `launch`, which reads the text it passes on. Two of `relaunch` against a running scratch server, one with the key removed and one with the remote port set to the server's own: it refuses and the server still answers (phase 1) |
| AC38 | Go tests of the bridge and the guard on both listeners: a call with no id, with a malformed id, with the id of no open stream, with the id in the body and not in the header, and a second stream with a connected id; on the remote listener hello with the server's own id, which is answered, and every other route with it, which is refused. T09 Part A's attacks from a page of another origin, run again, with a page that only opened a stream: it is given no board and no tool call (phase 7; the remote listener's clauses in phase 2) |
| AC39 | Go tests of the hand-off per board with two stand-in pages: a free board, a held board with a release, a held board whose holder does not answer for 3 s, a write by a non-holder, a reconnect. The end-to-end suite with two real pages in place of its step 9 `[code: web/e2e/app.e2e.mjs:1096]` (phase 7) |
| AC40 | Go tests with two stand-in pages and a stand-in agent: a call for a held board, for a board nobody holds, with one page, with no page; a board lost while calls on it and on another board are open; a reply from the page that was not asked; `list_boards` and `create_board` with no page (phase 7) |
| AC41 | A Go test for each row of section 4's event table, once for a page (phase 7) and once for an API client (phase 2; the run rows in phase 8): who gets the type and who does not. A test that a content event arrives only after the read, and again after a reconnect and a new read. Two clients that follow one chat, with their streams compared |
| AC42 | Go tests of the scene write and of the draft write, each with a current and with a stale base. T11's steps X1, X3 (b), X4 and X5 run again with two real pages, with the scene on disk and the draft compared (phase 7) |
| AC43 | Go tests of the start call with the scripted stand-in: a repeat, 24 calls at once, a refusal that leaves nothing, ids of other forms, an id of a run without the caller's mark, a patch with another field than the name, no defaults written, the run's events by mark and by follow (phase 8). Then two scratch servers, with a run started through the local page: the result in a scratch repository on the remote one, a start whose answer is cut and then repeated, each row of the run table of 5.2, a stop of 60 s, a restart of the remote server; a web unit test for the draft run's composer (phase 9) |
| AC44 | Go tests with a scratch `PATH` folder into which a stand-in program is put and from which it is removed: the list in the state, the `agents` event, each refusal, and the two subagent tools. Web unit tests for the agent choice of a chat, of a chat on a run and of a draft run, for the empty state, for a stored agent the server lacks and for a server with no usable agent (phase 3). The start call's refusal in phase 8. The same choices with a remote scratch server, connected and unreachable (phase 5; a draft run in phase 9) |
| AC45 | Go tests: creations by two API clients, with the group and its contents read as a page reads them and no group in either API snapshot or stream; a call that names a group; the group deleted, and archived, before the next creation; an item moved out by the owner and then configured, with the defaults compared (phase 2; runs in phase 8) |

### Rollout

- **The server release is cut after phase 8 and phase 6's server parts** `[design]`. It needs phases 1 to 3, 7
  and 8 in the server, and it is feature level 1, the minimum for a remote server, with the run routes in it;
  a server with phase 1 alone reports no level. Later changes to what an API client can do are additions, or
  they raise the level; a raised minimum means an update on every remote machine `[design]`.
- **Client and remote server are updated independently** `[design]`. The client checks the level, not the
  version. The page and its own server ship together as today, and the version banner keeps comparing only
  those two `[code: web/src/logic/version.ts:14-22]`.
- **A remote server of another build** sends thread items made by that build through the relay to this page.
  The page ignores an event type it does not know: its switch has no default case
  `[code: web/src/conn.ts:39-62]`. Items were not tried `[not verified]`.
- **No remote entry for users before phase 5 is done;** until then scratch servers only. A run on a remote
  server comes with phase 9; until then "New run" makes a run of the local server whatever the group's sticky
  server is. Phase 3 and phase 7 can each be released by itself `[design]`.
- **Existing state is migrated once,** at the first start of a server that has phase 3, straight into the
  per-server shape (section 4). Phase 5 adds remote keys to that shape and migrates nothing `[design]`.

### Test tooling

- **In the repository:** a scripted stand-in for the Claude program, which a server takes as its Claude
  binary; the end-to-end test of runs uses it. Its directives, listed at the same place, have none for a
  permission ask `[code: internal/agenttest/fakeclaude.go:21-27]`.
- **Scratch servers** are started as in N01's "Set-up used": own ports, own data folder, and the stand-in in
  place of the agent programs `[design]`.
- **To build** `[design]`:
  - a permission directive for the stand-in, which AC12, AC13 and AC17 need across two server processes;
  - a stand-in agent whose send fails after its start, which the second case of AC16 (c) needs; the
    stand-in's directives have none for it `[code: internal/agenttest/fakeclaude.go:21-27]`;
  - a stand-in for the namer: the automatic name is made by running the real `claude` or `pi` program
    `[code: cmd/ai-whiteboard/main.go:164-167]`, so the "automatic name" row of AC33 cannot be decided with
    agent programs that do not exist;
  - a stand-in TLS server for the rows of the table in 5.1;
  - T10's link simulator ("Set-up used" there), placed between the two servers;
  - stand-in pages for Go tests that hold boards, follow items and answer tool calls, and a second real page
    in the end-to-end suite, which AC38 to AC42 need;
  - a scratch `PATH` folder with stand-in agent programs that a test puts in and removes, which AC44 needs.
- The rigs of the first version for pages in several window areas are not needed.

## 8. Assumptions, known limits and risks

### Assumptions

- Both machines are on one VPN, and the remote machine has an address there that the client reaches. The
  remote machine has no public address, or its firewall keeps the remote port to the VPN. The server does not
  check this `[design]`.
- Remote machines run macOS or Linux `[user: Q5]`.
- One owner: the person who uses the client also controls the remote machine, can run a script in a shell
  there, and reads the secret and the fingerprint from it.

### Known limits

Stated, not built; each is a named follow-up.

| Limit | Evidence |
|---|---|
| Boards, and chats on a board, are local `[user: Q23]` | The role per board lets any client hold one (section 4), but the remote listener serves no board route in this release. No route moves any chat onto a board, a remote one included: a board's chat moves with its board `[code: internal/chats/manager.go:1794-1816]` |
| A remote chat has no board tools | It is a plain chat or a chat on a run, and a board tool on a chat with no board answers "not available on this chat" `[code: internal/boardapi/mcp.go:341-343]`; the prototype, which kept one active page, got that answer `[run: N06 S4]` |
| A remote run's result stays on the remote machine `[user: Q27]` | Apply fast-forwards the run's folder there, by default at the run's end `[code: internal/rungit/deliver.go:80-88, internal/runs/deliver.go:24-30]`. No route sends a repository or a file |
| Chats and runs made on a remote server by its own page or by another client do not appear locally | The local server shows only the chats and runs it has a record for `[user: Q19]` |
| A chat or a run cannot be moved between servers, and a fork stays on its server | Thread, agent session and folder are on that machine; a fork is made from the source's session there `[code: internal/agent/agent.go:86-116]` (N04 S2). A run works in git worktrees on its server's machine `[code: internal/rungit/worktree.go:130-134]` (N04 S7) |
| Removing an entry forgets its chats and runs locally; adding it again does not bring them back. A turn or a run on that server goes on, unseen, and a run still applies its result | The records are the only local trace; the chats and runs stay on the server (5.6) `[design]` |
| A failed first message can leave a chat on a remote server: when that server cannot be reached at the moment the user changes the chat's server or deletes the chat, or when its entry is removed while the chat is unstarted after a failed first message or "start not confirmed". A run's start that was not confirmed can leave a started run there in the same way | 5.3, 5.8. The leftover sits in that server's remote group until it is deleted there. After a refusal a chat is unstarted, with no agent running; after a start that was not confirmed a chat or a run may be started, with its agents running `[design]` |
| One board is worked on in one client at a time; an edit the old holder cannot flush within 3 s is lost, with a notice | 5.5 `[design]` |
| Two clients typing in one chat's composer: one text wins | No merge: two clients in one chat are not a target (section 1) `[design]` |
| One secret for all clients of a server | Regenerating is the only way to take access away (section 6) `[design]` |
| Secrets are in a 0600 file within reach of the user's own processes and agents | N04 S8 `[user: Q17]` |
| A loopback link printed by a remote agent opens on the user's machine | 5.7 `[design]` |
| Targeting is not access control | One secret and an id that is only stated: whoever has the secret can state another client's id, or read any chat by its id (section 6) `[user: Q25]` |
| Two installs with one instance id cut each other's stream on a remote server | A copied data folder; the newer stream with a connected id replaces the older (section 4) `[design]` |
| Streaming re-sends the whole item for each piece of text | 20 KB of text in 200 pieces made 2.06 MB of events `[run: T10 M6]`. A follow-up unless poor links must be fast `[user: Q8]` |
| Opening a chat downloads its text twice | 3.25 MB and 13.4 s on the poor link for a 1,500-item thread `[run: T10 M2]`; again after each reconnect `[code: web/src/conn.ts:81-83]` |
| A chat waiting for approval waits without limit on its server | No timer is on that path in the server, and the chat was still waiting after 1.5 s in the test `[run: T06 §1]`; the agent programs' own time limits are unknown |
| A local server that cannot start blocks the app, remote chats included. A set-up server has more ways to fail (section 4). Only the start dialog shows the reason; after the server died the shell tries again with no dialog | Today's start-up and its Retry or Quit dialog stay `[code: desktop/main.js:140-160, desktop/lib.js:83-87]`; the retry without a dialog `[code: desktop/lib.js:129-132, 192-239]` (5.6) |
| The remote listener is IPv4 only | Section 4 `[user: Q22]` |
| An address the machine gets after set-up is not a name until `remote setup -name` adds it | Section 4, the Host rule `[design]` |
| While a server is unreachable a draft run for it cannot be checked or started | The lists and the draft check are that server's (section 4, 5.8) `[design]` |
| "Installed" means found on the server's `PATH`, not logged in. A program outside that `PATH` is found only after a restart with a `PATH` that has it | The look-up finds a program and does not start it (section 4, "Usable agents") `[design]` |
| The owner of a remote server can archive or delete the remote group, with the clients' items in it. Each client then shows its items as archived, or as gone there | It is an ordinary group, and the owner can already archive or delete each item (section 4) `[user: Q26]` |
| A run gives whoever holds the secret a shell command on that server | A run's set-up command goes through `/bin/sh` `[code: internal/rungit/setup.go:60]`; there is no switch for chats alone (section 6) `[user: Q28]` |

### Risks that no run has settled

Every `[not verified]` of this plan is one of these rows.

| Risk | What would be observed if it goes wrong, and the way out | First checked |
|---|---|---|
| An API client over the real HTTPS listener with the secret: the listener (N01 S5) and the prototype's role, which the plan's client records replace (N06 S3, S4), were each run alone. Also `catalog`, `agents` and the run events on an API client's stream, and two answers to one permission ask (N06, unknowns). Also the two things the plan does not take from that prototype (section 4): the named set of routes with 404 outside it, where the prototype's guard opened every `GET` under `/api` and answered 403; and the remote group, made at the first creation and made again when it is gone or archived, with the refusal of a board and of a named group, where the prototype let a chat on a board through (N06 S2) | Over HTTPS a page on the remote server loses a board or an event after all, or a stream does not behave as over plain HTTP; a client's lists go stale; a second answer to an ask is taken as a new one; an API client reaches a route outside the named set, or makes a chat on a board; two groups "Remote" appear, or a client's item lands in the ungrouped group. That an API client can act on chats beside a page needs no way out: the Go tests showed it for the prototype's role. The tests of AC23, AC13 and AC45 decide the route set, the refusals and the group | Phase 2, first step; the route set from phase 1 on (AC23) |
| The API snapshot (section 4): the API client's own items, by the client mark, built without side effect. The prototype sent the page's | A client gets another client's chats, or misses its own after a reconnect; a page on the remote server stops getting the events of the run agents' chats it follows when an API client connects; or the snapshot lacks something the local server needs | Phase 2 (AC41, AC13's last clause) |
| The role per board and the client records ("Clients, holders and events", 5.5, and the page's part of them): no run | A hand-off loses the holder's pending save, a board has two holders, or a tool call reaches the wrong page. Way out: pages keep today's one role and only API clients get a record; a board on a remote server then stays out of reach. This would leave point 4 of the second update unmet, so it is the user's decision | Phase 7, first step |
| The scene revision; boards that have none yet | A good save is refused as stale after a restart or an upgrade. Way out: the revision is taken from the file's content | Phase 7 |
| Targeting by list and by follow; two clients that follow one chat | A page shows a stale thread or sidebar: a type is in the wrong class, or a follow begins after its read. Way out: the type moves to the list class | Phase 7; phase 2 for API clients |
| The known-client guard, with the client id taken from the header only, and the reply to a tool call taken only from the client asked (section 6); the fallback of a tool call, with `list_boards` and `create_board` answered by the server, and the fallback never choosing a stream that made no call with the header; the take-over panel for a board that is not free; the draft counter and the composer's rule | T09 Part A's attacks still take a board or forge a reply, or a tool call goes to a page of another origin; with one page a tool that works today is refused; typed text is replaced. Way out for drafts: the composer's rule alone, without the counter | Phase 7 |
| The client mark, and with it "no sticky defaults", copied to a fork (section 4); the rule for an item the owner moved out of the remote group. N06 S6 ran the property on the chat itself, with a mark that named no client | A fork of a remote chat, or a moved one, writes its folder into that server's defaults | Phase 2 |
| The reload of the secret (section 4): the gate that asks hello before it signals; the close of API clients' streams over TLS with HTTP/2, set off by the secret's change (N06 S7 ran the close in a Go test, N01 S4 the reload) | `secret -new` ends a server of an older build, with its running agents; or whoever holds the old secret keeps reading events until the connection drops | Phase 2 |
| A request from another machine to the `0.0.0.0` listener (section 4); whether the macOS firewall showed a prompt is not known (N08 S6) | The test connection ends in "No answer" while `remote status` says listening. Way out: the owner allows the server program in the firewall | Phase 1, on a second machine |
| What N08 did not run (section 4). Binds: a port that another process has, Linux, a port held on loopback only, which the bind did not report (S2). Files: a key that cannot be read, PEM of another type, an owner's RSA or Ed25519 key (S4) | The server starts although another program has the port, or a start fails with an unclear message. Way out: a trial bind of `127.0.0.1:<port>` first | Phase 1; Linux in phase 6 |
| A real agent CLI in a chat that was first another agent's (5.3): the agent change ran with stand-in agents only (N07, unknowns) | A real program finds a session of the other kind, or a failed start of the first agent leaves a session file in the CLI's own store. Way out: the chat gets a new session id at every agent change, as the prototype already does | Phase 3, a manual run with the real CLIs |
| The defaults in the per-server shape (section 4): the prototype ran today's flat shape with an agent added. Also the migration's write of the file at the load, where the prototype wrote at the next save, and an older build started on a migrated file (N07, unknowns) | A group loses a value at the migration, the file still holds `last` after a start with no change, or the second shape change the plan means to avoid is needed after all. AC32's migration test decides the write | Phase 3 |
| Go as the client against a name that does not resolve and against a host with no route or no answer to the dial; "box off" against the system's roots: a self-signed certificate with a text of its own, and a certificate the system trusts (N01 S7 ran none of these) | A test that hangs past its limit or gives the wrong message; "box off" refuses a good certificate or does not say "tick the box" | Phase 4 |
| The relay (section 4): passed-on routes and re-sent events, shown by the page. To pass: a live thread, a permission card answered, a correct thread after the remote server was restarted and after a cut of 60 s, no item twice. Also the local server's follow and unfollow on the remote server for its pages, and thread items made by another build | A thread that stalls, repeats items or is wrong after a return; a remote thread stops updating while a page has it open, or the local server follows a chat no page has. The spike may pass the restart condition only by sending the page a full `snapshot`, which also drops the local chats' threads and pending moves; the real hook, the "server back" event, is phase 5 work. Way out for the relay as a whole: the page gets one connection object per server, over pass-through paths of the local server; phase 5 grows by the client work N04 S5 counts. The local server stays the client either way | Phase 5, first step; "server back" in phase 5 |
| The first message as one call (5.3): the message in the creation call, the chat's state in every answer, a refusal by the agent after its start, new values applied to an unstarted chat found by its id, "start not confirmed", the delete of a leftover, and the read of the chat with the page's reload of its thread once the outcome is settled. N07 S2 ran find-or-make by id only. A repeat that arrives after the chat was deleted there would make it again (N07, unknowns) | A message sent twice, a chat started there and shown as unstarted here, or a first message that is missing from the thread on screen. The call's own Go tests decide this before any local work rests on it. Way out for the missing message: the first-message call itself starts the local server's follow of that chat, and the local server passes on the events of that chat's id from the moment the call leaves, and not only once the chat is a record | Phase 5; the remote server's half has Go tests in phase 2 |
| The local server's work for a remote chat that nothing has run (sections 4 and 5.2): the local chat object replaced by a record at the first message; resolve and configure without local checks; lists by server in the page; the archived mark taken from the remote server, and a pending change passed on at once or at the next connect; the delete of a group that checks first | A remote folder replaced by the local default, a remote model refused, a local catalog overwritten by a remote one, an agent that keeps running under an archived chat, an archive made on the remote server's page that does not show or is taken back at a connect, a pending change that is lost, a group half deleted | Phase 5 |
| The start call (section 4, 5.8): find-or-make and start by a given id under a creation lock, a refusal that removes what the call made, the draft check, "start not confirmed". N07 S2 ran that shape for a chat only | A run started twice, or a draft left on the remote server. Way out: the draft lives on the remote server once that server is chosen, on today's routes | Phase 8, first step |
| A run with no client connected for its whole length, under the targeted send; the "no defaults" rule on a run; a chat created on a run by an API client; the run events by mark and by follow (section 4) | A run stalls when the client disconnects; a client's run changes the owner's defaults; a client misses a run's events | Phase 8 |
| The local server's work for a remote run (sections 4, 5.2, 5.4 and 5.8): a draft's choices by server, run records, the relay with its follows and with a run agent's chat that has no record, a chat on a remote run, archive, delete, outage and return; the size of a long run's detail and events on a poor link | A stale or slow task list, a transcript that stops, a local check that refuses a remote folder. Way out for following: the page reads the detail again on a timer | Phase 9, first step |
| Usable agents (section 4): the look-up on a timer, the `agents` event, the refusals, the subagent tools' list, the agent lists in the page | An agent is offered and fails at its start, or an installed one is missing; an existing test that names an agent with no program is refused | Phase 3 |
| Event volume of a busy remote server on a poor link (N04 S1); a real WAN with loss and jitter (T10) | Streamed text arrives late; AC15 and AC16 hold on the simulator only | Phase 5, on a real second machine |
| Sleep, wake and a change of network under the long stream (5.4) | An entry that stays "connected" on a dead stream until the pings are missed, or one that does not come back | Phase 5, on a laptop |
| Agent logins and the login `PATH` on a server started outside a login session, for example by a script at boot (T07 R2) | Chats and runs on the remote server fail to log in or do not find their agent programs, and its usable agents are fewer than what is installed. Way out: the owner starts the server in a normal login session | Phase 5, with the first chat on a second machine |
| Real agents' streaming sizes (T10 M6) | Slow streaming on a remote chat | Phase 5, a paid end-to-end run |
| The built bundle: where the script lands and whether it keeps its executable bit (N05 S2) | The README's command fails; calling it through `sh` is the guard | Phase 6 |
| Linux at runtime: only compiled so far (N05 S3, T07 R3) | The server, its certificate code or the scripts behave differently there | Phase 6; a run of the server on Linux before the server release is cut |
| "A message is sent, an agent runs" through an open port (T04 Q5 stopped before it) | Section 6 treats it as true; if it is not, the exposure is smaller than stated | Not run on purpose |

## 9. Questions

### Only the user can decide

| # | Question | Default | What changes otherwise |
|---|---|---|---|
| Q5 | Which systems must remote machines run? | macOS and Linux | Linux has only been compiled, never run `[run: T07 R3]`; dropping it removes that risk and two of the four builds |
| Q6 | Is using one remote server from several machines expected? | Yes: several clients at once, each with its own sidebar | If they should share one sidebar, the list-and-adopt screen of Q19 is needed |
| Q8 | What link quality must be supported? | Fully usable on "good"; correct and honest on "poor" (AC15, AC16) | If poor links must be fast, the streaming and thread-loading limits of section 8 move into the feature |
| Q10 | Should the remote server's log be readable from the app? | No; messages say where the log is on that machine | A new route on the remote listener |
| Q12 | Keep the research folder in the repository next to this plan? | Yes, while the plan is open | Citations then point at report names only |
| Q13 | Do remote servers reconnect at app start, and may that displace another client? | Reconnect: yes, by the local server at its start, with no action. Displace: no. A connection takes nothing; a board changes hands only by a user's action on that board (5.5) `[design]`. Not run: a risk of section 8 | Without the reconnect, remote chats and runs show no state until the user tests the entry |
| Q15 | Must loopback also need the secret? | No | Every local caller and the tests N01 S8 lists change; and the page cannot send a header on navigation `[run: N01 S3]` or on `EventSource` `[run: N02 S3]` |
| Q16 | Does the checkbox mean a pin? | Yes | "Skip verification": simpler; a client that skips it accepted a certificate with the wrong names `[run: N02 S2]`, so whoever can answer at the address on the VPN would get the secret |
| Q17 | May the client keep secrets in a 0600 file in its data folder? | Yes | The OS keychain: desktop app only and more work. It answered without a prompt in an unpackaged harness `[run: N02 S5]`; the packaged app was not tried |
| Q19 | Should a remote server's chats and runs that this client did not start be listed? | No | A list-and-adopt screen |
| Q20 | Does "only server (api) is exposed on https" mean that no page is served there? | Yes | The remote listener also serves the web client's files; navigation and `EventSource` cannot send the header `[run: N01 S3, N02 S3]`, so they need the secret some other way |
| Q21 | Does "New groups get defauls from ungrouped group" also hold for a subgroup? | No: a new top-level group copies the ungrouped group; a subgroup copies its parent, as today `[code: internal/defaults/defaults.go:64-75]` | Every new group copies the ungrouped group; seeding loses its parent rule, and `TestSeedSubgroupFromParent`, which passed unchanged `[run: N07 S5]`, changes |
| Q22 | The remote listener binds `0.0.0.0`, which is read as IPv4 only. Must it answer on IPv6 too? | No: IPv4 only | The listener binds the wildcard on network `tcp`, which answered IPv6 too `[run: N08 S1]`, and the names of the Host rule then cover IPv6 addresses |
| Q23 | Are boards on a remote server, and chats on them, part of this release? The second update says "This makes remote boards possible" | No. The role per board is built for every kind of client, and section 4 holds the design of a remote board | A phase after phase 5 builds what "Remote boards" lists; requirement 34 loses its board half, and the remote listener serves the board routes. New risks: a tool call through two bridges, a scene of megabytes through the relay, the 3 s timer of the hand-off on a poor link |
| Q25 | Is an id the client states itself enough to tell clients apart? | Yes, with one secret per server | A secret per client: the entries, set-up and `secret -new` change, and a server keeps a list of clients |
| Q26 | One remote group for all clients of a server, which its owner can rename, archive and delete? | Yes, named "Remote" | One group per client, with a name each client sends. Or a group the owner cannot remove: a second fixed key, with changes in three validators and in the web client |
| Q27 | Is it enough that a remote run's result stays in its folder on the remote machine? | Yes; the user fetches it by their own means, for example git | A new function that brings a branch or files to the client, with its own design |
| Q28 | Should a server's owner be able to allow its API clients chats but not runs? | No: a server with remote access on serves both; section 6 says what a run gives whoever holds the secret | A switch in the remote configuration, and the run routes answer 404 when it is off |

### Closed or dropped since the first version

- **Q1** (SSH as the only transport): closed by the user. No: HTTPS with a secret, behind the VPN.
- **Q2** (an entry by URL only): closed by the user's update, "it adds secret and host (url and port)": an
  entry is an address and a secret (5.1).
- **Q3** (may the Host check be changed): dropped. The loopback rule stays; the remote listener has its own.
- **Q4** (who installs and starts the remote server): closed by the user's update, which asks for scripts: the
  owner, with the scripts; the app does neither.
- **Q7** (must every connected server stay loaded): dropped. There is no page per server.
- **Q9** (host-key and passphrase questions in the app): dropped with SSH.
- **Q11** (the server list for browser-only use): closed by the design. Yes: the list is in the local server
  (section 4).
- **Q14** (a new secret at every start): closed by the second update, "It never creates the secret or the
  certificate". No start makes a secret: set-up makes it once, and only `secret -new` replaces it (section 4).
- **Q18** (runs, chats on a run, and chats on a board on a remote server). Runs: closed by the second update,
  yes (requirement 43). Boards: now Q23.
- **Q22, first form** (should the remote listener go back to one address the owner names): closed by the
  second update, "binds 0.0.0.0 for now". This plan builds no named address. Q22 now asks about IPv6.
- **Q24** (two clients in one chat at the same time): closed by the second update, "must not rule out two
  clients on the same chat (not a target)". Not built; section 4's avoided list keeps it possible.

### Open points left to implementation (not plan-critical)

| # | Open point | Default |
|---|---|---|
| U3 | Timing values: the time limits of calls passed on, with the longer limit of the first-message call (5.3), the back-off steps, how many missed pings make an outage, the limit of a test step | Start from what the runs used (N01 S7: 3 s for dial, handshake and answer headers; pings every 20 s) and from 5 s per test step. The first-message call waits for its answer longer than the 30 s that pi allows for its handshake (5.3). Tune in phase 5 |
| U4 | Whether a call that makes a chat says so in its answer, where the prototype answered 200 for "made" and for "found" alike (N07 S2) | The answer carries the chat's state, which is all the local server needs (5.3) |
| U5 | The timer of the hand-off, and how long a stopping server waits for its holders | Today's values: 3 s and 2 s `[code: internal/editorbridge/bridge.go:24, cmd/ai-whiteboard/main.go:224]` |
| U6 | Whether the page unfollows a thread when it drops it | Yes for a run agent's thread, which the page drops soon after its transcript closes `[code: web/src/conn.ts:427-428, 464-473, 475-484]`; no for other chats |
| U7 | How often a server looks its usable agents up again | Every 30 s, and at every check of an agent (section 4) |
| U8 | The time limits of a run's passed-on archive and delete, which wait up to 30 s on the remote server, and of the start call, which runs git | 45 s and 15 s; tune in phase 9 |
| U9 | The empty state's text, which names the three agents today | It names the local server's usable agents |

Two open points of the first version went with its design: U1, the port a remote start printed, and U2, the
page storage of a removed entry.

## 10. References

### Research reports

All in `plans/multiple-remote-servers-research/`, kept in the repository while the plan is open
`[user: Q12]`. Each starts with its summary.

- `T01.md` to `T12.md`, for the first version of this plan. T01 to T03 map the server, the desktop app and the
  web client; T04 to T12 record experiments. T05, T08, T11 and T12 belong to the design that was dropped (a
  page per server, the SSH tunnel, the hand-over between pages, several pages in one window); they are cited
  here only for what they show about today's app. T11's loss paths between two pages are what requirement 42
  is checked against, and T09's attacks from another origin what requirement 38 is checked against.
- `N01.md`: HTTPS and a header secret in the Go server, with Go as the client. `N02.md`: Electron as the
  client of such a server. `N03.md`: how a chat starts today, and the sticky defaults. `N04.md`: what binds a
  chat to its server. `N05.md`: build scripts, packaging, a server-only build and certificates. N03 and N04
  are readings of the code; what this plan takes from them carries a `[code: …]` mark.
- `N06.md`: a prototype of the API client, which receives the events of chats and acts on them without taking
  the active-client role. `N07.md`: a prototype in which an unstarted chat changes its agent, a chat is created
  with a given id, and the defaults work without "last used". Both were run as Go tests in a scratch copy at
  `9337940`, with stand-in agents. Neither patch is in the repository, and where the plan does not adopt what a
  prototype did, section 4 says so. The plan keeps what N06 showed about chat routes beside a page, and replaces
  its role by the client records of section 4.
- `N08.md`, for the second update: one Go program that listened on `0.0.0.0`, provoked port conflicts, loaded
  good and bad certificate and key files, and served HTTPS on a wildcard listener, on macOS. It served nothing
  through the machine's non-loopback address, with the macOS firewall on, so the plan cites it for loopback
  and for errors only.

### Documentation

- Go `crypto/tls`: https://pkg.go.dev/crypto/tls
- Go `crypto/x509`, `CreateCertificate`: https://pkg.go.dev/crypto/x509#CreateCertificate
- Go `net/http`, HTTP/2: https://pkg.go.dev/net/http#hdr-HTTP_2
- HTML standard, server-sent events: https://html.spec.whatwg.org/multipage/server-sent-events.html
