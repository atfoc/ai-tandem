# Prototype: Claude subscription usage (5h + weekly)

**Question:** Can we get Claude subscription usage info programmatically: 5-hour usage and reset time, and weekly usage and reset time?

**Mode:** without a human in the loop

**Branch / worktree:** `claude-subscription-usage` at `../claude-subscription-usage` (commit `03a0a3a`)

## What was tried

1. Reading the Claude Code OAuth token from the macOS keychain so we could call the usage endpoint directly. This was **not attempted**: the sandbox blocked credential access. That path is unverified.
2. Ran `claude -p "..." --output-format stream-json --verbose` and looked at the raw stdout. It contains a `rate_limit_event` line with both windows. **Works.**
3. Wrote `claude.ParseRateLimitEvent` (`internal/claude/ratelimit.go`) and a unit test using the real captured line. **Passes.**
4. Wrote `cmd/usage-probe`, which keeps one `claude -p` process open in the app's stream-json input mode, sends N turns and prints every rate-limit event. **Works.** One event per process, not one per turn.
5. Raw check: 3 turns piped into one process gave 1 `rate_limit_event` and 3 `result` lines. This confirms the once-per-process behaviour.

## Answer

**Yes.** Claude Code (2.1.281) reports both windows in its stream-json output. The app already runs `claude -p` with stream-json, so the data is already reaching us: `translate.go` currently drops the `rate_limit_event` line.

The raw line, captured on 2026-09-26:

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed",
  "resetsAt":1790464200,"rateLimitType":"five_hour",
  "overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,
  "unifiedWindows":{
    "five_hour":{"utilization":0.03,"resetsAt":1790464200},
    "seven_day":{"utilization":0.18,"resetsAt":1790614800}
  }},
 "uuid":"...","session_id":"..."}
```

- **5h usage:** `rate_limit_info.unifiedWindows.five_hour.utilization` (0–1)
- **5h reset:** `rate_limit_info.unifiedWindows.five_hour.resetsAt` (unix seconds)
- **Weekly usage:** `rate_limit_info.unifiedWindows.seven_day.utilization` (0–1)
- **Weekly reset:** `rate_limit_info.unifiedWindows.seven_day.resetsAt` (unix seconds)
- `status` is `allowed`, `allowed_warning` or `rejected`. The top-level `rateLimitType` and `resetsAt` name the window that is currently binding.

Probe output (`go run ./cmd/usage-probe -turns 3`):

```
turn 1 rate_limit_event: status=allowed overage=false
  5h: 4% used, resets Sun, 27 Sep 2026 01:10:00 CEST (in 4h27m0s)
  7d: 18% used, resets Mon, 28 Sep 2026 19:00:00 CEST (in 46h17m0s)
turns=3 rate_limit_events=1
```

## What the docs say (checked 2026-09-26)

- **Python Agent SDK, `RateLimitEvent`:** "Emitted when rate limit status changes (for example, from `"allowed"` to `"allowed_warning"`)." So the trigger is a **status** change, not a change in the utilization number. This matches the one-event-per-process result above.
- **TypeScript Agent SDK, `SDKRateLimitEvent`:** "Emitted when the session encounters a rate limit." The typed fields are only `status`, `resetsAt` and `utilization`.
- **Neither SDK documents `unifiedWindows`.** It is an undocumented field in the CLI output. In Python it is reachable only through `RateLimitInfo.raw`.
- **Issue [anthropics/claude-code#50518](https://github.com/anthropics/claude-code/issues/50518)** asked for per-window utilization to be exposed to headless SDK users. It was closed as stale ("not planned") with no maintainer reply. `unifiedWindows` looks like it arrived later without being documented.
- **Status line docs** document `rate_limits.five_hour` / `rate_limits.seven_day` (`used_percentage`, `resets_at`) as stable fields. That input only exists in the interactive TUI, not in `claude -p`.

## Follow-up finding: `/usage` as a prompt is free

The TypeScript docs say that sending `/context` or `/usage` as a prompt returns its output as an assistant message, and that local commands like `/usage` "bypass the query loop". Tested:

```sh
claude -p "/usage" --output-format stream-json --verbose --no-session-persistence
```

Result: one `assistant` message with `"model":"<synthetic>"`, all token counts 0, `num_turns: 0`, `total_cost_usd: 0`, and **no** `rate_limit_event`. The text contains:

```
Current session: 7% used · resets Sep 27 at 1:10am (Europe/Belgrade)
Current week (all models): 18% used · resets Sep 28 at 7pm (Europe/Belgrade)
Current week (Fable): 2% used · resets Sep 28 at 7pm (Europe/Belgrade)
```

So you can poll usage **without spending quota**. The catch: it is human-readable text in local time with no year and minute-level resets, so we would have to parse it with a regex. It also includes a per-model weekly window that the event does not have.

**Two ways to get it:**

1. **Inside running chats:** read `unifiedWindows` from `rate_limit_event`. It is free, but it only arrives at process start and on status changes.
2. **To refresh on demand:** run `claude -p "/usage"` and parse the text. It is free, but the text format is fragile.

## Caveats

- **Once per process.** A long-lived `claude -p` process emitted the event on its first turn only, not on later turns. The docs say it is re-sent when the *status* changes (allowed → allowed_warning → rejected), not when utilization changes. A fresh process always emits one.
- **Standalone checks.** Use `claude -p "/usage"`, which is free (see above), rather than a real turn.
- **Not an official API.** This is Claude Code's internal stream-json shape. `unifiedWindows` is newer than the old shape, which the existing test fixture still uses (only `status` and `rateLimitType`). The parser returns no windows for old-shape events and does not fail.
- **Only for subscription logins.** Only checked on a subscription login. With an API key, the event probably does not appear or has no `unifiedWindows`; this was not tested.
- **Direct endpoint not tried.** Calling an OAuth usage endpoint with the stored token was not tried (credential access was blocked). The stream-json route avoids handling tokens at all.

## How to run

```sh
cd ../claude-subscription-usage
go test ./internal/claude/ -run RateLimit -v
go run ./cmd/usage-probe -turns 3   # optional: -model haiku
```

## Follow-up finding: `/usage` also has structured limits

Checked 2026-09-26 with Claude Code 2.1.281. The `assistant` line of `claude -p "/usage"` also
carries `usage_report.rate_limits.limits[]`, so the text does not have to be parsed:

```json
{"kind":"session","group":"session","percent":8,"resets_at":"2026-09-26T23:09:59.571846+00:00","scope":null,"severity":"normal","is_active":false}
{"kind":"weekly_all","group":"weekly","percent":18,"resets_at":"2026-09-28T16:59:59.571867+00:00","scope":null,"severity":"normal","is_active":true}
{"kind":"weekly_scoped","group":"weekly","percent":2,"resets_at":"2026-09-28T16:59:59.572063+00:00","scope":{"model":{"display_name":"Fable"},"surface":null},"severity":"normal","is_active":false}
```

It also has `extra_usage` (`is_enabled`, `monthly_limit`, `used_credits`, `utilization`,
`currency`). The app uses `rate_limits` and reads the text only when it is missing
(`internal/claude/usage.go`, spec section 4.5).
