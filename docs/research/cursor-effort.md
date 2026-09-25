# cursor-effort: setting the reasoning level (effort) per model over `agent acp`

- **Question:** How does an ACP client set the reasoning level (effort) of the model in the Cursor
  agent (`cursor-agent` v2026.09.23-86fc751, `agent acp`)? Which effort levels does each model
  support, and does ACP really apply them? Also: how to **always select the largest context
  size**, and how to **keep thinking always on**. It is settled when a real chat runs with the chosen
  settings for every model.
- **Mode:** without a human in the loop.
- **Branch / worktree:** `cursor-effort` at `.worktrees/cursor-effort` (branched from
  `cursor-acp-context-usage`, reusing `cmd/acpprobe`).

## Answer

**Yes, ACP handles it, but only when the client opts in to Cursor's *parameterized model picker*.**
Send this in `initialize`:

```json
"clientCapabilities": { "fs": {...}, "terminal": false,
                        "_meta": { "parameterizedModelPicker": true } }
```

With the flag on:

- The `model` config option takes a **bare model name**, such as `claude-opus-5-5` or
  `gpt-5.4-mini`.
- Every parameter of the current model becomes its **own config option** in the `configOptions`
  of `session/new` and of every `session/set_config_option` response. Effort-like options have
  `category: "thought_level"`. The others (`context`, `fast`, `optimize_for`) have
  `category: "model_config"`.
- You set the effort with the same call used for the model, using the option's own id:

```json
{"method":"session/set_config_option","params":{"sessionId":"…","configId":"model","value":"claude-opus-5-5"}}
{"method":"session/set_config_option","params":{"sessionId":"…","configId":"effort","value":"max"}}
```

  The response returns the full `configOptions` with the new `currentValue`. An invalid value is
  rejected with `-32602 Invalid value for effort: …`.
- `cursor/list_available_models` (the extension method) returns every model with all of its
  parameter options and their defaults, so the app can build the whole picker from one call without
  switching models.

**The app's policy: always the largest context and thinking always on.** After every `model` set,
before choosing the effort, go through the `configOptions` that come back and:

- **`thinking`** (only on the Claude models; it is `thought_level`, values `false`/`true`): set it
  to `"true"`. It exists on 11 models. Its default is `true` on all of them except
  `claude-sonnet-4`, where it is `false`. So setting it explicitly matters, and the app should never
  show it as a user control.
- **`context`** (`model_config`, values like `200k`, `272k`, `300k`, `1m`): set it to the
  value with the biggest size. Parse the number and its `k`/`m` suffix; do not rely on the list
  order. It exists on 11 models, and today the largest is always `1m`. Models without a `context`
  option have a fixed window, so there is nothing to set.
- Then set the effort option the user picked. If a model has both `thinking` and `effort`, they
  work together: `thinking=true` plus any `effort` level was accepted and ran.

```
set model=M → for o in configOptions:
    o.id == "thinking"                   → set "true"
    o.id == "context"                    → set argmax(size(value))
    o.category == "thought_level", id != "thinking" → set the user's effort
```

This has to be done **on every model switch**, because the agent brings back that model's
last-used parameters, not its defaults (see Gotchas).

**The option id is not the same for every model.** It is `reasoning` (GPT, Kimi, GLM),
`effort` (Claude, Grok 4.5/4.6, Gemini 3.6/3.7) or `reasoning_effort` (Grok 4.7, Gemini 3.8).
Pick it by `category == "thought_level"`, never by name. Newer Claude models have **two**
`thought_level` options: `thinking` (on/off) and `effort` (a level).

**Without the flag (the default, "variants" picker)** you cannot choose the effort. The `model`
option lists one pre-built variant per model, such as `gpt-5.4-mini[reasoning=medium]` or
`claude-opus-5-5[context=300k,effort=medium,fast=false]`, which is each model's default. Any other
bracket string is rejected (the `cursor-rpc` prototype saw this with `gpt-5.4-mini[reasoning=low]`).

## Effort levels per model

From `cursor/list_available_models` (37 models; **bold** = default). Every row was set and
read back over ACP (see Evidence).

The app sets `thinking` → **true** and `context` → **1m** (the largest) wherever they appear.
The user picks only from the Levels column.

| Model | Option id | Levels | Other params |
|---|---|---|---|
| claude-opus-5-5 | `effort` | low, **medium**, high, xhigh, max | context 300k/1m, fast |
| claude-opus-5 | `thinking` + `effort` | thinking false/**true**; effort low, medium, **high**, xhigh, max | context, fast |
| claude-opus-4-8 | `thinking` + `effort` | thinking false/**true**; effort low, medium, **high**, xhigh, max | context, fast |
| claude-opus-4-7 | `thinking` + `effort` | thinking false/**true**; effort low, medium, high, **xhigh**, max | context, fast |
| claude-opus-4-6 | `thinking` + `effort` | thinking false/**true**; effort low, medium, **high**, max | context 200k/1m |
| claude-sonnet-5 | `thinking` + `effort` | thinking false/**true**; effort low, medium, **high**, xhigh, max | context |
| claude-sonnet-4-6 | `thinking` + `effort` | thinking false/**true**; effort low, **medium**, high, max | context |
| claude-opus-4-5, claude-sonnet-4-5, claude-haiku-4-5 | `thinking` | false, **true** | — |
| claude-sonnet-4 | `thinking` | **false**, true | — |
| gpt-5.6-sol / -terra / -luna | `reasoning` | none, low, **medium**, high, xhigh, max | context 272k/1m, fast |
| gpt-5.5, gpt-5.4 | `reasoning` | none, low, **medium**, high, extra-high | context 272k/1m, fast |
| gpt-5.4-mini, gpt-5.4-nano | `reasoning` | none, low, **medium**, high, xhigh | — |
| gpt-5.3-codex, gpt-5.2 | `reasoning` | low, **medium**, high, extra-high | fast |
| gpt-5.1 | `reasoning` | low, **medium**, high | — |
| grok-4.7 | `reasoning_effort` | low, medium, high, **xhigh** | fast |
| grok-4.6 | `effort` | low, medium, high, **xhigh** | fast |
| grok-4.5 | `effort` | low, medium, **high** | fast |
| gemini-3.8-flash | `reasoning_effort` | low, medium, **high** | — |
| gemini-3.7-flash | `effort` | low, medium, **high** | — |
| gemini-3.6-flash | `effort` | minimal, low, medium, **high** | — |
| kimi-k3 | `reasoning` | low, high, **max** | — |
| glm-5.2 | `reasoning` | **high**, max | — |
| gemini-3.1-pro, gemini-3.5-flash, gemini-3-flash, gemini-2.5-flash, gpt-5-mini, kimi-k2.7-code, composer-2.5 | — | no effort setting | composer: fast |
| auto-smart | — | no effort; `optimize_for` intelligence/**balanced**/cost | — |

The labels are not consistent: GPT-5.5/5.4/5.3/5.2 use `extra-high`, while GPT-5.4-mini/nano,
GPT-5.6, Claude and Grok use `xhigh`. Always send the `value` from the list, and show its `name`
(for example "Extra High").

## Evidence

All runs used `CURSOR_CONFIG_DIR=<scratch dir>`, seeded from the user's `cli-config.json`.

1. **`bin/acpprobe -s effortlist`**: `initialize` with the flag, then `session/new` (which now
   shows `reasoning(thought_level)=medium[none low medium high xhigh]` next to
   `model=gpt-5.4-mini`), then `cursor/list_available_models`. That produced the table above.
2. **`bin/acpprobe -s effortset`**: for each of the 37 models, set `model` and then every value of
   every `thought_level` option. Each response was checked for `currentValue == value` and for the
   model staying the same. **`TOTAL ok=128 fail=0`**. `bogus-level` was rejected for every option
   with `-32602 Invalid params`.
3. **`bin/acpprobe -s effortchat`**: one session, and for each model: set the model, set a
   *non-default* effort (the first level that is not the default, such as `effort:low`,
   `reasoning:none`, `thinking:false` or `glm reasoning:max`), then run a real turn,
   "Reply with exactly: pong". **All 37 models answered `pong` with `stopReason=end_turn`**, in
   1.6–4.3 s each. (auto-smart reported "Auto routed to Grok 4.6".)
4. **`bin/acpprobe -s effortcmp -only <m>`**: the same hard counting prompt in fresh sessions at the
   lowest and highest level (the correct answer is 378):

   | Model / level | Answer | Thought chunks / chars | Time |
   |---|---|---|---|
   | gpt-5.4-mini `reasoning=none` | 428 ✗ | 0 / 0 | 4.9 s |
   | gpt-5.4-mini `reasoning=xhigh` | 381 ✗ | 836 / 4 130 | 118 s |
   | claude-opus-5-5 `effort=low` | 378 ✓ | 311 / 3 213 | 49 s |
   | claude-opus-5-5 `effort=max` | 378 ✓ | 1 661 / 16 644 | 190 s |
   | gemini-3.7-flash `effort=low` | 383 ✗ | 16 / 5 398 | 53 s |
   | gemini-3.7-flash `effort=high` | 378 ✓ | 28 / 11 155 | 123 s |

   Higher effort gave 2.5–24× the wall time and much more thinking for every model. So the level
   really reaches the model; it is not just stored.

5. **`bin/acpprobe -s effortmax -ctl`** (the app's policy): for each of the 37 models, set the
   model, then `thinking=true`, `context=<largest>` and a non-default effort. Then open a **fresh
   `session/new`**, run the "pong" turn, and read the context window the agent really used
   (`max_tokens`) from the session store (the reader from `cursor-context-usage`). For models with a
   `context` option, a control turn at the smallest context ran first:

   | Model | Smallest context → store `max_tokens` | Largest (`1m`) → store `max_tokens` |
   |---|---|---|
   | claude-opus-5-5, opus-5, opus-4-8, opus-4-7, sonnet-5 | 300k → 300 000 | 1m → **1 000 000** |
   | claude-opus-4-6, sonnet-4-6 | 200k → 200 000 | 1m → **1 000 000** |
   | gpt-5.6-sol / -terra / -luna, gpt-5.5 | 272k → 272 000 | 1m → **1 000 000** |
   | gpt-5.4 | 272k → 272 000 | 1m → **922 000** |

   All 48 turns (37 policy + 11 control) ended with `end_turn` → "pong". None of the settings came
   back with a different `currentValue`. The fresh session's `configOptions` reported the policy
   values, for example `thinking=true context=1m effort=low`. `thinking=true` was accepted on all 11
   models that have it, including `claude-sonnet-4`, where it is off by default: that model then
   produced 12 thought chunks for "pong". The Claude 4.6+ models produced 0 thought chunks for
   "pong" even with thinking on. They decide per request whether a prompt needs thinking, and in
   run 4 claude-opus-5-5 thought heavily on the hard prompt. Models without a `context` option
   reported fixed windows: 200 000 (Gemini, older Claude, Kimi K3, GLM), 256 000 (Grok, Auto),
   262 000 (Kimi K2.7 Code) and 272 000 (other GPT models).

## What was tried

1. `bin/acpprobe -model "" -s hello` (default picker): `session/new` lists 37 model values, one
   pre-built variant each, with no separate effort option.
2. Read the ACP agent in the bundle (`7465.index.js`). `setSessionConfigOption` sends model options
   to `applyParameterizedModelConfigOption` or `applyVariantModelConfigOption`, depending on
   `clientCapabilities._meta.parameterizedModelPicker`. `buildModelParameterConfigOptions` turns
   each parameter definition with 2 or more values into a config option. `isThoughtLevelParameter`
   marks ids and names that match thinking/reasoning/effort as `thought_level`.
3. `1d9021a` adds `cmd/acpprobe/effort.go` (the `effortlist`,
   `effortset`, `effortchat` and `effortcmp` scenarios) and `ClientMeta` in `acp.go`, so the probe
   can send `clientCapabilities._meta`.
4. `42d3382` adds the `effortmax` scenario: thinking on, largest context and an effort in one go,
   with the window checked in the session store, plus a smallest-context control (`-ctl`).

## Gotchas

- **Model and effort are process-wide, not per session.** After each set, the agent calls
  `syncSessionsToCurrentModel()`, and a `session/new` in the same process reported the effort
  that was just set (`new session reports reasoning=xhigh`). So two chats that need different
  models or efforts need separate `agent acp` processes (the app already runs one process per chat),
  or they must re-set both before every prompt.
- **Switching the model restores that model's last-used parameters, not its default.** Choices are
  saved per model in `cli-config.json` → `modelParameters` (for example
  `"claude-opus-5-5":[{"id":"effort","value":"max"},…]`). The current choice is saved in
  `selectedModel`. After a `model` set, always set the effort explicitly, and read the defaults from
  `cursor/list_available_models`, not from the `configOptions` that come back after the switch.
  This is another reason to spawn with a server-owned `CURSOR_CONFIG_DIR`. Otherwise the app's
  choices overwrite the user's CLI defaults.
- The effort option changes with the model: its id, its values, and whether it exists at all. Rebuild
  the effort control from the `configOptions` returned by each `model` set, or from the cached
  `list_available_models` entry.
- **The context option value is not the exact usable window.** `gpt-5.4` at `1m` reported
  `max_tokens=922000`. Use the store's `max_tokens` for the context meter, not the option label.
- **The last-used-parameters memory also covers `thinking` and `context`.** A model once set to
  `thinking=false` or `300k` comes back that way after a model switch. The seeded user config
  already had `claude-opus-5` at `context=1m`, while the list default is `300k`. So the policy has to
  be applied on every switch, not once.
- With thinking on, trivial prompts can still get no thought chunks on the Claude 4.6+ models. That
  is expected; count on thinking only for real work.
- Not tested: `fast` (it is set the same way; it costs twice as much, so leave it `false`), and
  whether the flag changes anything in `session/load`.
