# Work breakdown: claude-retry-api-errors

Read `design.md` first: the decisions D1–D21 are referred to by number. Read the goal `claude-retry-api-errors-goal.md`
too. Read `AGENTS.md` for the test rules.

- **Never** run paid tests (`AIWB_CLAUDE_E2E`, `AIWB_CURSOR_E2E`, `AIWB_PI_E2E`, `web/e2e/app.e2e.mjs`).
- Each chunk is done in its own worktree, on a branch off `claude-retry-api-errors` that already has every chunk it
  depends on.
- Match the surrounding code's comment density, naming and idiom: comments are full sentences that say why.
- Do not edit a file another chunk owns unless its spec says so. If you find you must, say so in your report.
- Every sentence in quotes below is exact: copy it, do not reword it.

## Overview, merge order and parallel groups

| id | title | model | depends on | owns (main files) |
|---|---|---|---|---|
| C1 | Foundation: types, schedule, limiter, texts, endings | sonnet | — | `internal/agent/agent.go`, `internal/model/model.go`, `internal/chats/retry.go` (new), small edits in `internal/chats/{manager,subagents,delivery,nested,spawn,branches}.go`, `internal/agenttest/fake.go`, `cmd/ai-whiteboard/{testwaits,main}.go` |
| C2 | Adapters: Claude and pi classify, the Node stand-in fails like the CLI | sonnet | C1 | `internal/claude/{translate,claude}.go`, `internal/claude/testdata/api_error_*.jsonl` (new), `internal/pi/translate.go`, `internal/agenttest/fake-claude` |
| C3 | Sessions, the one start of a subagent, resume and stop on the manager | sonnet | C1 | `internal/chats/spawn.go` (not `handleSubEv`'s turn end), `internal/chats/resume.go` (new), `internal/chats/fork.go`, `internal/chats/sublimits.go` |
| C4 | A pause in the family: owed kept, children run, the parent told | sonnet | C1 | `internal/chats/nested.go` |
| C5 | The main agent's retry | **opus** | C1 | `internal/chats/retrychat.go` (new), `internal/chats/manager.go`, `internal/chats/branches.go`, `internal/chats/delivery.go` |
| C6 | The clients: rows, status, composer, browser checks | sonnet | C1 (shapes only) | `packages/core/src/{types.ts,logic/retry.ts,logic/status.ts,logic/labels.ts,logic/subagents.ts}`, `app/src/screens/{subagents,chat}/*`, `web/dev/checks/{L10,L19}*.mjs`, `web/dev/checks/README.md` |
| C7 | The subagent's retry and pause | **opus** | C3, C4, C5 | `internal/chats/retrysub.go` (new), `internal/chats/spawn.go` (`handleSubEv`, `finalizeAppSub`), `internal/chats/subagents.go`, `internal/chats/manager.go` (`Shutdown` only) |
| C8 | The `resume_subagent` tool | sonnet | C3, C6 | `internal/boardtools/tools.go`, `internal/boardapi/mcp.go`, `internal/pibridge/extension/index.ts`, `packages/core/src/logic/labels.ts` (tool labels only) |
| C9 | Scenarios end to end | sonnet | C1–C8 | `internal/boardapi/retry_e2e_test.go`, `internal/chats/scenarios_test.go`, `cmd/ai-whiteboard/retry_test.go` (all new) |
| C10 | Documents and the deviation | sonnet | C1–C8 | `docs/architecture.md`, `AGENTS.md`, `plans/deviations/r1.md` (new) |

**Groups:**
- **Group 0:** C1 alone. It fixes every shape, text and helper the others use.
- **Group 1 (in parallel, after C1 is merged):** C2, C3, C4, C5, C6.
  - The only file all of them read is `internal/chats/retry.go`. C1 writes it and nobody in group 1 changes it.
  - C3, C4 and C5 each own different files of `internal/chats`.
  - C3 edits `handleSubEv` only in its `EvSession` case.
  - Test helpers each chunk adds go in its own new test file, with names that start with the chunk's topic, so that
    two chunks never define the same helper.
- **Group 2 (in parallel, after group 1):**
  - C7 needs C3's `startSub`, C4's `tellPaused` and C5's `manager.go`;
  - C8 needs C3's `ResumeSubagentBy` and C6's `labels.ts`.

  They share no file.
- **Group 3 (in parallel, after group 2):** C9 and C10.
- **Merge order:** C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8 → C9 → C10. After the last merge, one agent runs
  `AIWB_TEST_FULL=1 go test -timeout 20m ./...` once, with nothing else testing on the machine, and the root
  `npm test && npm run check` once.

Shared commands (AGENTS.md):
- **While working:** `go test ./internal/<pkg>`, or one test with `-run '^TestName$'`. No `-count=1`.
- **Before finishing a Go chunk:** `go test ./...` once, and `AIWB_TEST_FULL=1 go test ./<pkg>` for each package you
  changed.
- **Code with timers or goroutines** (C1, C3, C4, C5, C7): also `go test -race ./internal/chats`.
- **A failing test your change cannot have touched:** run it again alone (`go test -count=1 -run '^T$' ./<pkg>`). If it
  passes alone, report it as load-sensitive with its failure line, and go on.
- **The chats tests** use the helpers of `manager_test.go`, `nested_test.go`, `delivery_test.go` and
  `spawn_test.go`:
  - `newEnv`, `e.boot()`, `e.nested(depth)`, `e.child(id, from, prompt)`, `e.spawn`, `e.limits`, `e.idleParent`;
  - `e.sub`, `e.subFile`, `e.items`, `notes`;
  - `waitChild`, `waitFor`, `agentClosed`, `closed`, `e.revoked`;
  - the fake spawner `e.claude`, and `fakeAgent.emit` and `fakeAgent.sent`.

  Use them; do not write new ones that do the same.
- **Retry waits in chats tests:**
  - set `e.m.retryWaits = [4]time.Duration{20 * time.Millisecond, 20 * time.Millisecond, 20 * time.Millisecond,
    20 * time.Millisecond}` and `e.m.retryJitter = func(d time.Duration) time.Duration { return d }` (helper
    `fastRetries(e)`, C1);
  - set them to an hour when a test must sit between attempts;
  - wait for "does not happen" for 10× the wait, and for "happens" with `waitFor`'s generous bound.

---

## C1 — Foundation: types, schedule, limiter, texts, endings

**Depends on:** nothing. **Model:** sonnet. No behaviour that exists may change: every existing test passes unchanged.

**Files and spec**

1. **`internal/agent/agent.go`:** the type `Temporary` and its five constants, exactly as in design D1, and the
   field `Temporary Temporary` on `Event`, right after `Error`. Its comment: "EvTurnEnd with Error: the error can
   pass (see Temporary); "" = not temporary, or not known. Never set with Aborted."
2. **`internal/model/model.go`** (design D7):
   - `StatusRetrying` after `StatusWaiting`. Its comment: "the agent's turn failed with a temporary error: it waits
     to be started again on its session, or is being started; shown as working, takes a message".
   - `SubPaused` after `SubStopped`, with the comment of D7. Rewrite the `SubStatus` comment.
   - The type `Retry`, the type `SubCause` and its 14 constants.
   - On `Subagent`, after `BgWaiting`: `Session`, `Retry`, `ErrorKind`, `Cause`, with doc comments.
     - `Session`: "the session its process runs on, recorded when it is started (Claude, pi) or when the agent reports
       it (Cursor); "" for a record from before, which cannot be resumed."
     - `Retry`: "set while it is being retried after a temporary error (running); zero otherwise."
     - `ErrorKind`: "paused: the agent.Temporary of its last failed turn."
     - `Cause`: "why it is in its status when that is not running; "" in a record from before."
   - On `ChatView`, after `Error`: `Retry Retry \`json:"retry,omitzero"\`` with the comment "the chat's agent is being
     retried after a temporary error (StatusRetrying); zero otherwise".
3. **`internal/chats/retry.go`** (new). Its package-level comment says what it holds: "The retry of an agent after a
   temporary error (design D5, D6, D14, D15, D17): the schedule, the limiter, the state of one retry, and the texts.
   The chat's agent uses them in retrychat.go, a subagent in retrysub.go."
   ```go
   var retrySchedule = [4]time.Duration{20 * time.Second, time.Minute, 3 * time.Minute, 8 * time.Minute}
   const retryAttempts = len(retrySchedule)
   const retryGateLimit = 2
   const retryGateHold = 60 * time.Second

   // scaledSchedule is the schedule a manager uses: retrySchedule for first == 0, else every pause
   // times first/retrySchedule[0] (cmd's AIWB_TEST_WAITS retry=).
   func scaledSchedule(first time.Duration) [retryAttempts]time.Duration
   // defaultJitter is d times a uniform random factor in [0.75, 1.25] (math/rand/v2).
   func defaultJitter(d time.Duration) time.Duration

   type retryGate struct { mu sync.Mutex; limit int; hold time.Duration; holding int; queue []*gateTicket }
   type gateTicket struct { start func(); state int /* ticketQueued, ticketHolding, ticketLeft */; timer *time.Timer }
   func newRetryGate(limit int, hold time.Duration) *retryGate
   // enter queues start; it runs on a goroutine of its own once a slot is free (at once when one is).
   func (g *retryGate) enter(start func()) *gateTicket
   // leave frees t's slot, or takes it out of the queue; idempotent, nil-safe. The next queued ticket
   // starts on a goroutine of its own: no caller's lock is held when start runs.
   func (g *retryGate) leave(t *gateTicket)
   func (g *retryGate) counts() (holding, queued int) // for tests

   // retryWait is one agent's retry (Chat.retry, sub.retry). c.mu held for every field.
   type retryWait struct {
   	attempt int             // the attempt waited for or running, 1..retryAttempts
   	kind    agent.Temporary // the failed turn's class
   	reason  string          // the failed turn's error text
   	at      time.Time       // when the attempt is due
   	timer   *time.Timer
   	ticket  *gateTicket
   	started bool            // its process was started: the next reply or failure ends it
   }
   func (w *retryWait) cancel(g *retryGate) // nil-safe: stops the timer, leaves the gate
   func (w *retryWait) model() model.Retry  // {Attempt, Of: retryAttempts, At: at.UnixMilli(), Kind: string(kind), Error: reason}

   func kindLabel(kind string) string // D14's labels; "temporary error" for anything else
   func waitWords(d time.Duration) string // "N s" below a minute (rounded up, at least 1), else "N min" (rounded up)
   func clip(s string, n int) string // at most n runes; a cut text ends with "…"
   func retryNote(kind, reason string, attempt int, wait time.Duration) string // D17's note
   func pausedNote() string // D17, with retryAttempts in it
   func gaveUpNote() string // D16, with retryAttempts in it
   const carryOnTag = "carry-on"
   func carryOnRetryBlock(kind, reason string) string // D15
   func carryOnResumeBlock(prev model.Subagent) string // D15: paused or stopped by prev.Status
   const pausedListTag = "subagents-paused-or-stopped"
   func pausedListBlock(subs []model.Subagent, withMessage bool) string // D14
   func whyText(sa model.Subagent) string // D14's <why>
   var listedCauses = map[model.SubCause]bool{model.CausePerson: true, model.CauseParent: true, model.CauseShutdown: true, model.CauseRestart: true}
   // pausedOrStopped is D14's selector: the records, in order. c.mu held.
   func pausedOrStopped(c *Chat, parent string) []model.Subagent
   // logRetry writes "chats: retry <chat> sub=<sid, - for ""> <msg>" through m.retryLog.
   func (m *Manager) logRetry(chatID, sid, msg string)
   ```
   - Errors in texts are escaped with `xmlEscape`. They are cut with `clip`: 500 characters in a carry-on, 300 in a
     `<why>`, and 300 in a log line, where they are `%q`-quoted.
   - The `<Label>` of a note is `kindLabel` with its first letter upper-cased.
4. **`internal/chats/manager.go`:**
   - `Deps.RetryFirst time.Duration`, with the comment "the first pause of the retry schedule (retry.go); 0 = the
     production 20 s. Only a test sets it (cmd's AIWB_TEST_WAITS retry=)."
   - `Manager` fields `retryWaits [retryAttempts]time.Duration`, `retryJitter func(time.Duration) time.Duration`,
     `retryGate *retryGate`, `retryLog func(string)`, documented like `subQuietWait`. `New` sets them:
     `scaledSchedule(d.RetryFirst)`, `defaultJitter`, `newRetryGate(retryGateLimit, retryGateHold)`, `func(s
     string) { log.Print(s) }`.
   - `Chat` field `retry *retryWait // the chat's agent is being retried (retrychat.go); nil otherwise`.
   - `pubOf`: `StatusRetrying` → `pubWorking`. `busy`, `inTurn` and `waiting` stay as they are (retrying is none of
     them; the test below pins that).
   - `retrying(c *Chat) bool`: `c.retry != nil`.
   - `view(c)`: `if c.retry != nil { v.Retry = c.retry.model() }`.
   - The calls of `stopSubs` and `stopAppSubs` pass the new `why` argument (item 5):
     - `pump`: `endParent`;
     - `InterruptOf`: `endPerson`;
     - `Shutdown`: `endShutdown`.
5. **`internal/chats/subagents.go`:**
   - `sub` fields `retry *retryWait // being retried (retrysub.go); nil otherwise` and `listed map[string]bool //
     the paused children a message to it has listed (nested.go)`.
   - `stopSubs(c, why, out)`, `stopAppSubs(c, why, out)` and `stopRunningSubs(c, out, appOnly, why)` take the ending,
     instead of the fixed `endParent`.
6. **`internal/chats/branches.go`:** `stopLocked` passes `endPerson` to `stopSubs`.
7. **`internal/chats/delivery.go`:**
   - Append `endPerson // the user stopped the chat's agent (Interrupt, Stop, archive, delete)` and `endShutdown // the
     server stopped while it ran` to the `subEnding` constants. Both are false in `endingNotifies`.
   - Add `var causeOf = map[subEnding]model.SubCause{…}`, one entry per ending. Its mapping: `endTurn`→turn,
     `endTurnError`→turn-error, `endFailed`→failed, `endAborted`→aborted, `endGone`→gone,
     `endSpawnFailed`→spawn-failed, `endStopTool`→stop-tool, `endParent`→parent, `endPerson`→person,
     `endShutdown`→shutdown, `endRestart`→restart, `endNative`→native.
   - `ended(s, why)` sets `s.meta.Cause = causeOf[why]` first, for every subagent, then does what it does.
8. **`internal/chats/nested.go`:** extract from `deliverSub` the loop that takes the owed results:
   `func (m *Manager) takeSubOwed(c *Chat, s *sub, tr *transcript.Transcript, out *outbox) (d *carry, taken
   []model.Subagent, ups []transcript.Update)`. It returns nil d when nothing is owed. `deliverSub` calls it. No
   change in behaviour.
9. **`internal/chats/spawn.go`, `handleSubEv`:** the pi no-reply case becomes `case s.carry != nil &&
   !s.carry.settled && s.meta.Kind == model.Pi && len(s.carry.sids) > 0:`.
10. **`internal/agenttest/fake.go`:** `func (t *Turn) FailTemp(kind agent.Temporary, text string)`. It is `Fail` with
    `Temporary: kind`, and is documented as "ends the turn with an error the CLI reported as temporary (design D1).
    The process stays."
11. **`cmd/ai-whiteboard`:**
    - `testwaits.go`: the name `retry`, a field `retry time.Duration`, and the doc line "retry the first pause of the
      retry of an agent after a temporary error (chats.Deps.RetryFirst, 20 s); the other three keep their ratio to
      it". Add it to the error sentence's list of names.
    - `main.go`: `RetryFirst: waits.retry` in `chats.Deps`.
    - `testwaits_test.go`: `lowered["retry"] = 20 * time.Second`.

**Tests**
- **`internal/chats/retry_test.go`** (new):
  - `TestScaledSchedule`: 0 gives the production four; 2 s gives 2 s, 6 s, 18 s, 48 s.
  - `TestDefaultJitterBounds`: 1000 draws of `defaultJitter(time.Second)` all lie in [750 ms, 1250 ms], and are not
    all equal.
  - `TestRetryGateLimitsAndOrder`: limit 2, five `enter`s whose `start` signals a channel.
    - Two start, three are queued (`counts`).
    - `leave` of a holder starts the oldest queued one.
    - `leave` of a queued one removes it, and it never starts.
    - A second `leave`, and `leave(nil)`, change nothing.
  - `TestRetryGateHoldFreesASlot`: hold 30 ms. A holder that never leaves frees its slot, and the queued one starts.
  - `TestRetryWaitCancel`: a `retryWait` with an armed timer and a ticket. After `cancel`, the timer's func never
    runs (wait 10× its time) and the ticket has left.
  - `TestWaitWords`: 400 ms → "1 s", 20 s → "20 s", 59.2 s → "60 s", 60 s → "1 min", 61 s → "2 min", 8 min → "8 min".
  - `TestKindLabel`: the five classes, "" and "other".
  - `TestRetryTexts`: these are golden strings. Write each one out in the test.
    - `retryNote("login", "Failed to authenticate. API Error: 401", 1, 20*time.Second)` is "Login failed: Failed to
      authenticate. API Error: 401. Trying again in about 20 s (attempt 1 of 4)."
    - The three carry-on blocks of D15: retry; resume of a paused record; resume of a record stopped with `person`.
    - `pausedNote()`, `gaveUpNote()`.
    - A reason holding `<x>` is escaped, and one of 600 characters is cut to 500 with "…".
  - `TestPausedListBlock`: golden strings for two records, in both `withMessage` forms. The first record is paused,
    with a description; the second is stopped (`person`), with none. Escaping is checked, and the 300-character cut.
  - `TestPausedOrStoppedSelection`: a chat with records set by hand (`c.subs`). Listed:
    - paused;
    - stopped with person, parent, shutdown, restart.

    Not listed:
    - stopped with stop-tool, aborted or gone;
    - `Kind == ""`;
    - `NotCarried`;
    - `Session == ""`;
    - running, completed or failed;
    - another parent's.

    The order is by `Ended`, then id.
  - `TestEndedRecordsCause`: for every `subEnding`, `ended` sets `causeOf[why]`. `Delivery` follows `endingNotifies`
    as before (an app sub and a native one).
  - `TestRetryingIsWorkingNotBusy`: `pubOf(model.StatusRetrying) == pubWorking`. For a chat whose transcript status is
    retrying, `busy`, `inTurn` and `waiting` are all false.
  - `TestViewCarriesRetry`: with `c.retry` set under the lock, `view(c).Retry == c.retry.model()`. With nil, it is
    zero.
- **`internal/chats/retryhelp_test.go`** (new), helpers for the chunks after this one:
  - `fastRetries(e *env)`, as in "Retry waits in chats tests" above.
  - `func (e *env) pauseByHand(id, sid, reason string, kind agent.Temporary)`. Under `c.mu` it:
    - detaches and later closes the subagent's process, as `stopSub` does (`denySubPerms`, `closeStop`,
      `revokeExtra`);
    - sets `Status = SubPaused`, `Ended`, `Error`, `ErrorKind`, `Cause = CauseRetriesFailed`, a zero `Retry` and
      `Waiting = false`;
    - calls `endSub`.

    It does **not** call `tellPaused` (C4). Its own test is `TestPauseByHand`: the record is written paused and the
    process closed.
- **`internal/model/model_test.go`:** `TestNewSubagentFieldsAreAdditive`.
  - The JSON of a `Subagent` with none of the new fields set has exactly the keys it had before (list them in the
    test).
  - A paused one has `"status":"paused"` and no `retry` key.
  - A `ChatView` with a zero `Retry` has no `retry` key.
- **`internal/agenttest/fake_test.go`:** `TestFakeFailTemp`. `FailTemp(agent.TempLogin, "x")` ends the turn with
  `Error "x"`, `Temporary login`, and the process lives.
- **`cmd/ai-whiteboard/testwaits_test.go`:** extend `TestTestWaits` with `retry=2s`, and with the fast clock's
  `retry`.

**Commands:**
- `go test ./internal/agent ./internal/model ./internal/chats ./internal/agenttest`;
- `go test ./cmd/ai-whiteboard -run '^TestTestWaits$'`;
- `go test -race ./internal/chats`;
- `go test ./...`;
- `AIWB_TEST_FULL=1 go test ./internal/agent ./internal/model ./internal/chats ./internal/agenttest ./cmd/ai-whiteboard`.

**Done when:**
- [ ] Every name above exists, with the doc comments asked for.
- [ ] Every existing test passes unchanged.
- [ ] The new tests pass, the race run is clean, and the texts match D14, D15 and D17 to the byte.

---

## C2 — Adapters: Claude and pi classify, the Node stand-in fails like the CLI

**Depends on:** C1. **Model:** sonnet. Design D1, D2, D3, D19.

**Files and spec**

1. **`internal/claude/claude.go`, struct `proc`:** add `apiErr, apiRetryErr string` and `apiRetried bool`, with the
   comment "the turn's api-error class (D2): the error of its api-error assistant line, and whether and with what the
   CLI retried it itself; cleared at each result". Nothing else in `claude.go` changes.
2. **`internal/claude/translate.go`:**
   - In the second `type == "system"` switch (after the `parent_tool_use_id` check, so native subagents' lines are not
     looked at), add `case "api_retry": p.apiRetried, p.apiRetryErr = true, str(m["error"]); return nil`.
   - In the top-level `assistant` case: when `apiErr` (the existing `is_api_error_message` flag) is true, set
     `p.apiErr = str(m["error"])`.
   - In the `result` case, before the check that skips empty results:
     - take `class, retryClass, retried := p.apiErr, p.apiRetryErr, p.apiRetried`, then clear the three fields;
     - after `errText` is computed, set `temp := agent.Temporary("")` and, `if isErr && !aborted`, `temp =
       claudeTemporary(class, retryClass, retried)`;
     - put `Temporary: temp` on the `EvTurnEnd`.
   - Add `func claudeTemporary(class, retryClass string, retried bool) agent.Temporary`: D2's table, with `class`
     falling back to `retryClass` when empty. Its comment cites the CLI version the classes were read from (2.1.309).
3. **`internal/claude/testdata/`** (new fixtures, synthesized):
   - Follow the shape of `api_error_auth.jsonl` line for line:
     - init (`"claude_code_version":"2.1.309"`);
     - status requesting;
     - the `api_retry` lines asked for;
     - the assistant line with `"is_api_error_message":true` and `"error"`;
     - the result with `"is_error":true`, `"terminal_reason":"api_error"`, `"subtype":"success"`, `api_error_status`
       and the same text.
   - Each file gets its own session id and uuids.

   | file | `api_retry` lines (error, status) | assistant `error` | status | text |
   |---|---|---|---|---|
   | `api_error_overloaded.jsonl` | 2 × (`overloaded`, 529) | `overloaded` | 529 | "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment." |
   | `api_error_rate.jsonl` | 1 × (`rate_limit`, 429) | `rate_limit` | 429 | "API Error: 429 Rate limited." |
   | `api_error_refresh.jsonl` | none | `server_error` | none (field absent) | "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute." |
   | `api_error_billing.jsonl` | none | `billing_error` | 400 | "Credit balance is too low" |
   | `api_error_unknown_retried.jsonl` | 3 × (`unknown`, 500) | `unknown` | 500 | "API Error: 500 Internal server error" |
   | `api_error_unknown.jsonl` | none | `unknown` | absent | "An unknown error occurred" |

   A comment in the test says these six are synthesized, and that the refresh text's end is `[not verified]` (it was
   read from the binary's strings).
4. **`internal/pi/translate.go`:**
   - Add the field `retryGaveUp bool` to the translate state: "pi's own retry ran out in this turn
     (auto_retry_end success false): the error that ends the turn is one pi judged it could retry".
   - On `auto_retry_end`, set it to `!success`.
   - In `onSettled`, set `end.Temporary = agent.TempRetried` when `end.Error != "" && p.retryGaveUp`, then clear it.
   - Update the header comment: `auto_retry_end` is no longer ignored.
   - `pi.go`'s send-failure turn ends stay `""`.
5. **`internal/agenttest/fake-claude`:** the directive `[[apierror CLASS N]]` (also `<<apierror CLASS N>>`), documented
   in the header list:
   > `[[apierror CLASS N]]` → this turn and the next N-1 turns of this session end as the CLI ends a turn the API
   > refused with error class CLASS: status requesting, one system/api_retry, the api-error assistant line, an
   > errored result with terminal_reason api_error. With FAKE_CLAUDE_STATE=<dir> the count is kept in
   > `<dir>/<session>.apierror`, so the turns of a later process on the same session (--resume) fail too, whatever
   > their message. N defaults to 1.
   - Statuses and texts:

     | class | status | text |
     |---|---|---|
     | `authentication_failed` | 401 | "Failed to authenticate. API Error: 401 OAuth token has expired." |
     | `overloaded` | 529 | "API Error: 529 Overloaded." |
     | `rate_limit` | 429 | "API Error: 429 Rate limited." |
     | `server_error` | 500 | "API Error: 500 Internal server error." |
     | `billing_error` | 400 | "Credit balance is too low" |
     | any other | 400 | "API Error: CLASS" |

   - At the start of every turn the fake first reads the state (the file, or the process's own count without
     `FAKE_CLAUDE_STATE`). If any count is left, it takes one and fails the turn, and no other directive of that
     message runs.

**Tests**
- **`internal/claude/temporary_test.go`** (new):
  - `TestClaudeTemporaryTable`: every class of D2. Each with `retried` false and true, and with `retryClass` used
    when `class` is empty.
  - `TestTemporaryOfAPIErrorTurns`: each fixture played through `translateLine` (as `TestTranslateAPIErrorTurn`
    does). Exactly one `EvTurnEnd`, with the error text unchanged and this `Temporary`:

    | fixture | `Temporary` |
    |---|---|
    | auth (real) | login |
    | model (real) | "" |
    | overloaded | overloaded |
    | rate | rate_limit |
    | refresh | server_error |
    | billing | "" |
    | unknown_retried | retried |
    | unknown | "" |

  - `TestAbortedIsNeverTemporary`: an api-error assistant line, then an aborted result: `Temporary` "".
  - `TestTemporaryClearedAfterEachResult`: the auth fixture's turn, then a turn ending with `is_error` and no api
    lines: the second has `Temporary` "".
  - `TestSubagentAPIErrorLinesIgnored`: an api-error assistant line and an `api_retry` with `parent_tool_use_id` set,
    then a top-level errored result: `Temporary` "".
  - `TestTranslateAPIErrorTurn` stays green as it is.
- **`internal/pi`:** `TestPiTemporaryOnlyAfterItsOwnRetries`. Replay `failed_turn_retries.jsonl` → the turn end has
  `Error "Connection error."` and `Temporary retried`; `failed_turn.jsonl` → `Temporary ""`; `retry_recovered.jsonl` →
  no error. Use the replay helper the existing tests of those fixtures use.
- **`internal/agenttest/fakeclaude_test.go`:** `TestFakeClaudeAPIError`, through the real `claude.Spawner` as
  `TestFakeClaudeBackgroundCommand` does, with `FAKE_CLAUDE_STATE` a temp dir (`t.Setenv`, so no `t.Parallel`).
  - Process 1 is sent `[[apierror authentication_failed 2]] hi`. Its turn ends with the 401 text and `Temporary
    login`.
  - Process 2, `Resume` on the same session id, is sent `carry on`, and fails the same way.
  - Process 3 is sent `carry on` and answers `FAKE(<model>): carry on`.
  - Skip without Node. It is in the default set if it takes under about a second alone. Otherwise it is full set only,
    with the reason "TestTemporaryOfAPIErrorTurns (internal/claude) covers the lines".

**Commands:**
- `go test ./internal/claude ./internal/pi ./internal/agenttest`;
- `go test ./...`;
- `AIWB_TEST_FULL=1 go test ./internal/claude ./internal/pi ./internal/agenttest`.

**Done when:**
- [ ] The table of D2 is the only place Claude's classes are read.
- [ ] pi is temporary only after its own retry ran out.
- [ ] The fixtures exist.
- [ ] The stand-in fails across processes of one session.
- [ ] Cursor's code is untouched.

---

## C3 — Sessions, the one start of a subagent, resume and stop on the manager

**Depends on:** C1. **Model:** sonnet. Design D4, D12, D13.

**Files and spec**

1. **`internal/chats/spawn.go`:**
   - **`subSpawnOptions`** gains the parameters `session string, resume bool` and sets `SessionID: session, Resume:
     resume`. It no longer makes a uuid.
   - **`SpawnSubagent`:**
     - Before the record is made, `session := ""` and, for `model.Claude` and `model.Pi`, `session = uuid()`.
     - `Session: session` is in the record's meta.
     - It calls `subSpawnOptions(…, session, false)`.
   - **New `startSub`:**
     ```go
     // startSub is the one start of a subagent's process (design D4): a new one (SpawnSubagent), or one again
     // on its recorded session (a retry, retrysub.go; a resume, resume.go). It starts the process with opts,
     // unlocked; then, with the chat locked, prepare says whether s still wants it and returns the first
     // message (prepare may set s.carry and emit). The process is attached and runSub hands it the message.
     // It returns the error of the start (no process then); a start that is no longer wanted closes the
     // process and returns nil.
     func (m *Manager) startSub(chatID, sid string, kind model.AgentKind, opts agent.SpawnOptions,
     	prepare func(c *Chat, s *sub, out *outbox) ([]agent.ContentBlock, bool)) error
     ```
     - The body is the tail of today's `SpawnSubagent`, from `sp := m.Spawners[kind]` on.
     - "no spawner for agent %q" is an error.
     - A deleted chat, or `s` gone or not running, gives `go ag.Close()` and nil.
     - It uses `s.stop` when it is set, and makes one when it is nil.
   - **`SpawnSubagent`** calls `startSub` with `prepare` returning `{{Text: prompt}}, true`. On an error it does what
     it does today: `folderMissingError`, then `finishAppSub(…, SubFailed, …, endSpawnFailed)`. Every existing spawn
     test passes unchanged.
   - **`runSub(c, sid string, blocks []agent.ContentBlock, ag, stop)`** sends `blocks`.
   - **`handleSubEv`, `case agent.EvSession`:** also `s.meta.Session = ev.SessionID` when it is not empty. This is
     how Cursor's session is recorded. Touch nothing else in `handleSubEv`.
   - **`StopSubagentBy`** (D13):
     - A paused `s` is stopped like a running one: `stopSub(…, endStopTool, …)`, then `stopBelow`, then `deliver` if
       that left approval.
     - A stopped `s` whose `Cause` is in `listedCauses` gets `Cause = model.CauseStopTool`, is saved and emitted, and
       the call returns nil.
     - Any other status keeps today's error.
2. **`internal/chats/resume.go`** (new):
   - The `ErrNotStarterResume` sentence of D12.
   - `func (m *Manager) ResumeSubagent(chatID, sid string) (model.Subagent, error)`, which is `ResumeSubagentBy(chatID,
     "", sid)`.
   - **`func (m *Manager) ResumeSubagentBy(chatID, by, sid string) (model.Subagent, error)`.** Model it on
     `SpawnSubagent`, step for step:
     - lock, `trOf`, archived and legacy, `m.down`;
     - the caller is running (`"the calling subagent has ended"`);
     - `ErrNoSubagent`;
     - `s.meta.Parent != by` gives `ErrNotStarterResume`;
     - `resumeRefusal(s)`;
     - the cap: `runningAppSubs(c) >= limit` gives `&SubCapError{Cap, Running, Resume: true}`;
     - accept (D12's field changes, `prev := s.meta`, `wasApp := s.app`);
     - `saveSub`, `emitSub`, `emitCounts`;
     - `opts := m.subSpawnOptions(c, sid, subLevel(c, sid) >= depth, s.meta.Kind, s.meta.Model, s.meta.Effort,
       s.meta.Session, true)`;
     - unlock;
     - `startSub(chatID, sid, kind, opts, prepare)`, where `prepare` checks that `s.meta.Status == running` and
       `s.ag == nil`, and returns `m.resumeBlocks(c, s, prev, out)`.
   - **On a start error:** under the lock, if `s` is still running with no process, restore `s.meta = prev` and
     `s.app = wasApp`, then save, emit and emit counts. Return `fmt.Errorf("subagent %s could not be started again:
     %v; it is %s as before", sid, err, prev.Status)`.
   - **On success:** return the meta taken at accept time.
   - **`func resumeRefusal(s *sub) error`:** the per-subagent sentences of D12, in its order, with `fmt.Errorf`.
   - **`func (m *Manager) resumeBlocks(c *Chat, s *sub, prev model.Subagent, out *outbox) []agent.ContentBlock`:**
     - `carryOnResumeBlock(prev)`;
     - then, when `takeSubOwed` takes any, `resultsBlock(taken, runningKids(c, sid), false, true)`, with `s.carry =
       d` and the result rows emitted;
     - then, when `pausedOrStopped(c, sid)` is not empty, `pausedListBlock(…, false)`, and `s.listed[k] = true` for
       each paused one (make the map).
3. **`internal/chats/sublimits.go`:** `SubCapError` gets `Resume bool`. When it is set, `Error()` gives D12's resume
   sentence.
4. **`internal/chats/fork.go`, `addUnlisted`:** after the existing loop over the cut records, go over every `c.subs`
   record:
   - set `Session = ""` and `Retry = model.Retry{}`;
   - a `SubPaused` one becomes `SubStopped` with `NotCarried = true`;
   - save the ones that changed.

   Extend the doc comment: a copy resumes nothing, and only the source keeps the sessions.

**Tests**
- **`internal/chats/session_test.go`** (new):
  - `TestSubagentSessionRecordedAtStart`: a Claude subagent's record has a non-empty `Session` equal to its spawn's
    `opts.SessionID`, also in `subagent.json`. The same for a pi subagent: give the env a pi spawner as the chats
    tests that start pi chats do.
  - `TestCursorSubagentSessionFromEvSession`: a Cursor subagent has `Session ""` until its process emits
    `EvSession{SessionID: "cur-1"}`, then `"cur-1"`.
  - `TestOldRecordCannotBeResumed`: a record written without `session` (stopped, `Cause person`, `Kind claude`) is
    refused with the no-session sentence (scenario 10).
- **`internal/chats/resume_test.go`** (new; `fastRetries` is not needed here; use `e.pauseByHand` from C1):
  - **`TestResumePausedSubagent`:** resume a paused lead L.
    - The receipt is running.
    - The new spawn has `Resume`, `SessionID == L.Session`, L's kind, model and effort, and a new MCP token (the old
      one is revoked).
    - The record has `Ended 0`, no `Delivery`, no `Error`, `ErrorKind` or `Cause`, and a zero `Retry`.
    - The first message's first block is `carryOnResumeBlock(prev)`.
  - **`TestResumeCarriesOwedResults`:** a child K of a paused L finished, and its `Delivery` was set to `SubOwed` by
    hand under the lock (C4 makes that happen by itself). The resume message has the carry-on block, then the results
    block holding K, then nothing else. K's `Delivery` is `sent`.
  - **`TestResumeStoppedSubagentListsItsStoppedChildren`** (goal 4.6): `Interrupt` stops L and its child K (`Cause
    person`). Resuming L starts no process for K. L's message ends with the list block naming K and the person `why`.
  - **`TestResumeRefusals`** (scenario 4): a table of the exact sentences, one row each for:
    - running;
    - running and retrying (set `s.meta.Retry` and `s.retry` by hand);
    - completed;
    - failed;
    - another parent's (a subagent's child asked by the chat's agent);
    - native;
    - not carried;
    - no session;
    - unknown sid.
  - **`TestResumeOverTheCapRefused`:** cap 1 with one running; resume a paused one → the resume cap sentence. Nothing
    started, and the record is still paused.
  - **`TestResumeRefusedWhenArchivedOrShuttingDown`:** `ErrArchived`, `ErrShutdown`.
  - **`TestResumeStartFailureRestores`:** the next spawn fails (swap in `failingSpawner` from `nested_test.go`). The
    error is the "could not be started again … it is paused as before" sentence, and the record equals what it was
    (`subFile` too).
  - **`TestResumedSubagentReportsWhenItFinishes`** (goal 4.5): after the resume, a clean turn end completes it, and its
    parent is handed its result once.
  - **`TestStopPausedSubagent`** (D13): the record is stopped (`Cause stop-tool`), its running child is stopped, and
    what was owed to it is given up.
  - **`TestStopAgainTakesItOffTheList`:** a lead stopped by `Interrupt` (`person`), then `StopSubagent` → nil. Its
    `Cause` is stop-tool, and `pausedOrStopped(c, "")` is empty.
  - **`TestCopyDropsSessionsAndPaused`:** a branch copy (use the copy helper of `nested_test.go`'s
    `TestCopyWithNestedSubagents`) of a chat with a paused and a stopped subagent. In the copy both have `Session ""`,
    and the paused one is stopped and `NotCarried`. The source's records are unchanged.

**Commands:**
- `go test ./internal/chats`;
- `go test -race ./internal/chats`;
- `go test ./...`;
- `AIWB_TEST_FULL=1 go test ./internal/chats`.

**Done when:**
- [ ] `startSub` is the only place a subagent's process is started.
- [ ] Every app-started subagent records its session.
- [ ] Every sentence of D12 is returned where it should be.
- [ ] A failed resume changes nothing.

---

## C4 — A pause in the family: owed kept, children run, the parent told

**Depends on:** C1. **Model:** sonnet. Design D9 (what a pause does *not* do), D10, D14 for `deliverSub`.

**Files and spec**: `internal/chats/nested.go` only.
- **`giveUpOrphans`:** also `continue` when the parent's status is `model.SubPaused`. Say why in its comment: a paused
  subagent gets what it is owed when it is resumed (goal 3.3).
- **`stopBelow`:** stop the subagents below that are running **or paused**, with the same call. Update its comment.
- **New:**
  ```go
  // unlisted returns the children of p that are paused and that no message to p has listed yet
  // (sub.listed): what p must be told before it may finish. c.mu held.
  func unlisted(c *Chat, p *sub) []*sub
  // tellPaused tells the parent of k, which has just paused, when it waits with nothing else to come:
  // no child of it runs and nothing is owed to it (design D10). It is handed the news at once, in a
  // message of its own (deliverSub); otherwise its next message carries it. The chat's agent is never
  // told so. c.mu held.
  func (m *Manager) tellPaused(c *Chat, k *sub, out *outbox, aft *after)
  ```
  `tellPaused` acts only when the parent p:
  - exists, is `app`, is running and `Waiting`;
  - has no carry and has a process;
  - has `runningKids == 0` and nothing owed.

  Then it calls `aft.add(m.deliverSub(c, p, out))`.
- **`subWaits`:** the early return also needs `len(unlisted(c, s)) == 0`.
- **`waitOver`:** after the check of running children and owed results, and before the background check, a waiting p
  with `len(unlisted(c, p)) > 0` gets `aft.add(m.deliverSub(c, p, out))`, and the function returns.
- **`deliverSub`:**
  - It starts a turn when `len(owed) > 0 || len(unlisted(c, s)) > 0`.
  - The blocks are the results block (only when results were taken, through `takeSubOwed`), then the list block
    `pausedListBlock(pausedOrStopped(c, s.meta.ID), false)` when that is not empty.
  - Every paused sid in the list is put in `s.listed`.
  - With no results, the carry has no `sids` and no result rows are added.
  - Its doc comment says so.
- **The package doc comment:** add a paragraph. A subagent whose retries ran out is paused, not ended (retrysub.go). It
  keeps what is owed to it and what it started runs on. A parent that waits only on paused children is told of them
  and decides.

**Tests** (`internal/chats/pause_family_test.go`, new). Use `e.pauseByHand` (C1). For the parent to be told, call
`e.m.tellPaused` under the lock in a local helper `pauseAndTell(e, id, sid)`.
- `TestPausedKeepsWhatIsOwedToIt` (goal 3.3): lead L is paused, and its child K then finishes. K's `Delivery` is
  `owed`, and after `e.boot()` it is still `owed`.
- `TestPausingDoesNotStopChildren` (goal 3.2): K is running and its process is not closed after L is paused.
- `TestPausedNotCountedInCap` (goal 3.4): cap 2, with L paused and K running. A spawn by the chat's agent succeeds,
  and `runningAppSubs` is 2 (K and the new one).
- `TestEndedSubagentStopsThosePausedBelow`: P is running, and its child L is paused. P's clean last turn completes P,
  and L is stopped with `Cause parent`.
- `TestWaitingParentToldOfPausedChild`:
  - P waits only on L, and `pauseAndTell(L)` runs.
  - P is handed one message: exactly one block, `pausedListBlock([L], false)`. `P.listed[L]` is set.
  - P's clean turn end with nothing else completes P, and the chat's agent is owed P's result.
  - There is no second message to P.
- `TestWaitingParentWithRunningChildrenNotWoken`: P waits on L and M, and L pauses: no message to P. M then finishes.
  P's delivery is the results block holding M, then the list block naming L.
- `TestCleanEndWithUnlistedPausedChildWaits`: L is paused while P is in a turn (no tell). P's clean end leaves P
  waiting, and it is handed the list.
- `TestDeliverSubUnchangedWithNothingListed` (scenario 11): a delivery to a subagent with no paused or stopped
  children is exactly `[resultsBlock(taken, n, false, true)]`, as before.
- `TestPiNoticeWithoutReplyDoesNotFail`: a pi P is handed a list-only message, and its turn ends cleanly with no
  output. P is not failed: it completes, or waits if anything still holds it.

**Commands:**
- `go test ./internal/chats`;
- `go test -race ./internal/chats`;
- `go test ./...`;
- `AIWB_TEST_FULL=1 go test ./internal/chats`.

**Done when:**
- [ ] A paused subagent loses nothing owed to it, now or after a load.
- [ ] Nothing below it stops.
- [ ] It is not in the cap.
- [ ] A waiting parent is told once.
- [ ] Every existing nested test passes unchanged.

---

## C5 — The main agent's retry (opus)

**Depends on:** C1. **Model:** **opus**. Why opus: `pump`, the carry, the hold and the cap on turns are intertwined.
The retry adds a state in which the chat has no process but shows as working, takes a message, and must cancel cleanly
under three different callers. Read the doc comments of `delivery.go`, `cap.go` and `background.go` first. Design
D14 (where the list goes), D15, D16, D17.

**Files and spec**
1. **`internal/chats/retrychat.go`** (new). Every function documents its locking (c.mu held, or no lock held).
   ```go
   // retryLeftChat reports whether a temporary failure of c's agent is retried: no retry runs, or the one
   // that runs has an attempt after it. c.mu held.
   func retryLeftChat(c *Chat) bool
   // chatTempFail is D16's failure, after the turn end was applied as a clean one: the thread's retry
   // note, StatusRetrying, c.retry for the next attempt (1, or the running one's + 1), the timer, the
   // carry's results back to owed with no attempt counted and no hold, the log. It returns the process
   // to close (dropProcess). c.mu held.
   func (m *Manager) chatTempFail(c *Chat, ev agent.Event, out *outbox) agent.Agent
   // chatRetryFire is the timer of w: when w is still c's retry and c may start, it enters the gate. No lock held.
   func (m *Manager) chatRetryFire(c *Chat, w *retryWait)
   // chatRetryStart is w's slot: the attempt starts c's agent on its session through spawn, with the
   // retry's message (chatRetryBlocks), and hands it over on a goroutine. No lock held.
   func (m *Manager) chatRetryStart(c *Chat, w *retryWait)
   // chatRetryBlocks is the retry's message: board context, carry-on, the owed results (carryOwed(c, false)),
   // the list. It sets c.carry. c.mu held.
   func (m *Manager) chatRetryBlocks(c *Chat, w *retryWait, out *outbox) []agent.ContentBlock
   // chatRetryOK ends the retry at the first reply of its process (goal 2.4). c.mu held.
   func (m *Manager) chatRetryOK(c *Chat)
   // chatRetryRefused is a retry's message the agent did not take: as refused, and the retry ends. No lock held.
   func (m *Manager) chatRetryRefused(c *Chat, w *retryWait, d *carry, err error)
   // chatRetryGaveUp is the end of the last attempt: the gave-up note, the retry cleared, the log. c.mu held.
   func (m *Manager) chatRetryGaveUp(c *Chat, ev agent.Event, out *outbox)
   // cancelChatRetry cancels c's retry (timer, gate) and logs why; nil-safe. c.mu held.
   func (m *Manager) cancelChatRetry(c *Chat, why string)
   ```
   **`chatRetryStart`:**
   - Lock. Return, and leave the gate, if `c.retry != w`, `c.deleted`, `c.tr == nil`, `c.ag != nil`, `m.down`, or the
     top-level chat is archived or legacy. In the last two cases, also `cancelChatRetry`.
   - `w.started = true`. Log "attempt n/4 starts".
   - `err := m.spawn(c, &out)`. On an error:
     - `spawnFailed` has shown it;
     - `cancelChatRetry(c, "the process ended")`;
     - `c.retry = nil`, `TurnActive = false`, `setHold`;
     - log "could not start: …";
     - send, and return.
   - The blocks, then status thinking, then flush, `logSave`, `emitItems` and `emitChat`.
   - `ag := c.ag`, `c.sentGen = c.gen`. Unlock and send.
   - `m.handoffs.Add(1)`, then a goroutine runs `ag.Send(blocks)`. On an error it calls `chatRetryRefused`.
2. **`internal/chats/manager.go`:**
   - **`pump`:**
     - (a) Right after the turn-sign block: `if c.retry != nil && c.retry.started && (modelOutput(ev) || (ev.Kind ==
       agent.EvTurnEnd && !ev.Aborted && ev.Error == "")) { m.chatRetryOK(c) }`.
     - (b) After `waits` is computed (it must keep reading the original event): `temp := ev.Kind == agent.EvTurnEnd
       && !ev.Aborted && ev.Error != "" && ev.Temporary != ""`. Then `retried := temp && retryLeftChat(c)`, and
       `failed := ev`. If `retried`, set `ev.Error, ev.Temporary = "", ""`: the end is applied as a clean one.
     - (c) In `case agent.EvTurnEnd`: `TurnActive = false` only when `!waits && !retried`.
     - (d) After the end mark: `if retried { toClose = append(toClose, m.chatTempFail(c, failed, &out)) } else if
       temp { m.chatRetryGaveUp(c, failed, &out) }`. Declare `toClose` earlier if needed. The existing stopSubs and
       dropProcess lines stay as they are: with a cleared Error they do not run.
     - (e) `if ev.Kind == agent.EvExit && c.retry != nil { m.cancelChatRetry(c, "the process ended"); c.retry = nil
       }`.
     - (f) `turnOver` is called only when `!retried`.
   - **`sendOn`:** right after `reserveTurn` succeeds: `if c.retry != nil { m.cancelChatRetry(c, "a message of the
     user"); c.retry = nil }`. Then, after the results block and before the pictures: `if subs := pausedOrStopped(c,
     ""); len(subs) > 0 { blocks = append(blocks, agent.ContentBlock{Text: pausedListBlock(subs, true)}) }`.
   - **`InterruptOf`:** after `lockBranch`, if `c.retry != nil`:
     - `cancelChatRetry(c, "stopped")`, `c.retry = nil`;
     - `TurnActive = false`, status ready;
     - one "Stopped." note, flush, `logSave`, emit;
     - then go on with the existing path (hold, stop app subagents), which must not add a second "Stopped.".
   - **`Shutdown`:** `if c.retry != nil { c.retry.cancel(m.retryGate); c.retry = nil }`, before the flush. `TurnActive`
     stays as it is.
3. **`internal/chats/branches.go`, `stopLocked`:** if `c.retry != nil`, `cancelChatRetry(c, "stopped")`, `c.retry =
   nil`, and treat it as `wasBusy` (the note).
4. **`internal/chats/delivery.go`:**
   - `unreceived(c, d, failed, hold bool, out)`: it sets the hold only when `hold`. The existing callers pass true.
   - `chatTempFail` puts the results back with `failed=false, hold=false` and clears `c.carry`.
   - `deliver`: after the results block, the list block (`withMessage` false) when not empty.
   - Update the comments of `setHold` and `deliver`: a temporary failure that is retried sets no hold.

**Tests** (`internal/chats/retrychat_test.go`, new; `fastRetries(e)` unless said; fakeAgent processes from
`e.claude`):
- **`TestChatRetriesATemporaryError`** (goal 2.1, 2.2, 2.7):
  - The first turn ends with `Error "Failed to authenticate."` and `Temporary login`. Then:
    - status retrying, `view.Retry.Attempt == 1`, `view.Working == 1`;
    - the thread's last note is the exact retry note, and there is no generic error note;
    - `TurnActive` is true, and the first process is closed;
    - the hold is not set.
  - Next, a second spawn has `Resume` and the same `SessionID`. Its one message holds exactly the carry-on retry block
    (no board in this chat).
  - Its text clears `view.Retry`, and its clean end gives ready.
- **`TestChatRetryCountStartsAgainAfterAReply`:** fail, then the attempt replies, then fail again: the attempt is 1.
- **`TestChatGivesUpAfterFourAttempts`** (goal 3.5): five temporary failures.
  - After the last one: status ready, the error note and then `gaveUpNote()`, `TurnActive` false, the hold set,
    `c.retry` nil.
  - Five processes were spawned in all, on the same session.
  - A next `Send` is taken and resumes the session.
- **`TestMessageDuringBackoffIsTheNextTurn`** (scenario 7): waits of an hour.
  - While retrying, `Send("go on")` is taken (no `ErrBusy`). A new process has `Resume`, and its one message is the
    person's text, with no carry-on block.
  - No other process is spawned later (wait 10× a short wait after setting it short again).
- **`TestInterruptDuringBackoffCancels`** (goal 2.8): waits of an hour.
  - `Interrupt` gives status ready, one "Stopped." note, `TurnActive` false and the hold set.
  - After lowering the waits, nothing is spawned.
- **`TestStopDuringBackoffCancels`:** the same with `e.m.Stop(id)`.
- **`TestRetryCarriesOwedResults`:** waits of an hour, then lowered.
  - A subagent finishes during the backoff: its result stays owed, and nothing is delivered (no process).
  - The retry's message is the carry-on block, then the results block, and its `Delivery` is sent.
- **`TestTemporaryFailureKeepsCarriedResultsOwed`:** a delivery turn (results carried) fails with a temporary error
  before any output. The results are `owed`, not `retry` or given up, and the retry carries them.
- **`TestNonTemporaryErrorAsToday`** (goal 1.3): `Error` with no `Temporary` gives the error note, ready, the hold, the
  process kept and no retry, as before.
- **`TestRetryingChatTakesAMessageButShowsWorking`:** `Busy(id)` is false, while the `pub` mirror is working.
- **`TestPersonMessageCarriesTheList`:** a lead is paused by hand. `Send("continue")`: the blocks are, in order, the
  person's other blocks, the list block with `withMessage` true, and the text.
- **`TestPersonMessageUnchangedWithNothingListed`** (scenario 11): with a lead completed, one stopped by request and
  one failed, the blocks are exactly `[text]` for a plain chat.
- **`TestDeliverCarriesTheList`:** an app delivery with a paused lead: the results block, then the list block.
- **`TestRetryLogLines`:** `e.m.retryLog` captures the lines. A failure, an attempt that answers, and a cancel by a
  message give the lines of D17 in order.
- **`TestShutdownDuringChatBackoff`:** after `e.boot()` the chat shows "Stopped: the app was closed while the agent
  was working.", and the next Send resumes.

**Commands:**
- `go test ./internal/chats -run 'Retr|Backoff|Temporary|Carries|Unchanged'`;
- `go test ./internal/chats`;
- `go test -race ./internal/chats`;
- `go test ./...`;
- `AIWB_TEST_FULL=1 go test ./internal/chats`.

**Done when:**
- [ ] A retrying chat shows as working, takes the person's message, and is cancelled by Stop, Interrupt, its process's
      exit and shutdown.
- [ ] Nothing starts after a cancel.
- [ ] Messages with nothing listed are byte-identical.
- [ ] Every existing test passes unchanged.

---

## C6 — The clients: rows, status, composer, browser checks

**Depends on:** C1 for the shapes. No Go code. **Model:** sonnet. Design D7, D18.

**Files and spec**
- **`packages/core/src/types.ts`:**
  - `Status` gets `"retrying"`, and `SubStatus` gets `"paused"`.
  - `export type Retry = { attempt: number; of: number; at?: number; kind: string; error?: string }`.
  - `Subagent` gets `session?`, `retry?: Retry`, `errorKind?` and `cause?`.
  - `ChatView` gets `retry?: Retry`.
  - Each new field has a comment like the Go field's.
- **`packages/core/src/logic/retry.ts`** (new): `kindLabel(kind?: string)`, `waitWords(ms: number)` (D17), and
  `retryLine(r: Retry, now: number)` and `pausedLine(sa: Subagent)` (D18), with the sentences exactly as written there.
- **`packages/core/src/logic/subagents.ts`:**
  - `subLine` gets a last parameter `now = Date.now()`. Before the status switch, it handles:
    - `sa.status === "paused"` → `{ text: pausedLine(sa), tone: "error" }`;
    - `sa.status === "running" && sa.retry?.attempt` → `{ text: retryLine(sa.retry, now), tone: "muted" }`.
  - `RESULT_STATUS` gets `paused: "Paused"`.
  - The default case stays as it is: an unknown status shows its word.
- **`packages/core/src/logic/status.ts`:** `composerControls`:
  - `stop` is `branchWorking(c) || c.status === "retrying"`;
  - `esc` is `busy || c.status === "retrying"`;
  - `blocked` is unchanged.

  `isBusy` and `inTurn` do not change. Update the comments: a retrying chat takes a message, and Stop cancels its
  retry.
- **`packages/core/src/logic/labels.ts`:**
  - `statusText(c, nameOf, now = Date.now())`: `case "retrying": return c.retry ? retryLine(c.retry, now) :
    "Retrying"`.
  - `rowLine`: `if (c.status === "retrying") return statusText(c, nameOf)`, right after the approval check.
  - `dotState`: retrying → `"thinking"`.

  Do not touch `toolVerb` or `toolDone`: C8 does.
- **`app/src/screens/subagents/Row.tsx` and `Drawer.tsx`:**
  - Pass `now` to `subLine`.
  - `useNow` already ticks while running, and a retrying subagent is running.
  - `useSubThread` loads the thread only when running, not waiting, and not retrying.
- **`app/src/screens/subagents/Parts.tsx`, `SubMark`:** a paused subagent shows the still ring of a waiting row, in the
  danger colour.
- **`app/src/screens/chat/Header.tsx`:** the header's status ticks once a second while the status is retrying
  (`useNow` from `screens/subagents/hooks.ts`, or the header's own timer if it has one). Pass `now` to `statusText`.
- **Browser checks.** Do not change the mock's seed: set state inside the check with `mockEval`, and put it back, as
  `AAC.1-first.mjs` does.
  - **`L19-subagents.mjs`:**
    - A running seed subagent given `retry: {attempt: 2, of: 4, at: Date.now() + 40000, kind: "login"}` reads
      "Retrying in 40 s · 2 of 4" (allow 39–40 s).
    - One with `status: "paused", errorKind: "login"` reads "Paused · login failed", in the error tone.
    - One with `status: "frozen"` (a status no client knows) still draws, and the list's other rows draw (scenario
      12).
  - **`L10-chatview.mjs`:** a seed chat with `status: "retrying"` and a `retry`.
    - Its header reads "Retrying in … · 1 of 4".
    - The composer shows Stop and Send is not blocked.
    - Stop posts `POST /api/chats/{id}/interrupt` (the mock's request log).
  - **`web/dev/checks/README.md`:** add these assertions to the rows of L10 and L19.
- **Unit tests** (`packages/core/test`):
  - `retry.test.ts`: `waitWords` and `retryLine` at 41 s, 40 s, 0 s and the past, and at 3 min; `kindLabel`;
    `pausedLine`.
  - `subagents.test.ts`: `subLine` for retrying, paused and unknown statuses; `subResultLine` for paused.
  - `status.test.ts`: `composerControls` for retrying gives `{stop: true, blocked: false, esc: true}`.
  - `labels.test.ts`: `statusText`, `rowLine` and `dotState` for retrying.

**Commands:**
- from the root `npm test && npm run check`;
- `cd web && npm test`;
- `cd desktop && npm test`;
- `cd web && npm run uicheck -- L10 L19` (Playwright 1.64.1, `web/dev/checks/README.md`).
- No Go tests.

**Done when:**
- [ ] The two sentences of goal 5.4 show in the rows.
- [ ] A retrying chat shows its sentence and Stop and takes a message.
- [ ] An unknown status still draws.
- [ ] No other check's expectations changed.

---

## C7 — The subagent's retry and pause (opus)

**Depends on:** C3 (`startSub`, `subSpawnOptions`), C4 (`tellPaused`), C5 (`manager.go`). **Model:** **opus**. Why
opus: this is the state machine of D8, D9 and D11. It is driven by `handleSubEv`, a timer, the gate and `startSub`,
under three locks, with stops, deletes and shutdown racing it. Every path must leave the record, the token, the process,
the carry and the gate consistent.

**Files and spec**
1. **`internal/chats/retrysub.go`** (new):
   ```go
   // subTempFail is D8: s's turn ended with a temporary error. c.mu held; what to close goes to aft.
   func (m *Manager) subTempFail(c *Chat, s *sub, ev agent.Event, out *outbox, aft *after)
   func (m *Manager) subRetryFire(c *Chat, sid string, w *retryWait)   // timer; no lock held
   func (m *Manager) subRetryStart(c *Chat, sid string, w *retryWait)  // gate slot; no lock held
   // subRetryBlocks: carry-on retry block, the owed results (takeSubOwed; s.carry), the list (s.listed). c.mu held.
   func (m *Manager) subRetryBlocks(c *Chat, s *sub, w *retryWait, out *outbox) []agent.ContentBlock
   func (m *Manager) subRetryOK(c *Chat, s *sub)                       // c.mu held
   // pauseSub is D9. tell says whether its parent is told (tellPaused): never during shutdown or a load. c.mu held.
   func (m *Manager) pauseSub(c *Chat, s *sub, reason string, kind agent.Temporary, cause model.SubCause, tell bool, out *outbox, aft *after)
   // cancelSubRetry cancels s's retry and clears its record's Retry; nil-safe. c.mu held.
   func (m *Manager) cancelSubRetry(c *Chat, s *sub, why string)
   ```
   - **`subTempFail`**, in this order:
     - (1) If `s.carry` is unsettled, set every result it carries that is `sent` back to `SubOwed` (save, emit). Then
       `s.carry = nil`.
     - (2) The next attempt: `n := 1`, or `s.retry.attempt + 1`.
     - (3) Close the process: `denySubPerms`, `aft.close = append(aft.close, s.ag)`, `s.ag = nil`, `closeStop(s)`,
       `m.revokeExtra(c.meta.ID, sid)`, `s.bg = bgWork{}`.
     - (4) If `n > retryAttempts`:
       - `subErrorNote(c, s, ev.Error, out)`;
       - the pause note in its thread;
       - `pauseSub(c, s, ev.Error, ev.Temporary, model.CauseRetriesFailed, true, out, aft)`;
       - log "paused after 4 attempts …";
       - return.
     - (5) Otherwise:
       - `d := m.retryJitter(m.retryWaits[n-1])`;
       - `w := &retryWait{attempt: n, kind, reason, at: m.now().Add(d)}`, `w.timer = time.AfterFunc(d, func(){
         m.subRetryFire(c, sid, w) })`;
       - `s.retry = w`, `s.meta.Retry = w.model()`, `Waiting = false`, `BgWaiting = false`;
       - the retry note in its thread (close its open text first);
       - flush, save, emit;
       - log "attempt n/4 in …".
   - **`subRetryStart`:**
     - Lock. Check `s.retry == w`, running, `!c.deleted`, `c.tr != nil`, `!m.down`, and the top-level chat not archived.
       Otherwise `cancelSubRetry` and return.
     - `w.started = true`, `s.meta.Retry.At = now`, emit.
     - `opts := m.subSpawnOptions(c, sid, subLevel(c, sid) >= depth, kind, model, effort, s.meta.Session, true)`. Log
       "attempt n/4 starts". Unlock.
     - `err := m.startSub(chatID, sid, kind, opts, prepare)`. `prepare` checks `s.retry == w && s.meta.Status ==
       running && s.ag == nil`, and returns `subRetryBlocks`.
     - **On an error:**
       - lock; if `s.retry == w`, `cancelSubRetry(c, s, "the process ended")`;
       - `finalizeAppSub(c, s, model.SubFailed, "could not be started again: "+err.Error(), endFailed, …)`;
       - log "could not start: …";
       - unlock and finish.
   - **`subRetryOK`:** log "answered", `w.cancel(m.retryGate)`, `s.retry = nil`, `s.meta.Retry = model.Retry{}`.
2. **`internal/chats/spawn.go`:**
   - **`handleSubEv`:**
     - (a) After `before := s.meta`: `if s.retry != nil && s.retry.started && (modelOutput(ev) || (ev.Kind ==
       agent.EvTurnEnd && !ev.Aborted && ev.Error == "")) { m.subRetryOK(c, s) }`.
     - (b) In `case agent.EvTurnEnd`'s switch, right after `case ev.Aborted:`, add `case ev.Error != "" &&
       ev.Temporary != "": m.subTempFail(c, s, ev, &out, &aft); return`.
   - **`finalizeAppSub`:** first thing, while running, `m.cancelSubRetry(c, s, "the process ended")`. An exit during an
     attempt, a refused message and a failure to start all end the retry.
3. **`internal/chats/subagents.go`:**
   - **`stopSub`:** `m.cancelSubRetry(c, s, "stopped")` first.
   - **`loadSubs`:** a record that is running with a non-zero `Retry` is not cut. Set `Status paused`, `Ended now`,
     `Error = Retry.Error`, `ErrorKind = Retry.Kind`, `Cause = CauseRetryingAtStop` and `Retry = {}`, then save. A
     record that is running with no `Retry` is cut as today (its `Cause` restart, through `ended`).
4. **`internal/chats/manager.go`, `Shutdown` only:** before `stopAppSubs`, every running app subagent with `s.retry !=
   nil` gets:
   - `cancelSubRetry`;
   - its open process detached and closed with the others;
   - `pauseSub(c, s, w.reason, w.kind, model.CauseRetryingAtStop, false, …)`.

**Tests** (`internal/chats/retrysub_test.go`, new; `fastRetries(e)` unless said):
- **`TestSubRetryLoginThenReply`** (scenario 1): depth 2, lead L with a running chunk K.
  - L's turn fails with `TempLogin`. Then:
    - L is running, with `Retry{1, 4, kind login}`, and L's process is closed and its token revoked;
    - K is running, its process not closed;
    - the chat's agent is handed nothing.
  - A new L process has `Resume`, `SessionID == L.Session`, and the carry-on retry block. Its text clears `Retry`.
  - L ends cleanly and waits on K. K finishes, and L gets K's result. L ends, completed. The chat's agent is handed L's
    result exactly once.
- **`TestSubPausedAfterFourAttempts`** (scenario 2):
  - Five failures. Then L is paused (`Error`, `ErrorKind login`, `Cause retries-failed`, zero `Retry`), its process
    closed, and its thread has the error note and the pause note.
  - K is still running. K then finishes and its result is owed to L.
  - `runningAppSubs` excludes L. The chat's agent was handed nothing for L.
- **`TestSubRetryWaitsFollowTheSchedule`:** with waits 10, 20, 30 and 40 ms and no jitter, the record's `At` minus
  the failure time equals each wait in turn (±5 ms).
- **`TestTwentyLoginFailuresGoThroughTheGate`** (scenario 5): use `fakeEnv` (`agenttest.Fake`), cap 30, and 20
  subagents of the chat's agent.
  - Each script fails with `TempLogin` while `!t.Opts.Resume`. With `Resume` it counts itself in an atomic "inside"
    counter, sleeps 30 ms, says "ok", and counts itself out.
  - All 20 fail at once.
  - The highest value of "inside" is ≤ 2. All 20 complete, and the chat's agent is owed or handed 20 results.
  - Every subagent was spawned exactly twice.
- **`TestNonTemporaryErrorEndsSubAsToday`** (scenario 6): an `Error` with no `Temporary`. L completes with the error,
  K is stopped, and L's result is owed to the chat's agent.
- **`TestStopSubagentDuringBackoff`:** waits of an hour. `StopSubagent(L)` stops L. After lowering the waits, no
  spawn follows.
- **`TestStopDuringBackoffCancelsEveryRetry`** (scenario 8): waits of an hour. The chat's agent is retrying (C5) and
  lead L is retrying.
  - `Interrupt` gives status ready, and L is stopped (`Cause person`).
  - After lowering the waits, no spawn follows, and the gate holds nothing.
- **`TestShutdownDuringBackoffPauses`** (scenario 9): waits of an hour. L is retrying and its child K finished with
  its result owed to L.
  - `e.m.Shutdown()`, then `e.boot()`. L is paused with `Cause retrying-at-stop`, the same `Session`, `Error` and
    `ErrorKind`, and K's result is still owed to L.
  - `ResumeSubagent` starts L with K's result in its message.
- **`TestCrashDuringBackoffPauses`:** write L's `subagent.json` by hand as running with a `retry`, then `e.boot()`. It
  is paused, and not stopped.
- **`TestPausedLeadToldToItsWaitingParent`:** depth 3. P waits only on L. L's retries run out, and P is handed the
  list naming L (C4's path through `pauseSub`).
- **`TestSubRetryCarriesOwedResults`:** waits of an hour, then lowered. K finishes during L's backoff. L's retry
  message is the carry-on block, then K's results block, and K's `Delivery` is sent.
- **`TestSubRetryStartFailureFails`:** the spawn of the attempt fails. L is failed with "could not be started again:
  …", and its parent is owed its result.
- **`TestSubRetryLogLines`:** the D17 lines, for a failure, an attempt, an answer and a pause.

**Commands:**
- `go test ./internal/chats -run 'SubRetry|Paused|Backoff|Gate|Crash|Shutdown'`;
- `go test ./internal/chats`;
- `go test -race ./internal/chats`;
- `go test ./...`;
- `AIWB_TEST_FULL=1 go test ./internal/chats`.

**Done when:**
- [ ] Scenarios 1, 2, 5, 6, 8 and 9 pass in the default set.
- [ ] The race run is clean.
- [ ] No path leaves a timer, a gate slot or a token behind (the tests check `retryGate.counts()` is `0, 0` at their
      end).

---

## C8 — The `resume_subagent` tool

**Depends on:** C3 (`ResumeSubagentBy`, the new `StopSubagentBy`), C6 (`labels.ts` merged). **Model:** sonnet.
Design D12, D13.

**Files and spec**
- **`internal/boardtools/tools.go`:**
  - Append to `SpawnFamily`, after `stop_subagent`:
    ```go
    {
    	Name: "resume_subagent",
    	Description: "Start again one subagent that you started and that is paused (a temporary error outlasted the app's retries) " +
    		"or stopped, by sid, in its own session where it stopped. It returns at once with a receipt and the subagent runs " +
    		"in the background: it is sent a message to carry on, together with the results it is owed, and its result " +
    		"comes to you as a message when it finishes, as for spawn_subagent. Subagents it had started that were " +
    		"stopped with it are not started again: it is told of them and resumes the ones it needs. " +
    		"The app lists the subagents you may resume in a <subagents-paused-or-stopped> block on your messages.",
    	Schema:  obj(props{"sid": str("subagent id from your own spawn_subagent call")}, "sid"),
    	Summary: `{"sid": "<sid>"}`,
    },
    ```
  - `stop_subagent`'s description becomes D13's sentence.
  - `subWords` covers the new texts for `SpawnFamilyForSub` if they say "this chat"; they do not, so check that.
- **`internal/boardapi/mcp.go`:**
  - `parseStopArgs` becomes `parseSIDArgs(tool string, args)`, whose error says "invalid <tool> arguments".
  - `case "resume_subagent"`: on an error, `r.Chats.ResumeSubagentBy(caller.Meta.ID, caller.SID, sid)` gives
    `err.Error(), true`; on success, `fmt.Sprintf("resumed subagent %s (%s)", sa.ID, sa.Status), false`.
- **`internal/pibridge/extension/index.ts`:** add `"resume_subagent"` to `SPAWN_FAMILY_BARE`, and its `endsWith`
  form. The comment says four bare names.
- **`packages/core/src/logic/labels.ts`:** `toolVerb` gives "Resuming subagent" and `toolDone` gives "Resumed
  subagent".
- Claude's allowed tools and Cursor's allow-list are built from `SpawnFamily`, with no change needed: the tests below
  pin that.

**Tests**
- `internal/boardtools`: `TestSpawnFamilyHasResume`. The four names are in order. `resume_subagent` requires `sid`.
  `IsSpawnFamily("resume_subagent")` is true, and the Sub variant has the same text.
- **`internal/boardapi`** (next to `mcp_depth_test.go`, in a new `resume_tool_test.go`):
  - `TestResumeSubagentTool`: a Fake chat's agent calls `resume_subagent` for a paused subagent and gets "resumed
    subagent <sid> (running)". Pause it the way `internal/boardapi`'s tests can: let its turns fail with `FailTemp`
    under a `Deps.RetryFirst` of 1 ms until it is paused.
  - `TestResumeSubagentToolRefusals`: a running sid, an unknown sid and a missing sid give error results with C3's
    sentences.
  - `TestResumeSubagentNeedsTheFamily`: a chat with depth 0 is refused with `NoSpawnText("resume_subagent")`.
- `internal/claude`: in the existing args test, `mcp__board__resume_subagent` is in `--allowedTools` when the family
  is on, and absent with `NoSpawn`.
- `internal/pibridge`: the extension's test of `isSpawnFamilyTool` covers `resume_subagent` and
  `mcp__board__resume_subagent`.
- `packages/core/test/labels.test.ts`: the two labels.

**Commands:**
- `go test ./internal/boardtools ./internal/boardapi ./internal/claude ./internal/pibridge`;
- `npm test && npm run check` at the root;
- `go test ./...`;
- `AIWB_TEST_FULL=1 go test ./internal/boardtools ./internal/boardapi ./internal/claude ./internal/pibridge`.

**Done when:**
- [ ] `resume_subagent` is offered exactly where `spawn_subagent` is.
- [ ] Its answers are the manager's sentences.
- [ ] pi runs it in parallel like the rest of the family.

---

## C9 — Scenarios end to end

**Depends on:** C1–C8. **Model:** sonnet. Only tests. Covers the scenarios of "How it is known to be built" that the
other chunks' tests do not cover end to end: 3 through the tool, 1 and 9 through a real server, and 11 for every
message kind at once.

**Files and spec**
- **`internal/boardapi/retry_e2e_test.go`:** `TestContinueResumesPausedLead` (scenarios 2 and 3, goal 5.3).
  - Set up as `TestNestedChainPerKind` does: `agenttest.New(model.Claude)`, `f.MCP = relay`, depth 2, and a manager
    with `Deps.RetryFirst = time.Millisecond`.
  - The chat's agent's first message "start" calls `spawn_subagent {"prompt":"lead","description":"Lead"}` and ends.
  - **Lead L:**
    - turn 1 (not `Resume`): calls `spawn_subagent {"prompt":"chunk","description":"Chunk"}`, then `FailTemp(login)`;
    - turns 2 to 5 (`Resume`): `FailTemp(login)`;
    - turn 6 (the resume): checks that its message holds `<carry-on>` and K's result "chunk done", then says "lead
      done".
  - **Chunk K:** says "chunk done" after L is paused. Gate K's script on a channel the test closes once L's record is
    paused.
  - The test waits for L paused, then for K completed with its `Delivery` owed to L.
  - The chat's agent's second message is "continue". The script checks that the message holds
    `<subagents-paused-or-stopped>` and L's sid, calls `resume_subagent {"sid": L}`, and checks the receipt.
  - L's spawn 6 has `SessionID` equal to spawn 1's. L completes. The chat's agent gets a third message, a results
    block holding "lead done".
  - Goal 5.3, "the app does not resume because a message arrived": after L is paused and before "continue" is sent,
    wait 10× the longest retry wait. L is still paused, and has been spawned exactly 5 times. After "continue", its
    6th spawn comes only from the tool call.
- **`internal/chats/scenarios_test.go`:** `TestMessagesUnchangedWithNothingListed` (scenario 11, all at once). A chat
  whose subagent records are completed, failed, stopped by request, stopped and aborted, `NotCarried`, and one
  pre-change stopped record (no `Cause`, no `Session`). In each of these, no block with the list's tag is present, and
  the blocks equal the expected composition, written out in the test:
  - the person's message;
  - an app delivery to the chat's agent;
  - a delivery to a waiting subagent;
  - a retry message (with the waits short).
- **`cmd/ai-whiteboard/retry_test.go`** (new). Both tests are `serverTest(…)`, full set only. They skip without Node,
  and set `FAKE_CLAUDE_STATE` to a temp dir with `in.setenv`.
  - **`TestServerRetriesALoginFailure`** (scenario 1 through a real server). Reasons: `TestChatRetriesATemporaryError
    (internal/chats)` and `TestFakeClaudeAPIError (internal/agenttest)`.
    - The server runs with `-claude <agenttest.FakeClaude>` and `fast.env(t, "retry")`.
    - A Claude chat is sent `[[apierror authentication_failed 1]] hello`.
    - Its view shows status `retrying` with `retry.attempt == 1`, then idle.
    - Its items have the retry note and then a text starting "FAKE(".
    - The server's stderr (captured into a buffer, not `os.Stderr`) has the lines "attempt 1/4 in" and "attempt 1/4
      answered".
  - **`TestServerStopDuringRetryPausesSubagent`** (scenario 9 through a real server). Reasons:
    `TestShutdownDuringBackoffPauses (internal/chats)` and `TestCrashDuringBackoffPauses (internal/chats)`.
    - Production waits (no `retry` in `AIWB_TEST_WAITS`).
    - The chat is sent `[[mcp spawn_subagent {"prompt":"<<apierror authentication_failed 9>>","description":"lead"}]]`.
    - Wait until `GET /api/chats/{id}/items` shows the subagent running with `retry.attempt == 1`.
    - `in.run(t, "stop")`, start `serve` again on the same home, and read the items. The subagent is `paused`, with
      `cause` "retrying-at-stop", `errorKind` "login", a non-empty `session`, and the 401 text as `error`.

**Commands:**
- `go test ./internal/boardapi -run '^TestContinueResumesPausedLead$'`;
- `go test ./internal/chats -run '^TestMessagesUnchangedWithNothingListed$'`;
- `AIWB_TEST_FULL=1 go test ./cmd/ai-whiteboard -run 'Retr'`;
- `go test ./...`;
- `AIWB_TEST_FULL=1 go test ./internal/boardapi ./internal/chats`.

**Done when:**
- [ ] The scenario table at the end of this file has a passing test for every row.

---

## C10 — Documents and the deviation

**Depends on:** C1–C8 (what was built). **Model:** sonnet. Design D20. No code; no tests (AGENTS.md: documentation
only).

- **`docs/architecture.md`**, the Server bullet, after the sentences on background work. In the document's own voice,
  three to six sentences:
  - A turn that ends with an error the CLI reports as temporary (Claude: login, rate limit, overload, server; pi:
    what pi retried itself) is retried on the same session in a new process. It is retried four times, after about
    20 s, 1 min, 3 min and 8 min with jitter, and at most two retries start at once across the server.
  - Meanwhile the agent is running: a chat shows `retrying` and takes a message, which cancels the retry, and Stop
    cancels it.
  - A subagent whose retries run out is `paused`. It keeps its session and what is owed to it, and what it started
    runs on.
  - A parent resumes a paused or stopped subagent it started with `resume_subagent`.
  - Every message to an agent lists its paused subagents and those stopped without its asking, so "continue" to the
    chat's agent is enough.
  - Every app-started subagent records its session.

  Also add `resume_subagent` to the spawn family's list in the same bullet.
- **`AGENTS.md`**, in "Do not wait out production waits": add `retry` to the names of `AIWB_TEST_WAITS` (and the
  missing ones, if you check `testwaits.go` and find more).
- **`plans/deviations/r1.md`** (new), titled "R1: agents survive temporary errors: what Cursor and pi cannot do", in
  the format of the files next to it:
  - Cursor: its failed prompt reaches the adapter as text without a class (the JSON-RPC code is dropped, and no
    recording of a Cursor login, rate or overload error exists). So no Cursor turn is temporary: it ends as before,
    nothing retries it, and it never pauses. A Cursor subagent records its session at `EvSession`, and can be resumed
    when it was stopped.
  - pi: only an error pi retried itself and gave up on (`auto_retry_end` with `success: false`) is temporary, with
    the class "temporary error". A login failure (a 401, which pi does not retry) is not, and ends as before.
  - Claude: classes read from the CLI (2.1.309). "Not logged in" and a lost connection are assumed to come as
    api-error lines `[not verified]`.

**Commands:** none (documentation only).

**Done when:**
- [ ] The architecture text says everything in the list above.
- [ ] `AGENTS.md` names `retry`.
- [ ] The deviation file exists.

---

## After the last merge

- One run of `AIWB_TEST_FULL=1 go test -timeout 20m ./...` with nothing else testing.
- One run of the root `npm test && npm run check`.
- `cd web && npm run uicheck -- L10 L19`.
- **Only when the person asks** (it spends money and needs a login that fails): one real Claude subagent whose login
  has expired, to confirm R2 of `design.md`. No paid test is part of this plan.

## Outcomes and scenarios → chunks

| outcome | delivered by | test that shows it |
|---|---|---|
| 1.1 told from what the CLI reports | C2 | `TestClaudeTemporaryTable`, `TestTemporaryOfAPIErrorTurns` |
| 1.2 login failure is temporary | C2 | `TestTemporaryOfAPIErrorTurns` (auth, real lines) |
| 1.3 not temporary behaves as today | C5 (chat), C7 (subagent) | `TestNonTemporaryErrorAsToday`, `TestNonTemporaryErrorEndsSubAsToday` |
| 1.4 Cursor and pi, deviation | C2, C10 | `TestPiTemporaryOnlyAfterItsOwnRetries`; `plans/deviations/r1.md` |
| 2.1 every agent retried by one rule | C5, C7 (on C1's schedule) | `TestChatRetriesATemporaryError`, `TestSubRetryLoginThenReply` |
| 2.2 new process, same session, one carry-on message | C3 (`startSub`), C5, C7 | the same two, `TestFakeClaudeAPIError` |
| 2.3 four attempts, the schedule, jitter, one place, lowered by tests | C1 | `TestScaledSchedule`, `TestDefaultJitterBounds`, `TestSubRetryWaitsFollowTheSchedule`, `TestTestWaits` |
| 2.4 a reply ends the retrying | C5, C7 | `TestChatRetryCountStartsAgainAfterAReply`, `TestSubRetryLoginThenReply` |
| 2.5 the limiter | C1, C7 | `TestRetryGateLimitsAndOrder`, `TestTwentyLoginFailuresGoThroughTheGate` |
| 2.6 retrying is running; record says it | C1, C7 | `TestSubRetryLoginThenReply`, `TestSubRetryCarriesOwedResults` |
| 2.7 a retrying chat shows working, with a note | C5, C6 | `TestChatRetriesATemporaryError`, `TestRetryingChatTakesAMessageButShowsWorking`, L10 |
| 2.8 Stop, Interrupt, a stop of a subagent, the person's message cancel | C5, C7 | `TestInterruptDuringBackoffCancels`, `TestStopDuringBackoffCancelsEveryRetry`, `TestStopSubagentDuringBackoff`, `TestMessageDuringBackoffIsTheNextTurn` |
| 2.9 the log | C1, C5, C7 | `TestRetryLogLines`, `TestSubRetryLogLines` |
| 3.1 paused with the reason, process closed, no result | C7 | `TestSubPausedAfterFourAttempts` |
| 3.2 pausing stops nothing below | C4 | `TestPausingDoesNotStopChildren` |
| 3.3 owed results stay owed | C4 | `TestPausedKeepsWhatIsOwedToIt` |
| 3.4 paused not in the cap | C4 | `TestPausedNotCountedInCap` |
| 3.5 the chat holds after the last attempt | C5 | `TestChatGivesUpAfterFourAttempts` |
| 3.6 paused after a server stop | C7, C9 | `TestShutdownDuringBackoffPauses`, `TestCrashDuringBackoffPauses`, `TestServerStopDuringRetryPausesSubagent` |
| 4.1 the tool, in the family | C8 | `TestSpawnFamilyHasResume`, `TestResumeSubagentNeedsTheFamily` |
| 4.2 only paused or stopped, only one's own, sentences | C3, C8 | `TestResumeRefusals`, `TestResumeSubagentToolRefusals` |
| 4.3 session, kind, model, effort, new credentials, carry-on with results, receipt | C3 | `TestResumePausedSubagent`, `TestResumeCarriesOwedResults` |
| 4.4 the cap, depth, archive, shutdown | C3 | `TestResumeOverTheCapRefused`, `TestResumeRefusedWhenArchivedOrShuttingDown` |
| 4.5 running again; end and owed mark cleared | C3 | `TestResumePausedSubagent`, `TestResumedSubagentReportsWhenItFinishes` |
| 4.6 children not started; listed | C3 | `TestResumeStoppedSubagentListsItsStoppedChildren` |
| 4.7 session recorded on every subagent | C3 | `TestSubagentSessionRecordedAtStart`, `TestCursorSubagentSessionFromEvSession` |
| 5.1 the list; unchanged when empty | C1 (text), C4, C5 | `TestPausedListBlock`, `TestPausedOrStoppedSelection`, `TestPersonMessageUnchangedWithNothingListed` |
| 5.2 on the person's messages and every carry-on | C5, C3, C7 | `TestPersonMessageCarriesTheList`, `TestResumeStoppedSubagentListsItsStoppedChildren`, `TestPausedLeadToldToItsWaitingParent` |
| 5.3 "continue" is enough; the app does not resume | C9 | `TestContinueResumesPausedLead` |
| 5.4 the row sentences, no new screen | C6 | L19, `subagents.test.ts`, `retry.test.ts` |
| 6.1 a result owed to the chat's agent goes with the person's message | C5 (unchanged rule) | `TestPersonMessageCarriesTheList`, existing delivery tests |
| 6.2 a paused subagent's results go with its resume | C4, C3 | `TestPausedKeepsWhatIsOwedToIt`, `TestResumeCarriesOwedResults`, `TestContinueResumesPausedLead` |
| 6.3 a stopped subagent's results given up | C3 (unchanged rule) | `TestStopPausedSubagent`, existing tests |
| 6.4 no result while retrying; told when paused | C7, C4 | `TestSubRetryLoginThenReply`, `TestWaitingParentToldOfPausedChild` |

| scenario | chunk | test |
|---|---|---|
| 1 login failure, then a reply | C7, C9 | `TestSubRetryLoginThenReply`; `TestServerRetriesALoginFailure` (full set) |
| 2 four failures: paused, chunks run, owed, not in the cap | C7, C4 | `TestSubPausedAfterFourAttempts`, `TestPausedNotCountedInCap` |
| 3 the parent's message lists it, the parent resumes it, it finishes | C9 | `TestContinueResumesPausedLead` |
| 4 resume refusals, and the cap's | C3, C8 | `TestResumeRefusals`, `TestResumeOverTheCapRefused`, `TestResumeSubagentToolRefusals` |
| 5 twenty login failures at once | C7 | `TestTwentyLoginFailuresGoThroughTheGate` |
| 6 a non-temporary error as today | C7 | `TestNonTemporaryErrorEndsSubAsToday` |
| 7 the chat's agent retries; a message between attempts is the next turn | C5 | `TestChatRetriesATemporaryError`, `TestMessageDuringBackoffIsTheNextTurn` |
| 8 Stop during a backoff cancels every retry | C7 | `TestStopDuringBackoffCancelsEveryRetry` |
| 9 a server stop during a backoff: paused, resumable, owed kept | C7, C9 | `TestShutdownDuringBackoffPauses`; `TestServerStopDuringRetryPausesSubagent` (full set) |
| 10 session in the record; none in an old one, and it says so | C3 | `TestSubagentSessionRecordedAtStart`, `TestOldRecordCannotBeResumed` |
| 11 nothing paused or stopped: byte for byte | C4, C5, C9 | `TestDeliverSubUnchangedWithNothingListed`, `TestPersonMessageUnchangedWithNothingListed`, `TestMessagesUnchangedWithNothingListed` |
| 12 the rows say so; an old client still draws the list | C6, C1 | L19, `subagents.test.ts`, `TestNewSubagentFieldsAreAdditive` |
