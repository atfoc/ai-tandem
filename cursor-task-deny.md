# Stopping Cursor from spawning subagents with its native Task tool

Question: can Cursor be made to *refuse* native subagent spawning (the `Task` tool) — deterministically, so
delegation must go through some other path? Mode: settled by running code, no human in the loop.
Settled means: a real run in which the `Task` call is refused by Cursor itself, not merely avoided by the model.

Branch: `cursor-task-deny`. Worktree: `/Users/pedjat/Documents/projects/ai-whiteboard-worktrees/cursor-task-deny`
(built on `ai-whiteboard` main `669487f`). Every attempt is committed there; the code is scaffolding, the answer
is here.

## Answer

Use a Cursor **`preToolUse` hook** that matches the `Task` tool and returns a deny. The hook runs inside Cursor,
before the tool call executes, and the CLI refuses the call: no subagent process is created.

Hook config (`hooks.json`):

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      { "command": "node /absolute/path/deny-task.js", "matcher": "^Task$" }
    ]
  }
}
```

The script reads a JSON payload on stdin (`hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, ...)
and, when `tool_name === "Task"`, writes:

```json
{ "permission": "deny", "user_message": "…why, and what to do instead…", "agent_message": "…same…" }
```

Anything else must print `{}` (no decision) so other tools behave normally. Deny wins over `--force` and over any
permission mode: the tool result the model sees is `Task blocked by preToolUse hook: <user_message>`.

Where the file must live differs by how Cursor runs, and this was the non-obvious part:

| mode | where Cursor reads project hooks | what the runs showed |
| --- | --- | --- |
| `agent -p` / interactive | `<git root of cwd>/.cursor/hooks.json` | a hook in the cwd (`scratch/.cursor/hooks.json`) was ignored; the one at the git root fired |
| `agent acp` — what ai-whiteboard uses | `${CURSOR_DATA_DIR:-~/.cursor}/projects/<slug(cwd)>/.cursor/hooks.json`, slug = cwd with every run of non-alphanumerics replaced by `-` | hooks in the repo and in the cwd were ignored; the per-project data-dir hook fired |

For ACP the hook is per project folder and outside the repo: with the default data dir and chat folder
`/Users/x/proj`, it is `~/.cursor/projects/Users-x-proj/.cursor/hooks.json`. Cursor's ACP session setup computes
`~/.cursor/projects/<slug(session cwd)>` as its workspace (the hook payload's `workspace_roots` confirms it), so an
app can write this file itself without touching the user's repo or their global CLI config.

### ACP cannot carry hooks itself

The ACP protocol has no place to put them. The server-visible surface is:

- `initialize`: `clientCapabilities` / `clientMetadata` — the ACP server reads only
  `_meta.parameterizedModelPicker` and subagent support (`subagents`), and the latter only turns subagent **event
  streaming** on or off (`sessionCapabilities.subagents`, the publisher/drain); it does not remove the `Task` tool.
- `session/new` / `session/load`: `cwd` and `mcpServers` only.
- `session/prompt`, `session/cancel`, `cursor/list_available_models`, …: no hook fields.

In the ACP chunk, the hook executor is built as `new HookExecutor(await configLoader(hookPaths).load(), workspace, …)`
where `hookPaths = Ve(Xq(session cwd))` — files only. There is no session parameter, capability, or metadata that
feeds it. Two adjacent candidates were tested and one works:

- **`--plugin-dir` does not work in ACP.** A local plugin with `hooks/hooks.json` was loaded by `-p` mode (hook
  fired, Task denied) but not by `agent acp` (hook never ran, subagent spawned). In the bundle, plugin hooks are
  merged into the hook executor only in the CLI-chat shared services (`getPluginHooks`), which the ACP path never
  calls.
- **`CURSOR_DATA_DIR` works and is the cleanest app-owned option.** The ACP hooks path is derived from the data
  dir, so running `agent acp` with `CURSOR_DATA_DIR=/app/owned/dir` makes Cursor read
  `/app/owned/dir/projects/<slug(cwd)>/.cursor/hooks.json` — verified: the hook fired there, Task was denied, no
  subagent, and login/session/model all behaved normally. `CURSOR_CONFIG_DIR` does **not** move these paths
  (that variable only covers `cli-config.json` and `acp-sessions`).

**Steering to the "other way" is a message, not a mechanism.** The deny only blocks the call. Put the alternative
in `user_message` / `agent_message`. With the message "run the Cursor CLI yourself, e.g.
`agent -p --force --trust --model composer-2.5 \"…\"`", both modes took the fallback — Shell in `-p`, Bash in ACP —
and returned the command's output to the parent agent, which used it as the subagent's report. In a real
integration the message would name the actual path instead (board MCP command, an app endpoint, …).

**What it does not do:** it does not remove `Task` from the model's tool list. The model still sees it and may try
it once per turn; every call is refused. `permissions.deny` in `cli-config.json` cannot do this job — those rules
take parameters (`Shell(...)`, `Read(...)`, `Write(...)`), not a tool name.

## What was tried

All runs used model `composer-2.5`, in `prototype/cursor-task-deny/scratch` (a throwaway project), with hooks
logging every invocation to `logs/pre-tool-use.jsonl`. Evidence files are on the branch under
`prototype/cursor-task-deny/logs/`.

| # | commit | run | what it showed |
| --- | --- | --- | --- |
| 1 | `398c736` | `agent -p` baseline, "delegate via Task" | `taskToolCall` spawned a subagent; it ran `echo $((17*23))` and reported 391 — `logs/01-baseline.jsonl` |
| 2 | `bf7ca3c` | `agent -p`, project hook at the git root, plain deny | hook fired with `tool_name: "Task"` and the full task input; result was `Task blocked by preToolUse hook: …`; no subagent; the model ran the command itself — `logs/02b-deny-root.jsonl`, `logs/pre-tool-use.jsonl` |
| 3 | `a611db8` | same, deny message names the `agent -p` fallback | model tried Task, got denied, ran `agent -p …` through Shell, reported `SUBAGENT-OK` — `logs/03-deny-fallback.jsonl` |
| 4 | `e28ee87` | ACP baseline via the app's own `internal/cursor` client, no hook | Task spawned (EvSub, child Bash, 391); **no permission request** for Task — the app never gets a chance to deny it at the permission layer — `logs/04-acp-baseline.jsonl` |
| 5 | `8d05c35` | ACP with the hook in the repo root and in the cwd (also a non-repo `/tmp` folder) | hook never ran, subagent spawned — `logs/05-acp-deny-hook.jsonl`, `logs/05c-acp-nonrepo.jsonl` |
| 6 | `065338d` | ACP with the hook at `~/.cursor/projects/<slug(cwd)>/.cursor/hooks.json` | hook fired, Task denied, no EvSub; the parent agent ran the command itself — `logs/05d-acp-projectdir-hook.jsonl` |
| 7 | `afcd68f` | ACP + deny message names the `agent -p` fallback | model ran `agent -p …` through Bash and used its `SUBAGENT-OK` output — `logs/05e-acp-fallback.jsonl` |
| 8 | `800835c` | ACP with `CURSOR_DATA_DIR=/tmp/ctd-data` and the hook under it | hook fired at `/tmp/ctd-data/projects/<slug(cwd)>/.cursor/hooks.json`, Task denied, login/session/model unaffected — `logs/08-acp-data-dir.jsonl` |
| 9 | `b2757a9` | ACP and `-p` with `--plugin-dir` pointing at a local plugin with `hooks/hooks.json` | **`-p`:** hook fired, Task denied (`logs/09c-cli-plugin-dir.jsonl`). **ACP:** hook never ran, subagent spawned — plugins are not merged into the ACP hook executor (`logs/09-acp-plugin-dir.jsonl`) |

Negative results worth keeping: attempt 4 shows a native Task never asks the ACP client for permission, so an app
cannot stop it by rejecting permission requests; attempt 5 shows the ACP server does not read repo hooks even
though the same file works in `-p` mode; attempt 9 shows plugin hooks (which work in `-p`) are not loaded by the
ACP hook executor at all.

## How to reproduce

All under `prototype/cursor-task-deny/` on the branch:

- `hooks/deny-task.js` — logs every `preToolUse` payload and denies `Task`; the message is `plain` or `fallback`
  (fallback names `agent -p …` as the alternative).
- `set-hook.sh plain|fallback|off` — writes the config into `scratch/.cursor/` and the git root (`-p` mode).
- `set-acp-hook.sh <cwd> plain|fallback|off` — writes `${CURSOR_DATA_DIR:-~/.cursor}/projects/<slug(cwd)>/.cursor/hooks.json`
  (ACP mode, the path the app needs); run the ACP process with the same `CURSOR_DATA_DIR` to keep it app-owned.
- `run-cli.sh <label> <prompt>` — one `agent -p` turn into `logs/<label>.jsonl`.
- `acpcheck/main.go` — one real ACP session through the app's own `internal/cursor` client:
  `go run ./prototype/cursor-task-deny/acpcheck -cwd <dir> -prompt "…"` (`-bin` takes a wrapper binary, e.g. to
  add `--plugin-dir`).
- `configs/` — the exact `hooks.json` files used (plain, fallback, and the plugin under `configs/plugin/`).

The live hooks were turned off after the runs (`b99bb76`); configs and evidence stay on the branch. `Task` is
spelled with a capital `T` in `tool_name`; the matcher is a regex, so `^Task$` is safe (bare `Task` would also
match names containing it).

## What this changes for ai-whiteboard

The MCP-subagents plan left Cursor as "instruction-steered only" because it assumed any Cursor tool deny would be
user-global (`internal/cursor/config.go` writes `~/.cursor/cli-config.json`). That assumption is now wrong in a
useful way: the ACP path honours a per-project `preToolUse` hook under
`<CURSOR_DATA_DIR>/projects/<slug(chat folder)>/.cursor/hooks.json`, which is outside the user's repo and scoped to
the chats that run in that folder. Setting `CURSOR_DATA_DIR` for the spawned `agent acp` process makes it fully
app-owned — no writes into `~/.cursor` either — and the run in attempt 8 shows login, session and model selection
are unaffected. The ACP protocol itself cannot carry the hook: the client has no field for it, so if one truly
wanted no files at all, it would take a Cursor feature request. For board chats this makes "no native Task"
deterministic for Cursor as well as Claude, and the deny message is where the board spawn tool would be named.

Caveats: hooks are a young feature — re-check on upgrades; the per-project data dir is a directory Cursor
manages, so the app should create only the `.cursor/hooks.json` inside it and tolerate Cursor touching the rest.
The follow-up below corrects the version (most runs above were already on `2026.10.01-e373342`), tests the
user-global file, and turns this into a concrete recipe.

## Follow-up: open questions A–G

Tested on Cursor CLI **`2026.10.01-e373342`**, macOS, model `composer-2.5` unless stated. Commit `e01f49b` on
`cursor-task-deny`; evidence in `prototype/cursor-task-deny/logs/<label>.jsonl` (raw ACP frames) and
`logs/probe.jsonl` (hook invocations). ACP runs used `run-acp-hook.sh <label> <config> <prompt>`, which puts the
hook under a throwaway `CURSOR_DATA_DIR` and drives `agent acp` with `acpraw.js`.

### Recommendation for ai-whiteboard

Per chat spawn, before `session/new` / `session/load`:

1. Pick an app-owned data dir **outside the app root** (e.g. `<app state>/cursor-data`) and start `agent acp`
   with `CURSOR_DATA_DIR=<that dir>`. Leave `HOME` and `CURSOR_CONFIG_DIR` alone.
2. Write `<data dir>/projects/<slug(cwd)>/.cursor/hooks.json`, where `cwd` is the exact string sent in
   `session/new` (not its realpath) and `slug` replaces every run of non-alphanumerics with `-`, trimmed:

   ```json
   {
     "version": 1,
     "hooks": {
       "preToolUse": [
         {
           "command": "echo '{\"permission\":\"deny\",\"user_message\":\"Native subagents (the Task tool) are disabled in this chat. To delegate, use <board spawn tool> instead.\"}'",
           "matcher": "^Task$",
           "failClosed": true
         }
       ]
     }
   }
   ```

3. If the user's project MCP servers should keep working, copy
   `~/.cursor/projects/<slug>/mcp-approvals.json` into the same app-owned project dir (see C).

Run 27 did exactly this through the app's own client (`acpcheck`): no `sub` event, and the model quoted
`Error: Task blocked by preToolUse hook: Native subagents (the Task tool) are disabled in this chat. To delegate,
use STUB-SPAWN-TOOL instead.` Nothing is written to the repo, `~/.cursor`, or `~/.claude`.

Why each part:

- **`failClosed: true` is required.** Without it a hook that crashes or times out lets `Task` run (runs 14, 15).
- **The redirect text goes in `user_message`.** That is the only field the model receives; `agent_message` is
  not delivered for a denied `Task` (run 24, four models quoted only the `user_message`).
- **A static `echo` needs no Node or script file.** The matcher already restricts it to `Task`.
- **The file is read once**, when the session's resources are built (`session/new` or `session/load`), so it
  must exist before that call.
- **Clean-up:** the app owns the whole data dir. Cursor also writes `agent-transcripts/`, `terminals/`, `mcps/`
  and similar under `projects/<slug>/`; delete project dirs of removed chats, or the whole dir on uninstall.
- **The app must read the refusal from `rawOutput.error`** of the `tool_call_update` if it wants to show it;
  the update has no `content`, which is why the app's stream showed an empty tool result.

### A. Non-file ways to inject hooks into `agent acp` — none usable

The ACP session builds its hook config from files only (`3351.index.js`: `Ve(Xq(cwd))` → loader → executor).
The single later update is `updateConfig` from team hooks fetched from the Cursor dashboard.

| candidate | result |
| --- | --- |
| `clientCapabilities` / `_meta` keys | the server reads only `_meta.parameterizedModelPicker` and `_meta.subagents` |
| custom methods | only `cursor/list_available_models`, `cursor/task`, `cursor/ask_question`, `cursor/create_plan`, `cursor/update_todos`, `cursor/generate_image` — none touch hooks |
| `--plugin-dir` | still not wired: the ACP chunk has no reference to plugin hooks |
| team hooks (dashboard) | a real non-file channel, but set by a team admin for every member and every session — not chat-scoped |
| enterprise file | `/Library/Application Support/Cursor/hooks.json` (`/etc/cursor/hooks.json` on Linux) — needs root, machine-wide |
| `subagentStart` hook event | exists in the schema with allow/deny, but **never fired in ACP** (run 20: subagent spawned) |

### B. Which hook files fire in ACP

| source | path | fires in ACP? |
| --- | --- | --- |
| project | `<data dir>/projects/<slug>/.cursor/hooks.json` | yes (settled earlier) |
| user | `~/.cursor/hooks.json` | **yes** — run 12b, Task denied |
| Claude project | `<data dir>/projects/<slug>/.claude/settings.json` (`PreToolUse`, matcher `Task`) | **yes** — run 21 |
| Claude user | `~/.claude/settings.json` | loaded by the same code path; **not run**, because it cannot be tested without editing the real file or moving `HOME` |

The user path comes from `os.homedir()`, not from `CURSOR_DATA_DIR`. Redirecting `HOME` to isolate it **breaks
login**: `authenticate` failed with `Failed to save the "cursor-access-token" credential` (run 12, with
`CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR` still pointing at the real `~/.cursor`). So `HOME`/`XDG` redirection is not
an option, and the user-global file is not chat-scoped.

Consequence: the user's own global hooks (Cursor or Claude format) also run in app chats. They cannot undo the
app's deny, because merged decisions resolve `deny > ask > allow` (run 17: an `allow` hook plus a `deny` hook →
denied).

### C. What `CURSOR_DATA_DIR` moves

Only `<data dir>/projects/…` is derived from it (`cursor-config/dist/paths.js`); everything else stays in the
config dir (`CURSOR_CONFIG_DIR` or `~/.cursor`).

| | where | under the redirect |
| --- | --- | --- |
| login, `cli-config.json`, `acp-config.json`, model list | config dir / keychain | unaffected (every run) |
| `acp-sessions/<id>/store.db` | config dir | unaffected — the context meter (`ctxusage.go`) reads the same path |
| `chats/<md5(cwd)>/…` (subagent stores) | config dir | unaffected |
| resuming a session created without the redirect | — | works; hook fired (run 25) |
| workspace trust marker `.workspace-trusted` | data dir | missing in a fresh dir; ACP does not need it (every run started fresh) |
| `agent-transcripts/`, `terminals/`, `mcps/`, `agent-tools/`, `repo.json`, `worker.log` | data dir | written into the app's dir instead of `~/.cursor/projects` |
| `mcp-approvals.json` and the disabled-MCP list | data dir | **not carried over** — project MCP servers the user approved in Cursor are unapproved in app chats unless the app copies the file. From code reading; not run. |

Two details for the app:

- Cursor tells the model about files under `projects/<slug>/` (terminal output, MCP descriptors). The app rejects
  permission requests that mention its own root (`agent.TouchesAppDir`), so the data dir should not live under
  that root.
- The slug is taken from the `cwd` string as sent: with `cwd=/tmp/ctd/ws` the hook was read from
  `projects/tmp-ctd-ws`, although Cursor also created `projects/private-tmp-ctd-ws` (run 26).

### D. Hook semantics in ACP

| question | result | run |
| --- | --- | --- |
| timeout field | `timeout`, in **seconds** (not `timeoutMs`). Hook slept 8 s with `timeout: 2`: **Task ran** | 15 |
| timeout + `failClosed: true` | denied: `…configured to fail closed… Hook script timed out after 2000ms` | 15b |
| hook exits non-zero | **Task ran** (fail-open) | 14 |
| exits non-zero + `failClosed: true` | denied | 14b |
| hook prints non-JSON | denied even without `failClosed`: `returned invalid JSON. The command was blocked for safety.` | 14c |
| `permission: "ask"` | no permission card; the call fails with `The 'ask' permission for preToolUse hooks is not yet implemented` | 13, 13b |
| `type: "prompt"` hook | works in ACP; Task denied with the hook model's reason | 19 |
| several hooks | `deny > ask > allow`; messages are concatenated | 17 |
| `updated_input` | applied: `echo ORIGINAL` ran as `echo HOOK-REWROTE` | 18 |
| matcher case | case-sensitive, unanchored regex: `^task$` did not fire and Task ran | 16 |
| tool name across models | `Task` on `composer-2.5`, `gpt-5.2`, `gemini-3.7-flash`, `claude-haiku-4-5`; all denied | 24–24d |
| what the model receives | `Task blocked by preToolUse hook: <user_message>` as the tool error; in ACP it is `tool_call_update.rawOutput.error` | 24d |

A denied call still sends one `cursor/task` request with empty `description`/`prompt`; no subagent session
follows. `subagent_type` is validated before the hook: an unknown type fails with `Invalid arguments` and the hook
is not called. The types offered here were `generalPurpose`, `cursor-guide`, `ci-investigator`,
`best-of-n-runner`.

### E. Removing `Task` instead of denying it — not possible

- **`--exclude-tools task_tool_call`** (hidden flag, "internal only") and the header it sets,
  `x-cursor-agent-exclude-tools`, sent directly with `-H`: both ignored by the backend for this account — the
  model still had `Task` and spawned a subagent (runs 10, 10b, `agent -p`). The ACP command does not forward
  either flag anyway.
- **`--statsig-overrides` / `CURSOR_STATSIG_OVERRIDES`:** compiled off in release builds (the enabling constant
  is `false`).
- **Feature gates:** `subagents_client_side_vscode`, `enable_await_for_subagents` and
  `subagent_support_interrupt` appear only in the table of gate defaults shared with the IDE; no CLI code reads
  them. The one subagent gate the CLI does read, `subagents_discovery_allow_external_symlinks`, is about finding
  custom agent files. Gates cannot be set locally anyway (previous point).
- **Team admin settings:** controls exist for auto-run, sandboxing, network, MCP tools and a command denylist;
  none for subagents.
- **Ask mode** (`session/set_mode ask`): the model made no `Task` call and said to switch to Agent mode (run 23).
  It also removes edits and commands, so it is not a fit for board chats.

`Task` is not in the model's base tool list at all: it is fetched on demand as a tool of a built-in `cursor`
MCP server (`getMcpToolsToolCall {server: "cursor", toolName: "Task"}` in runs 10/10b). The backend decides
that list.

### F. Version drift — it was an auto-update

`~/.local/bin/agent` was re-linked from `2026.09.28-64d2043` to `2026.10.01-e373342` at 12:54 on 2026-10-02,
between attempts 1 and 3 of the first round. The hook payload's `cursor_version` is a constant in the bundle, so
it reported the version actually running; nothing here is server-side. Attempts 3–9 and everything in this
follow-up ran on `2026.10.01-e373342`, the newest version installed. `agent update` was not run, because it
would change the installed CLI.

### G. Fallback statement

Making `Task` unavailable, or injecting a hook over ACP, needs a Cursor feature (forwarding `--plugin-dir` /
plugin hooks to ACP, or honouring `--exclude-tools`). Until then the app-owned hook file under `CURSOR_DATA_DIR`
is the mechanism: deterministic, chat-scoped, and it leaves the user's repo and Cursor config untouched.
