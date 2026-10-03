# Claude model picker: why new models don't show, and how to fix it

Research date: 2026-10-03. Claude Code CLI 2.1.284.

## Summary

The Claude model picker never shows new models because its list is typed into the code. The
app has never asked Claude Code which models exist. The fix is to read the model list that the
Claude Code CLI already returns in its `initialize` control response. This is the same kind of
boot and per-chat refresh the app already does for Cursor and pi.

## Why new models don't show up

1. **The list is fixed in the code.** `internal/claude/catalog.go:8` has three entries:
   `sonnet` ("Sonnet 5"), `opus` ("Opus 5.5") and `haiku` ("Haiku 4.5"). It came from the UI
   prototype's `MODELS2` and has had exactly one commit (`6e9b17e`). Every client gets it from:
   - `internal/app/app.go:50` (`cl := claude.Catalog`)
   - `internal/chats/manager.go:330` (`cat := claude.Catalog`)
2. **Claude never gets a refresh.** Cursor and pi update their lists each time the server starts
   (`cmd/ai-whiteboard/main.go:182-183` calls `refreshCursorCatalog` and `refreshPiCatalog`).
   They update again during each chat (`internal/cursor/cursor.go:246`, `internal/pi/pi.go:293`
   send `EvCatalog`). No `refreshClaudeCatalog` exists, and nothing calls
   `SetCatalog(model.Claude, …)`. `internal/model/model.go:69` documents stored catalogs as
   "(Cursor, pi)" only. `plans/mcp-subagents-refresh/adapters.md:406` says: "Pi/Cursor catalogs
   can change under the user… Claude cannot."
3. **The server rejects any model not on the list.** `findModel`
   (`internal/chats/manager.go:770-780`) only accepts exact matches and is called from
   `Configure` (`PATCH /api/chats/{id}`). So `fable` or `claude-opus-5-5` fails with
   `unknown model`. Separately, `defaults.Resolve` (`internal/defaults/defaults.go:36-47`)
   quietly switches an unknown saved model back to `sonnet`.
4. **The installed app has the list built in.** The binary in
   `bin/AI Whiteboard.app/Contents/MacOS/ai-whiteboard` (built by `scripts/build-app.sh`) carries
   the old labels. A code fix only reaches the picker after rebuilding and reinstalling.
5. **The current label is already wrong.** The CLI now resolves `sonnet` to Sonnet 5.5, but the
   picker still says "Sonnet 5". Fable is missing entirely.

Ruled out:
- **Commit `eaa7cdd`** (model search by ordered terms) only changed client-side filtering in
  `web/src/logic/models.ts`, not how any list is built.
- **The web client** filters only through the search box. It has no ID regex or allowlist, and
  catalogs are not kept in localStorage.

## Where an up-to-date list comes from

Claude Code has no `models` subcommand or `--list-models` flag, unlike `pi --list-models` and
Cursor's `cursor/list_available_models`. It does, however, return the full account-aware list in
its `initialize` control response. Verified locally from `/tmp` with the user's normal sign-in;
it took under a second and sent no prompt:

```bash
printf '%s\n' '{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}' \
 | claude --print --input-format stream-json --output-format stream-json --verbose
```

`response.response.models` held 12 entries:

| value (pass to `--model`) | resolvedModel | displayName | efforts |
|---|---|---|---|
| `default` | `claude-opus-5-5` | Default (recommended) | low…max |
| `opus` | `claude-opus-5-5` | Opus 5.5 | low…max |
| `claude-fable-5-1` | `claude-fable-5-1` | Fable 5.1 | low…max |
| `sonnet` | `claude-sonnet-5-5` | Sonnet 5.5 | low…max |
| `haiku` | `claude-haiku-4-5-20251001` | Haiku 4.5 | none |
| `claude-sonnet-5` | `claude-sonnet-5` | Sonnet 5 | low…max |
| `claude-opus-5` | `claude-opus-5` | Opus 5 | low…max |
| `claude-fable-5` | `claude-fable-5` | Fable 5 | low…max |
| `claude-opus-4-8` | `claude-opus-4-8` | Opus 4.8 | low…max |
| `claude-opus-4-7` | `claude-opus-4-7` | Opus 4.7 | low…max |
| `claude-opus-4-6` | `claude-opus-4-6` | Opus 4.6 | low, medium, high, max |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | Sonnet 4.6 | low, medium, high, max |

Each entry also has `description` and the flags `supportsEffort`, `supportsAdaptiveThinking`,
`supportsFastMode` and `supportsAutoMode`. The list is filtered by the account's org settings,
so it is more accurate than any static list. It has **no context-window size**.

The app already sends this exact request on every Claude chat (`internal/claude/claude.go:203`).
`readLoop` then discards the answer at line 240 (`p.reply(sc.Bytes())`).

Other sources considered and rejected:
- **The model registry built into the CLI binary:** tied to the installed version, internal, and
  not a stable interface.
- **`~/.claude.json` caches** (`additionalModelOptionsCache`, `modelAccessCache`): stale copies
  of the CLI's own bootstrap call, so a fallback at best.
- **`GET /api/claude_cli/bootstrap`:** an internal endpoint that needs OAuth.
- **Anthropic `GET /v1/models`:** needs an API key, and returns dated model IDs without the CLI's
  short names, `default`, `[1m]` variants or effort levels.
- **The Agent SDK:** not used. The repo is Go and speaks the control protocol directly.

## How to fix it

1. **Fetch the list at startup.** Add `claude.Spawner.Catalog(timeout)`, following the pattern
   in `internal/cursor/probe.go`. It would start `claude` briefly in `os.TempDir()`, send
   `initialize`, read the first `control_response`, then stop the process. Map each entry:
   `value` → `ID`, `displayName` → `Label`, `description` → `Note`,
   `supportedEffortLevels` → `Efforts`. Use the `default` entry (or the CLI's chosen model) for
   `Catalog.Default`.
2. **Refresh it like the others.** In `cmd/ai-whiteboard/main.go`, add `refreshClaudeCatalog`
   next to the Cursor and pi refreshers. It saves the list with `SetCatalog(model.Claude, cat)`
   and broadcasts `{"type":"catalog","agent":"claude",...}`. If the fetch fails, keep the stored
   list.
3. **Use the saved list everywhere.** `app.go:50` and `manager.go:330` should prefer the saved
   Claude list and fall back to the built-in `claude.Catalog`. This also fixes the `findModel`
   rejection. Update the fallback list too: add Fable and correct the Sonnet label to 5.5.
4. **Optionally keep it fresh during chats.** In `readLoop`, read `response.models` from the
   `init_*` `control_response` and send `EvCatalog`, as Cursor and pi do.
5. **Clean up code that assumes the short names:**
   - `internal/claude/claude.go:73` (`o.Model != "haiku"`): check whether the catalog entry has
     effort levels instead.
   - `internal/claude/translate.go:224` and `web/src/logic/subagents.ts:106` match on
     `"-"+id`. That works for short names but not full model IDs.
   - Context window: the `initialize` response lacks it. Use `result.modelUsage` (already parsed
     in `translate.go`), the `[1m]` suffix, or a small lookup by family.
   - `internal/chats/namer.go:25` hardcodes `--model haiku` for chat naming. That is fine as is.
6. **Update tests and rebuild.** Fixtures that hardcode the old list:
   - `internal/app/app_test.go:603-613`
   - `internal/defaults/defaults_test.go:11-22`
   - `web/test/subagents.test.ts:126-134`
   - `web/test/models.test.ts:68-74`
   - `web/e2e/app.e2e.mjs:69-70,474`

   Add a parse test that uses a captured `initialize` response saved in `testdata/`. Then rebuild
   the app binary.
