# Prototype: subagents in the chat UI

- **Question:** How should subagents look and feel in the chat UI? That covers how a subagent
  started by a Claude or Cursor chat appears, what it shows while it runs (status, activity,
  context, its own tool calls and text), and what is left once it finishes. It is settled when the
  user names the variant that feels right with real subagents running.
- **Mode:** with a human in the loop.
- **Branch / worktree:** `subagents-ui`, at `.worktrees/subagents-ui`.

## Backend (real subagents, everything streamed)

The prototype runs real subagents; nothing is mocked. Commit `859892e`.

- **Claude**
  - Adds the `--forward-subagent-text` flag, so foreground subagents also stream their text and
    thinking.
  - Sends the SDK `initialize` control request with `agentProgressSummaries: true` and
    `forwardSubagentText: true`, for model-written progress lines in `task_progress.summary`.
  - Maps `system/task_started|task_progress|task_updated|task_notification` (`local_agent` only)
    to a new `EvSub` event.
  - Tags every line that has a `parent_tool_use_id` as that subagent's own text, tool call or tool
    result. Each assistant `usage` gives its context fill.
  - `can_use_tool.agent_id` marks approvals asked by a subagent.
  - The chat's context window now comes from the parent model's `modelUsage` entry, not the
    largest one.
- **Cursor**
  - Adds `clientCapabilities._meta.subagents = true`.
  - Routes `session/update` by `sessionId`, so each child has its own stream state.
  - `subagent_spawned` and `subagent_state_update` become `EvSub`.
  - Each child's `chats/<md5(cwd)>/<id>/store.db` is polled every second for its context meter.
  - `cursor/task` is answered with `{}`, and its model is used.
  - The Task tool call is shown as `Agent`, with `{description, prompt, subagent_type}`.
- **Transcript**
  - The parent's Agent/Task tool item carries `agent` (the `model.Subagent` state) plus the
    subagent's own item list. That list is built by a nested in-memory transcript, so it is
    persisted in `items.jsonl` with the parent.
  - Stop, an aborted turn, process exit and reload all mark running subagents `stopped`.

Checked with real runs (`/tmp/drive.py`):

- A Claude chat on haiku, with two parallel subagents (the CLI started them as background ones).
- A Cursor chat with two parallel Task subagents.

Both streamed status, activity, tool calls, text, tokens against the window, and the final report.

## How to run

```
cd .worktrees/subagents-ui
(cd web && node build.mjs)
go build -o bin/ai-whiteboard ./cmd/ai-whiteboard
./bin/ai-whiteboard serve -port 4848 -home /tmp/aiwb-subagents-proto -no-open
```

- Open http://127.0.0.1:4848.
- A new plain chat offers two prototype suggestion chips that spawn subagents: two in parallel,
  and one in the background.
- **Switch:** the dark pill at the bottom right ("Subagents UI · n name") opens the variant list.
  ⌥V cycles through the variants. The switch is instant, with no reload, and the choice is kept in
  localStorage.

## Variants

| # | What it is | Commit | Switch |
|---|---|---|---|
| 1 | **Inline card.** A card in the thread where the Agent tool call is. See below. | `d5e0fc4`, `5c5a681` | pill → 1, or ⌥V |
| 2 | **Row + popup.** A one-line row opens the subagent in a centered popup. See below. | `f7b0bf2` | pill → 2, or ⌥V |
| 3 | **Row + side drawer.** The same row opens a drawer on the right; the chat stays usable. See below. | `f7b0bf2` | pill → 3, or ⌥V |
| 4 | **Row + wider side drawer.** Variant 3 with the drawer `min(700px, 58vw)` wide instead of `min(520px, 46vw)`. | `656e4a5` | pill → 4, or ⌥V |

Variant 1 in detail:

- **Header:** status icon, type badge, description, and a `background` tag. On the right: the
  model, tool count, live duration and a context meter (tokens / window %).
- **Second line:** what the subagent is doing now (the progress summary, "Running …", "Thinking…")
  or how it ended.
- **While it runs:** a peek at its last two items.
- **Click to expand:** the prompt, collapsed, and the subagent's full live thread, indented.
- **When done:** its report under the card.
- **Approval cards** say "Asked by subagent · description".

Variants 2 and 3 were built from the user's direction: no card, an inline element with a summary
instead of contents, and click to open.

- **The row** (the same in both):
  - A pulsing green dot while running, then ✓, ! or ■.
  - The name (the description), plus a type badge for custom agents and a `background` tag.
  - A sidebar-style summary line: green "Running `ls`…" or "Thinking…" while it runs, then
    "Done · first line of the report", or the error.
  - On the right: model · effort, tool count, live duration and the context meter.
- **Variant 2, popup:** clicking the row opens a centered popup.
- **Variant 3, drawer:** clicking the row opens a drawer on the right, with no backdrop, so the
  chat stays usable. The open row is highlighted.
- **Inside the popup or drawer:**
  - The same header.
  - The prompt the parent wrote.
  - The subagent's live thread, followed while it runs. A finished one opens at the top.
  - The report, when it differs from the last text.
  - ‹ n/N › to step between the chat's subagents. Esc closes.
- **Effort:** Cursor includes it in the subagent's model id, so it is shown. Claude does not report
  a subagent's effort on stdout. It appears only in hook payloads (`effort.level` on
  PreToolUse/PostToolUse), which the app does not use, so no effort is shown for Claude subagents.

## Answer

**Variant 4: a one-line row in the thread that opens the subagent in a wide side drawer**
(commit `656e4a5`). The user chose the side drawer and asked for it wider. Variant 4 is that
change, and the user accepted it on 2026-09-25.

What it settles:

- **No card in the thread.** A subagent is one compact row where the parent's Agent/Task tool call
  is. It never shows the subagent's contents inline, only a summary.
- **The row shows:**
  - A status mark: a pulsing green dot while running, then ✓ completed, ! failed or ■ stopped.
  - The name (the description the parent gave it), a type badge only for custom agents, and a
    `background` tag for background ones.
  - A one-line summary in the sidebar's style: green, live activity while it runs ("Running
    `ls`…", "Thinking…", or Claude's progress summary). Afterwards: "Done · first line of the
    report", or the error in red.
  - On the right: model · effort, tool count, live duration and a context meter (tokens against
    the subagent model's window, as a bar and %).
- **Clicking a row, running or done, opens a drawer on the right,** `min(700px, 58vw)` wide.
  - It has no backdrop, so the user can keep reading and typing in the chat while a subagent
    runs. The open row is highlighted; clicking it again or pressing Esc closes the drawer.
  - The drawer header shows the name, the type, the background tag and the activity line, with the
    same stats as the row.
  - The body shows the prompt the parent wrote, then the subagent's own live thread: its text, and
    tool cards that expand like the parent's.
  - A running subagent is followed as it streams. A finished one opens at the top.
  - The report is shown when it differs from the last text.
  - ‹ n/N › steps between the chat's subagents.
- **Approval cards** a subagent raises stay in the parent thread, labelled "Asked by subagent ·
  <name>".

For the real build:

- **The backend part above is needed as is:**
  - `--forward-subagent-text` and the `initialize` request for Claude.
  - `_meta.subagents` and per-session routing for Cursor.
  - Subagent state and its thread on the parent's tool item.
  - Running subagents marked stopped on Stop, exit and reload.
- **Effort is shown for Cursor subagents only.** Showing it for Claude needs hooks; see the
  effort note under Variants.
- **The drawer covers the right side of the thread; it does not push it aside.** This was not
  judged separately.
- **Behaviour seen in the real runs that the UI has to allow for:**
  - Claude may start subagents in the background unasked. The parent goes Idle while they run, and
    then starts a follow-up turn on its own.
  - Cursor keeps the parent turn running until its subagents finish.
  - Stop stops every subagent (the recorded decision).
- **The switch pill, ⌥V, and the prototype suggestion chips are scaffolding.** Leave them out.
