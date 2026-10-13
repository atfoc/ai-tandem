# Server commands and flags

The commands of the `ai-whiteboard` binary, the commands for remote access, and the flags of `serve`, `launch`, `relaunch` and `stop`.

```sh
ai-whiteboard [serve]   # run the server in the foreground
ai-whiteboard launch    # start it in the background if it isn't running, print its URL
ai-whiteboard relaunch  # stop the running server, then launch
ai-whiteboard stop      # stop the running server
```

The commands for remote access (see
[Use a server on another machine](remote-servers.md#use-a-server-on-another-machine)):

| Command                  | What it does |
| ------------------------ | ------------ |
| `remote setup`           | makes what is missing (secret, key and certificate, configuration) and replaces nothing; prints port, names, fingerprint and the server's own port, and whether the next start will work. `-port N` sets the remote port (4748 at first), `-name X` adds a name or IPv4 address (may be repeated) |
| `remote setup -new-cert` | replaces the key and the certificate |
| `remote status`          | what the running server does (off, or listening with port, names and fingerprint) and what the files say for the next start, with the reason when the server will not start. Never the secret |
| `remote off`             | removes the remote configuration only; a running server keeps listening until its next start, and a later set-up gives the same secret and fingerprint |
| `secret`                 | prints the secret |
| `secret -new`            | replaces the secret and prints the new one; a running server takes it at once and disconnects its clients |

Each takes `-home` for the data folder; `remote setup` and `remote status` take `-server-port`
for the server's own port when it is not the running server's or 4747. They exit 1 when they
refuse or fail, and also when the files are written and the server will not start with them: the
message says which file or port, and the command that repairs it. A server whose remote set-up
is broken does not start at all. The flags in the table below belong to `serve`, `launch`,
`relaunch` and `stop`.

| Flag       | Default            | What it does                              |
| ---------- | ------------------ | ----------------------------------------- |
| `-port`    | `4747`             | port to listen on                         |
| `-home`    | `~/.ai-whiteboard` | data folder for boards and chats          |
| `-cwd`     | current folder     | default working folder for new chats      |
| `-client`  | `web/dist`         | built web client to serve                 |
| `-claude`  | `claude`           | Claude Code binary                        |
| `-cursor`  | `agent`            | Cursor agent binary                       |
| `-pi`      | `pi`               | pi binary                                 |
| `-pi-namer-model` | pi's default | pi model used to name new chats (empty = the CLI's current model) |

At boot the server logs `pi <version> at <path>` (or a warning when pi is missing), so a broken pi
install is visible without failing startup: pi chats then show the error in the chat.

There is no MCP port flag. The MCP listener is always on 6006, because Cursor's org allowlist
approves exactly `http://localhost:6006/mcp`; the only other value is a hidden test-only override.
Only one AI Whiteboard instance per machine can serve MCP: if 6006 is taken the app refuses to
start (see [Port 6006 is taken](troubleshooting.md#port-6006-is-taken)).
