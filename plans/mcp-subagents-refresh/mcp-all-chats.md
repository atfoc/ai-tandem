# MCP attachment today: board chats vs every chat

Status: facts only, against this worktree at HEAD `b15640a`. Not a plan. No proposed design.

Line numbers are against files in `/Users/pedjat/Documents/projects/ai-whiteboard-worktrees/mcp-subagents-plan`.

This document answers: **what current code does to attach MCP to a chat, what is gated on “belongs to a board”, and what would have to start happening for a plain chat to even speak MCP.** A planner can rebase “spawn-family tools on all chats, board tools still board-only” onto these facts without re-reading adapters.

Verified facts cite `path:line`. Anything not pinned in this tree is marked **assumption**.

Related (architecture of the already-landed endpoint, not re-derived here): `plans/mcp-subagents-refresh/mcp-architecture.md`, `plans/mcp-subagents-refresh/adapters.md`.

---

## 1. How a chat is associated with a board vs plain

Verified:

- `ChatMeta.Board` is the board id, omitempty. Empty means plain. `ChatMeta.Group` is used only by plain chats; board chats leave Group empty and inherit the board’s group (`internal/model/model.go:197–198`).
- Association is set only at `Manager.Create(agent, group, board)` (`internal/chats/manager.go:343–370`):
  - `board != ""`: look up the board (`Boards.Get`); fail `ErrNotFound` / `ErrArchived`; force `group = bd.Group`; store `meta.Board = board`; **do not** set `meta.Group`.
  - `board == ""`: require the group exists; store `meta.Group = group`; leave `meta.Board` empty.
- HTTP create is `POST /api/chats` with `{Agent, Group, Board}` (`internal/server/server.go:447–462`). Empty Board → group check; non-empty Board → `Chats.Create` as above.
- There is **no setter** for `meta.Board` after create. The only assignment in production code is the Create literal (`internal/chats/manager.go:364`). A chat cannot be moved onto a board or off a board.
- `Manager.Move` is plain-chats only. If `c.meta.Board != ""` it returns `"a board chat moves with its board"` (`internal/chats/manager.go:896–908`). `App.MoveChat` is that method (`internal/app/app.go:297–298`). Moving a **board** moves its chats only in the sense that `GroupOf` reads the board’s group (`internal/app/app.go:294–295`, `internal/chats/manager.go:1036–1043`).
- Board archive/delete cascades to that board’s chats (`internal/app/app.go:316–318`, `527–532`). There is no live chat whose `Board` points at a deleted board except by hand-editing disk after boot (Load skips unreadable board folders; chats are independent files).

So: board vs plain is a create-time, durable field. It does not change for the life of the chat.

---

## 2. Token minting

Verified:

- Token is minted **only** at Create when `board != ""`: `meta.Token = randHex(16)` → 32 hex chars (`internal/chats/manager.go:366–369`, `1088–1092`). Plain Create leaves `Token` empty (`omitempty`).
- Comment on the field: “board chats: the durable MCP credential, sent in the Authorization header” (`internal/model/model.go:204`).
- Persistence: `save` writes the whole `ChatMeta` to `chats/<id>/chat.json` (`internal/chats/manager.go:129–131`). Create calls `save` immediately (`internal/chats/manager.go:382`), so the token exists on disk **before** any agent process starts (agent starts on first `Send`, `internal/chats/manager.go:342`, `425–443`).
- Reload: `Load` unmarshals `chat.json` into `ChatMeta` as-is (`internal/chats/manager.go:222–248`). No rotation, no re-mint, no uniqueness check against other chats.
- `ByToken` linear-scans every loaded chat (including archived) and matches `meta.Token == token`. Empty token → not found immediately. Comment says “the board chat whose MCP credential is token”; the **code does not check `meta.Board`** (`internal/chats/manager.go:1007–1021`).
- Token is stripped from the client view (`internal/model/model.go:279–281`; pinned by `internal/chats/manager_test.go:515`).
- Tests freeze minting:
  - Plain create: `m.Token != ""` fails (`internal/chats/manager_test.go:489–490`).
  - Board create: token matches `^[0-9a-f]{32}$` (`internal/chats/manager_test.go:502–503`). Claude/Cursor/Pi board chats all get a token (`internal/chats/manager_test.go:512`, `840–852`, `908–910`).

`ByToken` is the only MCP token consumer (`internal/boardapi/mcp.go:52`, `259`). There is no second in-memory token type.

Hypothetical (not produced by Create): a `chat.json` with `token` set and `board` empty **would** resolve in `ByToken`. Spawn would still omit MCP config, because `spawnOptions` keys off `c.meta.Board != ""`, not off Token (`internal/chats/manager.go:477–479`). The inverse (Board set, Token empty) would pass `BoardAccess{Token: ""}` into adapters.

---

## 3. When Claude / Cursor / Pi receive MCP config

Gate is one field: `agent.SpawnOptions.Board *BoardAccess`, comment “nil for plain chats” (`internal/agent/agent.go:22–27`). Manager fills it only when `c.meta.Board != ""` (`internal/chats/manager.go:470–479`). Adapters never look at `ChatMeta` themselves.

### Claude — `--mcp-config` only if `o.Board != nil`

`internal/claude/claude.go:73–81`:

```
if o.Board != nil {
    mcp := boardMCPConfig(o.Board)
    allowed := []string{}
    for _, t := range boardtools.Tools {
        allowed = append(allowed, "mcp__board__"+t.Name)
    }
    args = append(args, "--append-system-prompt", s.Prompt, "--mcp-config", mcp,
        "--allowedTools", strings.Join(allowed, ","))
}
```

Config JSON (`internal/claude/claude.go:98–107`):

```json
{"mcpServers":{"board":{"type":"http","url":"<MCPURL>","headers":{"Authorization":"Bearer <Token>"}}}}
```

Pinned: `internal/claude/args_test.go:53–61`. Plain chat must **not** have `--append-system-prompt`, `--mcp-config`, or `--allowedTools` (`internal/claude/args_test.go:31–36`).

### Cursor — ACP `mcpServers` empty vs one HTTP server

`internal/cursor/cursor.go:260–276`. `session/new` and `session/load` both pass `mcpServers(p.o)` (`internal/cursor/cursor.go:197`, `205`).

- `o.Board == nil` **or** `o.Board.MCPURL == ""` → `[]any{}`.
- Else one entry: `type=http`, `name=board`, `url=MCPURL`, headers array `Authorization: Bearer <Token>`.

Pinned empty for non-board: `internal/cursor/cursor_test.go:261`, `453`, `901`. Pinned board payload: `internal/cursor/cursor_test.go:585–601`.

### Pi — `AIWB_MCP_CONFIG` only if board access has an MCP URL

`boardMCPConfig` returns `""` when `board == nil || board.MCPURL == ""` (`internal/pi/args.go:104–116`). `env` adds `AIWB_MCP_CONFIG=` only when that is non-empty (`internal/pi/args.go:147–148`). Comment: “Plain chats get no board config” (`internal/pi/args.go:132–133`). Frozen contract: `internal/agent/bridge.go:17–20` (“AIWB_MCP_CONFIG board chats only”).

The app adapter never passes `--mcp-config`; production config is the env var (`internal/pibridge/extension/index.ts:111`: flag wins over env; app does not set the flag). On `session_start`, if selection source is `"none"`, the extension returns without registering any `mcp__*` tools (`internal/pibridge/extension/index.ts:147–149`).

Pinned:

- Env JSON: `internal/pi/args_test.go:170–182`, `internal/pi/pi_test.go` board spawn.
- Plain env has no `AIWB_MCP_CONFIG` even with a bridge run handle: `internal/pi/args_test.go:190–193`.
- Plain spawn: `internal/pi/pi_test.go:250–259` (`TestSpawnPlainChatNoMCPConfig`).
- Real-pi boot, bridge present, no env config: registers **exactly** `subagent`, no `mcp__*` (`internal/pibridge/extension_boot_test.go:896–921`, `TestMCPRealPiAppPlainChatBoot`).

Pi still always gets the UDS bridge when `Spawner.Bridge != nil` (production: always). `RegisterRun` is not board-gated (`internal/pi/pi.go:161–165`). Plain Pi chats therefore have `AIWB_BRIDGE_*` and the native `subagent` tool, and no MCP.

### Confirmed nil/absent for plain chats

| Agent | MCP config surface | Plain | Board |
| --- | --- | --- | --- |
| Claude | `--mcp-config` argv | absent (`claude.go:73`, `args_test.go:31–36`) | present |
| Cursor | ACP `mcpServers` | `[]` (`cursor.go:265–267`) | one `board` HTTP server |
| Pi | `AIWB_MCP_CONFIG` | unset (`args.go:147–148`, `args_test.go:190–193`) | set |

---

## 4. Board-only extras vs MCP-connectivity extras

These currently share the same `o.Board != nil` / `c.meta.Board != ""` gate. They are **not** the same kind of extra.

### MCP connectivity (today board-gated; without these a process never talks to `/mcp`)

| Extra | Where | What it does |
| --- | --- | --- |
| Token mint | `manager.go:366–369` | Credential `ByToken` can resolve |
| `spawnOptions.Board` | `manager.go:477–479` | Adapters see `BoardAccess{MCPURL, Token}` |
| Claude `--mcp-config` | `claude.go:73–80` | Claude loads the HTTP MCP server |
| Cursor `mcpServers` non-empty | `cursor.go:264–276` | Cursor ACP session loads the HTTP MCP server |
| Pi `AIWB_MCP_CONFIG` | `pi/args.go:147–148` | Extension `startMCP` + `pi.registerTool` for `mcp__board__*` |

If spawn-family tools are to be reachable on plain chats, **these** are the surfaces that currently do not fire.

### Board-tool extras (today board-gated; they exist to teach/allow **board** operations)

| Extra | Where | What it does |
| --- | --- | --- |
| Claude `--append-system-prompt` | `claude.go:79`, `prompts.Claude()` | Whiteboard body: “with the `board` MCP tools” (`prompts.go:19–24`). Not a tool list. |
| Claude `--allowedTools mcp__board__*` | `claude.go:75–80` | One name per `boardtools.Tools` entry. **Not** Task/Agent. This tree does **not** document whether Claude treats the flag as auto-approve vs a hard allow-list (`adapters.md` already flags that). |
| Cursor first-message whiteboard body | `manager.go:603–608` | Same `prompts.Claude()` injected once; `McpInstructionsSent` persisted. Cursor has no system-prompt slot. |
| Cursor board-MCP auto-approve | `cursor.go:817–821` | `session/request_permission` for provider `"board"` + `boardtools.IsTool` is answered `allow_once` (else `allow_always`) with no user card. Live Cursor often sends **no** permission request for MCP at all (`cursor_test.go:616–618`). |
| Cursor tool-card rename | `cursor.go:692–696` | Board MCP calls displayed as `mcp__board__<name>` only when `p.o.Board != nil`. |
| Pi `--append-system-prompt` file | `pi.go:178–181`, `args.go:57–58` | Writes `prompts.Pi()` (= Claude whiteboard body) to `chats/<id>/pi/append-prompt.md`. |
| Pi `mcp__board__*` auto-allow | `mcp-wiring.ts:75–86`, `index.ts:251–260` | Permission gate auto-allows discovered `mcp__board__*` names only when config is app-sourced env + key `"board"` + bridge present. `subagent` is auto-allowed separately. |
| Pi subagent wording | `mcp-wiring.ts:133–150` | Promises “including the board tools” / “child inherits the board tools” only if `boardServerActive`. |
| Every board-chat user message | `manager.go:603–619` | Prepends `<ui-context>` naming the chat’s board (`prompts.BoardContext`). Plain chats drop any client-supplied context (`manager.go:617–618`, `manager_test.go:823–827`). |

DeepSeek Flash’s extra `--append-system-prompt` (“Never run bash commands without timeout”) is **not** board-gated (`pi/args.go:59–61`).

---

## 5. MCP endpoint: any `ByToken` hit, or board assumed?

The listener and handshake do **not** require a board. `tools/call` of a **board** tool does.

Verified:

- `POST /mcp` → `Relay.ServeFixedMCP` → `serveRPC` (`internal/boardapi/mcp.go:177–184`, `196–256`). No board id in the URL. Credential is only `Authorization: Bearer`.
- `initialize` / `tools/list` / `ping`: **no token check**. Same `serverInfo.name = "board"` and the same global tool list for missing/unknown/valid tokens (`mcp.go:219–232`; `mcp_fixed_test.go:43–61`). README documents this (`README.md:161–162`).
- `tools/call` → `Relay.Call(token, name, args)` (`mcp.go:233–242`):
  1. `ByToken` — fail → `"unknown board token"` (`mcp.go:52–54`). A plain chat with empty Token cannot pass this, even if an agent somehow POSTed.
  2. Archived / `InstructionsSent` / unknown tool name → text errors (`mcp.go:55–62`). Unknown tool is anything not in `boardtools.Tools` (`mcp.go:40–46`, `61–62`).
  3. **No check that `meta.Board != ""`.**
  4. `bd, _ := r.Boards.Get(meta.Board)` — ignore ok (`mcp.go:65`). Missing/empty board → zero `model.Board`, `bd.ID == ""`.
  5. `Bridge.Call("tool", {chat, board: bd.ID, name, args}, 30s)` (`mcp.go:66–68`). Window closed → immediate `NoClientText` (`mcp.go:26–28`, `67–69`). Does **not** itself require a board id.

Client (`web/src/board.ts:278–371`): `call.board` is “the chat’s own board id”. `list_boards` still runs with an empty id (it just will not mark “this chat’s board”). Tools that resolve “this chat’s board” (`read_board`/`apply`/… with no `args.board`, `create_board`, `get_view`) throw `NO_BOARD` (`this chat's board ${call.board} no longer exists`) when `boards[call.board]` is missing — including `call.board === ""`.

So: **a token that `ByToken` finds is enough for initialize, tools/list, and to enter `Call`.** Board is assumed only when executing a board-engine tool through the browser bridge. There is **no production chat** with a token and no board (Create never makes one); the path above is what the code would do if one existed.

`tools/list` does not depend on the chat at all. Attaching MCP config to a plain chat, with today’s handler, would advertise all seven board tools to that process.

---

## 6. `boardtools.Tools` — global board-tool list, no per-chat filter

Verified:

- Package comment: “the board tool list shared by the agent adapters, the prompts and the board API” (`internal/boardtools/tools.go:1–2`). Imports nothing from this project.
- Single global `var Tools = []Tool{…}` — seven tools in order: `list_boards`, `read_board`, `get_view`, `apply`, `delete_elements`, `create_board`, `show_board` (`tools.go:44–108`). Pinned: `boardtools_test.go:8–12`, `boardapi_test.go:162–178` (`TestToolsList` wants `len == 7`).
- `mcpTools()` copies that slice into MCP `tools/list` shape (`mcp.go:161–174`, `229–232`). No token, no chat, no caller identity.
- Consumers of the same list:
  - MCP `tools/list` (`mcp.go:229`).
  - MCP `isTool` / unknown-tool (`mcp.go:40–46`).
  - Claude `--allowedTools` (`claude.go:75–80`).
  - Cursor `boardtools.IsTool` for auto-approve and card rename (`cursor.go:675`, `692–696`).
  - Pi discovery uses whatever the MCP server returns (i.e. this list), then names them `mcp__board__<name>` (`internal/pibridge/extension/mcp.ts` prefix `mcp__` + config key `board`).
- There is **no** per-chat or per-caller filtering anywhere. Handshake identity is unused for authorization of list or of which tools exist.

`serverInfo.name` is `"board"` (`mcp.go:154–156`, `224`). Claude/Pi therefore name every tool on this server `mcp__board__<tool>` regardless of whether the caller is a board chat.

---

## 7. Tests / docs that freeze “MCP only for board chats”

Verified tests (will fail if MCP config or a token appears on a plain chat, or if board extras leak):

| Test | Freeze |
| --- | --- |
| `internal/chats/manager_test.go:489–490` | Plain `chat.json` has empty Token |
| `internal/chats/manager_test.go:823–827` | Plain Send drops board context |
| `internal/chats/manager_test.go:840–852`, `908–914` | Board spawn gets `BoardAccess` with fixed URL + token, token not in URL |
| `internal/claude/args_test.go:31–36` | Plain Claude argv has no `--mcp-config` / `--append-system-prompt` / `--allowedTools` |
| `internal/claude/args_test.go:53–71` | Board Claude has those three, `--allowedTools` is exactly `mcp__board__*` × `boardtools.Tools` |
| `internal/cursor/cursor_test.go:261`, `453`, `901` | Non-board `mcpServers` is `[]` |
| `internal/cursor/cursor_test.go:585–601` | Board `mcpServers` is the one HTTP `board` server |
| `internal/pi/args_test.go:190–193` | Plain env has no `AIWB_MCP_CONFIG` |
| `internal/pi/pi_test.go:250–259` | `TestSpawnPlainChatNoMCPConfig` |
| `internal/pibridge/extension_boot_test.go:896–921` | Plain app-run Pi: only `subagent`, no `mcp__*`, wording must not promise board tools |
| `internal/boardapi/mcp_fixed_test.go:43–61` | `tools/list` is permissive and returns the full global list even with a garbage Bearer |
| `internal/boardapi/boardapi_test.go:162–178` | `tools/list` length 7 = `boardtools.Tools` |

Docs / comments that state the same:

- `internal/agent/agent.go:22` — `Board *BoardAccess // nil for plain chats`
- `internal/agent/bridge.go:16–20` — `AIWB_MCP_CONFIG` / `AIWB_APPEND_PROMPT` “board chats only”
- `internal/chats/manager.go:39` — `MCPURL` “handed to every **board** chat”
- `internal/chats/manager.go:1007` — `ByToken` “finds the **board** chat”
- `README.md:148` — “A **board chat’s** board token is in … `chat.json`”
- `README.md:133` — status `"chat": "unknown"` means credential “resolves to no **board** chat”
- Existing subagents plan (`plans/mcp-subagents.md:3–4`, `42`) — “Scope: board chats only … Out of scope: plain chats (no MCP there; native subagents stay)”

`BridgeRegistry` comment “nil means no bridge (plain chats only)” (`internal/agent/bridge.go:112`) is **not** how production behaves: `main` always attaches the bridge (`cmd/ai-whiteboard/main.go:145–170` region) and Pi `RegisterRun`s every Pi chat. The comment describes a nil spawner field in tests, not product plain chats.

---

## 8. Implications that are facts, not design

### Native subagents are live on every chat today

- **Pi:** the extension registers `subagent` whenever the bridge is present (`internal/pibridge/extension/index.ts:189–192`, `222–230`). Production Pi always has the bridge. `TestMCPRealPiAppPlainChatBoot` asserts the plain-chat tool list is **exactly** `subagent`. Children inherit the parent env, including `AIWB_MCP_CONFIG` if any (`index.ts:192–195`; `subagent.ts:161–180` copies env). Plain children therefore inherit **no** MCP config; board children inherit the parent’s board token. There is no adapter API to give a child a different token.
- **Claude:** `--forward-subagent-text` is on **every** chat (`claude.go:58–60`, `args_test.go:101–103`). `--disallowedTools` is only app-dir Read/Edit/Write/Bash globs (`claude.go:72`, `args_test.go:103–107`). Task/Agent are **not** denied anywhere in this tree. Native spawn translation is live (`claude.go:50–51`, `translate.go` `task_*`).
- **Cursor:** native Task is detected and rendered as `"Agent"` (`cursor.go:688–691`, `462–470`). ACP `initialize` sets `_meta.subagents: true` for event streaming, which does **not** remove Task (`cursor.go:167` comment). `CURSOR_DATA_DIR` is **not** set; no `preToolUse` hook is written (`adapters.md` / `cursor-task-deny.md`). Task-deny is research-only, not implemented. Native Task never asks the ACP client for permission (`cursor-task-deny.md`; `cursor_test.go` traces). User-global `cli-config.json` deny rules are app-dir Read/Write, not tool names (`internal/cursor/config.go`).

### What current code assumes, that a “MCP on every chat” rebase collides with

1. **Token ≡ board chat.** Create mints iff `board != ""`. Comments, README, and `ByToken`’s comment all say “board chat”. The scan itself only matches `meta.Token`.
2. **MCP config ≡ `SpawnOptions.Board != nil` ≡ `meta.Board != ""`.** One pointer carries URL + token into all three adapters. There is no “MCP without a board” option type.
3. **`tools/list` is the seven board tools, always.** Any process that is given MCP config sees board tools. There is no spawn-family tool and no per-caller list.
4. **`tools/call` of a known name always goes through `Relay.Call` → browser bridge.** A non-board tool name is `"unknown tool …"` today (`mcp.go:61–62`). Spawn/wait/stop cannot be added as names without either extending `boardtools.Tools` (which would also advertise them on `tools/list` and Claude `--allowedTools`) or branching before `isTool`.
5. **Board-tool execution needs a board id and an open window.** `Call` does not reject empty `meta.Board`; the client does when the tool needs “this chat’s board”. Window closed → `NoClientText` for **every** current tool.
6. **Claude `--allowedTools` is generated from `boardtools.Tools` and only on board chats.** Adding names to `Tools` changes Claude board-chat argv, Cursor auto-approve (`IsTool`), MCP list, and Pi discovery together. Plain Claude today passes neither `--mcp-config` nor `--allowedTools`.
7. **Pi MCP tools exist only if `AIWB_MCP_CONFIG` is set.** Native `subagent` is orthogonal (bridge-gated). Giving plain Pi MCP config would register `mcp__board__*` unless `tools/list` is filtered first; those names would then be auto-allowed if the config is app-sourced env with key `"board"` (`autoAllowedToolNames`).
8. **Cursor without `mcpServers` entries never connects.** Auto-approve of board MCP is irrelevant until there is a server. Auto-approve matches `boardtools.IsTool`, so a new spawn tool name would **not** be auto-approved until `IsTool` says yes (or the match changes).
9. **Whiteboard prompt / `<ui-context>` / Cursor first-message injection are board-chat UX, not MCP transport.** They can stay board-gated without blocking a plain chat from holding a token or an MCP config.
10. **Existing tests named in §7 are the freeze.** Changing token mint, `spawnOptions`, or any adapter’s plain-chat MCP absence requires those tests to change; they are not comments.

### What would block MCP on plain chats **as the code stands**

These are current-code stoppers, not design choices:

- No `ChatMeta.Token` → `ByToken` fails → `tools/call` returns `"unknown board token"` (handshake would still succeed if the process connected).
- `spawnOptions` leaves `Board == nil` → Claude has no `--mcp-config`, Cursor sends `mcpServers: []`, Pi has no `AIWB_MCP_CONFIG` → **the process never connects**.
- Pi extension: `selectMCPConfig` source `"none"` → no `mcp__*` registration even if the user somehow had other MCP settings, because the app passes `--no-extensions` and only its extension (`pi/args.go:42–45`).
- Tests in §7 assert the above absences.

Handshake itself is not a blocker: `/mcp` already answers `initialize` / `tools/list` without a valid token and without a board.

### Not verified in this tree

- Whether Claude `--allowedTools` is additive or exclusive, and whether MCP tools appear for Claude without that flag. **Assumption:** board chats rely on the flag at least for auto-allow of `mcp__board__*`; plain chats have no data.
- Whether a hand-edited `chat.json` with a token and empty `Board` is loadable and callable. Code path exists (`ByToken` + `Call`); no test.
- Native Claude/Cursor subagent children inheriting the parent MCP config. **Assumption** (same as `adapters.md`): they see the parent session’s servers; the adapter does not spawn them and has no second credential.
- Comment at `agent/bridge.go:112` (“nil means no bridge (plain chats only)”) vs production (bridge always attached). Treat as stale wording, not a product rule.
