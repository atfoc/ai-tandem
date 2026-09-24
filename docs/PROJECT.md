# AI Whiteboard — what this project is

A single Go binary you run locally. It starts an HTTP/WebSocket server, opens a browser tab, and gives
you a whiteboard editor (Excalidraw) with **AI chats that can read and edit the boards** you have open.

It is the big sibling of the `excalidraw-live` skill
(`~/Documents/projects/agents/claude/skills/excalidraw-live`): same idea of a local server + an
Excalidraw engine in a browser tab that an agent drives, but turned inside out. In the skill, an
agent session starts the server. Here, **the server is the host**, and it starts the agents.

## Core ideas

- **Server-first.** `ai-whiteboard [files or dir...]` starts the server and opens the browser. The
  server owns the files on disk, the editor state, and the agent processes.
- **Pages (boards) in tabs.** The editor holds several pages — `.excalidraw` files — shown as tabs.
  You can open, create and switch between them.
- **Chats sit on top of pages.** A chat is a conversation with an agent. It is not tied to one
  page; it floats above the editor and can work on any of them.
  - You can **reference** one or more pages explicitly in a message (e.g. `@arch.excalidraw`).
  - If you reference **none**, the agent is told which page you are **currently looking at**
    (active tab, and ideally viewport/selection) and treats that as the context.
- **New chat = new agent process.** Starting a chat spawns a coding agent CLI in its
  machine-readable / RPC-like streaming mode:
  - **Claude Code** (`claude` CLI, stream-json in/out), or
  - **Cursor agent** (`cursor-agent` / `agent` CLI).
  The server pipes the user's messages in and streams the agent's responses (text, tool calls,
  status) back to the UI.
- **System prompt teaches whiteboard editing.** Each agent is launched with a system prompt (and
  whatever tooling it needs — scripts, an API, MCP, etc.) that teaches it how to read and edit
  boards through the server, the way the `excalidraw-live` skill teaches it today (summary, keyed
  shapes, arrows, commit, render, conflicts, "don't touch what the user drew").
- **Human and agent edit together.** Like the skill's shared mode: the user draws in the tab while
  the agent edits through the engine; conflicts mean the user wins.

## Rough architecture (to be refined)

```
 browser tab (Excalidraw editor, page tabs, chat panel(s))
        │  WebSocket / HTTP
 Go server ── page store (.excalidraw files on disk, locks, revisions)
        │   ── chat manager: one agent subprocess per chat
        │        stdin  ← user messages (+ context: referenced / active page)
        │        stdout → streamed events → UI
        │   ── board API the agents call to read/edit pages
        ▼
 claude / cursor-agent subprocesses
```

## Open questions

- Exact RPC/streaming protocol for each CLI: how to start a session, send follow-up messages,
  stream partial output, inject a system prompt, resume, interrupt, and handle permissions/tool
  approvals. → Being answered by prototypes, reports in `docs/research/`.
- How agents edit boards: shell scripts against a local HTTP API (like the skill), an MCP server
  exposed by the Go binary, or custom tools.
- How "current page" context is delivered: prepended to each user message vs. a tool the agent calls.
- Where the Excalidraw engine lives (browser tab only, or a headless one for renders).

## Research

- `docs/research/claude-rpc.md` — driving Claude Code CLI as a long-lived streaming subprocess.
- `docs/research/cursor-rpc.md` — driving Cursor agent CLI the same way.
