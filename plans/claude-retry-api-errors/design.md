# Design: agents survive temporary API and login errors

The architecture for `claude-retry-api-errors-goal.md` (the goal). The work breakdown is in `chunks.md`, next to this
file. Section numbers like "goal 3.4" point into the goal. Every decision has a one-line reason. What was not seen in
a recording or in the CLI's own code is marked `[not verified]`.

## 0. What was checked before deciding

- **The CLI's errors, from recordings.** `internal/claude/testdata/api_error_auth.jsonl` and `api_error_model.jsonl` are
  real lines of Claude Code 2.1.284 (`TestTranslateAPIErrorTurn`):
  - A refused request ends with an `assistant` line that carries `"is_api_error_message": true` and
    **`"error": "<class>"`** (`"authentication_failed"` for a rejected key, `"model_not_found"` for an unknown model),
    model `"<synthetic>"`, the CLI's text as its only content. `translate.go` already keeps that text out of the thread.
  - Then a `result` line with `"is_error": true`, `"terminal_reason": "api_error"`, `"api_error_status": 401` (or 404),
    `"subtype": "success"` and the same text in `result`.
  - Before them, for a class the CLI retries itself, `system/api_retry` lines:
    `{"attempt":1,"max_retries":10,"retry_delay_ms":591,"error_status":401,"error":"authentication_failed"}`. The
    auth fixture has ten of them over 181 s: **the CLI already retries inside a turn** before it gives up.
- **The CLI's error classes, from its binary** (Claude Code 2.1.309, installed here; strings only, nothing run):
  - The enum of the assistant line's `error`: `authentication_failed, oauth_org_not_allowed, account_on_hold,
    verification_required, billing_error, rate_limit, overloaded, invalid_request, model_not_found, server_error,
    unknown, max_output_tokens, cloud_credential_error`.
  - The two messages of the incident are both in it:
    - `"Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is
      usually transient; retry in a minute…"` with class **`server_error`**;
    - `"Failed to authenticate: OAuth session expired and could not be refreshed"` and `"Not logged in · Please run
      /login"` with class **`authentication_failed`**.
  - `cloud_credential_error` is built with `apiErrorIsTransient: true`.
  - `rate_limit` covers a short rate limit and also `usage_limit_reached` and `model_requires_usage_credits`.
  - A lost connection is `server_error` with `apiError: "no_response"` `[not verified: only seen in strings]`.
  - That a "Not logged in" turn reaches the stream as the same api-error assistant line plus errored result
    `[not verified: the shape is the one recorded for a rejected key; the text was seen only in strings]`.
- **Cursor.** A failed `session/prompt` comes back as a JSON-RPC error. `conn.Call` turns it into
  `"session/prompt: <message> <data>"` text (`acp.go`, `rpcErrorText`), so its code is lost. No recording of a Cursor
  login, rate or overload error exists here `[not verified]`. Cursor reopens a session in a new process
  (`session/load`, the chat's resume).
- **pi.** A failed turn is an assistant message with `stopReason: "error"` and a free-text `errorMessage`. pi retries
  what it judges retryable by itself: `agent_end {willRetry:true}`, `auto_retry_start {attempt, maxAttempts, delayMs,
  errorMessage}`, and when its retries run out `auto_retry_end {success:false, finalError}`
  (`internal/pi/testdata/failed_turn_retries.jsonl`, "Connection error.", 3 attempts). A 401 (`failed_turn.jsonl`) has
  `willRetry:false` and no retry lines. pi reopens a session in a new process (the chat's resume, `<Dir>/pi`).
- **Today's code.**
  - A subagent's turn that ends with an error: `handleSubEv` → `finalizeAppSub(SubCompleted, endTurnError)`. Its
    result becomes owed to its parent, its process is closed, and `stopBelow` stops everything it started.
  - A chat's errored turn: `transcript.Apply` adds the error note, status ready, `turnOver` sets the hold. The process
    stays.
  - `SpawnSubagent` makes a session id for Claude and pi (`subSpawnOptions`), but only `SpawnOptions` has it: **the
    record does not**. For Cursor `EvSession` writes the session id into `AgentID`.
  - `Shutdown` stops every running app subagent (`stopAppSubs`, `endParent`). `loadSubs` marks a record still
    `running` on disk as stopped (`endRestart`), and `giveUpOrphans` gives up what was owed to it.
  - `sub.app` is in memory only: after a load an app-spawned record is known by `meta.Kind != ""`.
  - `ChatView` and `Subagent` are compared with `==` (`view(c) != before`, `s.meta == s.saved`), so new fields must be
    comparable values, not pointers.

## 1. Decisions

**D1. A temporary error is a value on the turn end: `agent.Temporary`.**
```go
// internal/agent/agent.go
// Temporary is the class of an error that can pass, as the agent's CLI reports it on a failed turn
// (goal 1.1). "" is an error that is not temporary, or one the adapter cannot tell.
type Temporary string

const (
	TempLogin      Temporary = "login"        // the login failed (Claude authentication_failed, cloud_credential_error)
	TempRate       Temporary = "rate_limit"   // rate or usage limited (Claude rate_limit)
	TempOverloaded Temporary = "overloaded"   // the provider is overloaded (Claude overloaded)
	TempServer     Temporary = "server_error" // the provider or the connection failed (Claude server_error)
	TempRetried    Temporary = "retried"      // no class, but the CLI retried it itself before it gave up (Claude api_retry, pi auto_retry_end)
)
// New field on Event, EvTurnEnd only, set only together with Error and never with Aborted:
Temporary Temporary
```
Reason: the manager decides on one value, and only the adapter reads its CLI's lines (goal 1.1, 1.4).

**D2. Claude's rule (`internal/claude/translate.go`).** Per turn the adapter keeps:
- `apiErr`: the `error` of the last top-level `assistant` line that has `is_api_error_message: true`;
- `apiRetried`, `apiRetryErr`: a top-level `system/api_retry` line was seen, and its `error`.

Lines with `parent_tool_use_id` (native subagents) are not looked at. All three are cleared after each `result`. On a
`result` with `is_error` and not aborted, the class is `apiErr`, else `apiRetryErr`, and:

| class | Temporary |
|---|---|
| `authentication_failed`, `cloud_credential_error` | `TempLogin` |
| `rate_limit` | `TempRate` |
| `overloaded` | `TempOverloaded` |
| `server_error` | `TempServer` |
| `billing_error`, `invalid_request`, `model_not_found`, `max_output_tokens`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required` | `""` |
| `unknown`, `""`, anything else | `TempRetried` if `apiRetried`, else `""` |

Notes on the table:
- `TempLogin` follows goal 1.2. A key that is simply invalid is classed the same; it pauses after the retries, and
  that is acceptable.
- `rate_limit` includes a usage limit that resets in hours. Its retries run out and the agent pauses, so a later
  "continue" resumes it.
- An error result with no api-error line and no `api_retry` (a failed `--resume`, `max_turns`) is `""`.
- The text of the error is never parsed.

Reason: the CLI names the class (goal 1.1). Where it names none, its own retry is its statement that the error could
pass.

**D3. Cursor and pi (goal 1.4).**
- **Cursor** never sets `Temporary`: its errors behave as today. It can reopen a session, so its subagents are
  resumed (D12) and its sessions recorded (D4).
- **pi** sets `TempRetried` on a turn end with an error when, in that turn, pi sent `auto_retry_end` with
  `success:false`. Any other pi error is `""`, a 401 included. pi's retries take seconds; the app's take minutes.
- Both are written as a deviation in `plans/deviations/r1.md` (chunk C10):
  - Cursor: no class reaches the adapter, so no retry and no pause; a Cursor agent that fails ends as before;
  - pi: only what pi itself retried is temporary, and a login failure is not.

Reason: neither CLI gives a class the adapter can read. For pi, its own retry is the only statement that is not free text.

**D4. One way to start an agent again on its session.** No process is kept after a failed turn. A retry, a resume and
the person's message all start a new process on the recorded session through one function per kind of agent:
- **The chat's agent: `Manager.spawn(c, out)`**, as today: with no process it starts one with `Resume = Locked` on
  `c.meta.SessionID`. A retry (D16) and the person's next message (`sendOn`) both call it.
- **A subagent: `Manager.startSub(chatID, sid, opts, prepare)`** (new, `spawn.go`). It is the tail of `SpawnSubagent`
  made reusable:
  - it runs `Spawner.Spawn(opts)` unlocked;
  - then it locks the chat and calls `prepare(s)`, which either returns the first message's blocks (and may set
    `s.carry`) or `false`, meaning "no longer wanted";
  - then it attaches `s.ag`, makes a new `s.stop`, and runs `runSub(c, sid, blocks, ag, stop)`.

  `SpawnSubagent` (new session), the retry (D8) and the resume (D12) call it. `subSpawnOptions` takes the session and
  `Resume` from its caller, and always issues a new MCP token (the credentials of a new subagent, goal 4.3).
- **The session is recorded on every subagent the app starts** (goal 4.7): `model.Subagent.Session`.
  - Claude and pi: the id is made before the record is first written, and the same id goes into `SpawnOptions`.
  - Cursor: the session id of `EvSession` (written into `AgentID` too, as today).
  - A record from before has `Session == ""` and cannot be resumed.
- **Copies** (a new branch or a fork, `addUnlisted`):
  - every copied record loses `Session` and `Retry`;
  - a copied record that is paused becomes stopped and `NotCarried`, as a running one does.

  Two processes must never write one session, and only the source may resume its subagents.

Reason: the goal's "retry is a resume". With one start per kind of agent, the three paths cannot drift.

**D5. The schedule, in one place, overridable, with jitter.** In `internal/chats/retry.go`:
```go
// retrySchedule is the pause before each retry of a turn that failed with a temporary error (goal 2.3).
var retrySchedule = [4]time.Duration{20 * time.Second, time.Minute, 3 * time.Minute, 8 * time.Minute}
const retryAttempts = len(retrySchedule)
```
- **Manager fields:**
  - `retryWaits [4]time.Duration`: the schedule. `New` sets it from `Deps.RetryFirst`: 0 means the production
    values; otherwise every pause is scaled by `RetryFirst / 20 s`, so the four keep their ratio 1 : 3 : 9 : 24.
  - `retryJitter func(time.Duration) time.Duration`: by default uniform in [0.75 d, 1.25 d]. Tests set it to the
    identity.
- **`Deps.RetryFirst`** is set only by `cmd/ai-whiteboard` from the new `AIWB_TEST_WAITS` name `retry`
  (`testwaits.go`, `lowered["retry"] = 20 * time.Second`). A built server keeps the production values.
- **Attempts.** Attempt *n* (1 to 4) waits `retryJitter(retryWaits[n-1])`. The original turn is not an attempt. So an
  agent's model is asked at most five times in a row.

Reason: one table that tests can lower, as `subQuietWait` and `ImageWait` are lowered. ±25 % takes twenty agents that
failed together, at 20 s, apart over 10 s.

**D6. The limiter: at most two retries starting at once, for the whole server (goal 2.5).**
`retryGate` (in `retry.go`) is a FIFO with `limit` slots (`retryGateLimit = 2`) and a `hold` (`retryGateHold = 60 s`):
- `enter(start func()) *gateTicket` queues the attempt. `start` runs on a goroutine of its own when the attempt gets a
  slot.
- A ticket holds its slot from then until `leave(t)`. That is called on the attempt's first reply, its failure, its
  cancel, or when the `hold` runs out, whichever is first. The hold keeps a hung attempt from blocking every other.
- `leave` is idempotent and nil-safe, and removes a ticket that is still queued. It starts the next queued ticket on a
  goroutine, never under a lock of its caller.

Its mutex is a leaf: no chat's lock is taken under it. **Every retry goes through it**, of every class and every kind
of agent. Both fields are on the Manager (`retryGate *retryGate`) so tests can change them.

Reason: the incident's refresh race is reported both as `authentication_failed` and as `server_error`, so the gate is
not limited to `TempLogin`. Spreading restarts helps overload and rate limits too. Two slots keep a refresh race to
two processes without lining twenty agents up behind one slow first reply.

**D7. Model additions (additive; old clients safe).** In `internal/model/model.go`:
```go
StatusRetrying Status = "retrying" // the chat's agent failed with a temporary error and waits to be started again, or is being started (D16)
SubPaused SubStatus = "paused"     // its retries ran out: no process, its session kept; neither running nor finished

// Retry is the state of an agent that is being retried after a temporary error (goal 2.6).
type Retry struct {
	Attempt int    `json:"attempt"`         // the attempt waited for or running, 1 to Of
	Of      int    `json:"of"`              // how many attempts there are (4)
	At      int64  `json:"at,omitempty"`    // unix ms the attempt is due; in the past once it waits for the limiter or runs
	Kind    string `json:"kind"`            // the agent.Temporary of the failed turn
	Error   string `json:"error,omitempty"` // the failed turn's error text
}
// SubCause says why a subagent is in a status that is not running (stored, for the list of D14).
type SubCause string
const (
	CauseTurn SubCause = "turn"; CauseTurnError = "turn-error"; CauseFailed = "failed"; CauseAborted = "aborted"
	CauseGone = "gone"; CauseSpawnFailed = "spawn-failed"; CauseStopTool = "stop-tool"; CauseParent = "parent"
	CausePerson = "person"; CauseShutdown = "shutdown"; CauseRestart = "restart"; CauseNative = "native"
	CauseRetriesFailed = "retries-failed"   // paused: its retries ran out
	CauseRetryingAtStop = "retrying-at-stop" // paused: it was being retried when the server stopped
)
```
- **New fields on `Subagent`:**
  - `Session string \`json:"session,omitempty"\``;
  - `Retry Retry \`json:"retry,omitzero"\`` (set only while running);
  - `ErrorKind string \`json:"errorKind,omitempty"\`` (paused: the class);
  - `Cause SubCause \`json:"cause,omitempty"\``.
- **New field on `ChatView`:** `Retry Retry \`json:"retry,omitzero"\``.
- `Retry` is a struct of scalars, so `Subagent` and `ChatView` stay comparable.
- The `SubStatus` comment "Every state but running is final" becomes "running is live; paused is neither live nor
  final; every other state is final".
- **Old clients.**
  - An old app shows a `paused` row with the raw word ("paused"): `subLine`'s default case.
  - It shows a `retrying` chat with no status text and no Stop, and Send enabled.
  - Neither breaks the list (goal scenario 12).
  - A server never omits a field an old client reads. The feature level is not raised.

Reason: the goal's "paused is a status of its own" and "the new status and the retry fields are additions".

**D8. A subagent's temporary failure keeps it running (goal 2.1, 2.2, 2.6, 6.4).** In `handleSubEv`, an `EvTurnEnd`
with `Error != "" && Temporary != "" && !Aborted` goes to `subTempFail` (`retrysub.go`). It does not go to
`finalizeAppSub`:
1. Its carry, if it had one and it is unsettled, gives its results back as `SubOwed`. No failed attempt is counted and
   nothing is given up: the retry carries them.
2. Its thread gets the retry note (D17), which holds the error text. When it pauses instead, it gets the error
   note (`subErrorNote`) and then the pause note.
3. Its process is closed: perms denied, `s.ag` to `aft.close`, `closeStop`, `revokeExtra`, `s.bg` cleared.
4. **If an attempt is left:**
   - `s.retry = &retryWait{attempt: n, …}`;
   - `s.meta.Retry = Retry{Attempt: n, Of: 4, At: now+delay, Kind, Error}`;
   - `Waiting` and `BgWaiting` are cleared;
   - the timer is armed;
   - the attempt is logged.

   Its status stays `running`. So it counts against the cap, the subagents it started run on, results owed to it
   stay owed (its `deliverSub` needs a process and returns nil), and its parent is handed nothing.
5. **Else** it is paused (D9).

**The attempt:**
- **The timer fires.** It checks `s.retry == w`, running, not deleted, not shut down, and the chat not archived. Then
  `retryGate.enter`.
- **The slot is given.** `subRetryStart` sets `Retry.At` to now, builds `opts` (`Resume: true`, `SessionID:
  s.meta.Session`) and calls `startSub`.
- **`prepare` composes the message:**
  - the retry carry-on block (D15);
  - the results it is owed (`takeSubOwed`, as `deliverSub` takes them: marked sent, `s.carry` set);
  - the list of D14.

  It then sets `w.started`.
- **A `Spawn` error** is no temporary error: the subagent fails as a spawn that fails after start does
  (`finalizeAppSub(SubFailed, endFailed, "could not be started again: <err>")`).
- **A reply** is the first model output, or a clean turn end, of the new process (goal 2.4). It ends the retrying:
  `subRetryOK` logs it, leaves the gate, and sets `s.retry = nil` and `s.meta.Retry = Retry{}`. The next temporary
  error starts again at attempt 1.
- **A further temporary failure** comes back to `subTempFail` with `attempt+1`.

Reason: goal 2.6 says that a retrying subagent is running. Closing the process at once means no stale process lives
through the pause, and the new one reads the current login (goal 2.2).

**D9. Pause (goal 3.1–3.4).** `pauseSub(c, s, reason, kind, cause, out, aft)` (`retrysub.go`):
- `Status = SubPaused`, `Ended = now`, `Error = reason`, `ErrorKind = kind`, `Cause = cause`, `Retry = Retry{}`,
  `Waiting = BgWaiting = false`, `s.retry = nil`.
- It does what `endSub` does: open text closed, `Last` kept, permission cards closed, written and emitted.
- **Not `ended`**: no result is owed to its parent.
- **Not `stopBelow`**: what it started runs on.
- **Not `giveUpOrphans`** for it: what is owed to it stays owed (D10).
- Its thread gets the muted note of D17.
- Its parent is told (`tellPaused`, D10).
- Counts are emitted. The cap counts only `SubRunning`, so a paused one does not count.

Reason: the goal's "paused is not stopped": stopping stops what it started, pausing does not.

**D10. What a pause means for the agents around it** (`nested.go`):
- **Owed results kept (goal 3.3, 6.2).** `giveUpOrphans` skips a result whose parent is `SubPaused`. A result that
  becomes owed to a paused subagent stays owed, and its resume carries it.
- **Ending ends what is paused below.** `stopBelow` stops running *and paused* subagents below one that has ended
  (`endParent`): nobody is left to resume them.
- **A waiting parent is told.** `sub.listed map[string]bool` (in memory) holds the sids a message to that subagent
  has listed (D14). `unlisted(c, p)` gives p's children that are paused and not in `p.listed`.
  - `subWaits`: a clean turn end with unlisted paused children waits, as for owed results.
  - `deliverSub` starts a turn when results are owed **or** `unlisted` is not empty. Its message is the results block
    (if any) and then the list block (D14), and it records the listed sids. A delivery with no results has a carry
    with no `sids`.
  - `tellPaused(c, k, out, aft)` (called by D9 for the paused k): when k's parent p is a subagent that waits, has a
    process, no carry, **no running children and nothing owed**, it calls `deliverSub(c, p, out)` at once. Otherwise
    the news rides on p's next message. That is a delivery, a carry-on or a resume, all of which carry the list.
  - `waitOver`: a waiting p with no running children and nothing owed, but unlisted paused children, is handed them
    (`deliverSub`) instead of being finished.
- **pi's no-reply rule** (`handleSubEv`: a clean end on pi of a carrying turn with no model output fails the
  subagent) applies only when the carry holds results (`len(s.carry.sids) > 0`).
- The chat's own agent is never woken by a pause (goal 5.3: the person continues). Its next message, of the person or
  a delivery, carries the list.

Reason: a parent waiting only on a child that paused would otherwise wait forever, or finish without its work. It
cannot act on a pause while its other children still run, so one message tells it of both (goal 6.4: "is told that it
is paused").

**D11. Server stop and load (goal 3.6).**
- **`Shutdown`:**
  - before `stopAppSubs`, every running app subagent with `s.retry != nil` is paused (`CauseRetryingAtStop`, reason
    and kind from its retry), without `tellPaused` (no turn may start);
  - every other running one is stopped with the new ending `endShutdown` (`CauseShutdown`) instead of `endParent`;
  - the chat's own retry is cancelled (D16).
- **`loadSubs`** (a crash, with no `Shutdown`): a record that is `running` with a non-zero `Retry` is paused the same
  way. It is not cut, and it keeps `Session`, `Error` and `ErrorKind`. Every other running record is stopped as today,
  with `CauseRestart`.
- `giveUpOrphans` at load skips paused parents (D10), so what was owed to them is still owed.

Reason: a subagent that waited between attempts was not doing work that a stop loses. Paused is its true state.

**D12. The resume (goal 4).**
- **Tool:** `resume_subagent {sid}`, in `boardtools.SpawnFamily`. So it is offered exactly where `spawn_subagent` is:
  - Claude's allowed tools are built from that list;
  - Cursor uses `IsSpawnFamily`;
  - pi's `SPAWN_FAMILY_BARE` gets the name.

  `MaySpawn` gates it at the MCP endpoint.
- **Manager:** `ResumeSubagentBy(chatID, by, sid string) (model.Subagent, error)` (`resume.go`).
- **Refusals, in this order, each with its own sentence** (`%s` is the sid):

  | case | answer |
  |---|---|
  | unknown sid | `ErrNoSubagent` ("no such subagent") |
  | another's | `ErrNotStarterResume`: "that subagent was not started by you: resume_subagent resumes only the subagents you started yourself" |
  | native (`Kind == ""`) | "subagent %s was not started by the app: it cannot be resumed" |
  | copy | "subagent %s was not carried over into this chat: it cannot be resumed here" |
  | running, retrying | "subagent %s is running: it is being retried after a temporary error (attempt %d of %d); only a paused or stopped subagent can be resumed" |
  | running | "subagent %s is running: only a paused or stopped subagent can be resumed" |
  | completed, failed | "subagent %s has finished (%s): a finished subagent cannot be resumed; start a new one if more work is needed" |
  | no session | "subagent %s cannot be resumed: its session was not recorded (it was started before the app kept subagent sessions)" |

  The chat-wide refusals come first, as for `spawn_subagent`:
  - `ErrArchived`, `ErrLegacy`, `ErrShutdown`;
  - "the calling subagent has ended";
  - the cap: `*SubCapError{Cap, Running, Resume: true}`, whose text is "this chat's cap on running subagents is %d
    and %d are running, at every level: the subagent was not resumed and the resume is not queued. End your turn to
    wait for a result of a subagent you started, stop one of yours with stop_subagent, or resume it later."

  The depth needs no check: the level of a subagent is fixed, and its parent has the family.
- **Accepted, in one hold of the lock with the count of the cap:**
  - `prev := s.meta`;
  - `Status = running`, `Ended = 0`, `Delivery = ""`, `Error = ""`, `ErrorKind = ""`, `Cause = ""`, `Retry = {}`,
    `Waiting = false` (goal 4.5);
  - `s.app = true`, `s.listed = nil`;
  - written and emitted.

  Then, unlocked, `startSub` runs with `Resume: true`, the recorded `Session`, `Kind`, `Model` and `Effort`. Its
  `prepare` composes the resume carry-on block (D15), the results owed to it (`takeSubOwed`) and the list of its own
  children (D14, goal 4.6). Its receipt is "resumed subagent %s (running)", given once `Spawn` has returned, as
  `spawn_subagent`'s is.
- **A `Spawn` error** restores `prev` (and `s.app`), and is returned as "subagent %s could not be started again:
  <err>; it is %s as before". Nothing is lost by a failed resume.
- **Not started:** the subagents below that were stopped with it (goal 4.6). They are listed in its message.

Reason: the goal's limits and sentences. A failed start must not destroy the one thing a resume exists for.

**D13. `stop_subagent` on paused and stopped subagents.**
- `StopSubagentBy` accepts a **paused** subagent. It is stopped (`endStopTool`), what runs below it is stopped
  (`stopBelow`), and what was owed to it is given up (`giveUpOrphans`, as for any stopped subagent, goal 6.3).
- A subagent **stopped by anything but its parent's request** that is asked to stop again keeps its status. Its
  `Cause` becomes `CauseStopTool`, so it leaves the list. The answer is "stopped subagent %s" as always.
- The tool's description: "Cancel one running or paused subagent that you started, by sid. Every subagent it has
  started is cancelled with it. A subagent listed as stopped can be stopped again so that it is no longer listed."

Reason: goal 5.2 sends the list "for as long as it is not empty". Without a way to empty it, a parent that does not
want a subagent back would be told of it on every message.

**D14. The list of paused and stopped subagents (goal 5.1, 5.2).**
- **Who is listed.** `pausedOrStopped(c, parent)` gives the children of `parent` ("" for the chat's agent) that:
  - were started by the app (`Kind != ""`), are not `NotCarried`, and have a `Session`;
  - and are `SubPaused`, or `SubStopped` with `Cause` in {`person`, `parent`, `shutdown`, `restart`}.

  Ordered by `Ended`, then id. Not listed:
  - those stopped by request;
  - those whose stop already reached the parent as a result (`aborted`, `gone`: `endingNotifies`);
  - records from before (no `Cause`, no `Session`).
- **The block**, `pausedListBlock(subs, withMessage)`; what a subagent supplied is escaped (`xmlEscape`), and its
  error text is cut to 300 characters:
  ```
  <subagents-paused-or-stopped>
  This block was written by the app, not by the user. These subagents you started are paused or were stopped without your asking, and do not run: no result will come from them unless you resume them. To have one carry on in its own session where it stopped, call resume_subagent with its sid: it is then sent the results it is owed, and its result comes to you as usual. If you no longer need one, call stop_subagent with its sid and it is no longer listed.

  <subagent>
  <sid>4f0a1c2b9e7d</sid>
  <description>Lead: storage layer</description>
  <state>paused</state>
  <why>its turns failed with a temporary error and the app's 4 retries failed too (login failed: Failed to authenticate…)</why>
  </subagent>
  </subagents-paused-or-stopped>
  ```
  - With `withMessage` (the person's message), the first sentence is "This block was written by the app, not by the
    user; the user's message follows it."
  - `<description>` is left out when empty.
  - `<why>`, by status and cause:

    | status, cause | `<why>` |
    |---|---|
    | paused, `retries-failed` | "its turns failed with a temporary error and the app's 4 retries failed too (<label>: <error>)" |
    | paused, `retrying-at-stop` | "it was being retried after a temporary error when the server stopped (<label>: <error>)" |
    | stopped, `person` | "the user stopped the chat's agent while it ran" |
    | stopped, `parent` | "it was stopped together with the agent that started it" |
    | stopped, `shutdown`, `restart` | "the server stopped while it ran" |

    Labels: `login` "login failed", `rate_limit` "rate limited", `overloaded` "overloaded", `server_error` "server
    error", anything else "temporary error".
- **Where it goes**, when not empty, as the last block before the person's text and images, or as the last block of
  an app message:
  - the person's message to the chat's agent (`sendOn`, after the results block);
  - an app delivery to the chat's agent (`deliver`);
  - a delivery or notice to a subagent (`deliverSub`);
  - every carry-on message (retry of either, resume).

  A subagent's first prompt has none. When the list is empty nothing is added: every message is **byte for byte what
  it was** (goal 5.1, scenario 11).
- The app never acts on the list (goal 5.3).

Reason: one selector and one text for every reader, so "continue" reaches every level the same way.

**D15. The carry-on blocks** (`retry.go`, tag `carry-on`, reason escaped and cut to 500 characters):
- **retry:**
  ```
  <carry-on>
  This message was written by the app, not by the user. Your last turn ended with a temporary error (<label>: <error>). The app has started you again in the same session: carry on with your task where you stopped.
  </carry-on>
  ```
- **resume of a paused subagent:** the middle sentence becomes "You were paused: your turns failed with a temporary
  error (<label>: <error>) and the app's retries failed too. The agent that started you has resumed you in the same
  session: carry on with your task where you stopped."
- **resume of a stopped subagent:** "You were stopped (<why of D14>). The agent that started you has resumed you in
  the same session: carry on with your task where you stopped."

The results block and the list follow, in that order. A chat's retry message starts with its board context, as
`deliver`'s does.

**D16. The main agent's retry (goal 2.7, 2.8, 3.5)** (`retrychat.go`, `pump`, `sendOn`, `InterruptOf`, `stopLocked`,
`Shutdown`):
- **The failure.** A temporary `EvTurnEnd` (D1) with an attempt left:
  - it is applied to the thread as a clean end: no generic error note; the end mark is added and the turn is counted;
  - `TurnActive` **stays true**: the turn goes on across the attempts;
  - `chatTempFail`:
    - puts an unsettled carry's results back as owed, with no failed attempt and **no hold**;
    - adds the error-tone retry note (D17);
    - sets the status `StatusRetrying` and `c.retry`, and arms the timer;
    - closes the process (`dropProcess`);
    - does not call `turnOver`, so no hold is set.
  - The chat's leads keep running, and their results stay owed: `deliverable` needs a process.
- **Shown as working (goal 2.7).**
  - `pubOf(StatusRetrying) = pubWorking`, so it counts in `working` and in the cap on running turns: its slot is held
    through the pause, and the retry is not admitted again.
  - `view` sets `ChatView.Retry` from `c.retry`.
  - `busy(c)` is **false** for retrying (Send is taken), and so is `inTurn`.
- **The attempt.**
  - Timer, then `retryGate.enter`, then `chatRetryStart`.
  - The checks are those of D8, and `c.ag == nil`.
  - `m.spawn(c, out)` resumes the session. A spawn error shows as today (`spawnFailed`), clears the retry, sets
    `TurnActive = false`, and holds.
  - The message: board context, the carry-on block, the results owed (`carryOwed(c, false)`) and the list.
  - Status thinking, `c.carry` set, `sentGen` set; `ag.Send` on a goroutine counted in `m.handoffs`.
  - A refused Send ends retrying as `refused` does: error note, ready, hold.
- **The reply.** `pump` clears `c.retry` (`chatRetryOK`) at the first model output or clean turn end of a retry's
  process.
- **The last attempt fails** (goal 3.5): the turn end is applied as today (error note, ready, `turnOver` holds; the
  process stays as after any error). Then the muted note "The app tried again 4 times without success. Your next
  message starts the agent again in the same session." is added, `c.retry` is cleared, and it is logged.
- **The person's message between attempts (goal 2.8).** `sendOn` cancels `c.retry` once the message has passed every
  refusal (after `reserveTurn`). The message then starts the session in a new process through `spawn`, as after any
  closed process, and carries the owed results and the list. No carry-on block is added: the person's text is the
  turn.
- **Stop and Interrupt (goal 2.8).**
  - `InterruptOf` and `stopLocked` cancel `c.retry`, add "Stopped.", set the status ready and `TurnActive = false`, and
    hold.
  - The subagents' retries end because those calls stop every running app subagent (`stopSub` cancels a subagent's
    retry, D8). Paused subagents stay paused: they have no retry to cancel.
- **`EvExit`** of a retry's process cancels `c.retry`.
- **`Shutdown`** cancels the timer and the ticket. `TurnActive` stays true, so the next load shows "Stopped: the app
  was closed while the agent was working.", and the person's message resumes.

Reason: a retrying chat must show as working and still take the person's message. `waiting` (busy) would refuse it,
and `ready` would not show it working, so it is a status of its own.

**D17. Notes and the log (goal 2.7, 2.9).**
- **The retry note** (error tone), in the thread of whoever failed: "<Label>: <error>. Trying again in about <wait>
  (attempt <n> of 4)."
  - `<Label>` is D14's label capitalised.
  - `<wait>` is "N s" below a minute (rounded up), else "N min" (rounded up).
- **A subagent pauses:** its thread gets the muted note "Paused: the app tried again 4 times without success. The
  agent that started this subagent can resume it."
- **The log**, through `m.retryLog func(string)` (default `log.Print`; tests capture it). The lines are below, with
  `<sub>` "-" for the chat's agent and the error `%q`-quoted and cut to 300 characters:
  ```
  chats: retry <chat> sub=<sub> attempt <n>/4 in <wait> (<kind>): "<error>"
  chats: retry <chat> sub=<sub> attempt <n>/4 starts
  chats: retry <chat> sub=<sub> attempt <n>/4 answered
  chats: retry <chat> sub=<sub> attempt <n>/4 could not start: <err>
  chats: retry <chat> sub=<sub> paused after 4 attempts (<kind>): "<error>"
  chats: retry <chat> sub=- gave up after 4 attempts (<kind>): "<error>"
  chats: retry <chat> sub=<sub> cancelled: <why>
  ```
  `<why>` is one of "stopped", "a message of the user", "the process ended", "shutdown".

**D18. The clients (goal 5.4, scenario 12).** `packages/core/src/logic/retry.ts` (new):
- `retryLine(r, now)`:
  - "Retrying in <wait> · <attempt> of <of>" while `r.at > now` (`<wait>` as in D17: "40 s", "3 min");
  - else "Retrying · <attempt> of <of>".
- `kindLabel(kind)`: the labels of D14.
- `pausedLine(sa)`: "Paused · <kindLabel(sa.errorKind)>".

Where they are used:
- **The subagent row** (`subLine`):
  - paused: the paused line, tone `error`;
  - running with a `retry.attempt`: the retry line, tone `muted`;
  - an unknown status: its raw word, as today.
- **The chat:**
  - `statusText` "retrying" → `retryLine`;
  - `rowLine` shows it;
  - `dotState` maps it to `thinking`;
  - `composerControls`: `stop` and `esc` are true while retrying, `blocked` stays false.
- **Ticking.** The header, the row and the drawer re-render every second while retrying (`useNow`).
- No new button, banner or screen.

Reason: the goal's two sentences, in the rows and status line that exist.

**D19. Test support.**
- `agenttest.Turn.FailTemp(kind agent.Temporary, text string)`.
- The Node stand-in's `[[apierror CLASS N]]` with `FAKE_CLAUDE_STATE=<dir>`. It writes the CLI's real lines: status
  requesting, one `api_retry`, the api-error assistant line, the errored result with `terminal_reason: "api_error"`.
  It does so for N turns of that **session**, across processes, so a retry's resumed process fails again.
- Every timed test lowers the waits through `m.retryWaits`, `m.retryJitter`, the gate's fields, or
  `AIWB_TEST_WAITS=retry=…`.
- No test calls a paid model.

**D20. Documents.**
- `docs/architecture.md`, Server bullet, after the background-work sentences:
  - retry on temporary errors;
  - the paused status;
  - `resume_subagent`;
  - the list on messages;
  - sessions recorded;
  - `retrying`.
- `AGENTS.md`: `retry` joins the names of `AIWB_TEST_WAITS`.
- `plans/deviations/r1.md`: D3.

**D21. Out of the design on purpose:**
- the CLI's own retries inside a turn (`api_retry`) are left as they are;
- no refreshing of the token;
- no resume by the app;
- no change to Claude's steering: the block and the tool's description explain themselves;
- nothing for native subagents;
- no feature-level bump.

## 2. Sequences

```
lead L (running, chunk K running)
  turn ends: Error "Failed to authenticate…", Temporary login
    → L running, Retry{1/4, at now+20s}; L's process closed; K runs; nothing to main
  K finishes meanwhile → K's result owed to L (deliverSub: L has no process → stays owed)
  timer → gate slot → startSub(L, Resume, Session) ; message: carry-on + K's result + list
  L's new process writes text → retry over (Retry cleared, slot freed)
  L ends cleanly, no kids running, nothing owed → L completed → its result owed to main, once

…or four more failures → L paused (Error, ErrorKind login, Cause retries-failed); K runs; main not woken
person: "continue" → main's message carries <subagents-paused-or-stopped> listing L
main calls resume_subagent L → L running, startSub(Resume) ; message: resume carry-on + owed results + L's own list
```

## 3. Risks and open points

- **R1: the CLI retries too.** A login failure already takes about 3 minutes of the CLI's own retries per attempt
  (the fixture). Five attempts and the app's pauses take about 12 minutes plus five times the CLI's time before a
  pause. That is accepted: the goal sets the app's schedule, not the CLI's.
- **R2 `[not verified]`: "Not logged in" and a lost connection** are assumed to reach the stream as api-error lines
  (D2's sources). If the CLI instead exits, the exit is no temporary error and behaves as today. A paid check is the
  confirmation (see `chunks.md`, after the last merge).
- **R3: a retry closes background work.** A Claude agent whose turn fails while its background commands run loses
  them when its process is closed (D8, D16). It is told to carry on and can start them again.
- **R4: the list may be long-lived.** Subagents the person stopped stay listed on the chat agent's messages until it
  resumes or stops them again (D13). That is what goal 5.2 asks.
- **R5: a resumed subagent's result row.** The thread keeps one result row per subagent (`AddSubResult` is per sid).
  After a resume, the row shows the newest record, which is what it shows of any change.
