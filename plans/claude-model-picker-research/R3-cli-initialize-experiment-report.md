# R3 — Claude Code `initialize` control response as a model-list source — experiment report

Author: research subagent (pi, DeepSeek V4.1 Flash). Status: **reviewed, PASS** (independent Claude Opus reviewer confirmed the facts against the saved captures, the code and one re-run; reviewer addenda are at the end).

Raw captures: `/var/folders/v8/t9kbrt2j7nl0pggwxyhdvvxxd3969g/T/tmp.GIDJ4PXwnT` (`run1.stdout.jsonl`, `run2.stdout.jsonl`, `run3.stdout.jsonl`, `appflags.stdout.jsonl`, `invalid_model.stdout.jsonl`, plus meta/summary files). These contain account identifiers (email, organisation) under `response.response.account` — do not copy them anywhere unredacted. Every `claude` invocation had a hard 30 s timeout. No user prompt was sent to any model.

## 1. Version and binary
- `claude --version` → `2.1.284 (Claude Code)`; binary `/Users/pedjat/.local/bin/claude`, a symlink to `/Users/pedjat/.local/share/claude/versions/2.1.284` (Mach-O arm64). Matches the research document.

## 2. The base command
Run from a scratch directory, one stdin line then EOF:

```
printf '%s\n' '{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}' \
 | claude --print --input-format stream-json --output-format stream-json --verbose
```

- wall-clock **1.241 s** (includes process spawn and exit), exit code **0**, stderr **empty**.
- **1 line** emitted, 34 314 bytes: top-level `type` = `control_response`; the subtype is nested at `response.subtype` = `"success"`. No `system/init`, no `result`, no other lines.

## 3. Model list path, keys, entries
- Exact JSON path: `$.response.response.models`. The envelope also has `$.response.subtype` = `"success"` and `$.response.request_id` echoing the request id, plus `pending_permission_requests: []`, `pending_user_dialog_requests: []`.
- **12 entries.** Union of keys on entries (9 keys):

| key | type | present |
|---|---|---|
| `value` | string | 12/12 |
| `resolvedModel` | string | 12/12 |
| `displayName` | string | 12/12 |
| `description` | string | 12/12 |
| `supportsEffort` | bool | 11/12 (missing on `haiku`) |
| `supportedEffortLevels` | array of string | 11/12 (missing on `haiku`) |
| `supportsAdaptiveThinking` | bool | 11/12 (missing on `haiku`) |
| `supportsAutoMode` | bool | 11/12 (missing on `haiku`) |
| `supportsFastMode` | bool | **4/12 only** (`default`, `opus`, `claude-opus-5`, `claude-opus-4-8`) |

- Entries table (order as returned):

| # | value | resolvedModel | displayName | supportedEffortLevels | description |
|---|---|---|---|---|---|
| 0 | `default` | `claude-opus-5-5` | Default (recommended) | low, medium, high, xhigh, max | Opus 5.5 · Best for everyday, complex tasks |
| 1 | `opus` | `claude-opus-5-5` | Opus 5.5 | low, medium, high, xhigh, max | For complex work and everyday tasks |
| 2 | `claude-fable-5-1` | `claude-fable-5-1` | Fable 5.1 | low, medium, high, xhigh, max | For your toughest challenges |
| 3 | `sonnet` | `claude-sonnet-5-5` | Sonnet 5.5 | low, medium, high, xhigh, max | Most efficient for simpler tasks |
| 4 | `haiku` | `claude-haiku-4-5-20251001` | Haiku 4.5 | *(key absent)* | Fastest for quick answers |
| 5 | `claude-sonnet-5` | `claude-sonnet-5` | Sonnet 5 | low, medium, high, xhigh, max | Efficient for routine tasks |
| 6 | `claude-opus-5` | `claude-opus-5` | Opus 5 | low, medium, high, xhigh, max | Best for everyday, complex tasks |
| 7 | `claude-fable-5` | `claude-fable-5` | Fable 5 | low, medium, high, xhigh, max | Most capable for your hardest and longest-running tasks |
| 8 | `claude-opus-4-8` | `claude-opus-4-8` | Opus 4.8 | low, medium, high, xhigh, max | Best for everyday, complex tasks |
| 9 | `claude-opus-4-7` | `claude-opus-4-7` | Opus 4.7 | low, medium, high, xhigh, max | Best for everyday, complex tasks |
| 10 | `claude-opus-4-6` | `claude-opus-4-6` | Opus 4.6 | low, medium, high, max | Best for everyday, complex tasks |
| 11 | `claude-sonnet-4-6` | `claude-sonnet-4-6` | Sonnet 4.6 | low, medium, high, max | Efficient for routine tasks |

- No context-window field exists anywhere in the entries (confirms the research document).

## 4. Default / current model, other payload keys
- Nothing is explicitly marked as "current": there is no `default`/`selected`/`isDefault` boolean on any entry. The only default signal is entry 0: `value: "default"`, `displayName: "Default (recommended)"`, `resolvedModel: "claude-opus-5-5"`. Whether the CLI actually *uses* it when no model is chosen is an assumption.
- **No other field states the CLI's selected model.** Running initialize with `--model sonnet` and `--model claude-fable-5-1` gave a payload identical to the no-model run (minus `pid`).
- Other top-level keys of the payload (`response.response`), 19 total: `models`; `account` (keys `email`, `organization`, `subscriptionType`, `apiProvider` — redacted); `agents` (configured subagent definitions); `commands` (slash commands/skills); `output_style`; `available_output_styles`; `user_output_styles_dir`; `current_permission_mode` (`"auto"`); `session_state` (`"idle"`); `pid`; `analytics_disabled`; `feedback_mode`; `fast_mode_state` (`"off"`); `fast_mode_disabled_reason` (`"sdk_opt_in_required"`); `remote_control_available`; `remote_control_auto_enable`; `remote_control_auto_connect_default`; `remote_control_auto_on_by_default`; `ide_rc_auto_enable_gate`.

## 5. Process lifecycle, side effects, model request
- With stdin closed immediately after the request: the process exits by itself, exit code 0, total wall ≈ 1.23 s. No `result` line, no other output, stderr empty.
- With stdin kept **open**: request flushed at 0.002 s, first response line arrived at **0.529 s**, and the process was **still alive 4 s later**. Only after stdin was closed did it exit, **0.765 s after close** (exit code 0). It answers, then waits for more stdin; it does not self-exit while stdin is open.
- **No files created in the working directory**; **no project directory for the scratch cwd appeared under `~/.claude/projects`**.
- **No model request observed**: no `assistant` line, no `result` line, no usage/cost/token fields. (Assumption: the response is produced from CLI bootstrap data, not a model call — consistent with the ~0.5 s latency.)
- Untested: whether `--session-id` (which the app always passes for chats) causes transcript files to be created.

## 6. Repeat runs
| run | wall | exit | stdout lines | stderr | models |
|---|---|---|---|---|---|
| run1 | 1.241 s | 0 | 1 (`control_response`/`success`) | empty | 12 |
| run2 | 1.226 s | 0 | 1 | empty | 12 |
| run3 | 1.260 s | 0 | 1 | empty | 12 |

The model list is identical across all three runs; raw stdout is byte-identical after normalising `pid`.

## 7. How the app spawns the CLI, and an app-flags rerun
- `Spawner.Args` in `internal/claude/claude.go` (`61-89` per the reviewer) builds: always `-p`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--permission-mode auto`, `--permission-prompt-tool stdio`, `--forward-subagent-text`; `--resume <sessionID>` or `--session-id <sessionID>`; `--model <model>` if set; `--effort <effort>` if set and model != `"haiku"`; `--disallowedTools <AppDirRules…,Task,Agent>`; if MCP: `--mcp-config <json>` and (when the list is non-empty) `--allowedTools <list>`; `--append-system-prompt <…>`. `internal/claude/ctxsplit.go:93` additionally passes `--fork-session`. Spawn env adds `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; `cmd.Dir` = chat folder; stderr captured (64 KB cap).
- The app's own initialize request (`claude.go:203-204`): `request_id: "init_<4-byte hex>"`, `request: {subtype:"initialize", agentProgressSummaries:true, forwardSubagentText:true}`.
- Rerun with the app's always-on flags (no session, MCP or prompt flags) and the app's exact request body: exit 0, ~1.3 s, 1 line `control_response`/`success`, stderr empty; `models` **identical** to run1; rest of payload identical minus `pid`. (Reviewer re-ran this independently with the eight always-on flags and inherited `CLAUDE*` env variables removed: identical payload, 1.233 s.)

## 8. Failure shapes
- Non-JSON line: exit **1**, 0 stdout lines, stderr `Error parsing streaming input line (type=unknown, 23 chars): SyntaxError`, 0.483 s.
- Valid JSON but missing `request`: exit **1**, 0 stdout lines, stderr `Error: Missing request on control_request`, 0.506 s.
- Valid request with unknown subtype: exit **0**, one `control_response` with `response.subtype: "error"`, `response.error: "Unsupported control request subtype: bogus_subtype"`, request id echoed, no stderr, 1.199 s.
- `--model definitely-not-a-real-model-xyz` with the initialize request: exit 0, success, 1.402 s. The list is returned with **13 entries**: the 12 normal ones plus an appended synthesized entry with `value`/`resolvedModel`/`displayName` all equal to the unknown name, `description: "Custom model"`, `supportsEffort: true`, `supportedEffortLevels: [low, medium, high, xhigh, max]`, `supportsAdaptiveThinking: true`, `supportsAutoMode: true` (no `supportsFastMode`). **The CLI does not reject unknown model names; it treats them as custom models and adds the process's `--model` value to the list.** Consequence for an in-chat refresh: a chat spawned with a `--model` value that is not in the standard list will see its own value appended to `models`.
- Signed-out state: **not tested**. Nonexistent binary: not tested.

## Differences from the research document
1. **"under a second"**: the *response* arrives ~0.53 s after spawn, but the whole command takes 1.23–1.31 s wall (exit takes ~0.7 s after stdin close).
2. **`supportsFastMode` is not on every entry**: present on only 4 of 12.
3. **`haiku` has no flags at all** and no `supportedEffortLevels` key — the key set is not uniform; a parser must treat missing as "no efforts"/false.
4. **Effort lists are abbreviated in the doc**: actual lists are `low, medium, high, xhigh, max`; only `claude-opus-4-6` and `claude-sonnet-4-6` lack `xhigh`.
5. **Unmentioned behavior:** an unknown `--model` value is not rejected and is appended to `models` as a "Custom model" entry.
6. **The app's actual request differs slightly** from "the app already sends this exact request": it adds `agentProgressSummaries: true`, `forwardSubagentText: true` and an `init_`-prefixed id. Response is the same.
7. Everything else in the doc's 12-row table matches exactly.

## Open questions
1. Is the list actually filtered by org/account settings (as the doc claims)? Only one signed-in account was available; signed-out state untested.
2. Does an app-style spawn with `--session-id`/MCP/`--append-system-prompt` change the `models` payload? Only session-free runs were tested.
3. Which CLI versions/plans return this shape, and how stable the key set is over time (only 2.1.284 on one account observed).
4. What `fast_mode_disabled_reason: "sdk_opt_in_required"` means for the app.
5. Whether `request_id` needs to be unique/non-empty for correlation.

## Reviewer addenda (independent Claude Opus review, verdict PASS)
1. `p.reply` is a dispatcher, not a discard. `case "control_response"` is at `claude.go:240`, the `p.reply(sc.Bytes())` call at 241. `reply` (`internal/claude/ctxsplit.go:36-46`) hands the response to whichever request is waiting on that `request_id`; the `init_*` id has no waiter, so it is dropped. A request/reply mechanism already exists (`p.request`, `p.replies`).
2. Side-effect check covered only the working directory and `~/.claude/projects`. In the reviewer's re-run `~/.claude.json` changed (mtime/size) during the 1.2 s window — a single observation with other sessions running, so unconfirmed whether the probe writes to it.
3. "No model request" is an inference from the absence of `assistant`/`result`/usage lines, not from network observation. Whether the list comes from a network bootstrap call or a local cache, and therefore how the probe behaves offline, is unknown.
4. No `[1m]` values in the list: none of the 12 `value`/`resolvedModel` strings has the `[1m]` suffix the research document suggests as a context-window source.
5. Support flags are `true` or absent, never `false`. A parser must treat a missing key as false.
6. Existing precedent for throwaway CLI spawns: `internal/claude/usage.go:26-27` and `internal/chats/namer.go:25-26` already spawn the CLI with `--no-session-persistence --strict-mcp-config`, and `usage.go` runs in `os.TempDir()`.
7. The probe result does not depend on inherited `CLAUDECODE`/`CLAUDE_CODE_*` environment variables (re-run with them removed gave an identical payload).
