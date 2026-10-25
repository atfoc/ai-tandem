# Places that send from the composer with Enter and can run at the phone viewport

After C1-6 the web build at the phone layout makes a line on Enter (and Shift+Enter) and sends on Ctrl+Enter / ⌘Enter; tablet and desktop still
send on Enter. Each place below sends (or expects a send) with a plain Enter in the composer at a viewport where the phone layout runs.
Fix: press the Send button (`byTid(page, "send")`), or `ControlOrMeta+Enter`. Line numbers are of ux-c1-6 (from ux-c1 0367a8a).

## Sends a message (must change)
- `web/dev/checks/fork.mjs:94` `typeAndSend` (types, then Enter). Used by `fork.mjs:100` `send(..., { composer: true })`,
  `P0.4-routes.mjs:358` (viewports desktop, tablet, phone), `P7.1-flavours.mjs:177` (desktop, tablet, phone), `P7.2-menu.mjs:323` (desktop, tablet: unaffected).
- `web/dev/checks/AAC.3-remotedown.mjs:48` and `:71` (desktop, tablet, phone): Enter sends, then waits for the POST.
- `web/dev/checks/SEC.8-sameid.mjs:98` and `:108` (desktop, tablet, phone): type, Enter, wait for the call.
- `web/e2e/lib/ui.mjs:332` `send(p, text)` (fill + Enter), used by `web/e2e/remotechat.e2e.mjs` (also run with `VIEWPORT=phone`:
  `:676 :725 :737 :744 :834 :840 :901`), `newchat.e2e.mjs`, `voice.e2e.mjs`.
- `web/e2e/remotechat.e2e.mjs:890` (types " and more", Enter; sends) and `:920` (`box(page).press("Enter")`, sends the kept text); both in the
  phone run.

## Expects that Enter sends nothing, or only checks a read-only box (still true at the phone: Enter is a line break there)
- `web/dev/checks/AAC.2-localdown.mjs:66`, `SEC.7-drop.mjs:87`, `L23-gone.mjs:53` (read-only box; the Enter there is a no-op either way; L23's
  Enter / Tab with the @ list: at the phone the list is closed at that point, nothing to pick).

## Already guarded (no change needed)
- `web/dev/checks/L16-composer.mjs`: `keys = viewport !== "phone"` (line 28) guards every Enter send (`:52-58`, `:191`, `:222`, `:271-279`, `:299`,
  `:326-340`, `:351-373`); the phone path presses Send or the dock's row. After C1-6 `keys` could become true for a phone with `Ctrl+Enter`; keep it as is.
- Not composer sends (name, label, path, library fields, rails, drawers): L10-chatview, L15-fork, L21-focus, L7-servers, L11-sidebar, PL*, SEC.5,
  SEC.10, IM3.5, A1.5, A6.1, L17-quote (the quote field's own Enter), P7.4-board (the quote field's Enter).
- `web/e2e/app.e2e.mjs` (paid, still on the old page's selectors): `:733 :744 :766 :912 :984 :1046 :1339 :1352 :1591` send with Enter; desktop only.
- `web/e2e/twopages.e2e.mjs:197`, `newchat.e2e.mjs:262`, `remotechat.e2e.mjs:664 :667`: name and path fields, not the composer.
