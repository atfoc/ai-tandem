# cursor-effort-load: `session/load` with the parameterized model picker

- **Question:** With `clientCapabilities._meta.parameterizedModelPicker: true`, does
  `session/load` (resuming an existing session in a **new** `agent acp` process) work, and does the
  app's policy (set model → `thinking=true` → largest `context` → the user's effort) apply correctly
  on the resumed session? What does load report before the policy is re-applied, whose model does it
  restore, and does the conversation history survive?
- **Mode:** without a human in the loop.
- **Branch / worktree:** `cursor-effort-load` at `.worktrees/cursor-effort-load` (branched from
  `cursor-effort`, reusing `cmd/acpprobe`; new file `cmd/acpprobe/effortload.go`).

## Answer

**`session/load` works with the flag, and the policy works on the resumed session. But load does
not bring back the session's own model or parameters. It reports and runs with the process-wide
*last-used* selection from `cli-config.json` (`selectedModel` + that model's `modelParameters`),
which is whatever the most recent `agent acp` process sharing that config dir set.** So the app
must re-apply the full policy (model, thinking, context, effort) after every `session/load` and
before the first prompt. Once it does, everything is correct.

1. **Load succeeds.** It took about 2 s and returned `modes`, `models` and `configOptions` in the
   same parameterized shape as `session/new`: a bare model name, plus `thinking` / `context` /
   the effort option (`effort`, `reasoning`) / `fast` for the model it reports. It also replays the
   history as `session/update` (`user_message_chunk`, `agent_message_chunk`) before the response.
   **The model and values it reports are the process-wide last-used ones, not the session's.**
2. **The policy after load succeeds on all 6 models tested.** Every `set_config_option` came back
   with `currentValue` equal to what was asked (`MATCH`), and "Reply with exactly: pong" ended with
   `end_turn` → `pong` on every one.
3. **The resumed session really uses the settings.** The store's `max_tokens` after the re-applied
   turns was 1 000 000 for claude-opus-5-5, claude-sonnet-5 and gpt-5.6-sol, 922 000 for gpt-5.4
   (at `1m`, as in the earlier research), and 200 000 for gemini-3.1-pro and claude-sonnet-4
   (fixed windows). Effort really applies after load: the same hard prompt on a loaded session gave
   claude-opus-5-5 `low` 369 thought chunks / 58 s against `max` 1 283 / 158 s, and gpt-5.4-mini
   `none` 0 chunks / 2 s (wrong answer 428) against `xhigh` 862 chunks / 15 s. `thinking=true`
   applies too: claude-sonnet-4 produced 0 thought chunks while it was stale at `thinking=false`,
   and 10–12 once the policy set it to `true`.
4. **Gotcha confirmed.** Load reports the last-used state, and the first turn *runs* with it:
   - When another process had switched to `gpt-5.4-mini` afterwards, load reported
     `model=gpt-5.4-mini reasoning=medium` for a session created on claude-opus-5-5, claude-sonnet-5,
     gpt-5.4, gpt-5.6-sol, gemini-3.1-pro or claude-sonnet-4. A turn sent without re-applying ran
     with a window of 272 000 tokens (gpt-5.4-mini's), so it really ran on the wrong model.
   - When another process only changed the same model's parameters, load reported them: for
     example claude-sonnet-5 `thinking=false context=300k effort=max`, and gpt-5.4
     `context=272k reasoning=extra-high`. The un-reapplied turn ran with a window of 300 000 /
     272 000, and gpt-5.4 produced 89 thought chunks for "pong" at the stale `extra-high`.
   - Setting `model` to the session's model brings back that model's stale last-used parameters,
     not the session's, as already seen for `session/new`. Re-applying thinking, context and effort
     fixes it every time: `MATCH`, and `max_tokens` back at the largest window.
   - With no other process in between, load reported the session's own settings, but only because
     they were still the last-used ones.
5. **The history survives.** On every model, in both interference modes, the resumed session
   answered the codeword it was given before the reload (for example `zebra-claude-opus-5-5`).
   This held even after switching to a different model on load, and when the first turn after load
   ran on a different model.

**Integration plan: no change to the order**, but the policy step is mandatory, not an
optimisation: initialize (flag) → authenticate → `session/load` → `cursor/list_available_models`
→ set `model` (always, even when load already reports the right model) → `thinking=true` →
largest `context` → effort, then prompt. Take the model and effort to set from the app's own
chat record, never from what `session/load` reports. The `configOptions` in the load response
cannot be used to learn what the chat was using.

## Evidence

All runs used a scratch `CURSOR_CONFIG_DIR` per run, seeded from `~/.cursor/cli-config.json`
(`/tmp/effload/cfg-<run>`). Parallel runs each had their own config dir, so they did not share
last-used state.

`effortload` for each model M: process **A** creates the session, applies the policy with a
non-default effort E1, and says "Remember this codeword for later: zebra-M. Reply with exactly: ok".
Process **C** (the interferer, `-interf`) opens its own session, sets M with `thinking=false`,
the smallest context and a different effort E2, and with `switch` then selects `gpt-5.4-mini`.
Process **B** is fresh. It runs initialize(flag) → authenticate → `session/load` and prints the
load's `configOptions`. Then it runs **turn0** "pong" without re-applying anything, and reads
`max_tokens`. Then `list_available_models` → set M (it prints the stale options) → policy (E1) →
**turn1** "What was the codeword…?" → **turn2** "pong", reading `max_tokens` after each.

```
bin/acpprobe -cfg /tmp/effload/cfg-sw   -work /tmp/effload/sw   -s effortload -interf switch \
  -only claude-opus-5-5,claude-sonnet-5,claude-sonnet-4,gpt-5.4,gpt-5.6-sol,gemini-3.1-pro
bin/acpprobe -cfg /tmp/effload/cfg-stay -work /tmp/effload/stay -s effortload -interf stay \
  -only claude-opus-5-5,claude-sonnet-5,claude-sonnet-4,gpt-5.4,gemini-3.1-pro
bin/acpprobe -cfg /tmp/effload/cfg-none -work /tmp/effload/none -s effortload -interf none \
  -only claude-opus-5-5,gpt-5.4
bin/acpprobe -cfg /tmp/effload/cfg-cmpo -work /tmp/effload/cmpo -s effortloadcmp -only claude-opus-5-5
bin/acpprobe -cfg /tmp/effload/cfg-cmpg -work /tmp/effload/cmpg -s effortloadcmp -only gpt-5.4-mini
```

**`-interf switch`** (the interferer ends on gpt-5.4-mini):

| Model | A policy → max_tokens | Load reports | turn0 (no re-apply) max_tokens | Set M reports (stale) | Policy after load | turn1 codeword / max_tokens |
|---|---|---|---|---|---|---|
| claude-opus-5-5 | context=1m effort=low → 1 000 000 | model=gpt-5.4-mini reasoning=medium | 272 000 | context=300k effort=max | MATCH | ✓ / 1 000 000 |
| claude-sonnet-5 | thinking=true context=1m effort=low → 1 000 000 | gpt-5.4-mini | 272 000 | thinking=false context=300k effort=max | MATCH | ✓ / 1 000 000 |
| gpt-5.6-sol | context=1m reasoning=none → 1 000 000 | gpt-5.4-mini | 272 000 (82 thought chunks) | context=272k reasoning=max | MATCH | ✓ / 1 000 000 |
| gpt-5.4 | context=1m reasoning=none → 922 000 | gpt-5.4-mini | 272 000 | context=272k reasoning=extra-high | MATCH | ✓ / 922 000 |
| gemini-3.1-pro | (no options) → 200 000 | gpt-5.4-mini | 272 000 | model=gemini-3.1-pro | MATCH | ✓ / 200 000 |
| claude-sonnet-4 | thinking=true → 200 000 | gpt-5.4-mini | 272 000 | thinking=false | MATCH | ✓ (12 thought chunks) / 200 000 |

turn2 "pong" → `end_turn` "pong" on all of them.

**`-interf stay`** (the interferer changes M's parameters but leaves M selected):

| Model | Load reports | turn0 (no re-apply) | After the policy |
|---|---|---|---|
| claude-opus-5-5 | context=300k effort=max | max_tokens 300 000 | MATCH, codeword ✓, 1 000 000 |
| claude-sonnet-5 | thinking=false context=300k effort=max | 300 000 | MATCH, ✓, 1 000 000 |
| gpt-5.4 | context=272k reasoning=extra-high | 272 000, **89 thought chunks for "pong"** | MATCH, ✓, 0 thought chunks, 922 000 |
| gemini-3.1-pro | model=gemini-3.1-pro | 200 000 | MATCH, ✓ |
| claude-sonnet-4 | thinking=false | 0 thought chunks | MATCH, ✓, **10 thought chunks** |

**`-interf none`**: load reported exactly what A had set (`claude-opus-5-5 context=1m effort=low`,
`gpt-5.4 context=1m reasoning=none`), and turn0 already ran at 1 000 000 / 922 000.

**`effortloadcmp`**: A creates two sessions at the default effort. Each one is loaded in its own
fresh process, set to the lowest or highest level, and given the hard counting prompt (the answer
is 378):

| Model / level (after load) | Load reported | Answer | Thought chunks / chars | Time | max_tokens |
|---|---|---|---|---|---|
| claude-opus-5-5 `effort=low` | effort=medium | 378 ✓ | 369 / 3 578 | 58 s | 1 000 000 |
| claude-opus-5-5 `effort=max` | effort=**low** (the previous process's choice) | 378 ✓ | 1 283 / 13 705 | 158 s | 1 000 000 |
| gpt-5.4-mini `reasoning=none` | reasoning=medium | 428 ✗ | 0 / 0 | 2 s | 272 000 |
| gpt-5.4-mini `reasoning=xhigh` | reasoning=**none** (the previous process's choice) | 381 ✗ | 862 / 4 046 | 15 s | 272 000 |

`session/load` result (abridged, claude-opus-5-5 session after the `switch` interferer):
`{"modes":{…},"models":{"currentModelId":"gpt-5.4-mini",…},"configOptions":[mode, model=gpt-5.4-mini, reasoning=medium]}`.
Before the result, the history was replayed as a `user_message_chunk` and an `agent_message_chunk`.

## What was tried

1. `effortload` / `effortloadcmp` in `cmd/acpprobe/effortload.go` (commit on `cursor-effort-load`):
   the A / C / B process flow above, with `-interf switch|stay|none`.
2. First a single run on claude-opus-5-5 with `switch` (`/tmp/effload/w1`, sharing
   `/tmp/effload/cfg`). It showed the load reporting gpt-5.4-mini, and the 5-model matrix followed.

## Gotchas

- **`session/load` does not restore the session's model or parameters.** It uses the process-wide
  `selectedModel` and `modelParameters` from `cli-config.json`, as of process start. All the app's
  chat processes share one `CURSOR_CONFIG_DIR`, so the last chat that changed its model or effort
  decides what a resumed chat would run with. Always re-apply the policy from the app's own stored
  chat settings before the first prompt after a load.
- **Do not trust load's `configOptions` for the UI.** They show last-used values, not the chat's.
  Show the chat's stored model and effort, and use the `configOptions` from the final
  `set_config_option` response to confirm them.
- **Set `model` even when load already reports the right model.** Setting it again is cheap. It
  still returns that model's last-used parameters, so thinking, context and effort must be set after
  it every time.
- Every process writes last-used values back to the shared `cli-config.json`, including the
  `thinking=false` / small context set by any process. Always applying the policy makes this
  harmless. A process that skips the policy would leave stale values behind for the others.
- The history replay (`session/update` chunks) arrives *before* the `session/load` response. The
  app should ignore it or route it, since it already has the chat transcript.
- Not tested: loading a session concurrently in two live processes, and `fast`.
