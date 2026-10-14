# Troubleshooting the board MCP

How to check that the board MCP listener is up and an agent has connected, how to probe the endpoint by hand, what the server log says, and what to do when Cursor shows no board tools, port 6006 is taken, or this computer's server does not start.

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
