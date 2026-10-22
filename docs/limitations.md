# Limitations

What the app does not do, or does not do fully, and the limits it enforces.

- The app is the only client. AI Whiteboard is not used in a browser tab, and a machine without the
  app cannot show it whatever server runs on it. The app runs on macOS (the desktop app), on an iPhone
  and an iPad, and on Android; the server alone also builds for Linux, and is used from the app on
  any of those. A Windows app can be built, as an unpacked folder, but it has not been run on a Windows
  computer yet (see the [Windows notes](development.md#windows)). There is no Linux app.
- A phone or tablet has no server of its own, so its first section is not "this computer": it shows the
  servers you add. It is put on a device with a script, not from a store (see
  [Build and develop](development.md#install-the-app-on-a-phone-or-tablet)). What the device tests
  cannot do is checked by hand: drawing on the board with a finger or a Pencil, the code scan with a real
  camera, HEIC pictures from the iOS library, the local network permission prompt, an app suspended and
  resumed.
- One window changes a board at a time. The others show it read-only and follow it live; there is no
  merging and no drawing together. Anyone who may use the server may press **Edit here** and take the board.
- An agent working on a board that no window is editing (the server's headless writer) can read the
  board, create, change and delete elements, make boards and ask for a picture of a board, a frame, a
  region or chosen elements. It cannot show a board on your screen, read your selection or the view you
  are looking at, and what it does has no undo step in any window. It needs Node 22 or later on the
  server's machine, or the desktop app's own; without one, the agent is told that no board is open.
  Text in Excalidraw's own fonts is sized as in a window; Chinese, Japanese, Korean and emoji text is
  sized with the server machine's fonts, so a Linux server needs Noto CJK and Noto Color Emoji installed,
  and Han text on a Mac can come out up to 1.3% wider than a window's.
- Voice (speech mode, dictation, read aloud) needs your own ElevenLabs key. The mic mark on a message
  you spoke is kept on the device that sent the turn: another device, a fork of the chat or a
  reinstalled app does not show it. Speaking over the model does not interrupt it: while a reply is
  spoken nothing you say is heard, and a tap on the waveform or the orb interrupts it. Voice in the web build exists for
  tests only. Speech mode's send clears nothing but the turn: the text you typed in the box stays.
- With the app closed nothing is connected, to any server. Servers and their agents run on; each
  section fills again when the app opens.
- Every server that runs listens on its network, behind its secret alone. A server never starts
  before its set-up, which is a command you run by hand, once, on the machine. This computer's
  server is no exception: a laptop that never used remote access is reachable on its network once
  it is set up. Keeping the port off the internet is up to the machine's network and firewall.
- The secret of this computer's server can be read by any program of the same user, since the
  command that prints it can be run by one.
- On the desktop the server list and the secrets are a file in the app's folder, not in the system's
  keychain. On a phone or tablet they are in the device's secure storage.
- The old local port 4747 is gone: a script or a bookmark that called it stops working, and so do
  `remote off` and `remote status` (which is `status`).
- Your own pi extensions are not loaded: pi runs with `--no-extensions` plus the app's extension,
  so pi behaves the same in every chat of the app.
- A data folder that an earlier build with *runs* has used keeps what that build wrote for them:
  `~/.ai-whiteboard/runs/` (with the chats of the runs), the checkouts in `aiwb-run-work/` beside
  the data folder, and the `aiwb/…` branches in your repositories. This build does not read,
  show, change or delete any of it; delete it yourself when you no longer want it. The run
  defaults in `state.json` are not read and are gone from the file at its next write. The folder
  `remote/`, with `remote/runs/`, is removed at the first start of a build with sections (see
  [the update from a version without sections](remote-servers.md#updating-from-the-version-before)); that is not
  about the runs.
- The guard on pi's tool calls is not a sandbox. It refuses a tool input that names the app's own
  folder, which stops accidental access; a shell command that reaches the folder without naming it
  is not stopped.
- `/api/usage/pi` is not offered (pi has no plan-limit reporter).
- The pi context split is computed live from the running process and cached; it is not recomputed
  offline once the process exits.
- pi subagents are app-managed via the MCP spawn family: the app spawns child `pi --mode rpc`
  processes and reports them as subagent threads; the extension's native `subagent` tool is not
  registered on app chats.

At most 4 branches of one chat and 12 chats and branches overall work at the same time (a message
beyond that is refused with HTTP 429, code `cap`); for tests, `AIWB_CHAT_CAP` and `AIWB_APP_CAP`
(positive integers, read at start) override the two limits.
