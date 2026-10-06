# Concurrent branches: phase 0 answers

The phase 0 answers for `concurrent-branches-plan.md` (section 5, "Phase 0: prototypes"), dated 2026-10-05, with `claude` 2.1.284, `pi` 0.85.1 and `cursor-agent` 2026.10.01.
Everything was run with the real CLIs through the adapters' own `Spawn` / `SpawnFork`, in temp folders, on throwaway code that was discarded; no product code came out of phase 0.

Evidence marks are the plan's: **[experiment]** observed with the real CLI, **[code]** read in code (this repository's, or the CLI's where said), **[inferred]** reasoned, not observed.

## Summary

The first seven questions of the plan's section 7.

| Question | Answer | Fallback taken |
|---|---|---|
| pi fork from a live source with extension and bridge | Yes | None. "pi forks need an idle source" is not taken |
| Cursor: backup of a mid-turn store cut back to the previous turn-end root, used while the source runs | Yes | None. "Cursor forks need an idle source" is not taken |
| Claude: live fork at a boundary with the app's exact flags | Yes | None. "Claude forks need an idle source" is not taken |
| Claude: source compaction while a fork is being made | Partly | Taken: the existing "compacted since then" error. It is today's behaviour, no code change |
| Claude: fork of a source with native subagents or background tasks | Partly | Taken: drop orphan notices as the resume path does. Needs a fix, the existing code drops only the first |
| Model change on a fork with no message yet (pi and Cursor) | Yes for both | None. "Takes its model from the fork request only" is not taken |
| Larger-to-smaller window; thinking blocks in untested directions | Window: works on Claude and Cursor, not safe on pi. Thinking: no error on all three | Guard on known sizes taken for pi only; failed-first-turn rule stays as the general net |

Common consequence of the first three rows: `pointOK` in `internal/chats/points.go`, mirrored in `web/src/logic/forkpoints.ts` and `TreeItem.OK`, allows a running source at the finished boundary before the running turn for all three agent kinds.

## 1. pi, live source with the app extension and bridge loaded

**Answer:** yes.

**Evidence:**

- [experiment] Source with turns 1 and 2 finished and turn 3 blocked in a 75 s shell command; app's real `Spawner` flags, materialized extension, real `pibridge`, board MCP. `SpawnFork` with `Point` = turn 2's id, no `Next`, no `End`: the fork was ready in 0.3 to 0.4 s, held exactly turns 1 and 2, and finished two turns while the source still ran. Two full runs.
- [experiment] Source: mid-turn file (4,081 bytes) unchanged after the fork and a byte prefix of the final file; turn 3 settled normally 72 s later; turn 4 recalled everything. Bridge: both runs registered, neither deregistered until closed. Board tool and the app-folder read refusal each went to the right process under its own token.
- [experiment] Extension handlers in the second process: `session_start` on the source file, `session_shutdown{fork}`, then `session_start{fork}` on the new file. Each opens a board MCP session with the fork's token only; none used the source's token or run handle.
- [experiment] Race between `entryAfter` and the fork command: two forced cases and 16 forks started from 400 ms before to 700 ms after a source send were all correct. The check below was never seen to fail.
- [code, pi's] The second process works from the snapshot it loaded at start; only the copy re-reads the file.

**Fallback:** none needed.

**Consequence for the code:**

- `pointOK`, pi part: when no end mark follows the point (`markFrom(items, count) < 0`), return true in place of false. The rule for a later mark stays. Same in the two mirrors.
- `forkSourceOf` (`internal/chats/fork.go`): unchanged. It already gives `Point`, `Next: ""`, `End: false`; `End` must not be set there.
- `SpawnFork` (`internal/pi/fork.go`): refuse only `!End && Next == "" && Point == ""`. With `Next == ""` take the `entryAfter` path.
- `forkSession`: for the new case (`!End`, no `Next`), after the fork or clone and `get_state`, call `get_fork_messages` and fail the fork unless the last entry id equals `Point`; a failed or empty listing fails it too. Keep today's tolerance for `End: true` (`TestSpawnForkAtEndClonesWhenPointUnknown`). `TestSpawnForkNoProcessErrors/no next mark` changes: that input now starts a fork.
- Limit [code, pi's]: `get_fork_messages` omits user messages with empty text, so such a message is invisible to `entryAfter` and to the check. The adapter sends text only.

**Not verified:** subagents running in the source during the fork; a pi compaction entry between the point and the running turn ([inferred] harmless). The chat-manager rules were derived by reading; only the adapter change was run.

## 2. Claude, the app's exact flags

The live-fork, cache and background-task prototypes ran with the app's flags (permission mode, MCP config, tool lists, appended board prompt). The compaction prototype ran `Args()` with no MCP config and no board prompt.

### 2.1 Live fork at a boundary

**Answer:** yes.

**Evidence:**

- [experiment] Source blocked in a foreground 80 s command in turn 2; `SpawnFork` at turn 1's point returned in 0.55 s. The fork knew turn 1 only, also after the source's turn 3. Run on Haiku and on Sonnet.
- [experiment] Source file identical after the fork's whole first turn (261,273 bytes Haiku, 231,752 Sonnet) and a byte prefix after source turns 2 and 3; turn 2 ended with no error.
- [experiment] MCP calls arrived under each process's own token, the fork's while the source was blocked. On Haiku, `can_use_tool` prompts were answered in both processes (2 each).

**Fallback:** none needed.

**Consequence for the code:** `pointOK` and its mirrors allow a Claude fork from a finished boundary of a busy source. `SpawnFork` needs no change.

**Not verified:** a stdio prompt under true auto mode (Haiku reports `permissionMode: "default"` despite the flag; Sonnet reports `auto` and raised no prompt); a fork while the source is streaming rather than in a tool call.

### 2.2 Cache sharing between parent and fork

**Answer:** yes.

**Evidence:**

- [experiment] The fork's first request read exactly what the source's next request read: 30,698 tokens on Haiku (222 written), 40,997 on Sonnet (172 written).
- [experiment] Fork's first turn cost $0.0094 (Haiku) and $0.041 (Sonnet), against $0.045 and $0.139 for the source's first turn.
- [experiment] Did not matter: session ids, the fork flags, the MCP bearer token. Cache writes are the 1-hour kind.
- [inferred] Sharing needs the same model, system prompt (so the same board or no-board state), built-in tool set and working folder, and a fork within an hour of the source's last request. Sharing after more than an hour was not verified.

**Fallback:** none needed.

**Consequence for the code:** none. A same-model fork's first turn costs about what the source's next turn would.

### 2.3 A source that compacts while a fork is being made

**Answer:** partly. The source and a fork whose process has started are never disturbed; a fork made or re-made afterwards depends on where its point lies.

**Evidence:**

- [experiment] A compaction shows `status "compacting"` for 13 to 15 s and appends boundary and summary to the same file only at the end; the old prefix stayed byte-identical.
- [experiment] One fork made before `/compact` and 12 started during the "compacting" status (the last 0.3 s before the boundary) all answered from the full history at their point. The fork process loads the history at start.
- [experiment] Re-made after the compaction, point before the preserved tail (2 of 2): `SpawnFork` returns the "compacted since then" error in 0.5 s. Point inside the preserved tail (3 of 3): starts with no error, on summary plus tail.
- [experiment] The source answered normally after every case, failed forks included.
- [code] The error is `SpawnFork`'s return value. At creation `startFork` fails the request and nothing is left of the fork; at a relaunch `spawnFailed` sets the fork's `errText` and `StatusError`.

**Fallback:** the plan's, the existing "compacted since then" error returned by `SpawnFork`. It is today's behaviour; no code change.

**Consequence for the code:**

- `internal/claude/fork.go`: no change.
- Keep attaching the fork's process at creation (`startFork` → `m.attach`): it is what makes a later source compaction harmless.
- Any path that re-makes a no-message fork can hit the error and must show it through `spawnFailed`: an app restart, and phase 3's model change on such a fork. The fork then stays unusable.
- Known limit, accepted: a point inside the compaction's preserved tail starts silently on summary plus tail. The plan's 4.2 wording ("gives the existing error") holds only for points before the tail. Detecting it would need `system/compact_boundary`, which `translate` drops today.

**Not verified:** a fork reading between the boundary write and the summary write.

### 2.4 A source with running native subagents or background tasks

**Answer:** partly. The fork reports each unfinished background task of its prefix as stopped and tells its model so; nothing attaches to the source's tasks.

**Evidence:**

- [experiment] With `Task` and `Agent` disallowed, these still run across a turn boundary: background Bash, `Monitor`, `Workflow` (which runs a native subagent), a session cron job.
- [experiment] At fork start, per unfinished task in the prefix: a `system/task_notification` with `status: "stopped"`, then after the initialize answer one `result` with `num_turns: 0` and `origin.kind: "task-notification"`. Same order in 11 of 11 starts. A task started in the running turn gives nothing.
- [experiment] The source's tasks finished normally and reported to the source only.
- [experiment] The CLI writes a `<task-notification>` user entry into the fork's session; the fork's model then said the command "was stopped before completing", which was false.
- [experiment] Adapter output: one notice gives nothing spurious; two notices let the second empty result through as `EvUsage` plus `EvTurnEnd{Point: ""}` with nothing sent.
- [code] `translate` sets the bool `p.orphan` on such a notification and drops one `num_turns == 0` result, then clears it. A fork runs the same `proc` code.

**Fallback:** the plan's, "drop orphan notices as the resume path does". It needs a fix to hold for more than one notice.

**Consequence for the code:**

- `translate`, result case: drop every result with `num_turns == 0` whose `origin.kind` is `task-notification`. Otherwise the manager counts a turn and appends an id-less end mark on a fresh fork or resume. Fake-CLI case for `fork_test.go`: two notifications, the initialize answer, two empty results, no `EvTurnEnd` expected.
- The model-facing notice cannot be dropped by the adapter. The plan's "not carried over" notice (4.3) also says that background commands and workflows from before the fork point belong to the source and may still run there.
- `readLoop` early check and `confirmed`: a result before the initialize answer fails the fork; only an errored result should count ([inferred] hazard, never seen in 11 starts).
- Known limit, accepted: a session cron job in the prefix also fires in the fork (seen twice, about $0.003 per tick).

**Not verified:** a subagent started by the `Task` or `Agent` tool (both are disallowed by the app's flags, so none could run); the native subagent seen was the one `Workflow` started.

## 3. Cursor, live backup with cut-back

**Answer:** yes.

**Evidence:**

- [experiment] Source on `gpt-5.4-nano`, turns 1 and 2 finished, turn 3 running shell commands (one 75 s sleep in run A, 19 tool calls in run B). 13 forks at turn 2's point, made 0.3 to 58 s into the turn, alternating two models: all loaded, answered with turns 1 and 2 only, while the source still ran. `SpawnFork` took 6.8 to 7.5 s.
- [experiment] 369 `copyStore`-only copies during the turn, 318 of them while the live root was a pending one: `integrity_check` was `ok` for every copy and fork, and the point was present and loadable in each. In every fork `latestRootBlobId` equalled the point, with nothing of turn 3 in reachable blobs.
- [experiment] Source undisturbed: turn 3 ended normally in both runs, the store was `ok`, turn 4 knew everything and was still on its own model although `cli-config.json` then named the other.
- [experiment] All eight source turn-end points checked were committed roots with no pending step.
- [experiment] Shared files: `cli-config.json` (about 7,000 reads at 20 ms) and `hooks.json` (14 rewrites per run) never read as unparseable; no session ran on the wrong model.
- [code] `forkSourceOf` gives `End` false at the boundary before a running turn, so the cut-back happens.

**Fallback:** none needed.

**Consequence for the code:**

- `SpawnFork`, `copyStore` and `forkSourceOf` need no change for a running source at a finished boundary. The chat side is what blocks it today: `pointOK` and the busy refusal in `forkEntry`.
- Hardening taken: `copyStore` sets `latestRootBlobId` to `Point` whenever one is recorded, also with `End`. Today `End` keeps whatever root is latest at copy time, and a source that takes a message between `forkSourceOf` and the backup would start the fork at a mid-turn root [inferred]. Cut-back to a root equal to the live root is harmless [experiment].
- Optional, no fault observed: write `hooks.json` only when its content differs, or atomically. What a torn read would do was not verified.

## 4. Model choice at creation

### 4.1 A model change on a fork with no message yet

**Answer:** yes for pi and for Cursor.

| Adapter | Mechanism | Evidence |
|---|---|---|
| pi | Close the process, then an ordinary `Spawn` on the fork's own session with the new `Model` and `Effort` | [experiment] The fork's file exists before its first prompt (1,785 bytes). Resumed from deepseek-flash onto gemini-3.1-flash-lite: same file, `get_state` showed the new model and level, correct recall, source not needed |
| Cursor | `Close`, `DiscardFork`, `SpawnFork` | [experiment] nano to haiku in 7.2 s in total; the first prompt answered on the new model with the source's history; the source stayed on its own model |
| Claude | The fork is re-made from the source at launch, or resumes its own file when it already has one | [code] A fork is re-made on every launch until its first message. [experiment] A fork of a source with unfinished background tasks has a file at start (2.4), and resumes that |

**Fallback:** none needed. "Such a fork takes its model from the fork request only" is not taken.

**Consequence for the code:**

- pi: in the phase 3 restart, close and `Spawn` with `SessionID` = the fork's id. No `ForkSource` is kept for pi (`startFork` stores one for Claude only). This differs from the plan's 4.6 wording ("a fresh fork of the source"): pi resumes its own session.
- pi: re-forking from the source also worked [experiment] but leaves an orphan session file; not taken.
- pi: do not send `set_model` to the attached process. It worked [experiment], but the process keeps a stale `AIWB_MODEL`, `--model` and model-specific appended prompt.
- Cursor: the source store must still hold the point. `applyChoice` on the attached process also worked (2.4 s, three cases) [experiment], but needs a new method and an update of `proc.o.Model` / `Effort`; not taken.
- Claude: the re-make can hit the "compacted since then" error (2.3), shown through `spawnFailed`.
- All three: a fresh fork's meter shows the source model's window until its first turn. For Claude, `prefixMeta` copies the source's `CtxWindow`; set it from the target's known window or to 0.

### 4.2 Thinking blocks in the untested directions

**Answer:** no error in any direction tested, on all three.

| Adapter | Tested [experiment] | Not tested |
|---|---|---|
| pi | 30 ordered pairs over six models (DeepSeek, Claude Haiku 4.5, Gemini, MiniMax, Grok, GLM) plus 4 pairs with an OpenAI model; source at effort `high` with signed thinking and a tool call | `openai-codex/gpt-5.4` and `gpt-5.4-mini`: they fail every prompt on this account, as source too |
| Claude | Sonnet to Haiku and Opus to Haiku, each at the turn end and at a mid-turn `tool_result`; Opus to Sonnet at the turn end. Ten turns, each fork two turns with a tool call | Long thinking-heavy histories |
| Cursor | All six directions between Anthropic, OpenAI and Google, each source with signed reasoning and a shell call | xAI, Kimi, GLM, Composer, the larger Claude and GPT models |

**Fallback:** none needed. The failed-first-turn rule stays as the general net; the pi Codex failure arrives as `EvTurnEnd.Error` and is covered by it.

**Consequence for the code:** no rule and no guard on provider family in any adapter.

### 4.3 Larger-to-smaller context window

| Adapter | Answer | Evidence |
|---|---|---|
| Claude | Works: the fork compacts automatically | [experiment] 277k-token Sonnet history forked onto Haiku (200,000): `SpawnFork` in 0.5 s; at the first message "compacting" for 20.7 s, `pre_tokens` 277,893 to `post_tokens` 52,836; the turn ended with no error. Detail was lost as with any compaction |
| Cursor | Works: Cursor summarises silently | [experiment] 301,333-token Gemini history forked onto haiku (200,000) and nano (272,000): both first prompts ended with no error after 15 to 16 s; the root went from 8 messages to 5, one of them a 3.7 KB summary; use afterwards 19,479 and 17,173 |
| pi | Not safe | [experiment] Source at 79,572 tokens (`EvUsage.CtxIn`). Target 16,385: pi compacted, then the provider refused with `context_length_exceeded`, twice. Target 32,768: silent compaction, the fork no longer knew a line it had read. Target 64,000: `Send` failed with `pi did not answer prompt within 30s` and the adapter closed the process |

**Fallback:**

- Claude and Cursor: none; no refusal guard.
- pi: the plan's guard is taken. Refuse the choice when the source's last known context use (`Usage.CtxIn`) exceeds the target model's `ContextWindow` minus pi's 16,384-token reserve. Unknown sizes fall to the failed-first-turn rule.

**Consequence for the code:**

- pi guard data: `get_available_models` gives `contextWindow` per model, already in `model.CatalogModel.ContextWindow`. The reserve is needed: with the bare window the gap still compacts silently. [code, pi's] `prompt()` compacts before acknowledging the RPC when use exceeds window minus `reserveTokens`; the adapter's `rpcTimeout` is 30 s.
- Claude: a refusal guard would be wrong. A 212,719-token Sonnet history forked onto Haiku with no compaction at all (177,814 tokens there); token counts differ about 20% between the two models. The stored Claude catalog has `ContextWindow` 0 on all 11 rows; only the built-in `claude.Catalog` fills it.
- Cursor: a guard could only be partial; the catalog knows a window for 13 of 38 models.
- Neither CLI's compaction reaches the user: `translate` drops Claude's "compacting" status and boundary (about 21 s shown as thinking), Cursor's stream has no update for it, and the pi adapter drops `compaction_*` events.
- The reports differ on a warning: the Claude report suggests at most a warning when `Usage.CtxIn` exceeds the target's known window, the Cursor report calls it optional. None is decided here.

**Not verified:**

- Claude: a source far above the target window (for example 800k onto Haiku); tested up to about 1.4 times. The failed-first-turn rule stands there.
- Cursor: the threshold at which it summarises, and the summary's quality on real work.
- pi guard input: `Usage.CtxIn` is the chat's latest value in the source model's tokens, and use at an earlier boundary is not recorded (found in the Claude prototype, [code]). For a fork from an earlier point the guard therefore over-estimates. How far pi token counts differ between models was not measured.

## Side findings

What the prototypes found that the plan does not mention.

- **Claude, a fork can have a session file before any message.** With unfinished background tasks in the prefix the fork's file exists right after start (8 of 8 starts) [experiment]. The plan's "no file until its first message" (4.2, 4.6) is false for such a source: later launches hit "already in use" and take the existing plain-resume fallback, and a model change resumes the fork's own file. `ReadContextSplit` also uses `--fork-session` and probably leaves a file [inferred].
- **Claude, a fork's cost totals start with the source's.** `result.total_cost_usd` and `modelUsage` of a fork begin at the source session's totals [experiment]. The window is still right, it is keyed by the init model.
- **Claude, background work survives `Close`.** On the resume path a background command kept running after the process was killed at the end of the 3 s grace [experiment].
- **Claude, `Workflow` runs native subagents in app chats.** Its subagent's Bash prompt reached the adapter as `can_use_tool` with an `agent_id`, giving an `EvPermRequest` with empty `Sub`; nothing else of the subagent is forwarded [experiment].
- **Claude, Haiku ignores `--permission-mode auto`.** The CLI reports `permissionMode: "default"` and every Bash call asks [experiment].
- **Cursor, the Task-deny hook had no effect in the prototype.** A native subagent ran in 4 of 4 probes, tool name `Agent` [experiment]. Not investigated: it may come from `CURSOR_CONFIG_DIR` or from the matcher `^Task$`.
- **Cursor, one meter error while summarising.** `readCtxLocked` reported `Cursor session store has an unexpected format` once mid-turn, then the right figures [experiment].
- **pi, the smaller-window hazard is not fork-specific.** The same silent compaction, provider error or 30 s timeout exists for a resume on a smaller model [inferred].
