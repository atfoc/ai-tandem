# AI Whiteboard server

This folder is the AI Whiteboard server for one machine: the program `ai-whiteboard`, two
scripts and `headless/`, the program that edits boards while no window is open. The server serves no page; the app is its client, and the app on another machine connects
to it. There is no installer and no service file: the folder runs from wherever it is.

A server is meant for a private network or a VPN. Its client port listens on every IPv4 address of
the machine, over HTTPS and behind a secret; keeping the port off the internet is up to the
machine's network and firewall. A server that was never set up does not start.

## What the machine needs

- macOS or Linux, on the processor this folder was built for (the folder's name says which). A
  `windows` folder holds `ai-whiteboard.exe` and `headless/`, but the two scripts here are shell scripts
  that are not made to run on Windows, and the agents are not covered there: it has not been run on a Windows
  computer yet.
- At least one agent CLI, installed and logged in for the user that runs the server: `claude`
  (Claude Code), `agent` (Cursor CLI) or `pi`, on that user's `PATH`.
- For editing boards with no window open: **Node 22 or later** on the server user's `PATH` (`node
  --version`). See "Editing boards with no window open" below. Without it the server works as before.
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

   It starts the server in the background and prints its address and the fingerprint of its
   certificate. The server keeps running after you log out; it does not start by itself after a
   reboot. Run before the set-up, it says so and starts nothing.
4. In the app on your own machine open **Servers**, choose **Add server** and enter one of the
   addresses, the secret, and tick **Self-signed certificate**. Compare the fingerprint the app
   shows with the one set-up printed, and accept it only when they are the same.

On macOS with the firewall on, incoming connections to the server can be blocked: allow
`ai-whiteboard` when macOS asks, or add it in System Settings, Network, Firewall.

## Editing boards with no window open

An agent can change a board while the app is closed. The server then starts the **headless writer**,
the program in `headless/` (`headless.mjs`, `manifest.json` and `engine/`, which holds the board
engine, Excalidraw's fonts and the native canvas built for this machine's system and processor), and it
ends again when the work is done. Nothing is started when the server starts. The server looks for it next to
its own binary (`headless/`) and for a Node to run it with in this order: `-headless-node PATH` (or the
environment variable `AIWB_HEADLESS_NODE`), then `node` on the `PATH`, which must be version 22 or later.
Nothing else is installed: the canvas has no system libraries to add.

- **Node 22 or later** on the `PATH` of the user that runs the server. The agent CLIs mostly need
  one already. Without Node, or with an older one, the server works as before: boards change only
  while a window has them open, and an agent that asks for more is told so. The Mac app needs no Node:
  the server inside it uses the app's own Electron.
- **Keep `headless/` next to `ai-whiteboard`**, as the folder is, and copy the whole folder. The
  writer is one build with the server: `headless/manifest.json` names the version, and a `headless/`
  of another version than the server is not used (the server's log says so; a server built from source
  with no version takes any). `engine/` holds a native file, `node_modules/skia-canvas/lib/skia.node`,
  for this folder's operating system and processor only, and it needs glibc on Linux (Debian, Ubuntu,
  Fedora and the like; not Alpine).
- **What the sizes are measured with.** Text in Excalidraw's own fonts (Latin, accented Latin,
  Vietnamese, Cyrillic, Greek) is measured with the font files in `engine/fonts/`, the ones a window
  uses, so it comes out as in a window. Text in other scripts is measured with the machine's fonts, as a window
  does on its machine.
- **Linux fonts.** Text outside Excalidraw's own fonts (Chinese, Japanese and Korean text, emoji,
  and the like) is measured and drawn with the machine's fonts. For CJK and emoji install **Noto
  Sans CJK** and **Noto Color Emoji** (on Debian and Ubuntu `sudo apt install fonts-noto-cjk
  fonts-noto-color-emoji`; on Fedora `google-noto-sans-cjk-fonts` and `google-noto-color-emoji-fonts`).
  Without them such characters have no glyphs on the machine, so the sizes the writer stores for
  them and the pictures it draws are wrong. On macOS the system fonts cover them (the width of
  Chinese and Japanese text can differ by up to 1.3% from what a window on a Mac stores).
- `./ai-whiteboard status -json` has a `headless` object: whether it is `available` and, when it is
  not, the `reason` (no Node, an old Node, no `headless/`, another version, or a start that failed,
  for example a `headless/` built for another system).

## The scripts

`setup-remote.sh [--name NAME]... [--port N] [--new-cert] [--new-secret] [--home DIR]`

| Option            | What it does                                                                        |
| ----------------- | ----------------------------------------------------------------------------------- |
| `--name NAME`     | adds a DNS name or IPv4 address that clients reach this machine by; may be repeated |
| `--port N`        | the client port (default: keep it, or 4748 at the first set-up)                     |
| `--new-cert`      | replaces the key and the certificate: every client must accept the new fingerprint  |
| `--new-secret`    | replaces the secret: every client needs the new one; a running server takes it at once |
| `--home DIR`      | the data folder (default `~/.ai-whiteboard`)                                        |

`start-server.sh [--restart] [server flags]`

`--restart`, as the first argument, stops the running server first. Everything else is passed on
to the server as it is: `-home DIR` for the data folder and `-cwd DIR` for the default working
folder of new chats.

## Commands

```sh
./ai-whiteboard status          # what the running server serves (address, port, names, fingerprint, the MCP listener) and what the next start will do
./ai-whiteboard status -json    # the same as one JSON object
./ai-whiteboard secret          # prints the secret
./ai-whiteboard secret -new     # replaces the secret and prints the new one
./ai-whiteboard stop            # stops the server
```

`status` never shows the secret. A changed set-up (a new port, a new certificate) takes effect
when the server starts again: `sh start-server.sh --restart`; until then `status` shows both what
the running server serves and what the next start will do. A new secret is taken by a running
server at once, and its clients are disconnected until they have it. There is no command that
turns client access off: a server always serves its clients over HTTPS with the secret.

When the server does not start, the command says why and how to repair it; the server's log is
`server.log` in the data folder.

## Update

Stop the server (`./ai-whiteboard stop`), replace this folder (with its `headless/`) with the new
one and start it again. The data folder, with the set-up, is not in this folder and stays as it is.
