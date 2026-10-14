# Server commands and flags

The commands of the `ai-whiteboard` binary, what each prints, and the flags of `serve`, `launch` and `relaunch`.

```sh
ai-whiteboard [serve]    # run the server in the foreground
ai-whiteboard launch     # start it in the background if it isn't running, print its address and fingerprint
ai-whiteboard relaunch   # stop the running server, then launch
ai-whiteboard stop       # stop the running server
ai-whiteboard status     # what the running server serves, and what the next start will do
ai-whiteboard secret     # print the secret
ai-whiteboard remote setup   # set the server up, once, before its first start
```

The server has one API, for clients, over HTTPS behind a secret, and serves no page. It runs only
after its set-up: **`serve`, `launch` and `relaunch` refuse to start a server that was never set
up**, exit 1, and say:

```
AI Whiteboard is not set up on this machine. Set it up once with: "<program>" remote setup
```

(with ` -home "<folder>"` added when the data folder is not the default). Set-up is a command you
run by hand, once, on the machine; see
[Use a server on another machine](remote-servers.md#use-a-server-on-another-machine).

## Set-up, secret and status

| Command | What it does |
| ------- | ------------ |
| `remote setup` | makes what is missing (secret, key and certificate, configuration) and replaces nothing; prints port, names and fingerprint, and whether the next start will work. `-port N` sets the client port (4748 at first), `-name X` adds a name or IPv4 address to the certificate (may be repeated) |
| `remote setup -new-cert` | replaces the key and the certificate; every client has to accept the new fingerprint |
| `status` | what the running server serves (address, port, names, fingerprint, the MCP listener) and what the files say for the next start, with the reason when the server will not start. Never the secret. `-json` writes one JSON object |
| `secret` | prints the secret |
| `secret -new` | replaces the secret and prints the new one; a running server takes it at once and disconnects its clients |

`remote setup`, `status`, `secret` and `stop` take `-home` for the data folder (`~/.ai-whiteboard`
by default) and no flag of the server. They exit 1 when they refuse or fail, and `remote setup`
and `status` also when the files are written or read and the server will not start with them: the
message says which file or port, and the command that repairs it. A server whose set-up is broken
does not start at all.

`status` prints, for example:

```
Running: this build 1.2.3 (pid 4242)
Address: https://127.0.0.1:4748
Port: 4748
Names: mac.local, 192.168.1.20
Fingerprint: AB:CD:…
MCP listener: http://localhost:6006/mcp (up)
Files: the next start will listen
Port: 4748
Names: mac.local, 192.168.1.20
Fingerprint: AB:CD:…
```

The first `Port:`, `Names:` and `Fingerprint:` are the running server's, the ones after `Files:` are
what its files say, which a new start will use. With no server running the first line is
`Running: no server`; a server of the build before shows as `Running: older build …`. With
`-json` the object has `running` (null, or the build, version, pid, feature level, the client
listener and the MCP listener with the chats that contacted it) and `files` (whether it is set up,
whether the next start works, the port, names and fingerprint, and the message when it does not).
A changed set-up takes effect at the server's next start, except a new secret.

## Starting and stopping

`launch` finds a running server or starts one in the background, detached from the command, and
prints:

```
AI Whiteboard is running.
Address: https://127.0.0.1:4748
Fingerprint: AB:CD:…
```

The address is the one the client listener has on this machine, and the fingerprint is that of its
certificate. For a running server of the build before, `launch` says so and names `relaunch`
instead. `-json` prints one line of JSON and nothing else (`state`, `address`, `fingerprint`,
`version`, `featureLevel`, `instanceId`, `pid` and `home`, or `state: "old_build"` with the
version, feature level and pid); the desktop app reads that. When the start fails it exits 1 with
the reason on stderr. Two `launch` commands at the same time take turns: the second finds the
server the first started. `relaunch` stops the running server (of this build or the one before)
and launches; it refuses before it stops anything when the server would not start. `stop` stops
it; `serve` beside a running server says so and exits 0. Every command that looks for a running
server finds one of this build and one of the build before.

`remote status` and `remote off` are gone: `remote status` is `status`, and there is no remote
access to turn off, since the client listener is always HTTPS with the secret. Both words answer
exit 2 with a sentence that says so.

## Flags

The flags of `serve`, `launch` and `relaunch` (`-json` is for the last two):

| Flag       | Default            | What it does                              |
| ---------- | ------------------ | ----------------------------------------- |
| `-home`    | `~/.ai-whiteboard` | data folder for boards and chats          |
| `-cwd`     | current folder     | default working folder for new chats      |
| `-claude`  | `claude`           | Claude Code binary                        |
| `-cursor`  | `agent`            | Cursor agent binary                       |
| `-cursor-cost` | `cursor-cost`  | binary that reports the Cursor plan's usage (`~/bin` is tried too) |
| `-pi`      | `pi`               | pi binary                                 |
| `-pi-namer-model` | pi's default | pi model used to name new chats (empty = the CLI's current model) |
| `-json`    | off                | `launch` and `relaunch` only: one JSON line for the app |

There is no flag for the port or for a web client to serve: the client port is the one the set-up
made, and the server serves no page. At boot the server logs `pi <version> at <path>` (or a warning
when pi is missing), so a broken pi install is visible without failing startup: pi chats then show
the error in the chat.

There is no MCP port flag. The MCP listener is always on 6006, because Cursor's org allowlist
approves exactly `http://localhost:6006/mcp`; the only other value is a hidden test-only override.
Only one AI Whiteboard instance per machine can serve MCP: if 6006 is taken the app refuses to
start (see [Port 6006 is taken](troubleshooting.md#port-6006-is-taken)).
