# AI Whiteboard — what this project is

A local Go **server** and a separately built **client** (a web app in a browser tab for now, a React
Native macOS app later) that talks to the server only through its HTTP API. Together they give you
coding-agent chats and whiteboards (Excalidraw) with **AI chats that can read and edit their board**.

It is the big sibling of the `excalidraw-live` skill
(`~/Documents/projects/agents/claude/skills/excalidraw-live`): same idea of a local server + an
Excalidraw engine in a browser tab that an agent drives, but turned inside out. In the skill, an
agent session starts the server. Here, **the server is the host**, and it starts the agents.

## Core ideas

- **Server-first.** `ai-whiteboard` starts the server (or finds the running one) and opens the
  client. Its data lives in `~/.ai-whiteboard`. The server owns the files on disk, the chats and
  the agent processes.
- **Chats in groups.** The app is a list of chats in user-made groups. A chat is a full
  coding-agent session.
- **Whiteboards live in groups.** A whiteboard lives in a group and has its own chats, which see
  and draw on it. Other chats know nothing of whiteboards.
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

## Rough architecture

```
 web client (web/, built with esbuild, opened in a browser tab)
   │  HTTP JSON  (commands)         ▲ SSE /api/events (state, chat items, rpc calls)
   ▼                                │
 Go server (cmd/ai-whiteboard + internal/…)
   ├─ store      ~/.ai-whiteboard: state.json, boards/<id>/{board.json,drawing.excalidraw}, chats/<id>/{chat.json,items.jsonl}
   ├─ editorbridge  the one active client; takeover; rpc calls into the client's board engine
   ├─ chats      one agent per chat; transcript → items; persistence; sticky defaults
   │    ├─ claude adapter   claude -p stream-json (one process per chat)
   │    └─ cursor adapter   agent acp (JSON-RPC over stdio, one process per chat)
   ├─ boardtools the board tool list and the Cursor command parser (no dependencies; shared by adapters, prompts, boardapi)
   ├─ boardapi   MCP at /mcp/{token} (Claude), command endpoint /agent/{token}/{tool} (Cursor)
   └─ app        groups, archive/unarchive/delete cascades, moves
```

The full design is in `docs/features/app.md` (what the app is) and `docs/features/app.impl.md`
(the implementation spec).

## Open questions

All answered by the research in `docs/research/` and the app feature (`docs/features/app.md`, with
its implementation spec `docs/features/app.impl.md`):

- ~~Exact RPC/streaming protocol for each CLI: how to start a session, send follow-up messages,
  stream partial output, inject a system prompt, resume, interrupt, and handle permissions/tool
  approvals.~~ → Answered: `docs/research/claude-rpc.md`, `docs/research/cursor-rpc.md`.
- ~~How agents edit boards: shell scripts against a local HTTP API (like the skill), an MCP server
  exposed by the Go binary, or custom tools.~~ → Answered: board tools served by the server, as MCP
  for Claude and as a command endpoint for Cursor (`docs/features/app.impl.md`).
- ~~How "current page" context is delivered: prepended to each user message vs. a tool the agent
  calls.~~ → Answered: a `<ui-context>` block before each user message (`docs/features/app.impl.md`).
- ~~Where the Excalidraw engine lives (browser tab only, or a headless one for renders).~~ →
  Answered: in the client only; every board tool call goes to the active client
  (`docs/features/app.impl.md`).

## Research

- `docs/research/claude-rpc.md` — driving Claude Code CLI as a long-lived streaming subprocess
  (code on branch `claude-rpc`).
- `docs/research/cursor-rpc.md` — driving Cursor agent CLI the same way (code on branch `cursor-rpc`).

Findings so far (2026-09-24):

- **Both CLIs work as one long-lived process per chat**, with streaming, interrupt, resume and
  concurrent chats.
  - Claude: `claude -p --input-format stream-json --output-format stream-json --verbose
    --include-partial-messages`.
  - Cursor: `cursor-agent acp` (hidden subcommand, ACP = JSON-RPC 2.0 over stdio).
- **System prompt**
  - Claude takes `--system-prompt`.
  - Cursor has no flag; it reads `AGENTS.md` / `.cursor/rules` in the session cwd, so each chat
    gets a server-written workspace dir. *(Now: instructions travel in the conversation;
    no files are written into the chat's folder.)*
- **Board API**
  - Claude: an HTTP MCP server inside the Go binary (preferred).
  - Cursor: MCP is blocked by team policy on the current account, so it uses local HTTP + curl for
    now, with MCP also passed for accounts that allow it.
- **Approvals can be routed to the browser UI**
  - Claude: `--permission-prompt-tool stdio`.
  - Cursor: ACP `session/request_permission`.
- **Page context** is sent as a `<ui-context>` block before each user message.
- **Isolation.** Each spawned agent inherits the user's global CLI config unless isolated.
  *(Isolation is no longer used: every chat runs with the user's own settings.)*
  - Claude: `--strict-mcp-config`, `--disable-slash-commands`, `--setting-sources ""`.
  - Cursor: a server-owned `CURSOR_CONFIG_DIR`, because model changes are saved as the user's
    global default.
