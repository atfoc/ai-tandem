# Limitations

What the app does not do, or does not do fully, and the limits it enforces.

- Your own pi extensions are not loaded: pi runs with `--no-extensions` plus the app's extension,
  so pi behaves the same in every chat of the app.
- A data folder that an earlier build with *runs* has used keeps what that build wrote for them:
  `~/.ai-whiteboard/runs/` (with the chats of the runs), the checkouts in `aiwb-run-work/` beside
  the data folder, and the `aiwb/…` branches in your repositories. This build does not read,
  show, change or delete any of it; delete it yourself when you no longer want it. The run
  defaults in `state.json` are not read and are gone from the file at its next write. The folder
  `remote/`, with `remote/runs/`, is removed at the first start of a build with sections (see
  [the update from a version without sections](remote-servers.md#use-a-server-on-another-machine)); that is not
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
