# Troubleshooting the board MCP

How to check that the board MCP listener is up and an agent has connected, how to probe the endpoint by hand, what the server log says, and what to do when Cursor shows no board tools, an agent says a board is not open, a board is view only, port 6006 is taken, or this computer's server does not start.

The board tools reach agents over one fixed MCP endpoint. Cursor hides MCP load failures in its
ACP layer, so check the app side first.

## Is the listener up and has an agent connected?

The listener's state is on this computer's row in **Servers** (`MCP listener: http://localhost:6006/mcp (up)`),
and the server program prints it. With the app installed, from a terminal:

```sh
~/Applications/AI\ Whiteboard.app/Contents/MacOS/ai-whiteboard status          # the line "MCP listener: ... (up)"
~/Applications/AI\ Whiteboard.app/Contents/MacOS/ai-whiteboard status -json | python3 -m json.tool
```

(`bin/ai-whiteboard` of a checkout does the same; add `-home DIR` for a server whose data folder is
not `~/.ai-whiteboard`.) The JSON has, under `running.mcp`, the listener (`port`, the exact
advertised `url`, `up`) and one entry per chat that has contacted MCP, most recent first. `chat` is the first 8 characters of the chat's id (a UUID),
so it is a bare short id with no prefix. It is read-only and exposes no token and no board
content; an entry with `"chat": "unknown"` means a client connected with a credential that
resolves to no board chat, and no entry for a chat after a prompt means its agent never loaded the
MCP server, or never used a board tool.

```json
{
  "listener": { "port": 6006, "url": "http://localhost:6006/mcp", "up": true },
  "chats": [
    { "chat": "1a2b3c4d", "client": "Cursor", "clientVersion": "...", "method": "tools/call",
      "tool": "read_board", "outcome": "ok", "at": "2026-01-01T00:00:00Z" }
  ]
}
```

That is the value of `running.mcp`.

## Probe the endpoint by hand

A chat's token is in the chat's `chat.json` in the app's data folder, under `"token"`
(the app never prints it). POST an MCP `initialize` exactly as an agent would:

```sh
curl -sS -X POST http://localhost:6006/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <chat token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"curl","version":"0"}}}'
```

A 200 whose result has `serverInfo.name` `board` means the listener is reachable and the Host
check passed. Replace the method with `tools/list` to see the tools for that chat (spawn family on
every chat; board tools only on board chats; none for an archived chat). `curl` may use either
the `localhost` or `127.0.0.1` spelling; **agents must never be configured with `127.0.0.1`** (see
the [MCP listener](architecture.md)). The `initialize` and `tools/list` handshakes are permissive, so an unknown token still
answers them with an empty list; the `tools/call` then returns tool text (`isError`), never HTTP 401.

## The server log

Each MCP event is one line in the server log (stderr: the foreground `serve` output, or the log
`launch` writes):

```
mcp initialize chat=1a2b3c4d client="Cursor" version="..."
mcp tools/call chat=1a2b3c4d tool="read_board" outcome=ok
```

An unknown credential logs `chat=unknown`. The token itself is never logged, and tool arguments
are not logged.

## Cursor shows no board tools (silent ACP failure)

1. `ai-whiteboard status -json` (or the `mcp initialize` log line) shows no contact for the chat: the
   MCP server was never loaded, or the prompt never used a board tool.
2. Cursor's own debug log is at `$TMPDIR/cursor-agent-logs-<uid>/latest.log`. Search it for
   `Failed to load ACP session MCP server` and `Blocked by team policy`. A `Blocked by team
   policy` line means the configured URL does not match the org allowlist exactly.
3. Functional check: ask the Cursor chat to call `read_board`. Expect an `mcp__board__*` card. A
   reply that claims it has no board tools, with no server-side contact, is the silent-failure
   signature.
4. URL audit: a unit test pins the exact `http://localhost:6006/mcp` string for every spawner, so
   an accidental query, path, trailing slash or host spelling fails CI.

## An agent says the board is not open, or nobody is editing it

An agent can read and change a board with no window open, because the server runs the headless
writer for the boards no window holds ([Who changes a board](architecture.md#who-changes-a-board)).
When it cannot, the board tool answers with one of these, and the agent stops and tells you:

| The agent is told | What it means |
| ----------------- | ------------- |
| "The board isn't open: the AI Whiteboard window is closed. Board work needs the window open. …" | the headless writer is not available on this server and no window is connected |
| "Nobody is editing this board in a window, and this server cannot edit a board without one. Tell the user that they can press Edit here on the board; …" | the headless writer is not available, and a window is connected: press **Edit here** on the board, and ask the agent again |
| "The board's background editor stopped while it ran this call, so the call did not finish. …" | the headless writer died or was killed during the call; the board is as it was after the last finished change and has no writer. The agent's next call starts a new one |
| "The board was taken over in a window while this call ran, so the call did not finish. …" | someone pressed **Edit here** (or the board was archived or deleted) during the call; the earlier changes are saved |
| "The window that held the board did not answer in time, so this call did not finish, and that window no longer holds the board. The board is as it was after its last saved change, which may or may not include this call's change. Read the board again (read_board) before you change it." | a change (`apply`, `delete_elements`) was given to a window that holds the board and did not answer within 30 seconds; that window lost the board, which has no writer now, and the call is not repeated, since the window may have made the change. The agent's next call goes to the headless writer or to a window that took the board. A read is not told this: it is given again to the headless writer and answered late |
| "The window that held the board did not answer in time, so this read did not finish, and that window no longer holds the board. Nothing was changed. Call it again." | a read (`read_board`, `get_image`) was given again after a window did not answer it, to a window that had pressed **Edit here** meanwhile, and that window did not answer within 30 seconds either; it lost the board too, and the agent's next call goes to the headless writer |
| "TAKEN: … is being taken over in a window; call again in a moment and that window answers." | the headless writer was giving the board up when the call came |
| "SAVE_FAILED: the change was made but could not be saved: …" | the headless writer made the change and could not write it; the board file does not have it |

If the first two come when you expect the headless writer to work, ask the server:

```sh
~/Applications/AI\ Whiteboard.app/Contents/MacOS/ai-whiteboard status    # the line "Headless writer: …"
```

`Headless writer: not available: <reason>` names what is missing:

- **No Node.** The server uses, in this order, the program of `-headless-node` (or the variable
  `AIWB_HEADLESS_NODE`), the desktop app's own Electron when the server runs from inside the Mac
  app, and `node` on the `PATH` of the server, which must be version 22 or later. A server started from a
  launcher may have a shorter `PATH` than your terminal: give the full path with `-headless-node`.
- **No bundle, or one of another version.** The folder with `headless.mjs` and `manifest.json` is
  `-headless-dir`, else `Resources/headless/` of the Mac app, else `headless/` beside the server
  program. A bundle whose `manifest.json` names another version than the server is not used: the
  reason names both versions. Put the bundle of the server's build there. A server built from source
  without a version (`dev`) takes any bundle.
- **A start that failed.** The reason is the one the process gave. The usual ones are in its engine:
  a file of `engine/` is missing (the reason names it), or the native canvas
  (`engine/node_modules/skia-canvas/lib/skia.node`) does not load because the folder was built for
  another system or processor than the machine's. Copy the whole folder that
  `scripts/build-server.sh` made for this machine. A failed start is remembered for a minute, and calls in that minute fail at once; after
  that the next call tries again, and looks for Node and the bundle again. The server log has one line
  with the reason, and every line of the process starts with `headless:`.

An agent's picture or a text's size can be wrong on a Linux server although the writer runs: text outside
Excalidraw's own fonts (Chinese, Japanese, Korean, emoji, Arabic, Hebrew, Thai) is measured with the
machine's fonts, and a bare Linux server has none for CJK or emoji. Install **Noto Sans CJK** and
**Noto Color Emoji** (on Debian and Ubuntu `sudo apt install fonts-noto-cjk fonts-noto-color-emoji`). Latin,
accented Latin, Cyrillic and Greek need nothing: they are in the app's own fonts.

`Headless writer: available, not running` is the usual state when no agent is working away: it
starts at the first call that needs it and stops by itself, a few seconds after it holds no board.

## A board is "View only"

That is a reader: the board is shown, and follows its writer live, and the bar over it says who writes
(another window, an agent, or nobody). Press **Edit here** to become the writer; the writer, a window or
the headless writer, saves what it has and lets go. Opening a board, switching to it or connecting never
makes a window the writer, and neither does a restart of the server or a lost connection: a window that
was drawing on a board comes back as a reader. A change made while the connection was down is kept in
the window and saved when you press **Edit here** if the board has not moved on meanwhile; if it has,
the window says that the change was dropped. If the writer does not let go within 10 seconds, the board
is taken from it and its later saves are refused. So is a board whose window does not answer an agent's
call within 30 seconds: the window is a reader from then on, and the agent's next call goes to the headless
writer.

## Port 6006 is taken

The app binds 6006 before it writes `server.json`. If it cannot, it exits without touching the
running instance and prints:

```
cannot serve the MCP endpoint on port 6006: ... address already in use
Port 6006 is probably held by another AI Whiteboard instance (for a different data folder) or by another program.
Stop that instance or free port 6006, then start AI Whiteboard again.
```

`launch`/`relaunch` report the server stopped while starting with that message in the log tail,
and this computer's section of the sidebar shows it as the reason the server did not start.
Because the port is fixed, exactly one instance can serve MCP per machine, so stop a running app
before the default e2e run (see [Development](development.md)).

## This computer's server does not start

This computer's section of the sidebar says **Not started** and gives the reason the start gave;
**Open server log** opens `server.log` in the data folder. The app tries again by itself, and
**Retry** tries at once. The usual reasons:

- **AI Whiteboard is not set up on this machine.** A server never starts before its set-up. Run
  the command the reason names, once (`ai-whiteboard remote setup`; see
  [Use a server on another machine](remote-servers.md#use-a-server-on-another-machine)), then
  press **Retry**.
- **Port 6006 is taken**, by another AI Whiteboard instance or another program (see above).
- **A set-up that is broken**, a missing or unreadable file or a port in use: the message names the
  file or port and the command that repairs it. `ai-whiteboard status` shows the same.
- **The server is of another build** than the app, or older: the section says so and offers
  **Restart server**.
