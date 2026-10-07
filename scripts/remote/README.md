# AI Whiteboard server

This folder is the AI Whiteboard server for one machine: the program `ai-whiteboard`, the web
client it serves (`web/`) and two scripts. Use it to run AI Whiteboard on a machine that the app
on another machine connects to, a remote server. There is no installer and no service file: the
folder runs from wherever it is.

A remote server is meant for a private network or a VPN. Its remote port listens on every IPv4
address of the machine, over HTTPS and behind a secret; keeping the port off the internet is up
to the machine's network and firewall.

## What the machine needs

- macOS or Linux, on the processor this folder was built for (the folder's name says which).
- At least one agent CLI, installed and logged in for the user that runs the server: `claude`
  (Claude Code), `agent` (Cursor CLI) or `pi`, on that user's `PATH`.
- git 2.27 or newer for runs that use git.
- Port 6006 free: the server's MCP listener is always there, so one server per machine.

## Install and set up

1. Copy this folder to the machine, anywhere, for example `~/ai-whiteboard-server`.
2. Set remote access up. It asks nothing:

   ```sh
   sh ~/ai-whiteboard-server/setup-remote.sh
   ```

   It prints the addresses (every name and address the machine has, with the port, 4748), the
   fingerprint of the server's certificate, and the secret. Run again, it changes nothing and
   prints the same.
3. Start the server:

   ```sh
   sh ~/ai-whiteboard-server/start-server.sh
   ```

   It starts the server in the background and prints its local URL. The server keeps running
   after you log out; it does not start by itself after a reboot.
4. In the app on your own machine open **Servers**, choose **Add server** and enter one of the
   addresses, the secret, and tick **Self-signed certificate**. Compare the fingerprint the app
   shows with the one set-up printed, and accept it only when they are the same.

On macOS with the firewall on, incoming connections to the server can be blocked: allow
`ai-whiteboard` when macOS asks, or add it in System Settings, Network, Firewall.

## The scripts

`setup-remote.sh [--name NAME]... [--port N] [--new-cert] [--new-secret] [--home DIR] [--server-port N]`

| Option            | What it does                                                                        |
| ----------------- | ----------------------------------------------------------------------------------- |
| `--name NAME`     | adds a DNS name or IPv4 address that clients reach this machine by; may be repeated |
| `--port N`        | the remote port (default: keep it, or 4748 at the first set-up)                     |
| `--new-cert`      | replaces the key and the certificate: every client must accept the new fingerprint  |
| `--new-secret`    | replaces the secret: every client needs the new one; a running server takes it at once |
| `--home DIR`      | the data folder (default `~/.ai-whiteboard`)                                        |
| `--server-port N` | the server's own port, when it is not the running server's or 4747                  |

`start-server.sh [--restart] [server flags]`

`--restart`, as the first argument, stops the running server first. Everything else is passed on
to the server as it is: `-home DIR` for the data folder, `-port N` for the server's own port
(default 4747, on 127.0.0.1 only), `-cwd DIR` for the default working folder of new chats.

## Commands

```sh
./ai-whiteboard remote status   # off or listening, port, names, fingerprint; whether the next start will work
./ai-whiteboard remote off      # removes the remote configuration; takes effect at the next start
./ai-whiteboard secret          # prints the secret
./ai-whiteboard stop            # stops the server
```

`remote status` never shows the secret. `remote off` keeps the secret, the key and the
certificate, so a later set-up gives the same secret and fingerprint. A changed set-up (a new
port, a new certificate, `remote off`) takes effect when the server starts again:
`sh start-server.sh --restart`. A new secret is taken by a running server at once, and its
clients are disconnected until they have it.

When the server does not start, the command says why and how to repair it; the server's log is
`server.log` in the data folder.

## Update

Stop the server (`./ai-whiteboard stop`), replace this folder with the new one and start it
again. The data folder, with the set-up, is not in this folder and stays as it is.
