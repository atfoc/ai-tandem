# App as client: the checks by hand

Goal 7.4 of `app-as-client-goal.md` names four things that a test cannot show. This file turns each
into steps you run yourself, with what to look for. Run them on the merged branch, after
`AIWB_TEST_FULL=1 go test -timeout 20m ./...` and the JavaScript tests have passed.

Nothing here needs a paid agent. Where a step says "a chat", an idle chat with a typed draft is
enough.

## Setup for all four

The checks run in a scratch folder, with a scratch data folder and a scratch app folder, so that your
own AI Whiteboard (its data in `~/.ai-whiteboard`, its server, its port 6006) is not touched. Build
the app once and keep one shell with these variables:

```sh
cd <the repository, on the merged branch>
scripts/build-app.sh                       # makes bin/AI Whiteboard.app; no install

export CHECK=/tmp/aiwb-check
export APP="$PWD/bin/AI Whiteboard.app/Contents/MacOS/AI Whiteboard"
export BIN="$PWD/bin/AI Whiteboard.app/Contents/MacOS/ai-whiteboard"
export AIWB_MCP_PORT=16006                 # the hidden test-only MCP port, so that 6006 is left to your own server
```

A check starts the app like this (the three variables make it a separate instance: its own data
folder, its own app files, its own single-instance lock):

```sh
AIWB_HOME=$CHECK/data AIWB_USER_DATA=$CHECK/app "$APP" &
```

Quit it with ⌘Q between checks. To start a check from nothing, quit the app, stop its server
(`"$BIN" stop -home $CHECK/data`) and `rm -rf $CHECK`.

If you would rather use your real app and data, skip the variables, and stop your own server first
(only one server per machine can hold port 6006).

## 1. A first start on a machine that never ran AI Whiteboard, with the set-up run by hand

Best on a machine (or a user account) that never ran AI Whiteboard, with the app installed by
`scripts/install-app.sh` and no variable set. On your own machine the scratch folder stands in for
it.

1. `rm -rf $CHECK && mkdir -p $CHECK`, then start the app as above.
2. **The window opens at once**, before anything else happens. No "Starting…" window and no error
   dialog ever appears.
3. The first section of the sidebar is **This computer**. It says **Not started** and shows the
   reason, which reads `AI Whiteboard is not set up on this machine. Set it up once with: "<path>"
   remote setup -home "<folder>"`, with **Retry** and **Open server log** beside it. Its "+" and the
   Home screen's buttons are off. **Servers** (foot of the sidebar) shows **This computer** as its
   first row, with no edit or remove button.
4. In a terminal: `"$BIN" status -home $CHECK/data`. Expect `Running: no server`, `Files: not set up`
   and exit code 1 (`echo $?`).
5. Run the command the section named, but with a free port so that it cannot clash with another
   server: `"$BIN" remote setup -home $CHECK/data -port 14748`. Expect the port, the names, the
   fingerprint and `Next start: will listen`.
6. Without touching the app, wait up to half a minute, or press **Retry**. The section goes to
   **Connecting…** and then **Connected**, and its "+" works. Make a whiteboard and a chat in it.
7. `"$BIN" status -home $CHECK/data`: `Running: this build …`, `Address: https://127.0.0.1:14748`, the
   same fingerprint, `MCP listener: http://localhost:16006/mcp (up)`. **Servers** shows the same
   MCP line on the **This computer** row.
8. The client port needs the secret, and nothing else listens:

   ```sh
   S=$("$BIN" secret -home $CHECK/data)
   curl -sk https://127.0.0.1:14748/api/hello                      # JSON with featureLevel 6, no secret needed
   curl -sk -i https://127.0.0.1:14748/api/state | head -1         # 401
   curl -sk -H "X-AIWB-Secret: $S" -H "X-AIWB-Client: 5f0c2a7e-3b1d-4c6a-9e2f-7a8b9c0d1e2f" -H "X-AIWB-Level: 6" https://127.0.0.1:14748/    # 404 {"error":"not found"}: no page
   curl -s http://127.0.0.1:4747/ ; echo $?                        # nothing listens (7), unless your own old server runs
   ls $CHECK/data/servers.json                                     # no such file
   ```

9. ⌘Q the app. `status` still shows the server running, and so does the chat if one was working.
   Start the app again: the section fills again, with the whiteboard and the chat.

Look for: no step needs a typed address, secret or fingerprint for this computer; the failure is
shown in the section, in words that name the command; the app never blocks on the server.

## 2. An update from the version before, with a remote server in the list and with a server still running

The version before is `main` at `94d3798`. Build it beside this checkout and run its server in a
browser tab (the old version served its own page):

```sh
git worktree add /tmp/aiwb-old 94d3798
cd /tmp/aiwb-old
(cd web && npm ci && npm run build)
go build -o bin/ai-whiteboard ./cmd/ai-whiteboard
```

A. **The old list is not moved, and what lives on this computer is untouched.**

1. Make two old servers: this computer's (data `$CHECK/old`, page on port 14747) and a "remote" one
   (data `$CHECK/oldremote`, remote port 14748 on its own loopback server port 14750). Each needs
   its own MCP port:

   ```sh
   cd /tmp/aiwb-old
   AIWB_MCP_PORT=16007 bin/ai-whiteboard remote setup -home $CHECK/oldremote -port 14748 -server-port 14750 -name 127.0.0.1
   AIWB_MCP_PORT=16007 bin/ai-whiteboard launch -home $CHECK/oldremote -port 14750
   AIWB_MCP_PORT=16006 bin/ai-whiteboard launch -home $CHECK/old -port 14747
   S=$(bin/ai-whiteboard secret -home $CHECK/oldremote)
   ```

2. Open http://127.0.0.1:14747 in a browser. In **Servers** add the remote one
   (`https://127.0.0.1:14748`, the secret `$S`, **Self-signed certificate**, accept the fingerprint).
   Make a group, a whiteboard with a drawing, a chat with a draft and a prompt in the library on this
   computer, and a chat on the remote server. Check `ls $CHECK/old/servers.json`: it exists.
3. Stop both old servers: `bin/ai-whiteboard stop -home $CHECK/old -port 14747` and the same for
   `oldremote`. (`stop` of the old build takes the `-port` of its own page.)
4. Back in this checkout, start the new app on the old data folder: 
   `AIWB_HOME=$CHECK/old AIWB_USER_DATA=$CHECK/app "$APP" &` (the old data folder has no set-up).
5. **This computer** says **Not started** with the not-set-up reason (a server that never had remote
   access refuses to start). Run `"$BIN" remote setup -home $CHECK/old -port 14747`, then press
   **Retry**. Port 14747 is free again, so reuse it here, or choose another.
6. After it connects: `ls $CHECK/old/servers.json` is gone (the new server deleted it at its start,
   and any `servers.json.unreadable-*` with it). The group, the whiteboard with its drawing, the
   chat with its draft and the prompt are all there in **This computer**. **Servers** lists
   **This computer** only: the remote server is not there, and the page's theme, widths and last
   selection start fresh.
7. Bring the remote server to the new build and add it again. It keeps its set-up: 
   `AIWB_MCP_PORT=16007 "$BIN" launch -home $CHECK/oldremote`. Its secret, certificate, names and
   port (14748) are the old ones, so `$S` still works. In **Servers** choose **Add server** and add
   `https://127.0.0.1:14748` with `$S`; the fingerprint is asked for again. It connects, shows its
   section with the chat made before, and **This computer** keeps working while it is down
   (`"$BIN" stop -home $CHECK/oldremote`, then start it again).

B. **A server of the old build still running.**

1. Quit the app and stop the new server (`"$BIN" stop -home $CHECK/old`). Start the old server of the
   data folder again, and leave it running:
   `cd /tmp/aiwb-old && AIWB_MCP_PORT=16006 bin/ai-whiteboard launch -home $CHECK/old -port 14747`.
2. Start the new app on `$CHECK/old` as in A.4. No second server starts and no error dialog appears
   (`pgrep -fl "ai-whiteboard serve"` shows one). **This computer** says that its server is older than
   the app and offers **Restart server**. Its content is not shown (nothing of an old server is
   read).
3. The old server was set up before (A.5), so a restart works: press **Restart server**, confirm.
   The section says **Restarting…**, then **Connected** with the content back. `"$BIN" status -home
   $CHECK/old` now says `this build`. Had the set-up not been made, the restart would have been
   refused before it stopped anything, with the not-set-up reason.
4. Port 4747 is gone: `curl -s http://127.0.0.1:14747/` fails.

Optional: with the new server of step B.3 running, open the old page again at
`http://127.0.0.1:14747`. It does not load, since nothing serves a page; the old app of the
version before, as a client of the new server, is refused with the sentence `This app is too old for
this server: update AI Whiteboard on the machine that connects.` (visible in the new server's log).

## 3. Killing this computer's server while a chat is open and while a board is drawn on

Run in a scratch app as in check 1 (set up and connected). Make a whiteboard and a chat; for a good
look also add a remote server so that there is a second section.

1. Open the whiteboard and draw a few shapes. Open a chat (of the board, or a plain one) and type a
   draft into its composer without sending it. Note the draft's text.
2. Kill the server hard: take the pid from `"$BIN" status -home $CHECK/data` (the first line) and run
   `kill -9 <pid>`.
3. Within a few seconds expect, with no dialog and the page not loaded again:
   - **This computer**'s section goes to **Unreachable** (not connected) and then, by itself, back to
     **Connected**: the app starts the server again at intervals of 1, 2, 5, 10 and 30 seconds. The
     page keeps what it had on screen and does not flash or scroll back to the start.
   - The open chat stays on screen, read-only, under a warning that names "This computer"; the
     composer takes no typing and keeps your draft. When the server is back the warning goes and the
     draft is saved to the server (leave the chat and open it again: the draft is there).
   - The board stays open and can be drawn on; a banner says the changes are not saved. When the
     server is back they are saved: close the window's board and reopen it, or read
     `$CHECK/data/boards/<id>/drawing.excalidraw`.
   - The remote section, if there is one, stays **Connected** the whole time.
4. Repeat with `"$BIN" stop -home $CHECK/data` (the server stops cleanly) and with `"$BIN" secret -new
   -home $CHECK/data` (the server stays up, the section drops and returns once the app has read the
   new secret).
5. Kill it while a drawing is being saved: draw continuously and kill the server in the middle of
   a stroke. Nothing the app showed as saved is lost after the return, and the app does not show a
   save as done that was not.
6. Finally, take the remote server down (`stop` its home) and kill this computer's server too: each
   section reports its own state, and each returns by itself when its server is back.

Look for: a dead server is a state of the section and nothing more; nothing asks the user to restart
the app.

## 4. Two machines, each with the app, each a client of the other

Needs two Macs on one network, called A and B. On each, install the app
(`scripts/build-app.sh` and `scripts/install-app.sh`; the app is not signed, so open it the first
time from Finder with a right click), and quit your other AI Whiteboard instances so that 6006 is
free.

1. On each machine, set its server up and note what is printed. Use the name the other machine
   reaches it by:

   ```sh
   ~/Applications/AI\ Whiteboard.app/Contents/MacOS/ai-whiteboard remote setup -name <this machine's name or IP>
   ~/Applications/AI\ Whiteboard.app/Contents/MacOS/ai-whiteboard secret
   ```

   Allow `ai-whiteboard` through the firewall when macOS asks. Then open the app on both. Each shows
   **Connected** for **This computer**.
2. On A: **Servers**, **Add server**, name "B", address `https://<B>:4748`, B's secret, tick
   **Self-signed certificate**. The app shows B's fingerprint: compare it with the one printed on B
   and accept it only when they are the same. Do the same on B for A.
3. Each app now has two sections: its own **This computer** first, and the other machine below. On A,
   make a chat and a whiteboard in B's section and draw on the board. Expect:
   - the chat runs on B: B's app shows it in B's **This computer** section at once, with B's folders
     and B's agents; its working folder is a folder of B;
   - the drawing is on B (`~/.ai-whiteboard/boards/<id>/drawing.excalidraw` there), and A stores
     nothing of it (`ls ~/.ai-whiteboard` on A has no record of it);
   - B's app opens the same board: A's window gets the take-over panel, and **Use here** takes it
     back.
4. Make the same on B, in A's section, and then have both apps open the same chat of A at the same
   time: both see the thread grow.
5. B's own section in A shows B's tree only: no section of B's list appears in A (no chain), and no
   entry can be added for the machine itself: adding `https://<A>:4748` to A's own list says
   "This is this computer's server".
6. Quit the app on A (⌘Q). B's section for A stays **Connected**: A's server keeps running, and a
   chat of B on A keeps working. Kill A's server (`ai-whiteboard stop`): B's section for A drops, B's
   **This computer** is untouched; when A's app is opened again A's server starts and B's section
   reconnects by itself, with no new accept.
7. Replace A's secret (`ai-whiteboard secret -new` on A): B's section for A says **Secret not accepted**.
   Edit the entry in B's **Servers** with the new secret and it connects.

Look for: the two apps behave alike for the two servers; no role is "owner" or "client";
the secret never shows in a page (it appears only in the **Servers** form when you type it).

## When a check fails

Note the step, the state the section showed and the lines the app printed (`[conn] …` in the terminal
that started it) and the server's log (`$CHECK/data/server.log`, or **Open server log**), and say
which check it was. Do not run the paid suites to look into it.
