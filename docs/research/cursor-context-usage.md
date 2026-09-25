# cursor-context-usage: getting context-window usage from `agent acp`

- **Question:** How does an ACP client get context usage (tokens used / context window) from the
  Cursor agent binary (`agent` / `cursor-agent`, v2026.09.23-86fc751) running as `agent acp`?
  It is settled when running code prints a turn's context usage.
- **Mode:** without a human in the loop.
- **Branch / worktree:** `cursor-acp-context-usage` at `.worktrees/cursor-acp-context-usage`
  (branched from `cursor-rpc`, reusing `cmd/acpprobe`).

## Answer

**The ACP protocol does not carry it.** Cursor's ACP agent never sends a `usage_update`: the
bundled ACP SDK schema defines one, but Cursor's session code never emits it. `session/prompt`
returns only `{"stopReason":"end_turn"}`, and no `_meta` field holds usage. The only extension
method a client can call is `cursor/list_available_models`.

**The agent does compute it and saves it to disk after every model step.** Read it out of band
from the session store:

```
~/.cursor/acp-sessions/<ACP sessionId>/store.db      (SQLite; under $CURSOR_CONFIG_DIR when set — not verified)
  table meta:  key '0' → hex-encoded JSON {"latestRootBlobId": "...", ...}
  table blobs: id = latestRootBlobId → protobuf ConversationStateStructure (plaintext, despite a blobEncryptionKey in meta)
    field 5 token_details: ConversationTokenDetails
      1 used_tokens   (varint)
      2 max_tokens    (varint)   ← context window of the current model
      3 breakdown { 1 used, 2 max, 3 repeated entry { 1 id, 2 label, 3 tokens, 4 ? } }
```

The TUI uses this same `tokenDetails` for its context meter, and the statusline JSON exposes it as
`context_window.*`. The directory name is the ACP `sessionId` returned by `session/new`.

Implementation: `cmd/acpprobe/ctxusage.go`. `ReadContextUsage(sessionId)` runs two `sqlite3`
queries and a 100-line protobuf wire decoder. It needs no `.proto` files and no CGO.

## Evidence

`bin/acpprobe -work <dir> -s ctxusage` (model `gpt-5.4-mini[reasoning=medium]`):

```
after session/new:  store.db does not exist yet (it is created by the first prompt)
turn 1 "Say hi in one word."           result={"stopReason":"end_turn"}  → used=15989 max=272000 (5.9%)
turn 2 + ~15k tokens of filler text    result={"stopReason":"end_turn"}  → used=31091 max=272000 (11.4%)
turn 3 shell tool calls, polled every 300 ms during the turn:
   +328ms  used=31091   +3977ms root blob changed, used=31091   +6237ms used=31618
   after turn → used=31930 max=272000 (11.7%)
```

No `session/update` in any turn was usage-like. The kinds were `agent_message_chunk`,
`agent_thought_chunk`, `tool_call`, `tool_call_update`, `session_info_update` and
`available_commands_update`.

`bin/acpprobe -s readctx -session c60bf0cc-…` read the same session after the process had exited:

```
used=31930 max=272000 (11.7%) breakdown=[system_prompt=3249 tools=8037 rules=0 skills=4116 mcp=0
  subagents=483 summarized_conversation=0 conversation=16045]
```

The breakdown adds up exactly to `used`. About 16k tokens are baseline: system prompt, tools and
skills.

## What was tried

1. Read the static bundle (`~/.local/share/cursor-agent/versions/…/7465.index.js`, the ACP agent).
   Its `sessionUpdate` kinds are the message and thought chunks, tool calls, plan, commands, mode,
   session info and the subagent updates. It has no `usage_update`. `presentInteractionUpdate` ignores
   every agent event except text, thinking and tool calls. Its only client-callable extension method
   is `cursor/list_available_models`.
2. Traced the TUI's context meter to `getConversationStateStructure().tokenDetails`, and that to the
   `ConversationTokenDetails` protobuf stored in the session's root blob.
3. `b43749a` Added the `ctxusage` scenario, which runs live ACP turns and reads the store after and
   during each turn, and the `readctx` scenario, which reads a finished session.

## Gotchas

- `store.db` only appears after the first `session/prompt`. Before that there is nothing to read.
- The value updates after each model step within a turn, not only at the end of a turn. So polling
  gives a near-live meter; about every 300 ms is enough. You can also read it once when the
  `session/prompt` response arrives.
- The database uses WAL mode. Opening it with `sqlite3 -readonly` fails after the agent has exited,
  because SQLite cannot create the `-shm` file. Open it normally and run only SELECTs.
- This is an undocumented internal format, so a CLI update can change it. Guard the decode and fall
  back to "unknown".
- Not tested: whether `max_tokens` changes after `session/set_config_option` to a model with a larger
  window (for example `[context=1m]`), and the store path under an isolated `CURSOR_CONFIG_DIR`.
- For per-turn *billing* usage (input, output and cache tokens), ACP still gives nothing. Only print
  mode's `result.usage` reports it (see `cursor-rpc.md`).
