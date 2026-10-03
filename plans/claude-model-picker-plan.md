# Claude model picker: implementation plan

Status: draft for review; the owner's decisions U1–U5 were settled on 2026-10-03 and are applied
throughout. Scope: the Claude entry of the model picker (Go server, web client,
desktop bundle). No implementation code, pseudocode, signatures or schemas; this document fixes
decisions, ownership, flows, phases and acceptance so implementation can proceed without
re-deriving them.

Evidence base:

- `plans/claude-model-picker.md` — the research document (feature definition and proposed fix).
  Where it disagrees with the reports, the reports win; the differences are listed in §11.
- **R1** `/tmp/claude-model-picker-plan/R1-backend-catalog-report.md` — backend catalog lifecycle.
- **R2** `/tmp/claude-model-picker-plan/R2-adapter-web-tests-report.md` — adapter, short-name
  assumptions, web client, tests, build.
- **R3** `/tmp/claude-model-picker-plan/R3-cli-initialize-experiment-report.md` — recorded
  experiment on the CLI's `initialize` response (Claude Code 2.1.284, one signed-in account).
- Claude Code documentation: CLI reference (<https://code.claude.com/docs/en/cli-reference>),
  Agent SDK TypeScript reference (<https://code.claude.com/docs/en/agent-sdk/typescript>),
  settings (<https://code.claude.com/docs/en/settings>), settings reference
  (<https://code.claude.com/docs/en/settings-reference>) and model configuration
  (<https://code.claude.com/docs/en/model-config>). A statement cited to these pages is what the
  documentation says, not something observed on the installed CLI; where the design touches it,
  an assumption in §10 carries it and a phase in §8 checks or records it.

The reports live under `/tmp` and R3's raw captures under a per-user temp folder; both can
disappear. Copy the three reports next to this plan (the way `plans/mcp-research/` keeps its
evidence) before implementation starts.

*Note (2026-10-03): the three reports now live in `plans/claude-model-picker-research/`; the
`/tmp` paths above are historical.*

All `path:line` references are to HEAD `658f7bb` and were opened while writing this plan. Every
statement below is one of three kinds: a **verified fact** (carries a `path:line`, a report
section or a URL), an **assumption** (listed in §10 as A1–A10 and cited by that label) or an
**owner decision** (U1–U5 in §10, all settled on 2026-10-03). No question is open for the owner.

A step that needs the owner — because it sends a real prompt, spends money, changes the sign-in
state, changes the owner's saved defaults or chats in the installed app's data folder
(`~/.ai-whiteboard`), uses one of the owner's existing chat sessions, replaces the installed app
or restarts the running app — is marked **[owner]** wherever it appears (constraint 9, §8).

---

## 1. Goal

The Claude model picker shows the models the signed-in account can actually use, as reported by
the Claude Code CLI, instead of three entries typed into the code. The list is fetched when the
server starts, is stored the same way the Cursor and pi lists are stored, and is the one list
every server path validates against. It is fetched again whenever a top-level Claude chat process
starts, from the answer that process already receives (D12, owner decision U4) — the way the
Cursor and pi lists are already refreshed on every chat process start
(`internal/cursor/cursor.go:246`, `internal/pi/pi.go:293`). The built-in list remains only as a
fallback for a machine where the CLI has never answered.

## 2. Scope

### In scope

- Reading `models` from the CLI's `initialize` control response and mapping it to the app's
  catalog type.
- A startup refresh for Claude next to the existing Cursor and pi refreshers, and an in-chat
  refresh from the `initialize` response every top-level Claude chat process already receives
  (D12).
- One catalog lookup rule (stored list, else built-in) for validation, new-chat defaults,
  subagent spawns and the client snapshot.
- Bringing the built-in fallback list up to date.
- Removing code that assumes the three short model names: the `--effort` gate, the web client's
  substring label fallback, the e2e label picks. The e2e file is edited so that it does not rot,
  but it is not run for this work (owner decision U3).
- Default effort per model, so a model switch never leaves an empty effort.
- Keeping cross-agent subagent spawns on today's behaviour once Claude's list shares ids with
  Cursor's (D22).
- Tests, a captured fixture, stale comments, and the rebuild and reinstall of the desktop app.

### Out of scope

- Any picker redesign: no grouping, sorting, badges or new columns. The picker keeps rendering
  catalog order (`web/src/Composer.tsx:309-312`).
- Surfacing the CLI's `supportsFastMode`, `supportsAutoMode` and `supportsAdaptiveThinking` flags
  (R3 §3); they are read past and not stored.
- Changing how saved defaults are recorded on the first send (`internal/chats/manager.go:616-620`);
  the owner accepted that behaviour as it is (U2).
- Running the paid end-to-end suite (`web/e2e/app.e2e.mjs`). It is not part of acceptance and
  nobody runs it for this work (U3).
- A periodic timer, a manual "refresh models" button, or any refresh trigger other than a server
  start and a top-level Claude chat process start.
- The chat namer's `--model haiku` (`internal/chats/namer.go:25`): it does not use the catalog and
  `haiku` is still an offered value (R3 §3).
- Cursor and pi catalogs, other than staying untouched. The one shared piece of code this plan
  changes for all three agents is the cross-agent rule of D22, which keeps their behaviour as it
  is today.
- Migrating existing chats or saved defaults. They keep their stored ids.

## 3. Requirements and constraints

Functional:

1. The picker for a Claude chat lists the models the CLI reports for the account, with the CLI's
   display names and descriptions.
2. Every listed model can be chosen in the picker, becomes a new chat's model through saved
   defaults, and can be named in `spawn_subagent`. A model that is not listed is rejected with the
   existing `unknown model` error (`internal/chats/manager.go:779`).
3. The picker and server validation always use the same list.
4. The list is refreshed at server start and whenever a top-level Claude chat process starts
   (D12), is saved to `state.json`, and reaches an open client without a page reload.
5. A chat never holds an effort its model lacks, and never an empty effort when its model offers
   efforts and the server had to pick one.
6. A subagent spawned without a model for an agent kind other than its chat's runs on that kind's
   new-chat defaults when that kind's list is known, as it does today, even when the chat's model
   id also appears in that kind's list (D22). While that kind's list is not yet known, the chat's
   model is passed through, also as today (`internal/chats/spawn.go:294`).

Constraints:

1. **Startup never blocks or fails on the probe.** The existing refreshers are plain goroutines
   started just before the HTTP server begins serving, on a listener that is already bound
   (`cmd/ai-whiteboard/main.go:125`, `182-183`, `218`); the Claude refresher follows the same shape.
2. **The probe never sends a prompt.** Its only stdin line is the `initialize` control request.
   R3 §5 observed no `assistant`, `result` or usage lines for that request; that it makes no model
   request at all is an inference from that (R3 addendum 3).
3. **A failed fetch keeps the last stored list**, logs one line, and broadcasts nothing — the
   behaviour of `refreshCursorCatalog` and `refreshPiCatalog`
   (`cmd/ai-whiteboard/main.go:345-371`).
4. **Existing chats and saved defaults keep working.** The ids `sonnet`, `opus` and `haiku` are
   still values the CLI offers (R3 §3), and the mapping keeps each `value` as the id (D1).
5. **No credentials are handled by the app.** The probe uses the CLI's existing sign-in, like
   every other CLI spawn (`internal/claude/usage.go:38-40`, `internal/claude/claude.go:185-187`).
6. **The built-in list is never changed at runtime.** It is read concurrently by the snapshot, the
   manager and every Claude process's read loop (R1 "Things" #4; `internal/app/app.go:50`,
   `internal/chats/manager.go:330`, `internal/claude/translate.go:223`).
7. **No phase may ship with a Claude list in the store that validation does not read** (the
   inconsistent state of R2 "Things" #13); §8 orders the work accordingly.
8. A chat process start must not wait for the `initialize` answer: the test fake never answers it
   (`internal/claude/proc_test.go:37-84`), and a slow answer must not delay a message.
9. **Nothing that belongs to the owner is used up or changed without the owner.** No build or
   verification step sends a prompt to a model, spends money, signs the CLI out or in, edits the
   owner's Claude or Cursor configuration files or shell environment, changes the owner's saved
   defaults or chats in the installed app's data folder (`~/.ai-whiteboard`), uses one of the
   owner's existing chat sessions, replaces the installed app or restarts the running app unless
   the owner consents or performs it. A chat process starts only when a
   message is sent (`internal/chats/manager.go:611` is the only call that starts one), so any
   check that needs a running chat process is such a step. In the installed app, so is every
   model or effort pick — a successful pick is recorded as the saved choice for the chat's group
   and as the last-used choice (`internal/chats/manager.go:746`,
   `internal/defaults/defaults.go:54-62`), which later new chats and rebased subagents start
   from (§7.3) — and so is creating a chat, which adds it to the owner's chat list. Picks and
   new chats are therefore walked on a dev server with its own data folder (§8), never as an
   unflagged step in the installed app. Each such step is marked **[owner]** in §8
   and has a prompt-free substitute or a stated consequence for when it is skipped. Running the
   CLI with only the `initialize` request, or its sign-in status command, is not such a step
   (constraint 2).

## 4. Acceptance criteria

1. With a working CLI, shortly after server start a new Claude chat's picker lists every model the
   CLI reports, minus a `default` row that duplicates another row (D2) and minus any entry the CLI
   synthesized for an unlisted model name (D20). On the account R3 measured that is 11 rows, labels
   and notes as in R3 §3.
2. Choosing any listed model succeeds; `PATCH /api/chats/{id}` and `spawn_subagent` reject an id
   that is not listed with `unknown model`.
3. With the CLI missing, hanging, answering with an error or — where the guard of D21 is built —
   reporting that it is signed out, the server starts and serves normally, logs one line, and
   shows the previously stored list, or the built-in list if nothing was ever stored.
4. The probe writes exactly one line to the CLI's stdin, and that line is the `initialize`
   control request.
5. The stored list survives a restart, arrives in the client snapshot, and a live `catalog` event
   updates an open picker.
6. A chat created before the change with `sonnet`, `opus` or `haiku` opens, resumes and shows its
   label; saved defaults holding those ids produce the same new-chat model as before.
7. Switching a chat to a model that lacks the chat's current effort gives it that model's default
   effort; switching to a model with no efforts clears the effort and the process starts without
   `--effort`.
8. For the two states "nothing stored" and "a list is stored", the snapshot's Claude catalog and
   the catalog used by validation are the same list.
9. Outside the built-in list and the namer, no non-test code compares a model id with a literal
   short name.
10. No entry the CLI synthesized for an unlisted model name reaches the stored list (D20): (a) not
    from the startup probe, and (b) not from a chat whose own model id is outside the standard
    list when its process starts.
11. `go test ./...`, `cd web && npm test` and `cd desktop && npm test` pass (`README.md:224-226`),
    and the rebuilt, reinstalled app shows the new list. The paid end-to-end suite is not part of
    acceptance and is not run (U3).
12. A subagent spawned without a model for an agent kind other than its chat's takes that kind's
    new-chat defaults when that kind's list is known, also when the chat's model id is in that
    kind's list — in both directions between Claude and Cursor. A subagent of the chat's own kind
    inherits the chat's model and effort as before (D22).

How each criterion is checked, which of those checks need the owner, and what stands in for a
check the owner does not make, is the table in §8, P4. The resume in criterion 6, the process
start in criterion 7, criterion 10(b), criterion 12 and the `spawn_subagent` half of criterion 2
can be seen in the app only by sending a real prompt; without the owner they are proved by the
named tests, and criterion 6 is observed as "opens and shows its label" only. Choosing a model
(criteria 2 and 7) and creating a chat (criteria 1 and 6) change the owner's data when done in
the installed app (constraint 9), so they are walked on a dev server (§8, P1 and P2).

## 5. Decisions

| # | Question | Decision | Reasoning |
|---|---|---|---|
| D1 | What is a model's id? | The CLI's `value`, unchanged; it is what `--model` receives. `displayName` is the label, `description` the note. | The CLI offers `value` as the thing to select (R3 §3), and `Args` passes the chat's model verbatim (`internal/claude/claude.go:70-72`). Stored `sonnet`/`opus`/`haiku` stay valid. |
| D2 | The `default` entry and alias/full-id duplicates | `default` is not a picker row when another entry resolves to the same model; it is used only to choose the catalog default (D3). If several entries resolve to that model, the `default` entry stands for the first of them in the CLI's order and the others stay as rows. If no other entry resolves to the same model, it stays as an ordinary row, but is not the catalog default (D3). Nothing else is deduplicated. Two rules fix what "another entry" means: the twin is looked for only among the entries left after D20 has removed synthesized ones, and an entry that carries no `resolvedModel` — the `default` entry or a candidate — has no twin. | `default` and `opus` both resolve to `claude-opus-5-5` (R3 §3): two rows for one model. A chat holding the literal `default` would change model whenever the CLI changes its recommendation, and whether `--model default` works at run time was not tested (A5). No other pair of rows shares a resolved model, and the alias rows are the only rows for the newest Opus, Sonnet and Haiku (R3 §3), so removing aliases would remove models. The CLI's order is the only ranking the response carries, so it breaks the tie; the measured account has no tie (R3 §3). A `default` entry with no twin is kept because dropping it would leave its model with no row at all. D20 goes first because otherwise the `default` entry could stand for a synthesized row that is then dropped, leaving a default that is not among the rows, and D17 would discard the whole fetch. `resolvedModel` is optional in the documented type and is absent before Claude Code 2.1.197 (Agent SDK reference, `ModelInfo`); it was present on all 12 entries observed (R3 §3). Without it there is nothing to compare, so on such a CLI `default` is simply kept as a row (D3 case c). *Note (2026-10-03): P0 and P3 measured the `default` entry resolving to `claude-sonnet-5-5` (twin `sonnet`), not `claude-opus-5-5`; see "P0 findings".* |
| D3 | Catalog default model | Fetched list, three cases. (a) The `default` entry stands for another row under D2: that row (`opus` on the measured account). (b) There is no `default` entry, or (c) the `default` entry is kept as its own row: the built-in list's default model if it is among the rows, else the first row that is not the kept `default` row; the kept `default` row is the default only when it is the sole row. The mapping takes the fallback model from the built-in list and names no model itself. Built-in list: stays `sonnet`. | The response names no default other than that entry (R3 §4). Cursor and pi already take their default from what the agent reports (`internal/cursor/probe.go:43`, `54`; R1 §3). In case (c) the kept row is deliberately not the default: every new chat on such an account would otherwise hold the literal `default`, follow the CLI's recommendation silently (the objection in D2) and depend on run-time behaviour nobody has observed (A5); the row remains available to pick. Falling back to the built-in list's default keeps today's out-of-the-box model wherever the CLI gives no usable recommendation, and keeps the mapping free of literal model names, as acceptance 9 and the P4 sweep require. Case (a) changes the out-of-the-box model; the owner accepted that, with the five cases it reaches (U1). *Note (2026-10-03): the `opus` of case (a) and the changed out-of-the-box model are R3's measurement; P0 and P3 measured the `default` entry resolving to `claude-sonnet-5-5` (twin `sonnet`), so the catalog default on this account is now `sonnet`/`high`, as today; see "P0 findings".* |
| D4 | Default effort | Every row that offers efforts gets a default effort: `high` when offered, else `medium`, else the first listed level. The catalog default's effort is its model's default effort, or none when that row offers no efforts. Applies to fetched and built-in rows. | The response carries no default effort (R2 "General"). `high` is what new chats get today (`internal/claude/catalog.go:14`), and every measured effort list contains it (R3 §3). |
| D5 | Effort after a model switch | The model's default effort from D4, through the fallback the server already has. No new logic and no client change. Chats that already hold an empty effort are not migrated. | `Configure`, `Resolve` and the subagent path already fall back to the row's default effort and only reach "empty" because none is set (`internal/chats/manager.go:713-720`, `internal/defaults/defaults.go:41-47`, `internal/chats/spawn.go:276-281`). The empty chip comes from that (`web/src/Composer.tsx:313-314`). |
| D6 | Context window in the picker | Fetched rows carry no context window. The meter shows none until the first reply reports it. No family lookup table and no id-suffix parsing. | The response has no window field and no `[1m]` values (R3 §3, addendum 4). The catalog window is only a fallback: the meter prefers the reported one (`web/src/Composer.tsx:551`), which arrives with the first `result` (`internal/claude/translate.go:74-85`, `internal/chats/manager.go:542-544`). Before that, the only loss is one tooltip sentence (`web/src/Composer.tsx:554`). Invented numbers would be worse than none. |
| D7 | Legacy subagent window lookup | `windowFor` keeps reading the built-in list, unchanged. | It tries the reported windows first (`internal/claude/translate.go:220-222`) and is reached only for native Task/Agent subagents, which every spawn disallows (`internal/claude/claude.go:76`; R2 §2). Reading the immutable built-in list also keeps the read loop away from the store (constraint 6). |
| D8 | Built-in fallback list | Four rows in the CLI's order: `opus` (Opus 5.5), `claude-fable-5-1` (Fable 5.1), `sonnet` (Sonnet 5.5), `haiku` (Haiku 4.5); notes are the CLI's descriptions; five efforts on the first three, none on `haiku`; default efforts per D4; windows stay on the three aliases as today, none on Fable; default `sonnet`/`high`. | Fixes the wrong Sonnet label and the missing Fable (R3 §3, `internal/claude/catalog.go:10-12`). The three aliases and haiku's window must stay for D7 and its test (`internal/claude/translate_test.go:124-147`). It is not account-aware: Fable needs account access (CLI reference, `--advisor` row), so a machine without it would see a row that fails at the first turn — accepted for a list used only until the first successful refresh. The 1M/200k windows are carried over unverified (A8). |
| D9 | Lookup rule | One rule on every server path: the stored Claude list when one exists, else the built-in list. Never "unknown" for Claude. | `App.Snapshot` already works this way (`internal/app/app.go:64-69`); `Manager.catalog` is the one place that bypasses the store (`internal/chats/manager.go:328-332`). Returning nothing would make `findModel` accept any model (`internal/chats/manager.go:770-773`). |
| D10 | Concurrency of the built-in list | The package-level list is never assigned or mutated after start. Fetched lists exist only in the store, each refresh stores a freshly built value, and readers treat catalogs as read-only. | R1 "Things" #4. The store serialises writes (`internal/store/store.go:99-107`); readers already take shallow copies (`internal/chats/manager.go:336-337`, `internal/app/app.go:66-67`). |
| D11 | The `--effort` gate | The literal `haiku` check leaves the adapter. The manager, when it builds a Claude process's options, leaves the effort out if the catalog lists the model with no efforts; a model the catalog does not know keeps its stored effort. The adapter passes whatever effort it is given. | `Args` has no catalog and the spawn options carry no capability (`internal/claude/claude.go:25-30`, `73`; `internal/agent/agent.go:15-25`); the manager is the only layer that has both (`internal/chats/manager.go:489-497`, `internal/chats/spawn.go:326-337`). The context-split fork takes its options from the same place as the chat process (`internal/chats/contextsplit.go:66`), so the gate there covers it too; the subagent path builds its own options and needs the gate as well. What the CLI does with `--effort` on a model without efforts is untested (R2 open question 4) and the CLI reference only says levels depend on the model, so the protection is kept rather than dropped. |
| D12 | In-chat refresh | Yes, unconditionally (owner decision U4, 2026-10-03): every start of a top-level Claude chat process refreshes the stored list from the `initialize` answer that process already receives. Built as P3, the last functional phase; nothing else depends on it. A3 is not a gate: the P3 runs that probe it are informational and no result cancels the phase. Rules in §7.2. | The owner's reasoning: the app receives that information on every process start anyway. The answer is already on every chat process's stdout and is thrown away (`internal/claude/claude.go:203-205`, `240-242`; `internal/claude/ctxsplit.go:36-46`), and the manager already stores and broadcasts a catalog event for any agent (`internal/chats/manager.go:523-530`). Precedent: Cursor and pi already emit their list on every chat process start (`internal/cursor/cursor.go:246`, `internal/pi/pi.go:293`). The server is long-lived — installing a new build does not restart it (`scripts/install-app.sh:20-27`) — so a startup-only list goes stale. Accepted risk (A3): a chat process is not the probe. It runs in the chat's folder (`internal/claude/claude.go:186`), may resume a session, and the settings documentation says project settings are read from the session's working directory and can restrict the available models. The store holds one Claude list for every chat and folder and each write replaces it whole (D13, `web/src/conn.ts:44`), so if a folder's settings change the answer, a chat started there replaces the list for all chats until the next top-level Claude chat process starts elsewhere or the server restarts (§7.6). Whether a folder does change the answer is documentation, not observation; P3 records what the installed CLI does. *Note (2026-10-03): the folder effect is now observed: a folder's `availableModels` narrowed the answer to 5 entries (P3 runs 3 and 4); see "P3 informational runs".* |
| D13 | A list that shrinks | A well-formed, non-empty list replaces the stored one whole; nothing is merged or kept back. Consequences in §7.6; no code is added for them. | It is what Cursor and pi do today, on the server and in the client (`cmd/ai-whiteboard/main.go:353`, `367`; `web/src/conn.ts:44`). The one lasting effect is a saved default being overwritten at the next first send, which the owner accepted (U2). With the in-chat refresh built unconditionally (D12), a list can also shrink because one chat's folder narrows it (A3, documented and not observed); it is replaced whole all the same, and the U2 overwrite can follow from such a list too. Both are accepted (§7.6). |
| D14 | The test fake and the pinned request | The `initialize` request the app sends does not change, so `TestSpawnSendsInitialize` stays as it is. The fake gains an opt-in answer to `initialize` that echoes the request id and serves a fixture, off by default. Where the guard of D21 is built, the fake also tells the sign-in status invocation from the `initialize` one and can be told which exit code to give the former. | The request is pinned byte for byte (`internal/claude/proc_test.go:306-323`). The id is random (`internal/claude/claude.go:203`), so a scripted stdout line cannot answer it; the fake already answers one control request this way (`internal/claude/proc_test.go:56-78`). Off by default keeps every existing test on today's no-answer path (constraint 8). The fake is one program that today treats every invocation alike — it prints its script and records stdin (`internal/claude/proc_test.go:37-84`) — so without the distinction the guard's test could not show that the `initialize` process was never started. |
| D15 | e2e model picks | The e2e picks Claude models by id, not by label text, and reads expected labels from the server's snapshot. | `pickModel` matches a substring over label plus note (`web/e2e/app.e2e.mjs:340-342`, `web/src/Composer.tsx:428`); `"Sonnet 5"` (`web/e2e/app.e2e.mjs:474`) matches both "Sonnet 5.5" and "Sonnet 5" in the fetched list (R2 §7). Labels now come from the CLI and can change with any release. The edits keep the file from rotting; the suite is not run for this work (U3), so they are checked for syntax only and are otherwise unexercised (§8, P1). |
| D16 | Web substring label fallback | The Claude branch of `subModelLabel` is removed: a Claude subagent's model is labelled by exact catalog match, else shown as the raw id. | The branch is reached only for ids no longer in the catalog and can only mislabel by family there, e.g. a removed `claude-sonnet-5` shown as "Sonnet 5.5" (`web/src/logic/subagents.ts:95-96`, `105-107`; R2 §3). |
| D17 | What counts as a usable fetched list | At least one row after mapping (D2 and D20 applied), every row with a non-empty id, and a default that is one of the rows and carries an effort that row offers — or no effort when that row offers none. Anything else is a failed fetch. A row without a display name is labelled with its id; missing effort keys mean no efforts. | `Resolve` trusts the catalog default without checking it (`internal/defaults/defaults.go:31-32`, `38`; R1 "Things" #8). `haiku` has no effort keys at all (R3 §3), and a default row can be one without efforts — the "first row" of D3, or a `default` entry that stands for such a row; D4 gives it no default effort, so demanding one would discard the whole fetch. `Resolve` already hands out no effort for such a row (`internal/defaults/defaults.go:41-47`). |
| D18 | Probe invocation | A throwaway CLI process in the temp folder, with the stream-JSON flags, the two throwaway flags the app already uses, no `--model` and no session; one overall timeout of 20 s; stdin closed after the answer; killed after a short grace if it has not exited. | Precedent: `internal/claude/usage.go:26-27`, `39-40` and `internal/chats/namer.go:25-26`, `37`. R3 saw a synthesized entry only when an unlisted `--model` was passed (R3 §8). That a probe without `--model` never carries one was not observed: the CLI reference says `--model` overrides the `model` setting and `ANTHROPIC_MODEL`, so without the flag those choose the session model. It is an assumption (A10, checked in P0), and the mapping drops such an entry on this path too (D20), so the design does not rest on it. The answer arrives in about 0.5 s and the process exits about 0.7 s after stdin closes, but not while stdin is open (R3 §5). 20 s matches the other refreshers (`cmd/ai-whiteboard/main.go:348`, `362`). That the two throwaway flags leave `models` unchanged is A1. *Note (2026-10-03): observed in P0 (A10): a configured unlisted model adds an entry even without `--model`, in the shape D20 removes; see "P0 findings".* |
| D19 | Stale comments and plan documents | Code comments are corrected in the phase that makes them false (list in §6). Older plan documents are historical records: their text stays, and each affected passage gets a one-line dated note pointing here. | The affected passages are `plans/mcp-subagents-refresh/adapters.md:383` (the static Claude row), `387` ("Claude always static") and `406` ("Claude cannot"), `plans/mcp-subagents-refresh/subagent-card-ui.md:79`, and `plans/mcp-subagents.md:350-351` with its source `plans/mcp-subagents-refresh/adapters.md:428`. The last two say "model vocabularies are not interchangeable (Claude aliases, Cursor bare ids, Pi `provider/id`)". That stops being true, not merely out of date: the stored Claude list shares ids with Cursor's (§10). Their note says so and adds that the fallback described there for cross-agent spawns now holds by rule (D22) and no longer by the lists being disjoint. Among the code comments, the one at `web/src/logic/subagents.ts:82-88` describes the alias match D16 removes and is corrected with it, and the one at `internal/chats/spawn.go:249-250` ("inherited values that do not fit") is corrected with D22. `plans/unified-mcp-endpoint.md:20-23` already treats research copies as a historical record. |
| D20 | Entries the CLI synthesizes for an unlisted model name | The shared mapping drops every entry whose display name is present and identical to its value. The test is the entry's shape alone — not the process's `--model` flag and not the description text — and it runs on both paths, the startup probe and the in-chat refresh. It is the first rule the mapping applies: D2's twin lookup, D3 and D17 see only what it leaves. | R3 saw such an entry for an unlisted `--model` (R3 §8), but the flag is not the only thing that can name the session model: per the CLI reference it merely overrides the `model` setting and `ANTHROPIC_MODEL`. A filter keyed on the flag could never run in the probe, which passes no flag, and would miss an entry caused by a configured model (A10). All 12 real rows have a display name that differs from their value, and the one synthesized entry seen does not (R3 §3, §8; A9). One rule in the one mapping also keeps the two paths producing the same list. Cost: a real row the CLI labels with its own id would be hidden from the picker, as would a custom picker entry the user configured on purpose if the CLI lists it in that shape (the model configuration documentation describes such an option; not observed). That is accepted over storing a stale id that then passes validation (R2 "Things" #17). A row with no display name at all is a different case and is kept (D17). A custom entry that was given its own name is not of this shape and is kept: from the user's own settings or environment it applies to every chat and is a legitimate row; from one folder's settings it is part of the accepted risk of A3, which P3's folder runs record (D12). |
| D21 | Signed-out guard for the startup probe | The probe first runs the CLI's sign-in status command inside its overall timeout (D18) and treats a non-zero exit as a failed fetch (§7.6), without starting the `initialize` process. It guards the startup probe only. P0 always records the status command's exit code on the signed-in machine, whether or not the owner signs out, and decides whether the guard is built: (a) the code is 0 and no signed-out run was made — built, on the documented exit codes; (b) the code is 0 and the owner signed out — built only if the signed-out probe returned a well-formed list and the status command then exited non-zero; not built if the signed-out probe already failed by itself; (c) the code is non-zero while signed in — not built, because it would block every refresh. In (c) without a signed-out run, and in (b) when the status command does not tell the two states apart, there is no guard and A2 stays unchecked or false for the signed-out probe, with the consequence A2 names. | Without it A2 can be confirmed only by signing the owner out, which only the owner can do (constraint 9). The CLI reference documents `claude auth status` as exiting 0 when logged in and 1 when not (documentation, not observed); recording the code while signed in means the guard cannot block the setup the app is used on. The guard fails safe — a wrong non-zero exit only keeps the stored list — but on a setup where the command reports "not logged in" while chats work the list would never refresh, which P0 rules out for the owner's machine only. It does not cover being offline or a chat process started while signed out (A2). It writes nothing to stdin, so constraint 2 and acceptance 4 are unaffected. |
| D22 | Cross-agent subagent spawns once Claude and Cursor share model ids | A subagent takes the chat's model only when it runs as the chat's own agent kind. When `spawn_subagent` asks for another kind and names no model, the chat's model counts as not fitting — whether or not the same id appears in that kind's list — and the spawn is rebased onto that kind's new-chat defaults, exactly as happens today. Nothing else in `resolveSubSpawn` changes: a named model or effort is validated as before; a named model still keeps the chat's effort when it offers it; a subagent of the chat's own kind inherits as before, including the effort rule of §7.3; and a kind whose list is not known yet still passes values through unvalidated (`internal/chats/spawn.go:294`). Built in P1, before anything stores a Claude list. Settled by the owner (U5). | Today the lists never meet: Claude's holds `sonnet`, `opus` and `haiku` (`internal/claude/catalog.go:10-12`), none of which is a Cursor id, and no pi id observed is in another list: pi ids are provider-qualified whenever pi reports a provider (§10). After P2, six of the 11 stored Claude ids are also Cursor ids on this machine, with the same effort lists (§10). `resolveSubSpawn` starts from the chat's model and effort (`internal/chats/spawn.go:263`) and rebases only when the id is missing from the requested kind's list or the effort is not offered (`internal/chats/spawn.go:293-302`), so such chats would start handing their model and effort across kinds, in both directions — including Claude chats spawning Cursor subagents, a Cursor behaviour this plan's scope says stays as it is. Inheritance by coincidence of spelling is also uneven: a Cursor chat on `claude-opus-5` would pass its model to a Claude subagent while one on `claude-opus-5-5` would not, because Claude lists that model as `opus`; it would skip the group's saved choice for the requested kind for some chat models only; and it would change whenever either vendor renames a row. Keeping today's rule costs one condition in shared code and, on the lists observed, changes no outcome that exists today; the unchanged cross-agent tests of P1 pin that. The other answer has a real argument — an id both vendors list names the same model, and "the chat's current model" is what an omitted model was meant to give (`plans/mcp-subagents.md:340-342`) — which is why it was put to the owner, who chose this rule (U5). |

## 6. Components and ownership

| Component | Where | Responsibility after the change | Change |
|---|---|---|---|
| Built-in list | `internal/claude/catalog.go:5-15` | The fallback list, immutable at runtime (D8, D10). Also the legacy window source (D7) and the source of the fallback default model the mapping uses (D3). | Contents updated; comment at `:7` no longer says "served to every client". |
| Response mapping | new, in `internal/claude` | The only place that knows the CLI's response shape. Turns an `initialize` response into a catalog under D1–D4, D6, D17 and D20, or reports it unusable. Shared by the probe and the in-chat path, so both apply the same rules — including the removal of synthesized entries — and produce the same list. Reads the built-in list's default for D3; it sits in the same package and only reads it (D10). | New. |
| Startup probe | new, in `internal/claude`, beside `usage.go` | Runs the throwaway process of D18, preceded by the sign-in check of D21 when that is built, and returns a catalog or an error. The Claude counterpart of `internal/cursor/probe.go:12-70` and `internal/pi/catalog.go:142-205`. Owns process lifetime and the timeout. | New. |
| Chat process | `internal/claude/claude.go:203-205`, `228-243` | In addition to today: recognises the answer to its own `initialize` request, hands it to the shared mapping and emits one catalog event (§7.2). Never waits for it. | Extended in P3, the last functional phase (D12). |
| Control-reply dispatch | `internal/claude/ctxsplit.go:36-69` | Unchanged: delivers answers to waiting requests and drops the rest, including interrupt answers (`internal/claude/claude.go:323-326`). | None required. |
| Claude refresher | `cmd/ai-whiteboard/main.go`, beside `:345-371`; started beside `:182-183` | Calls the probe once at start; on success stores the list for `model.Claude` and broadcasts a `catalog` event; on failure logs and returns. Owns nothing else. | New, same shape as its two neighbours. |
| Store and model | `internal/model/model.go:65-98`, `115-129`; `internal/store/store.go:99-107` | Persist the list under the generic per-agent map in `state.json`. Already generic. | Comments only (`internal/model/model.go:69`, `121`). |
| Chats manager | `internal/chats/manager.go:328-341`, `489-497`, `523-530`; `internal/chats/spawn.go:252-337`, `462-463` | Owns the lookup rule for validation, defaults and subagent spawns (D9); owns the effort gate (D11); owns what a subagent inherits from its chat, in `resolveSubSpawn` (`internal/chats/spawn.go:252-324`), including the cross-agent rule of D22; persists and broadcasts in-chat catalog events (already generic); keeps dropping catalog events from app-spawned subagent processes. | Lookup rule and effort gate change. `resolveSubSpawn` gains the one condition of D22, shared by all three agent kinds; its comment at `internal/chats/spawn.go:249-250` follows. The event paths stay as they are. Comment at `:769` mentions only Cursor. |
| Defaults | `internal/defaults/defaults.go:18-50`, `84-102` | Unchanged logic. Gets a catalog whose default is guaranteed valid (D17) and rows that carry a default effort (D4). | None. |
| Snapshot | `internal/app/app.go:49-74` | Unchanged logic: stored list, else built-in. | None; comment at `:54-55` is still true. |
| Agent types | `internal/agent/agent.go:20`, `63` | Unchanged. | Comments only ("Claude alias", "Cursor reported its models"). |
| Web client | `web/src/conn.ts:44`, `web/src/store.ts:96-107`, `web/src/Composer.tsx:36-44`, `287-320`, `551` | Unchanged flow: the snapshot fills the catalogs, a `catalog` event replaces one agent's list, the picker renders it in order. | `web/src/logic/subagents.ts:82-108` (D16); comment at `web/src/types.ts:38-39`; picker rows expose the model id for the e2e (D15). |
| Tests and fixture | `internal/claude/testdata/`, the test files in §8 | A captured `initialize` response, reduced to its envelope and `models` (P0), is the single source for parsing tests. | New fixture; test changes per phase. |
| Build | `scripts/build-app.sh:17-36`, `scripts/install-app.sh:11-27` | Unchanged. The Go binary and the web client are copied into the bundle, so the fix reaches the installed app only after a rebuild, reinstall and server restart. | None. |

Relations: the mapping is the only producer of Claude catalogs and has two callers (the probe
from P2, and the chat process from P3). Both writers reach the store through paths that already exist
for Cursor and pi (the refresher's own store update; the manager's catalog-event handler). The
store is the only shared state. All readers — snapshot, validation, defaults, subagent spawns —
go through the D9 rule. The built-in list has exactly four readers: the D9 fallback (snapshot and
manager), D7, and the mapping, which reads only its default model (D3). The stored Claude list
and the stored Cursor list are separate values that now share some ids; the only place the two
meet is a cross-agent `spawn_subagent`, which D22 governs.

## 7. Operations and flows

### 7.1 Startup refresh

- **Trigger:** once per server start, in its own goroutine, alongside the Cursor and pi refreshes.
  No retry and no timer, as today (R1 §3).
- **Steps:** the probe — after the sign-in check of D21, when that is built — starts the throwaway
  process, writes the `initialize` request, reads lines until the answer to that request, closes
  stdin and waits for exit. The mapping builds the catalog, first dropping any synthesized entry
  (D20) and then a duplicate `default` row (D2). The refresher stores it, then broadcasts it.
- **Outcome:** `state.json` holds the Claude list. A client active at that moment gets the
  `catalog` event; any later client gets the list in its snapshot, because the broadcast goes only
  to the active client (`internal/editorbridge/bridge.go:189-200`, `304-322`) and the store update
  comes first.
- **Until it completes:** clients see the previously stored list, or the built-in one. The
  measured round trip is about 1.2 s (R3 §2, §6).
- **Access:** the CLI's own sign-in; no token or key passes through the app. The process inherits
  the server's environment like the other throwaway spawns (`internal/claude/usage.go:40`); the
  result does not depend on inherited `CLAUDECODE`/`CLAUDE_CODE_*` variables (R3 addendum 7).
- **What the list reflects:** the probe runs outside any chat's folder, so it sees the account
  plus the user's own settings and environment, not a project's. Those apply to every chat as
  well, so a restriction set there is rightly reflected. A configured model outside the standard
  list is the one case that could add an entry without `--model`; it is unobserved (A10) and
  removed by D20. *Note (2026-10-03): P0 observed it; see "P0 findings".*
- **Side effects:** no files in the working folder and no project folder were created by the base
  command (R3 §5). `~/.claude.json` may be touched (R3 addendum 2, unconfirmed).

### 7.2 In-chat refresh

Built unconditionally, in P3 (D12, owner decision U4).

- **Trigger:** every start of a top-level Claude chat process — a first message or a resume. It
  is the trigger Cursor and pi already have (`internal/cursor/cursor.go:246`,
  `internal/pi/pi.go:293`).
- **Recognising the answer:** the process remembers the id of the `initialize` request it wrote
  and considers only the answer carrying that id. All other control answers keep going through the
  existing dispatch, so context-usage answers still reach their waiter and interrupt answers are
  still dropped.
- **The CLI's synthesized entry:** when the process's `--model` value is outside the standard
  list, the CLI appends an entry for it (R3 §8). The shared mapping removes it by its shape — a
  display name identical to its value (D20) — exactly as it does for the probe, so the chat
  process does not need to compare anything with its own `--model` value. Every real row observed
  has a display name that differs from its value (R3 §3), so this does not depend on the "Custom
  model" description text (A9). Without this, a chat on a removed model would put its id back in
  the picker and make it pass validation (R2 "Things" #17).
- **Outcome:** one catalog event per process; the manager stores it for the chat's agent and
  broadcasts it, with no manager change (`internal/chats/manager.go:523-530`).
- **Nothing waits:** no answer, an error answer or an unusable list produce no event and no
  error; the chat proceeds as today.
- **Subagent processes:** an app-spawned Claude subagent runs the same process code, so it emits
  the event too; the manager already drops it (`internal/chats/spawn.go:462-463`). That stays, and
  a test pins it.
- **Context-split forks:** their events are drained unread (`internal/claude/ctxsplit.go:97-100`).
  Nothing to do.
- **What the stored list then reflects (accepted risk, A3):** the answer of the chat process that
  started last. A chat process runs in the chat's folder (`internal/claude/claude.go:186`) while
  the probe runs in the temp folder, and the stored list is one list for all folders (D13). The
  flow assumes that, after D20, a chat-style spawn returns the probe's list whatever its argument
  list (session flags, effort, tool lists), its listed `--model`, a resume, and the folder it
  runs in with that folder's project and local settings, an `env` block included. Where that does
  not hold — the documentation says a folder's settings can restrict the list, for example with
  `availableModels`; this was not observed — a chat started in such a folder replaces the stored
  list for all chats, until the next top-level Claude chat process starts elsewhere or the server
  restarts. The owner accepted this (U4). P3 runs the prompt-free checks and records what the
  installed CLI does (§10); no result changes whether this flow is built.
  *Note (2026-10-03): observed in P3: a folder's `availableModels` narrows the list (5 entries)
  and a folder's `env` custom option adds a row; see "P3 informational runs".*

### 7.3 Catalog lookup

- **Callers:** new-chat defaults in `Create` (`internal/chats/manager.go:378-381`; `POST
  /api/chats` takes no model), `Configure` behind `PATCH /api/chats/{id}`
  (`internal/chats/manager.go:705`, `internal/server/server.go:569-573`), and `spawn_subagent`
  for the requested agent kind (`internal/chats/spawn.go:260`).
- **Rule:** D9. For Claude the result is never empty.
- **Outcome:** an id in the list is accepted; any other id is an `unknown model` error (HTTP 400
  from `PATCH`, tool text from `spawn_subagent`; R1 §6).
- **What a subagent inherits.** A spawn starts from the chat's model and effort
  (`internal/chats/spawn.go:263`); a model or effort named in the request replaces the inherited
  one and is validated against the requested kind's list. When that list is known, the spawn is
  rebased onto new-chat defaults in three situations:
  1. no model was named and the inherited id is not in the requested kind's list
     (`internal/chats/spawn.go:295-298`) — a chat whose own model is no longer listed, or, today,
     every chat of another kind;
  2. neither a model nor an effort was named, the inherited model is listed, and the chat's
     effort is non-empty and not among that row's efforts (`internal/chats/spawn.go:299-301`). A
     named model never gets here: it keeps the chat's effort when it offers it and otherwise
     takes its own default effort (`internal/chats/spawn.go:276-281`);
  3. new with D22: no model was named and the requested kind is not the chat's kind, whatever the
     id.

  A rebase replaces whichever of model and effort the request did not name
  (`internal/chats/spawn.go:303-312`), so in situation 2 a listed model is replaced together with
  its effort. New-chat defaults are the group's saved choice for that agent, then the last-used
  one, then the catalog default (`internal/defaults/defaults.go:27-40`). With D3 that last step
  now lands on the CLI's recommended model, which the owner accepted (U1). A requested kind
  whose list is not known yet is not rebased at all: the chat's model and effort pass through
  (`internal/chats/spawn.go:294`), today and under D22.
- **Why situation 3 exists.** Today situation 1 covers every cross-agent spawn, because no id is
  in two lists. With the fetched list stored, six Claude ids are also Cursor ids (§10), so
  situation 1 alone would let a Cursor chat on `claude-opus-4-8` hand that model and its effort
  to a Claude subagent, and a Claude chat on `claude-sonnet-5` hand it to a Cursor subagent.
  Situation 3 keeps both on new-chat defaults (D22, settled by the owner as U5). No pi id
  observed is in another list (§10).
- **Not validated, as today:** the model of an existing chat at process start
  (`internal/chats/manager.go:491-492`) and the defaults recorded on the first send
  (`internal/chats/manager.go:616-620`).

### 7.4 Client snapshot and live update

- **Snapshot:** on becoming active the client receives all catalogs and replaces its whole map
  (`web/src/store.ts:96-107`); the server fills Claude from the store, else the built-in list
  (`internal/app/app.go:50-69`).
- **Live:** a `catalog` event replaces that agent's list whole (`web/src/conn.ts:44`). Consumers
  re-render: the composer toolbar, idle sidebar rows and the subagent stats line
  (`web/src/Composer.tsx:289`, `web/src/Sidebar.tsx:513-519`, `web/src/Subagents.tsx:67`).
- **A chat whose model is not in the list** shows the raw id as its label
  (`web/src/Composer.tsx:37`).
- No client logic changes for this flow.

### 7.5 Model selection and effort fitting

- **Trigger:** the user picks a model or effort in an unlocked chat; the client sends the choice
  and the server answers with the updated chat (`web/src/Composer.tsx:294`, `309-317`).
- **Model pick:** validated by §7.3. If the chat's effort is not offered by the new model, the
  chat takes the model's default effort (D4, D5), or none when the model has no efforts.
- **Effort pick:** rejected if the model does not offer it (`internal/chats/manager.go:728-731`).
- **Process start:** the manager passes the chat's model and effort, leaving the effort out for a
  model the catalog lists without efforts (D11).
- **Saved defaults:** a successful pick is recorded for the group and as the last choice
  (`internal/chats/manager.go:746`, `internal/defaults/defaults.go:54-62`); the first send records
  the chat's settings again, changed or not (`internal/chats/manager.go:616-620`). Unchanged. It
  is the reason a pick made in the installed app during verification is an **[owner]** step
  (constraint 9): both values are written by every pick, to the same model, and a pick cannot
  clear either.

### 7.6 Failure handling

| Situation | What happens |
|---|---|
| CLI binary missing or not startable | Probe returns an error; one log line; stored list (or built-in) stays; nothing is broadcast. |
| CLI exits non-zero, with or without stderr (R3 §8) | Same. The first stderr line goes into the log line. |
| Answer with an error subtype (R3 §8) | Same. |
| No answer within the timeout | Same; the process is killed. |
| Malformed JSON, no `models`, empty `models`, or a list that fails D17 | Same — treated as a failed fetch, never stored. |
| Signed out | What the `initialize` process returns then is unknown (R3 §8). With the guard of D21 the startup probe never gets that far: the sign-in check exits non-zero (CLI reference; documentation) and the fetch fails like the rows above, with its own log line. Without the guard there are two cases (D21): P0 saw a signed-out probe fail by itself, and it is one of the rows above; or the status command proved unusable on the owner's machine and no signed-out run was made, and the outcome stays unknown (A2). A chat process started while signed out is not guarded (A2): if its `initialize` answer then held a well-formed wrong list, the in-chat refresh would store it until the next good refresh. |
| Offline | Unknown (R3 addendum 3). Assumed to end in one of the rows above (A2). |
| The user's configured model (`model` setting or `ANTHROPIC_MODEL`) is outside the standard list | Whether the CLI then adds a synthesized entry even without `--model` is unobserved (A10). If it does, in the shape R3 saw, the mapping drops it (D20) and the stored list is unaffected. *Note (2026-10-03): P0 observed it; see "P0 findings".* |
| A chat folder whose project or local settings change the list (for example `availableModels`; documented, not observed) | Accepted risk (A3, owner decision U4). The in-chat refresh stores what that chat's process reports, so a chat started in such a folder replaces the one stored list for all chats, in every folder, until the next top-level Claude chat process starts elsewhere or the server restarts — either of which stores its own answer in turn. While the narrowed list is stored, the rows of this table for a list with fewer rows apply to every chat: models missing from it cannot be picked or named in `spawn_subagent` anywhere, and a saved default on a missing model can be overwritten at a first send (U2). If the folder adds a row instead, that row is offered to all chats for the same period. In the other direction nothing changes: the picker may offer a model that a folder's settings exclude; what the CLI does with it is untested, and the picker ignores folder settings today as well. P3's folder runs record whether the installed CLI behaves this way (§10). *Note (2026-10-03): observed, not only documented: P3 runs 3 and 4 (narrowed to 5 entries) and runs 5 and 6 (an added row); see "P3 informational runs".* |
| A well-formed list with fewer rows than before | Stored and shown (D13). Locked chats on a removed model keep their id, show it raw, and still pass it to the CLI, which accepts unlisted names as custom models at start-up (R3 §8). An unlocked chat on a removed model shows the raw id; an effort-only change on it is rejected until another model is picked (`internal/chats/manager.go:723-727`). A subagent spawned without a model from a chat on a removed model does not inherit it: it is rebased onto new-chat defaults — the group's saved Claude choice, then the last-used one, then the catalog default when neither is set or the one found is itself no longer listed (`internal/chats/spawn.go:293-312`, `internal/defaults/defaults.go:27-40`). The catalog default is now the CLI's recommended model at its default effort, not `sonnet` (D3, U1). *Note (2026-10-03): on this account the catalog default is `sonnet` now; see "P0 findings".* A saved default on a removed model resolves to the catalog default for new chats (`internal/defaults/defaults.go:35-40`); the first send in such a chat then records the substitute model in place of the saved one, for the group and as the last choice, while an empty substitute effort leaves the old saved effort in place (`internal/chats/manager.go:616-620`, `internal/defaults/defaults.go:89-94`). The owner accepted this: a send records a new model (U2). It holds whatever shortened the list — the account, a CLI release, or one chat folder's settings through the in-chat refresh (the row above). |
| A different CLI version returns unknown keys or lacks known ones | Unknown keys are ignored; missing effort keys mean no efforts; a missing or empty `value` fails D17. Only 2.1.284 was observed (A4). |
| Saving the list fails | Logged; the broadcast still goes out, as for Cursor and pi (`cmd/ai-whiteboard/main.go:353-356`). |
| In-chat answer missing or unusable | No event; the chat is unaffected and the stored list stays (§7.2). |
| An older binary runs on a `state.json` that already holds a Claude list | The old snapshot serves the stored list while old validation uses the old built-in list — the inconsistent state. Accepted; a downgrade is not a supported path. |
| The chat's model id is in both its own agent's list and the list of the kind a subagent is requested as | Not inherited: with no model named, the subagent takes the requested kind's new-chat defaults, as every cross-agent spawn does today when that kind's list is known (D22, §7.3 situation 3). A model named in the request is used as named. |
| A chat holds an effort its listed model no longer offers, and spawns a subagent of its own kind with neither model nor effort | The subagent is rebased onto new-chat defaults, model included (§7.3 situation 2). It is not expected today for Claude, whose list never changes and whose chats get their effort fitted on every model pick (`internal/chats/manager.go:713-720`); after P2 it follows a refresh that shortens a row's effort list under a locked chat. Existing behaviour, not changed. While the group's saved choice is still the chat's model — the chat's first send records it (`internal/chats/manager.go:616-620`) — the rebase lands on that same model at its default effort (`internal/defaults/defaults.go:35-47`). |

## 8. Build plan

Order and dependencies: **P0 → P2**, **P1 → P2 → P3 → P4**. P1 does not need P0. P3 needs P2 (the
mapping and the fake's answer) and is built unconditionally (D12); nothing else depends on it.

The state the reports warn about — a stored list visible in the picker but rejected by
validation (R2 "Things" #13) — arises if anything writes a Claude list to the store before
`Manager.catalog` reads it. P1 therefore changes every reader while nothing writes yet, and the
first writer arrives in P2. P1 and P2 may be merged into one change, but P2 must never land first.
The same ordering protects D22: the cross-agent rule lands in P1, before P2 stores the first list
that shares ids with Cursor's.

**Who performs a check (constraint 9).** Three kinds of manual step occur below:

- *Prompt-free CLI runs* (P0, the informational runs of P3): the CLI is started with only the
  `initialize` request, or as its sign-in status command. They use the owner's sign-in and send
  no prompt. The implementer edits none of the owner's settings files and no shell environment;
  a variable or a setting under test is given to that one process only, or written into a
  scratch folder made for the run. What the CLI writes by itself is outside the implementer's
  control and is named here: `~/.claude.json`, the CLI's own state file, changed during one such
  run (R3 reviewer addendum 2; one observation, unconfirmed that the run caused it), and a run
  that carries a session id may leave a project folder for its scratch folder under
  `~/.claude/projects` (untested, R3 §5; none appeared for the base command). Cleanup: after the
  runs the implementer removes the scratch folders and any project folder that appeared under
  `~/.claude/projects` for one of them — recognised by comparing that folder's contents before
  and after — and nothing else there. `~/.claude.json` is left as the CLI wrote it. The
  implementer may run them. The one exception is the `--resume` run of P3, which uses a chat
  session of the owner's and is **[owner]**.
- *Dev-server checks* (P1, P2): a server built from the working tree and started beside the
  installed app. It needs its own data folder, its own port and the test-only MCP port override,
  because the binary exits when a server already runs for its data folder or port and refuses to
  start when the fixed MCP port is taken (`cmd/ai-whiteboard/main.go:120-123`, `131-137`,
  `221-234`). It is also given its own Cursor configuration folder, the way the e2e script sets
  one up (`web/e2e/app.e2e.mjs:64-66`): every server start adds deny rules for its data folder to the
  Cursor CLI configuration, which is the owner's own file unless that folder is redirected
  (`cmd/ai-whiteboard/main.go:185`, `internal/cursor/config.go:14-29`). With those it leaves the
  owner's data folder, configuration and running app alone. Like every server start it runs the
  existing Cursor and pi list refreshes (`cmd/ai-whiteboard/main.go:182-183`) and, from P2 on,
  the prompt-free Claude probe. Nothing in these
  checks sends a message: creating a chat and picking a model start no process. Chats created
  there, the defaults that picks record (`internal/chats/manager.go:746`) and the lists the
  refreshes store all land in the dev server's own data folder, which is discarded afterwards;
  this is why every pick and every new chat of the verification is walked here and not in the
  installed app. The implementer may run them.
- **[owner]** *steps*: anything that sends a real prompt, signs the CLI out, changes the owner's
  saved defaults or chats in the installed app's data folder (a model or effort pick, a new
  chat), uses one of the owner's existing chat sessions, replaces the installed app or restarts
  the running app. The owner performs them or consents first; each names what stands in for it
  when the owner does not.

### P0 — Fixture and open facts (no product code)

Runs the CLI without a prompt, exactly as the probe will (D18); the A10 runs differ from it only
in the one input they test.

- Capture one `initialize` answer and keep only what the tests need: the envelope (type,
  subtype, request id) and `models`. Everything else in the payload is dropped, not just the
  account block and the process id: the payload also carries the owner's agent definitions,
  commands and skills and a directory path (`agents`, `commands`, `user_output_styles_dir`,
  R3 §4), and the account block holds an email and an organisation (R3 header). Save the result
  under `internal/claude/testdata/`.
- Derive a second fixture with the synthesized entry of R3 §8, by capturing with an unlisted
  `--model` value or by appending the entry by hand, reduced the same way. A captured one also
  re-checks A9.
- Check A1: the throwaway flags give the same `models` as R3's base command.
- Check A6: no session or project files appear.
- Check A10: run the probe, still without `--model`, once with `ANTHROPIC_MODEL` set to an
  unlisted name in that process's environment only and once with an unlisted `model` setting
  supplied for that run only (a scratch folder's project settings or the CLI's `--settings` flag;
  the user's own settings files and shell environment are not edited). Record whether an extra
  entry appears and, if so, its shape. The scratch folder is removed afterwards, with the
  cleanup named at the start of §8.
- Record the exit code of the sign-in status command on the signed-in machine. This is done in
  every case; it reads the sign-in state and changes nothing.
- **[owner]** Signing out, to record what the probe and the status command return then (A2).
  Only the owner signs out and back in. It reaches beyond the check: the sign-in is shared by
  every CLI process on the machine (constraint 5), so chats running in the app — and the
  implementing session, if it is a Claude one — may fail while signed out (expected, not
  observed). *If the owner does not do it:* the guard of D21 is built on the recorded exit code
  and the documented meaning of it, and A2 stays unconfirmed for the signed-out probe; if that
  exit code is non-zero, no guard is built and A2 stays unchecked (D21 case c).

**Verify:** the fixture's rows match R3 §3 and it holds nothing but the envelope and `models`;
findings are written back into §10 of this plan. Three outcomes change the work that follows and
are recorded there: a synthesized entry of a shape D20 does not catch (revisit D20 before P2); a
signed-out probe that fails by itself (D21 is not built); and a sign-in status command that
exits non-zero while signed in, or the same in both states (D21 is not built, and A2 is unchecked
or false for the signed-out probe).

### P1 — One list everywhere, built-in list up to date, short names removed

A complete slice with no new process: after it, the picker shows the corrected built-in list and
every server path agrees with it.

- Lookup rule D9 in `Manager.catalog`.
- Built-in list per D8 and D4.
- Effort gate per D11.
- Cross-agent rule per D22 in `resolveSubSpawn`. With the lists as they are in this phase it
  changes no outcome; it is here so that it is in place before P2.
- Web: D16; picker rows expose the model id; e2e picks by id (D15). The e2e file is edited but
  not run (U3).
- Comments made false by this phase (D19).

**Tests that change:**

- `TestArgsHaikuHasNoEffort` (`internal/claude/args_test.go:149-153`) is replaced: the adapter
  passes the effort it is given, and a manager-level test proves a chat on a no-effort model
  starts its process without one.
- `web/test/subagents.test.ts:125-134`, `160`: the fixture and the two alias assertions follow D16.
- `web/e2e/app.e2e.mjs:69`, `447-451`, `461`, `474`, `865`, `1023`: picks by id, labels from the
  snapshot. Not a test that runs in this work: the suite is not run (U3) and it is not part of
  `npm test` (`web/e2e/app.e2e.mjs:6`), so these edits get a syntax-only check (Verify, below).

**Tests that must pass unchanged** (they pin behaviour this phase keeps):

- The existing assertions of `TestSnapshotCatalogs` — fresh default is `sonnet`
  (`internal/app/app_test.go:604-611`). They stay as they are; the test only gains a case (below).
- The default Claude subagent inherits `sonnet`/`high` (`internal/chats/spawn_test.go:86-92`).
- Cross-agent spawns as they are today, which D22 must leave alone: a Cursor subagent with no
  model from a Claude chat takes Cursor's default model and effort, and a model named while
  Cursor's list is unknown is passed through (`internal/chats/spawn_test.go:359-382`); a pi
  subagent with no model from a Claude chat starts (`internal/chats/spawn_test.go:77-84`).
- Configure on `opus` and `haiku`, and rejection of `nope`
  (`internal/chats/manager_test.go:680-710`); the `opus` PATCH
  (`internal/server/server_test.go:570-573`).
- `TestTranslateSubagentLines` — haiku's 200 000 window
  (`internal/claude/translate_test.go:124-147`).
- `TestFirstSendRecordsDefaults` (`internal/chats/manager_test.go:812-831`) and
  `TestModelNotInCatalogAndEffortCleared` (`internal/defaults/defaults_test.go:155-168`), whose
  fixture is self-contained (`internal/defaults/defaults_test.go:12-21`).

**New tests:**

- A store-backed Claude catalog test, following `TestCatalogLegacyCursorField`
  (`internal/chats/manager_test.go:592-608`). It proves: with nothing stored the manager returns
  the built-in list; with a list stored, `Configure` accepts an id only that list has and rejects
  an id only the built-in list has; a new chat resolves the stored default; `spawn_subagent`
  validates against the stored list; with no listed Claude choice recorded, a Claude subagent
  spawned without a model from a Cursor or pi chat, and one spawned from a Claude chat whose
  model the stored list lacks, both take the stored list's default model and effort (U1 cases 3
  and 4, which the owner accepted).
- The collision case (D22, acceptance 12), with a stored Claude list and a stored Cursor list
  that share an id and offer the same efforts for it:
  - a Cursor chat on the shared id spawns a Claude subagent without a model — it gets Claude's
    new-chat defaults, not the chat's model and effort; with a saved Claude choice for the
    group, it gets that choice;
  - the reverse, a Claude chat on the shared id spawning a Cursor subagent without a model —
    Cursor's new-chat defaults;
  - the shared id named in the request — used as named, with the chat's effort kept;
  - a subagent of the chat's own kind from the same chat — inherits the chat's model and effort.
- The effort route (§7.3 situation 2, U1 case 5): a Claude chat on a listed model whose stored
  row lacks the chat's effort spawns a Claude subagent with neither model nor effort — it is
  rebased onto new-chat defaults, and never started with an effort its model lacks.
- The snapshot and the manager return the same Claude list in both states (acceptance 8); add a
  stored-Claude case to `TestSnapshotCatalogs`, which it lacks today (R2 §7), leaving its existing
  assertions untouched.
- Effort fitting: `haiku` to `sonnet` yields `high`; a model without the current effort yields its
  default effort.

**Verify:** `go test ./...`; `cd web && npm test`. The e2e edits are not exercised by either, and
the suite is not run (U3): their only check is a syntax-only parse of the file with Node
(`node --check web/e2e/app.e2e.mjs`), which executes nothing, starts no server or agent and sends
no prompt. It proves the file still parses, not that the id-based picks work; that is stated
here so nobody reads the e2e changes as tested. By hand on a dev server (own data folder, port,
MCP port and Cursor configuration folder, see above; no message is sent): four rows with the
corrected labels; picking each one succeeds; the effort chip is never empty after a switch. The
picks are recorded as defaults in the dev server's data folder only. The subagent rules of this
phase are not checked by hand — a subagent is spawned only by a running chat agent, which needs a
prompt — and rest on the tests above.

### P2 — Mapping, startup probe, refresher

Needs P0 (fixture) and P1 (readers). After it, the picker shows the account's list after start.

- The response mapping and the probe in `internal/claude`, the probe with the sign-in guard
  where P0 decided it is built (D21); the refresher and its start in `cmd/ai-whiteboard/main.go`.
- The fake CLI's opt-in `initialize` answer (D14).

**New tests:**

- Mapping, from the fixture: 11 rows in CLI order with no `default` row; ids equal to the CLI's
  values; `haiku` without efforts; the two 4.6 rows without `xhigh`; a default effort on every
  row with efforts; default `opus`/`high`; no context windows.
  *Note (2026-10-03): P0 and P3 measured the `default` entry resolving to `claude-sonnet-5-5`
  (twin `sonnet`), so the fixture's default is `sonnet`/`high`; see "P0 findings".*
- Mapping, from the synthesized-entry fixture: the same catalog as from the plain fixture (D20,
  acceptance 10a).
- Mapping, from small hand-made inputs. Each either fails D17 or produces the outcome named here:
  - error subtype; no `models`; empty `models`; a row without a value — unusable;
  - no `default` entry, with the built-in default among the rows — that row is the default;
    without it — the first row is (D3 case b);
  - a `default` entry that resolves to no other row — it is kept as a row and the default is
    chosen as if it were absent, skipping that row; when it is the only row it is the default
    (D2, D3 case c);
  - a `default` entry whose model several rows share — it stands for the first of them in the
    CLI's order (D2);
  - a `default` entry whose only twin is a synthesized entry — the synthesized entry is dropped
    first, `default` is kept as a row and the list is usable (D20 before D2);
  - entries without `resolvedModel` — `default` has no twin and is kept as a row (D2);
  - a default that lands on a row without efforts — usable, with a default that has no effort
    (D4, D17);
  - a row without a display name — kept and labelled with its id (D17); a row whose display name
    equals its value — dropped (D20); a list made only of such rows — unusable.
- Probe, against the fake: success; no answer, ending in a timeout with a short limit; non-zero
  exit with stderr; a binary that does not exist. In every failure the error is returned and no
  process is left behind. If D21 is built: a sign-in check that exits non-zero returns an error
  and the `initialize` process is never started; one that exits 0 is followed by the
  `initialize` process. The fake tells the two invocations apart (D14).
- The probe's stdin holds exactly one line, the `initialize` request (acceptance 4).

The refresher itself gets no unit test, like its two neighbours (no test under
`cmd/ai-whiteboard/` refers to them); it is covered by the manual check and by the stored-catalog
tests of P1.

**Verify:** `go test ./...`. By hand, on a dev server with its own data folder, port and MCP port
(see the start of §8) — never by restarting the installed app: start the dev server and see the
11 rows within a few seconds; that folder's `state.json` holds a Claude entry under its catalogs;
restart the dev server with the Claude binary flag pointing nowhere and see one log line and the
same list; create a chat in a group with no saved Claude choice while no last-used Claude choice
exists either — a fresh data folder has neither (`internal/defaults/defaults.go:27-33`) — and see
the D3 default. With a saved or last-used choice present, the D3 default does not show and the
check proves nothing — so this check comes before any pick, because every pick records both
(`internal/chats/manager.go:746`). Then the walks that acceptance 2 and 7 call for, which are
done here and not in the installed app (constraint 9): pick each of the 11 rows in an unlocked
chat and see every pick accepted; switch from a row at `xhigh` to one of the two 4.6 rows and
see that row's default effort, and to `haiku` and see no effort chip; end on `sonnet`, create
another chat in the same group and see it start on `sonnet` (the saved-defaults half of
acceptance 6, against the fetched list). The picks and chats live in the dev server's data
folder, which is discarded. No message is sent in any of this; the probe the dev server runs is the
prompt-free one (constraint 2). The live `catalog` event is seen only if a client is connected
when the probe finishes; otherwise it rests on the unchanged client path (`web/src/conn.ts:44`).
The signed-out row of §7.6 is not reproduced by hand: it rests on the probe test with the fake's
status exit code and, if the owner made it, the signed-out run of P0.

### P3 — In-chat refresh

Needs P2 (the mapping, and the fake's `initialize` answer). Built unconditionally (D12, owner
decision U4); nothing else depends on it.

- The chat process recognises its own `initialize` answer and emits the catalog event (§7.2).

**Informational runs (A3), without sending a prompt.** They are made while the phase is built and
their results are written into §10. No outcome cancels or delays the phase: they record how far
a chat's answer can differ from the probe's, which is the accepted risk of A3. Every run sends
only `initialize`, and its `models`, after the D20 filter, is compared with the P0 fixture:

- *Session flags:* start the CLI with the complete argument list the adapter builds for a chat
  process (`internal/claude/claude.go:61-89`), not a hand-picked subset: besides the session id,
  the MCP config and the appended system prompt it carries `--effort`, `--disallowedTools` and
  `--allowedTools`, none of which is among the eight always-on flags R3 §7 tested. The MCP
  config has the app's form but points at a dev server or at an address nothing listens on,
  never at the installed app with a real chat's token. Run it from a scratch folder, so that a
  session file, if one is written (untested, R3 §5), belongs to that folder; note whether one
  appears, and remove it with the scratch folder afterwards (cleanup at the start of §8).
- *Listed models:* repeat with `--model haiku` and `--model opus`; R3 tested only `sonnet` and
  `claude-fable-5-1`.
- *Folder:* repeat from a scratch folder whose project settings set `availableModels` to a subset
  of the list and `model` to a listed model; once more with the same keys in that folder's local
  settings; and once with a project-settings `env` block that sets
  `ANTHROPIC_CUSTOM_MODEL_OPTION` together with `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME`. A chat
  process runs in the chat's folder (`internal/claude/claude.go:186`), which the probe never
  does. The `env` case is derived from documentation, not from anything observed: `env` can be
  set in any settings file (settings reference) and the custom option adds one picker entry
  under the given name (model configuration). An entry with a name of its own would not have
  the shape D20 removes, so it is recorded here whether a folder can add one. The settings page
  says most project `env` values wait until the folder is trusted, and a scratch folder is not;
  but the settings reference says project and local `env` values apply at startup in `-p` mode,
  which never shows the trust dialog, and both these runs and every chat process are `-p`
  (`internal/claude/claude.go:62`). On the documentation, then, the scratch-folder run stands
  for a chat folder. As a control, the same two variables are first given to one run through
  its own process environment: no entry there means the custom option does not reach `models`
  at all; an entry there but none from the scratch folder's `env` block is recorded as an
  unexplained difference between the documentation and the installed CLI.
  Only the scratch folder's files are written; the owner's settings and shell environment are
  not.
- *Resume (optional, **[owner]**):* repeat once with `--resume`. This needs a session that
  already exists, and a session comes into being only through a sent message, so it is a
  session of the owner's. The run is made only if the owner names one: a chat the owner names
  as disposable or, failing that, a fork of a session the owner names — the context-split
  reader already starts such a fork without writing to the session, as its comment states
  (`internal/claude/ctxsplit.go:88-93`); a fork approximates a chat's plain resume and is
  recorded as such. No chat is created for the purpose. *If the owner names no session:* the
  run is skipped, the resume input stays unobserved and is recorded as such in §10, and the
  phase is built all the same.

**What a difference means.** A run that returns a different list is recorded in §10 — which
input changed the list, and how — and the phase proceeds. The folder runs are the likeliest to
differ: the settings documentation says project settings are read from the session's working
directory and that `availableModels` and `env` can be set there. Such a difference is the
accepted risk of A3 (§7.6), not a reason to stop. Only two outcomes call for more than a record:

- *The mapping fails outright on a chat-style answer (D17).* On the in-chat path that is no event
  and no harm (§7.2). If it happens only for one input, such as a folder setting, it is recorded.
  If it happens for the plain chat argument list — so that no chat would ever refresh the list —
  the mapping rule that rejects the answer is revisited before P3 is finished, because the phase
  would otherwise be built and do nothing.
- *An entry appears that the CLI synthesized and that D20 does not catch.* D20 is revisited
  before P3 is finished, as A10 already requires for the probe; otherwise a chat would put a
  stale id into the stored list (R2 "Things" #17).

**New tests:**

- With the fake answering: one catalog event whose list equals the mapping of the fixture.
- With the synthesized-entry fixture: the entry is absent from the event, whether or not the
  process's model is the synthesized one (acceptance 10b).
- With a model that is in the list: its row is kept.
- With the fake not answering: no event, and sending still works. The existing spawn and send
  tests already cover this and must pass unchanged, as must `TestSpawnSendsInitialize`.
- An interrupt answer and an unrelated control answer produce no catalog event
  (`internal/claude/ctxsplit_test.go:186` is the existing "dropped" case).
- Manager: a catalog event from a Claude chat is stored under Claude and broadcast, mirroring
  `TestPiCatalogEventPersistsAndBroadcasts` (`internal/chats/manager_test.go:610-642`).
- Manager: a catalog event from an app-spawned subagent process changes nothing in the store.

**Verify:** `go test ./...`. That is the whole prompt-free verification of this phase: the adapter
tests show the event is emitted and filtered, and the manager tests show it is stored and
broadcast. The informational runs add what the real CLI answers for a chat-style spawn; they
inform §10 and are not a pass or fail.

**[owner]** By hand, on a dev server: send a first message in a Claude chat whose folder is a
scratch folder and see a `catalog` event for Claude on the event stream; the picker is unchanged
when the list is unchanged. This
sends a real prompt on the owner's account — a chat process starts only when a message is sent
(`internal/chats/manager.go:611`), and the one process that starts without a message, the
context-split fork, drains its events (`internal/claude/ctxsplit.go:97-100`) — so only the owner
does it, or the implementer with the owner's consent. The chat, its recorded defaults and the
stored list stay in the dev server's data folder. Outside it, the CLI is expected to keep a
session for the scratch folder under `~/.claude/projects`, since a chat process does not pass
the flag that keeps a session off disk (expected from the CLI reference, not observed by R3);
it is removed with the cleanup named at the start of §8.
*If it is not done:* the phase is accepted on the tests; what stays unseen is only the event
arriving from a real CLI in a real chat.

### P4 — Sweep, rebuild, reinstall, acceptance

- Remaining stale comments and the dated notes in the older plan documents (D19); search non-test
  code for the three short names to confirm acceptance 9.
- `go test ./...`, `cd web && npm test`, `cd desktop && npm test`; and the syntax-only parse of
  the e2e file again (P1), since nothing else touches that file.
- `scripts/build-app.sh`. What it builds lands under the repository — the web client's and the
  desktop folder's build output and `bin/` (`scripts/build-app.sh:17-36`). Outside the
  repository it writes only to tool caches: Go's build cache, npm's cache when a `node_modules`
  folder is missing and `npm ci` runs (`scripts/build-app.sh:19`, `28`), and whatever
  electron-builder downloads or caches for packaging. It touches neither the installed app, nor
  the app's data folder, nor any agent configuration, and it signs ad hoc, without a keychain
  identity (`desktop/electron-builder.yml:28`). The implementer may run it. The loose
  `bin/ai-whiteboard` the e2e script looks for is a separate build (`web/e2e/app.e2e.mjs:49`)
  that this plan does not make.
- **[owner]** `scripts/install-app.sh`. It replaces the installed app in `~/Applications`
  (`scripts/install-app.sh:14-15`). The server of the previous build keeps running until it is
  restarted (`scripts/install-app.sh:20-27`). The owner runs it, or consents.
- **[owner]** Restart the server, from the app or with the `relaunch` command the install script
  prints. A restart ends every running agent chat (`scripts/install-app.sh:20-22`) — which can
  include the session that is carrying out this plan — so the owner triggers it, at a moment of
  the owner's choosing. The restart is also the moment the feature first writes to the owner's
  data: the new server's probe stores a Claude list in `~/.ai-whiteboard/state.json`, new Claude
  chats and subagents with no listed saved or last-used choice start on the CLI's recommended
  model from then on (U1), and every later top-level Claude chat process start stores its own
  answer (D12). That is the product working as decided, not a verification side effect, and it
  is why the step is the owner's. *Until it is done:* the fix is built and tested but not
  running; the installed-app column of the table below is open and acceptance 11's last clause
  is unmet.
- Acceptance, per the table below. In the installed app the walk only reads: it opens chats that
  exist, reads the picker's rows and reads `state.json`. Everything that would change the
  owner's data there is marked **[owner]** — a real prompt, a model or effort pick, a new chat —
  and the substitute in the last column is the evidence when the owner does not make it. The
  picks and the effort-chip walk of acceptance 2 and 7 are not installed-app steps at all: they
  are done on the P2 dev server.
- The paid end-to-end suite is not run, by anyone, at any point of this work (owner decision
  U3). It is not part of acceptance, and the changes made to `web/e2e/app.e2e.mjs` in P1 are
  therefore unexercised beyond the syntax-only parse.

Two rules hold for every **[owner]** step of the table that changes data in the installed app:

- *A pick.* A model or effort pick overwrites the saved Claude choice of the chat's group and the
  last-used Claude choice, both with the picked value (`internal/chats/manager.go:746`,
  `internal/defaults/defaults.go:54-62`). Every later new Claude chat in that group, or in a
  group with no saved choice, starts on it, and so does every Claude subagent rebased onto
  new-chat defaults — under D22 every cross-agent spawn (§7.3). If the owner makes a pick, both
  values are read from `state.json` beforehand and restored afterwards by picking the earlier
  model and effort again as the last pick. A pick writes the same value to both and cannot clear
  either (`internal/defaults/defaults.go:84-102`), so a state in which the two differed, or in
  which one was unset, cannot be brought back that way; the owner is told which of the two it
  is before deciding. That is why the walk does not ask for picks in the installed app and the
  dev server stands in.
- *A new chat.* Creating a chat adds it to the owner's chat list; it reads the saved defaults and
  records none (`internal/chats/manager.go:360-414`). A chat created for the walk is deleted
  afterwards, which removes the chat and its history and nothing else
  (`internal/chats/manager.go:1028-1057`); or an existing unlocked Claude chat is used and none
  is created.

| Acceptance | In the installed app, after the restart | Needs the owner? | Evidence without it |
|---|---|---|---|
| 1 | Open the picker of an unlocked Claude chat that already exists and read the rows: those of R3 §3 as D2 and D20 leave them. Nothing is picked. The picker exists only in an unlocked chat (`web/src/Composer.tsx:301-304`). | Reading: no. If the owner has no unlocked Claude chat, creating one is **[owner]**; it is deleted afterwards. | P2 mapping tests; P2 dev-server check. |
| 2 | Not walked in the installed app beyond reading the rows (row 1). Picking each row is done on the P2 dev server. The rejection half is not walked anywhere by hand: the picker offers only listed ids, and a subagent is spawned only by a chat agent during a turn. | A pick here: **[owner]**; it overwrites the group's and the last-used Claude choice, which are restored afterwards (rules above). A `spawn_subagent` call: **[owner]**, a real prompt, if wanted. | The P2 dev-server pick walk; P1 store-backed manager test; the unchanged rejection tests (`internal/chats/manager_test.go:680-710`, `internal/chats/spawn_test.go:348-350`). |
| 3 | Not walked in the installed app: it would mean restarting the owner's server with a broken CLI, or signing out. | — | P2 probe tests; the P2 dev-server restart with the binary flag pointing nowhere; for signed out, the guard test and P0. |
| 4 | Not observable in the app. | — | P2 probe test on the stdin line. |
| 5 | `state.json` holds a Claude entry (read, not changed) and the app's window, once it has reconnected after the restart, shows the list (row 1). Surviving a restart is not walked again here — it would take a second restart — and the live event is seen only by a client connected while the probe finishes. | Reading: no. | P2 dev-server check, whose restart with a broken binary flag shows the stored list surviving; the P3 manager test on storing and broadcasting. |
| 6 | An old chat on `sonnet`, `opus` or `haiku` opens and shows its label. That a new chat in a group with those saved defaults gets the same model as before is seen in the installed app only by creating a chat. "Resumes" means sending a message in that chat. | Open and label: no. New chat: **[owner]**; it adds a chat to the owner's list, records no default, and is deleted afterwards (rules above). Resume: **[owner]**, a real prompt. | Reduced to "opens and shows its label". For the new chat: the unchanged tests of P1 and the last step of the P2 dev-server walk. For the resume: the model is passed to the CLI verbatim (`internal/claude/claude.go:70-72`) and the three ids are still offered (R3 §3). |
| 7 | Not walked in the installed app: switching models and watching the effort chip is done on the P1 and P2 dev servers. That the process starts without `--effort` is visible only when a message is sent. | A switch here: **[owner]**, as a pick in row 2. Process start: **[owner]**, a real prompt. | The P1 and P2 dev-server effort walks; P1 manager test (no effort in the options of a chat on a no-effort model) and P1 adapter test. |
| 8 | Not observable in the app as such. | — | P1 store-backed manager test and the extended snapshot test. |
| 9 | Not an app check. | — | The search of this phase. |
| 10(a) | Not walked: it needs a configured unlisted model, and the owner's settings and environment are not edited. | — | P2 mapping test on the synthesized-entry fixture; P0 runs for A10. |
| 10(b) | A chat on an unlisted model starts its process and the picker does not gain that id. Walkable only if the owner already has a chat whose model is no longer listed; none is made for it, since an unlisted model cannot be picked. | **[owner]**, a real prompt, if such a chat exists and the owner wants it. | P3 adapter test on the synthesized-entry fixture. |
| 11 | The three test commands; the installed app shows the new list (row 1). | The install and the restart above: **[owner]**. | Tests alone prove the build, not the installed app. |
| 12 | Not walked: a subagent is spawned only by a chat agent during a turn. | **[owner]**, a real prompt, if wanted. | P1 collision tests and the unchanged cross-agent tests. |

## 9. Verification summary

| Layer | What proves it |
|---|---|
| Response shape and mapping rules, including every default branch of D2/D3/D17 and the D20 filter | Fixture-based and hand-made mapping tests (P2). |
| Probe lifecycle and failures, including the sign-in guard when built | Probe tests against the fake (P2). |
| One list for picker and validation | Store-backed manager tests and the extended snapshot test (P1). |
| Effort default and gate | Manager tests (P1). |
| Subagents that fall back to the catalog default (the cases the owner accepted under U1) | Store-backed manager tests (P1), including the effort route. |
| Cross-agent spawns when an id is in two lists (D22, acceptance 12) | Collision tests and the unchanged cross-agent tests (P1). Not checked by hand: it needs a real prompt. |
| Unobserved CLI behaviour (A1, A6, A10; A2 where possible) | Prompt-free runs in P0. The signed-out run is **[owner]**; without it the status command's exit code is recorded and A2 stays unconfirmed for the signed-out probe. |
| How far a chat's answer matches the probe's list (A3) | Not proved, and not a gate: informational prompt-free runs in P3, recorded in §10. No result cancels P3; a difference is the accepted risk of A3. The resume run is optional and **[owner]** (it needs a session the owner names); without one it is skipped. |
| In-chat refresh and its guards | Adapter and manager tests (P3). Seeing the event from a real chat is **[owner]** (a real prompt, on a dev server) and optional. |
| Nothing regressed for existing ids | The unchanged tests listed in P1. |
| Client rendering, every model pick and the effort chip | Manual checks on a dev server with its own data folder, ports and Cursor configuration folder (P1, P2), with no message sent; picks and new chats are recorded there and nowhere else. No unit test covers the catalog pipeline today (R2 "Things" #10) and none is added, because that code does not change. |
| Installed app | Rebuild by the implementer; install and restart **[owner]**; acceptance per the table in P4. There the unflagged steps only read — an existing chat, the picker's rows, `state.json`. Every step that sends a prompt, picks a model or effort (which would overwrite the owner's group and last-used Claude choice) or creates a chat is **[owner]**, states what is restored or deleted afterwards, and has a prompt-free or dev-server substitute. |
| e2e file edits (D15) | A syntax-only parse of `web/e2e/app.e2e.mjs` (P1, P4). The paid end-to-end suite is not run (U3), so the edits are otherwise unexercised. |

## 10. Facts, assumptions and owner decisions

### Verified facts the plan rests on

- The built-in list has three rows, default `sonnet`/`high`, no default efforts
  (`internal/claude/catalog.go:5-15`).
- Only the manager bypasses the store for Claude; the snapshot already prefers a stored list
  (`internal/chats/manager.go:328-332`, `internal/app/app.go:64-69`).
- Nothing stores a Claude list today, and the Claude adapter emits no catalog event
  (R1 §0 #10, §4). Cursor and pi chat processes emit one on every start, after listing their
  models (`internal/cursor/cursor.go:246`, `internal/pi/pi.go:293`).
- A successful model or effort pick in an unlocked chat is recorded, unconditionally, as the
  saved choice of the chat's group and as the last-used choice
  (`internal/chats/manager.go:746`, `internal/defaults/defaults.go:54-62`); a recorded value is
  replaced only by another non-empty one (`internal/defaults/defaults.go:84-102`). Creating a
  chat reads the defaults and records none (`internal/chats/manager.go:360-414`); deleting one
  removes the chat and its history only (`internal/chats/manager.go:1028-1057`). The model picker
  is offered only in an unlocked chat (`web/src/Composer.tsx:301-304`).
- The manager's catalog-event handler is agent-agnostic; app-spawned subagent processes and
  context-split forks drop the event (`internal/chats/manager.go:523-530`,
  `internal/chats/spawn.go:462-463`, `internal/claude/ctxsplit.go:97-100`).
- The `initialize` answer holds the list at `response.response.models`; 12 entries on the measured
  account; no context window, no default effort, no explicit default flag; `haiku` has no effort
  keys; an unlisted `--model` is appended as a synthesized entry (R3 §3, §4, §8).
- The app's request and always-on flags return the same list as the minimal command (R3 §7).
- The CLI keeps running after answering until stdin closes (R3 §5).
- Pi's startup probe gives each of its two calls the full timeout, so about 40 s plus a 3 s kill
  grace at worst; Cursor's is about 20 s plus up to 3 s on close
  (`internal/pi/catalog.go:173-196`, `internal/cursor/probe.go:58-69`,
  `internal/cursor/acp.go:181-192`).
- The Agent SDK exposes the same data publicly: `supportedModels()` "returns available models with
  display info" and `initializationResult()` returns the full initialization result including
  models (Agent SDK TypeScript reference). The reference documents the type of one entry,
  `ModelInfo`, with the nine keys R3 saw; `value`, `displayName` and `description` are required
  and the rest optional, `resolvedModel` among them ("Requires Claude Code v2.1.197 or later").
  The control message that carries the list on stdout is not documented there.
- `--model` accepts an alias or a full model name, `--effort` levels depend on the model, and
  `--no-session-persistence` is print-mode only and keeps the session off disk (CLI reference).
- A chat process runs in the chat's folder; the existing throwaway spawns run in the temp folder
  (`internal/claude/claude.go:186`, `internal/claude/usage.go:39`, `internal/chats/namer.go:37`).
- A subagent starts from its chat's model and effort (`internal/chats/spawn.go:263`). With the
  requested kind's list known, it is rebased onto new-chat defaults in exactly two situations
  today: no model was named and the inherited id is not in that list
  (`internal/chats/spawn.go:295-298`); or no effort was named, the model is listed, and the
  effort is non-empty and not offered by that row (`internal/chats/spawn.go:299-301`). The
  rebase replaces whichever of model and effort was not named
  (`internal/chats/spawn.go:303-312`). The agent kinds are not compared: a cross-agent spawn is
  rebased today only because its id is missing from the other list. While the requested kind's
  list is not known, nothing is rebased and the chat's model and effort pass through
  (`internal/chats/spawn.go:294`). New-chat defaults reach the
  catalog default when no group or last-used choice exists or the one found is not listed
  (`internal/defaults/defaults.go:27-40`).
- Six of the 12 values R3 §3 lists are also Cursor model ids: `claude-sonnet-5`,
  `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6` and
  `claude-sonnet-4-6`. All six are in Cursor's test fixture
  (`internal/cursor/testdata/models.json`, a single-line file) and in the Cursor list stored on
  this machine (`~/.ai-whiteboard/state.json`, read on 2026-10-03), where each has the same
  effort list as R3 §3 gives it. Cursor's id is the `value` it reports
  (`internal/cursor/catalog.go:98`). None of `sonnet`, `opus`, `haiku`, `default`,
  `claude-fable-5-1` and `claude-fable-5` is in either. Which ids overlap is a property of the
  two vendors' lists on one account at one time, not a fixed set.
- No pi id is in the Claude or Cursor list as observed: a pi id is `provider/id`, or the bare id
  when pi reports no provider (`internal/pi/catalog.go:43`, `76-79`); no value in R3 §3 and no
  id in the stored Cursor list contains a slash, and no stored pi id lacks one. It would take a
  CLI value that is itself of the `provider/id` form, or a pi model without a provider whose id
  another list also has, to change this; neither has been seen.
- The context-split fork is started with the options the manager builds for the chat process
  (`internal/chats/contextsplit.go:66`).
- A chat process is started in one place only, when a message is sent
  (`internal/chats/manager.go:611`); a subagent process is started only by `spawn_subagent`
  (`internal/chats/spawn.go:116`), reached only from the MCP tool a chat agent calls during a
  turn (`internal/boardapi/mcp.go:316`). The context-split
  fork sends nothing and drains its events (`internal/claude/ctxsplit.go:88-100`).
- A second server does not start beside a running one for the same data folder or port, and a
  server cannot start while another holds the fixed MCP port; the MCP port has a test-only
  override (`cmd/ai-whiteboard/main.go:120-123`, `131-137`, `221-234`). Every server start adds
  deny rules for its data folder to the Cursor CLI configuration, at a path an environment
  variable can redirect (`cmd/ai-whiteboard/main.go:185`, `internal/cursor/config.go:14-29`).
  Installing replaces the
  app but leaves the running server on the old build, because restarting it ends the running
  agent chats (`scripts/install-app.sh:14-15`, `20-27`).

### What the documentation says (not observed on the installed CLI)

These are statements of the Claude Code documentation. None was reproduced by R3, and none says
what the `initialize` response contains; A3 and A10 carry the consequences and name their checks.

- `--model` "overrides the `model` setting and `ANTHROPIC_MODEL`" (CLI reference). The model is
  chosen, in order of priority, by `--model`, then `ANTHROPIC_MODEL`, then the `model` setting
  (model configuration).
- The shared project settings file is read from the session's primary working directory
  (settings).
- `availableModels` restricts which models can be selected, can be set in user, project and local
  settings as well as managed ones, hides excluded models from the model picker, and also applies
  to the model restored when a session is resumed (settings; model configuration).
- `claude auth status` "exits with code 0 if logged in, 1 if not" (CLI reference).
- The `env` settings key can be set in any settings file; project and local settings cannot set
  a listed group of variables, and the custom-model variables are not in that group (settings
  reference). Most `env` values from a project file apply only once the folder is trusted
  (settings).
- `env` values from project and local settings are applied "after you trust the workspace, or at
  startup in `-p` mode, which never shows the trust dialog" (settings reference, "When Claude
  Code applies `env` values"; read on 2026-10-03). Chat processes and all prompt-free runs of
  this plan are `-p` (`internal/claude/claude.go:62`), so on the documentation a folder's `env`
  block reaches a chat process whether or not the folder was ever trusted.
- `ANTHROPIC_CUSTOM_MODEL_OPTION` adds a single custom entry to the model picker;
  `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME` gives it a display name, and without it the entry shows
  the model's name when the CLI recognises the id and the id otherwise (model configuration).
  Whether such an entry appears in `models` was not observed.
  *Note (2026-10-03): now observed. With both variables the entry appears under its given name
  and D20 keeps it; with the folder `env` and `availableModels` effects and the entry the CLI
  synthesizes for a configured model without `--model`, see "P3 informational runs" and "P0
  findings".*

### Assumptions

| # | Assumption | Checked in | If false |
|---|---|---|---|
| A1 | `--no-session-persistence --strict-mcp-config` do not change `models`. | P0 | Drop the flag that does; if dropping both, re-check A6. |
| A2 | Signed out or offline, a fetch ends in a handled failure, not in a well-formed wrong list. | Signed out: P0, if the owner signs out (**[owner]**); otherwise the startup probe does not rely on it where the guard of D21 is built, and it stays unchecked where the guard cannot be built (D21 case c). Offline, and a chat process started while signed out (the in-chat refresh of P3): not checked. | A wrong list would be stored and shown until the next good refresh. |
| A3 | After the D20 filter, a chat-style spawn returns the same `models` as the standalone probe. That means the list is independent of everything in a chat process's argument list — session id, MCP config, system prompt, `--effort` and the two tool lists — of any listed `--model`, of `--resume`, and of the chat's working folder with its project and local settings, including an `env` block that names a custom model option. Observed so far: the eight always-on flags, two `--model` values, no session, a scratch folder without settings (R3 §4, §7, open question 2). The documentation points the other way for the folder (see above), so this may well be false. It is an assumption the design no longer depends on: the in-chat refresh is built whether it holds or not (D12, owner decision U4). | Not a gate. P3 informational runs, one per input, recorded here. The resume run is optional and **[owner]**: it is made only if the owner names a session and is otherwise skipped, the input staying unobserved. | Accepted, documented risk. A chat process started in a folder whose project or local settings change the list (for example `availableModels`; documented, not observed) replaces the one stored list for all chats, until the next top-level Claude chat process starts elsewhere or the server restarts. A list narrowed this way can trigger the overwrite of a saved default at a first send (U2). Rows in §7.6. Only a chat-style answer the mapping cannot use at all, or a synthesized entry D20 misses, calls for more than a record (§8, P3). *Note (2026-10-03): the folder, the `env` custom option and the listed `--model` values are now observed ("P3 informational runs"); `--resume` is not.* |
| A4 | The response shape is stable across CLI versions and plans; only 2.1.284 on one account was seen (R3 open question 3). | Not checkable now | The mapping fails D17 and the app falls back; the picker goes stale, not wrong. |
| A5 | `--model default` works at run time. It matters only on an account where D2 keeps `default` as its own row, which the measured account is not (R2 §5), and there only for a chat whose user picks that row: D3 does not make it the default for new chats, except when it is the only row. | Not checked: it needs a prompt, and the CLI accepts any name at start-up (R3 §8), so a prompt-free run proves nothing. The mapping branch itself is tested in P2. | A chat on the `default` row would fail at its first turn on such an account. |
| A6 | The probe leaves no session or project files. Observed for the base command only (R3 §5). | P0 | Reconsider the flags of D18. |
| A7 | The list is filtered by account and organisation settings, as the research document says (R3 open question 1). | Not checkable with one account | No design impact. |
| A8 | The built-in windows (1M for `sonnet` and `opus`, 200k for `haiku`) are still right for the models those aliases resolve to. Carried over from current code. | Not checked | A wrong tooltip before the first reply, on the fallback list only. |
| A9 | The synthesized entry always has its value as its display name, and no real row does. Seen once for the synthesized entry and on 12 real rows (R3 §8, §3). D20 rests on both halves. | P0 fixtures | First half false: the stale id reappears in the picker for chats on that model. Second half false: a real model is missing from the picker. |
| A10 | With no `--model`, a configured model outside the standard list (the `model` setting or `ANTHROPIC_MODEL`) either adds nothing to `models` or adds an entry of the shape R3 saw for `--model`. R3 observed the entry only for the flag (R3 §8); the rest follows from the documentation of what `--model` overrides. | P0 | An entry of another shape would be stored as a row: revisit D20 before P2. The same holds for the in-chat path if a P3 run shows such an entry: revisit D20 before P3 is finished. |

### P0 findings (2026-10-03)

Claude Code 2.1.284, run by the implementer, prompt-free (only the `initialize` request on stdin,
stdin closed after the answer; or `claude auth status`). Each run: scratch folder as working
directory, `--print --input-format stream-json --output-format stream-json --verbose`; request
`{"type":"control_request","request_id":"p0_probe","request":{"subtype":"initialize"}}`. All
exited 0 in 1.2–1.3 s with empty stderr and one `control_response`/`success` line. The scratch
folder, the captures (they held the account block) and the helper were removed afterwards.
Reports R1–R3 are kept in `plans/claude-model-picker-research/`; fixtures are
`internal/claude/testdata/initialize.json` (12 rows) and `initialize_synthesized.json` (13 rows),
each holding only `type`, `response.subtype`, `response.request_id` and `response.response.models`.

- **A1 — holds.** The base command (no throwaway flags) and the same command with
  `--no-session-persistence --strict-mcp-config` returned identical `models` (parsed JSON equal) (12 rows).
- **A6 — holds for the probe-style run.** The set of folders under `~/.claude/projects` was the
  same before and after all runs (154 entries, none new), and the scratch folder gained no files
  (only the `.claude/settings.json` written for the A10 project-settings run). `~/.claude.json`
  changed during the runs (size and hash), as §8 warns; left as the CLI wrote it.
- **A9 — holds (first half now observed twice).** With `--model p0-unlisted-model-xyz` the CLI
  appended, after the 12 unchanged rows, one entry: `value`, `resolvedModel` and `displayName`
  all equal to the name, `description` `"Custom model"`, `supportsEffort` true,
  `supportedEffortLevels` [low, medium, high, xhigh, max], `supportsAdaptiveThinking` true,
  `supportsAutoMode` true, no `supportsFastMode` — the shape of R3 §8. No real row has a display
  name equal to its value (12 of 12 differ).
- **A10 — the second branch holds: an extra entry appears, in the same shape.** Probe without
  `--model`, with (1) `ANTHROPIC_MODEL=p0-env-model-abc` in that process's environment, (2)
  `--settings '{"model":"p0-setting-model-def"}'`, (3) a scratch folder's
  `.claude/settings.json` with `{"model":"p0-projsetting-model-ghi"}`: each returned 13 rows, the
  12 normal ones unchanged plus one appended entry, `value` = `resolvedModel` = `displayName` =
  the configured name, otherwise exactly the shape above. So a configured unlisted model does add
  an entry even without the flag, and D20 (shape alone) catches all three. No entry of another
  shape was seen; D20 does not need revisiting.
- **Sign-in status.** `claude auth status` on this signed-in machine exits **0**.
- **D21 — case (a): the guard is built in P2** on the documented exit codes (0 signed in, 1 not).
  The owner did not sign out, so A2 stays unconfirmed for the signed-out probe.
- **Outcomes that change later work:** none occurred. No synthesized entry of a shape D20 misses;
  no signed-out run was made (so no probe that fails by itself); the status command did not exit
  non-zero while signed in.
- **Difference from R3 §3 (cause unknown, not a shape change).** The 12 values, order,
  display names, `resolvedModel` of rows 1–11 and effort lists match R3. Row 0 `default` now has
  `resolvedModel` `claude-sonnet-5-5` and description `Sonnet 5.5 · Efficient for routine tasks`
  (R3: `claude-opus-5-5`, `Opus 5.5 · Best for everyday, complex tasks`) and no
  `supportsFastMode` (R3: present), so 3 rows carry that key now (`opus`, `claude-opus-5`,
  `claude-opus-4-8`) against 4 in R3. The twin of `default` by `resolvedModel` is therefore now `sonnet`, not
  `opus`: D2's twin lookup must not assume which alias it is. Same account, machine and CLI
  version as R3, about 2.5 hours apart, so the cause of the change is unknown. The catalog default
  on this account is therefore `sonnet`/`high` and can change between refreshes.

### P3 informational runs (2026-10-03)

Claude Code 2.1.284, run by the implementer, prompt-free: stdin held only the `initialize`
request the adapter writes (`agentProgressSummaries` and `forwardSubagentText` included), one
`control_response`/`success` line came back, stdin was closed, every process exited 0 with empty
stderr. Each run started in a fresh scratch folder with the complete argument list of
`Args` (`internal/claude/claude.go:61-89`): the eight always-on flags, a fresh random
`--session-id`, `--model`, `--effort high`, `--disallowedTools` (the four app-folder rules plus
`Task`, `Agent`), `--mcp-config` in the app's form (`type http`, a dummy bearer token) pointing at
a closed localhost port, `--allowedTools` (the seven board tools and the three spawn tools) and
`--append-system-prompt` (the spawn steering text plus a dummy board prompt). Every list below is
compared after D20 with the P0 fixture (12 rows, none dropped by D20): value, display name,
description, `resolvedModel` and effort levels. The `default` entry's `resolvedModel` was
`claude-sonnet-5-5` in every run, as in the fixture, so the recommendation did not change.

| Run | Input that varied | `models` after D20 vs. fixture |
|---|---|---|
| 1 | `--model sonnet` | equal, 12 of 12 |
| 1b | no `--model` | equal |
| 2 | `--model haiku`; `--model opus` | equal; equal |
| 3 | folder `.claude/settings.json`: `availableModels` `["sonnet","haiku"]`, `model` `haiku`; with `--model sonnet` and without `--model` | **differs**, both ways: 5 rows |
| 4 | the same keys in `.claude/settings.local.json` only; both ways | **differs**, the same 5 rows |
| 5 | `ANTHROPIC_CUSTOM_MODEL_OPTION` and `..._NAME` in the process environment only | **differs**: the 12 rows plus 1 |
| 6 | folder `.claude/settings.json` with an `env` block setting both; with `--model sonnet` and without | **differs**: the 12 rows plus 1, identical to run 5 |
| 7 | `--resume` | **skipped** ([owner], no session named); the resume input is **unobserved** |

- **Runs 3 and 4 (a folder narrows the list).** The answer holds 5 entries in the CLI's order:
  `default`, `sonnet`, `haiku`, `claude-sonnet-5`, `claude-sonnet-4-6`. Their fields equal the
  fixture's; `availableModels` `["sonnet","haiku"]` thus also kept the other two Sonnet entries,
  and removed the Opus and Fable entries. After D20 and the mapping the rows are 4 (`default`
  stands for `sonnet`), the default is `sonnet`/`high`. So a chat started in such a folder would
  replace the stored 11-row list with 4 rows (D13, accepted risk A3). The `model` key changed
  nothing in `models`, with or without `--model`. Project and local settings acted the same.
- **Runs 5 and 6 (custom option).** The entry appears in both, and in 6 with and without
  `--model`: so a folder's `env` block does reach `models` in `-p` mode, as the documentation
  says, and a scratch folder stands for a chat folder. It is appended after the 12 rows. Shape,
  with the id and name given: `value` = `resolvedModel` = the id (`p3-custom-model-id`), `displayName` =
  the given name (`P3 Custom Name`), `description` `"Custom model (<id>)"`, `supportsEffort` true,
  `supportedEffortLevels` [low, medium, high, xhigh, max], `supportsAdaptiveThinking` true,
  `supportsAutoMode` true. Its display name differs from its value, so **D20 keeps it** and it
  becomes a picker row (12 rows).
- **Session and project files.** None. In every run the scratch folder held nothing but the
  `.claude` folder written for runs 3, 4 and 6, and the listing of `~/.claude/projects` was the
  same before and after all runs (nothing new, so nothing was removed). `~/.claude.json` was not
  looked at. Scratch folders and captures were removed.
- **Outcome (i), the mapping fails on the plain chat argument list: did not occur.** Run 1's
  answer, given to the existing mapping (`CatalogFromInitialize`, run through a throwaway test
  outside the repository), yields 11 rows, all with a non-empty id, default `sonnet`/`high`
  among the rows; runs 1b and 2 give the same. No input made the mapping reject an answer.
- **Outcome (ii), a synthesized entry that D20 does not catch: did not occur.** The only
  entry beyond the 12 is the custom option of runs 5 and 6, which the user's own environment or
  folder settings asked for and which has a name of its own; D20 keeps such an entry on purpose.
  It is a folder-caused difference of the kind A3 accepts, not a synthesized id of an unlisted
  `--model`. No entry of the D20 shape appeared for a listed `--model`.
- **Effort.** Every run passed `--effort high`, `--model haiku` included. The app no longer does
  that after D11, which leaves the effort out for a model listed without efforts; the answer did
  not differ, but the haiku run is not the argument list a chat on `haiku` now gets.
- **Reviewer's spot check.** With `ANTHROPIC_CUSTOM_MODEL_OPTION` set and no `..._NAME`, the
  entry's display name equals its id, so D20 drops it. That is the cost D20 names: a custom
  option configured without a name is not offered in the picker.
- **A3 as recorded.** After D20, the argument list (session id, MCP config, system prompt,
  `--effort`, the two tool lists), `--model sonnet`/`haiku`/`opus`, and the model setting leave
  `models` unchanged. A folder's `availableModels` (project or local) narrows it and a folder's
  `env` custom option adds a row. Resume is unobserved.

### Steps not done (2026-10-03)

These **[owner]** steps and checks have not been done; the plan's evidence stands without them:

- The sign-out run of P0: not done. A2 stays unconfirmed for the signed-out probe (the guard of
  D21 rests on the documented exit codes).
- The `--resume` run of P3: not done, no session named. The resume input is unobserved.
- The real-prompt check of P3 on a dev server (a `catalog` event from a real chat): not done.
- `scripts/install-app.sh`: not run. The installed app is the old build.
- The server restart: not done. The installed app's server runs the old build.
- The paid e2e suite: not run, by anyone (U3). The edits to `web/e2e/app.e2e.mjs` are
  unexercised beyond the syntax-only parse.
- Open until the owner installs and restarts: the last clause of acceptance 11 (the reinstalled
  app shows the new list) and the installed-app reads of the §8 P4 table, rows 1, 5 and 6.

*Integration finding (2026-10-03).* A named effort on a cross-agent `spawn_subagent` without a
model was first checked against the chat's model, so when the requested kind's list also held that
id and its row lacked the effort, the spawn was rejected, although D22 rebases such a spawn and
HEAD accepted it. Fixed in `resolveSubSpawn`: that effort is validated only against the rebased
model. Tests: `TestSubagentSharedIDNamedEffort` (`internal/chats/claudecatalog_test.go`).

### Owner decisions (settled 2026-10-03)

These were the plan's unresolved questions U1–U5. The owner answered all five on 2026-10-03; the
identifiers are kept so that references elsewhere still resolve. Each entry gives the decision,
what it settles in the plan, and the alternative that was not chosen, for the record. **No
question remains open for the owner**, and applying these decisions raised no new one.

- **U1 — Default model where nobody chose one. Decided: follow the CLI's recommendation** for
  the fetched list, and keep `sonnet` in the built-in fallback list (D3, D8). On the measured
  account that makes the catalog default Opus 5.5 at `high` instead of Sonnet at `high` (D3,
  D4). The owner accepted the five cases this reaches after P2, all through the same fallback
  to the catalog default (`internal/defaults/defaults.go:27-40`):
  1. a new Claude chat in a group with no saved Claude choice while no last-used Claude choice
     exists either;
  2. a new Claude chat whose saved or last-used model is no longer listed;
  3. a Claude subagent spawned without a model from a Cursor or pi chat, when the choice found
     first — the group's saved Claude choice, else the last-used one — is missing or no longer
     listed (§7.3 situations 1 and 3). With D22 (U5) this is every Cursor and pi chat, whatever
     its model id;
  4. a Claude subagent spawned without a model from a locked Claude chat whose own model is no
     longer listed, under the same condition (`internal/chats/spawn.go:295-298`, `303-312`);
  5. a Claude subagent spawned with neither model nor effort from a Claude chat whose model is
     listed but no longer offers the chat's effort, under the same condition
     (`internal/chats/spawn.go:299-301`, `303-312`; §7.3 situation 2).

  Cases 3 to 5 are subagents nobody picked a model for. Case 3 runs on Sonnet today and will
  run on Opus — that includes Claude subagents spawned without a model from Cursor or pi chats,
  which the owner accepted explicitly; cases 4 and 5 are not expected today, because the list
  never changes, and will also land on Opus. A group whose saved Claude choice is still listed
  is not affected by any of the five. With the in-chat refresh unconditional (U4), cases 2, 4
  and 5 can also follow from a list that one chat folder's settings narrowed (A3).
  *Settles:* D3 case (a), D8's default, the P1 store-backed tests of cases 3 to 5.
  *Not chosen:* keeping the built-in list's default model as the catalog default whenever it is
  listed, which would have left the five cases on Sonnet.
  *Note (2026-10-03): "makes the catalog default Opus 5.5" and "will run on Opus" are R3's
  measurement. P0 and P3 measured the `default` entry resolving to `claude-sonnet-5-5` (twin
  `sonnet`): the catalog default is `sonnet`/`high` on this account now and the five cases land
  on Sonnet; see "P0 findings".*
- **U2 — A saved default whose model disappears is overwritten at the next first send.
  Decided: accepted.** The owner's words: "let a send record a new model". First-send recording
  is not changed (§2, §7.5); a list that passes D17 is treated as the truth, whatever shortened
  it (§7.6). It is how saved defaults already behave for Cursor and pi, and
  `TestFirstSendRecordsDefaults` pins the unconditional write. *Settles:* D13, the shrinking-list
  rows of §7.6. *Not chosen:* stopping the first send from recording a model the user did not
  choose — a change to shared defaults behaviour for all three agents.
- **U3 — The paid e2e run. Decided: not run at all.** It is not part of acceptance and nobody
  runs it for this work, the owner included. The edits to `web/e2e/app.e2e.mjs` (Claude models
  picked by id, not by label text, D15) are still made so that the file does not rot; their only
  check is the syntax-only parse named in P1, which sends no prompt. Stated plainly: the e2e
  changes are unexercised, and the real picker has no automated end-to-end check after this
  work. *Settles:* scope (§2), acceptance 11, D15, P1's Verify, P4, §9. *Not chosen:* the owner
  running the suite once after P4.
- **U4 — How the list stays fresh on a long-lived server. Decided: the in-chat refresh is built
  unconditionally** — on every top-level Claude chat process start (D12, §7.2, P3). The owner's
  reasoning: the app receives that information on every process start anyway; Cursor and pi
  already emit their list on every chat process start (`internal/cursor/cursor.go:246`,
  `internal/pi/pi.go:293`). The question this entry used to ask — how a long-lived server keeps
  the list fresh if P3 is skipped — no longer arises, because P3 is not skipped. The startup
  probe stays as designed (D18, §7.1). A3 remains a labelled assumption but is no longer a
  gate; what follows if it is false is an accepted risk, stated in A3 and §7.6: a chat started
  in a folder whose settings change the list replaces the stored list for all chats until the
  next top-level Claude chat process starts elsewhere or the server restarts, and a list
  narrowed that way can trigger the overwrite of U2. *Settles:* the goal, scope, requirement 4,
  acceptance 10(b), D12, D13, §6, §7.2, §7.6, P3, §9, A3. *Not chosen:* building the refresh
  only if the P3 runs showed a chat's answer equal to the probe's, and otherwise refreshing at
  server start only.
- **U5 — Cross-agent subagent model inheritance. Decided: keep today's behaviour (D22).** No
  model is inherited across agent kinds: when the requested kind's list is known, a subagent
  spawned for another kind without a model takes that kind's saved choice, last-used choice or
  catalog default, also when the chat's model id appears in that kind's list. While that
  kind's list is not yet known the chat's model passes through, as today
  (`internal/chats/spawn.go:294`). Background: once the fetched list is stored, six Claude ids
  are also Cursor ids on this machine (§10); with the code as it is, a Cursor chat on
  `claude-opus-4-8` that spawns a Claude subagent without a model would run it on
  `claude-opus-4-8` at the chat's effort, and a Claude chat on `claude-sonnet-5` would hand that
  model to a Cursor subagent; neither can happen today. No pi id observed is in another list
  (§10). The rule is predictable, leaves Cursor's behaviour as it is, and does not depend on how
  two vendors spell their ids. D22 is built in P1, before P2 stores the first list that shares
  ids with Cursor's. *Settles:* requirement 6, acceptance 12, D22, §7.3 situation 3, the P1
  collision tests, the notes of D19, and the scope of U1 case 3. *Not chosen:* building nothing
  and accepting inheritance wherever both agents list the chat's model under one id.

## 11. Where the research document is wrong or imprecise

| Research document says | Actually |
|---|---|
| `app.go:50` must be changed to prefer the saved list. | It already does (`internal/app/app.go:64-69`); line 50 is only the fallback. Only `Manager.catalog` changes (R1 §0 #5, R2 §6). |
| Two consumers of the built-in list. | Three: `windowFor` reads it too (`internal/claude/translate.go:223`; R1 §5). |
| `findModel` is called from `Configure`. | Also from the `spawn_subagent` path (`internal/chats/spawn.go:272`, `284`, `295`, `314`). |
| `Resolve` switches an unknown saved model back to `sonnet`. | To the catalog's default, which happens to be `sonnet` (`internal/defaults/defaults.go:38`). |
| `readLoop` discards the answer at line 240. | Line 241 hands it to a dispatcher, which drops it because nothing waits for that id (`internal/claude/ctxsplit.go:36-46`). |
| The app sends "this exact request". | The app's request has two extra fields and an `init_` id (`internal/claude/claude.go:203-204`); the answer is the same (R3 §7). |
| The probe takes "under a second". | The answer arrives in about 0.5 s; the whole command takes about 1.2 s (R3 §2, §5). |
| Every entry has the four `supports*` flags. | `haiku` has none and no effort key; `supportsFastMode` is on 4 of 12; flags are `true` or absent (R3 §3, addendum 5). *Note (2026-10-03): P0 and P3 measured `supportsFastMode` on 3 of 12 (the `default` entry resolves to `claude-sonnet-5-5` now); see "P0 findings".* |
| Context window could come from the `[1m]` suffix. | No value in the list has it (R3 addendum 4). |
| (Not mentioned) | An unlisted `--model` is appended to the list as a "Custom model" entry, which matters for the in-chat refresh (R3 §8). |
| (Not mentioned) | A chat's answer comes from a process running in the chat's folder (`internal/claude/claude.go:186`), while the list is stored once for all folders. Whether the folder's settings change the answer is unobserved. The in-chat refresh is built all the same, by the owner's decision, and the case where they do is an accepted, documented risk (A3, D12, U4). |
| (Not mentioned) | Six of the fetched ids are also Cursor model ids, so a stored Claude list would change what cross-agent subagent spawns inherit; D22 keeps today's behaviour by rule, as the owner decided (U5). |
| (Not mentioned) | A model pick is recorded as the group's and the last-used choice (`internal/chats/manager.go:746`), so verifying the picker by picking rows in the installed app would change the owner's defaults; the picks are walked on a dev server (constraint 9, §8). |
| `web/e2e/app.e2e.mjs:69-70,474` is among the fixtures to update. | It is updated (D15) but not run: the paid end-to-end suite is not part of this work (U3), so the edit is parsed for syntax only and is otherwise unexercised. |
| (Not mentioned) | The response has no default effort; a model switch can leave an empty effort today (R2 "Things" #5). |
| (Not mentioned) | The first send records defaults without validation (`internal/chats/manager.go:616-620`). |
| `claude.go:73` should check the catalog entry instead. | `Args` has no catalog to check (`internal/claude/claude.go:25-30`); see D11. |
| The `"-"+id` matches "work for short names but not full ids". | On the web, full ids match exactly first (`web/src/logic/subagents.ts:95-96`); the substring step is only a fallback. In Go the path is legacy (R2 §2, §3). |
| Five fixtures "hardcode the old list". | Only `web/test/subagents.test.ts:125-134` mirrors it. `defaults_test.go` and `models.test.ts` use their own generic fixtures, and `app_test.go` asserts the default, not the list (R2 §7). Tests the document misses are listed in §8, P1. |
| The list "came from the UI prototype's `MODELS2`". | Not verifiable in this repository (R1 §0 #3). |
| Commit `eaa7cdd` changed only `web/src/logic/models.ts`. | Also `web/test/models.test.ts` (R1 §0 #22). |

## 12. References

- Research document: `plans/claude-model-picker.md`.
- Reports R1, R2, R3: paths in the header.
- CLI reference: <https://code.claude.com/docs/en/cli-reference> (`--model`, `--effort`,
  `--no-session-persistence`, `--strict-mcp-config`, `--settings`, `claude auth status`).
- Agent SDK TypeScript reference: <https://code.claude.com/docs/en/agent-sdk/typescript>
  (`supportedModels()`, `initializationResult()`, the `ModelInfo` type).
- Settings: <https://code.claude.com/docs/en/settings> (where project settings are read from,
  `availableModels` across scopes, `ANTHROPIC_MODEL` and `--model` over the `model` setting,
  project `env` values and folder trust).
- Settings reference: <https://code.claude.com/docs/en/settings-reference> (the `env` key: its
  scope, the variables project and local settings cannot set, and when project and local `env`
  values are applied, including at startup in `-p` mode).
- Model configuration: <https://code.claude.com/docs/en/model-config> (order of priority for the
  session model, what `availableModels` applies to, the custom picker entry and its name).
- Cross-agent spawns: `internal/chats/spawn.go:252-324`, `internal/cursor/testdata/models.json`,
  `plans/mcp-subagents.md:340-354`.
- Patterns to follow: `internal/cursor/probe.go:12-70`, `internal/pi/catalog.go:142-205`,
  `cmd/ai-whiteboard/main.go:345-371`, `internal/claude/usage.go:25-41`,
  `internal/chats/manager_test.go:592-642`; for the in-chat refresh, the catalog event Cursor and
  pi chat processes emit on every start (`internal/cursor/cursor.go:246`,
  `internal/pi/pi.go:293`).
- What a pick and a new chat change in the app's data: `internal/chats/manager.go:746`,
  `754-767`, `360-414`, `1028-1057`; `internal/defaults/defaults.go:54-62`, `84-102`.
- Owner decisions U1–U5: settled 2026-10-03, recorded in §10.
