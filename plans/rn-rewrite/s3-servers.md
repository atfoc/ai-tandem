# Package S3: the Servers dialog, as built

What S1 (the foot's button), S4 and B4 (the warnings' "Servers…"), S12 (the phone's add-server flow) build on. Code: `app/src/screens/servers/`,
`packages/core/src/state/serversdialog.ts`; check `web/dev/checks-app/L7-servers.mjs`; unit test `app/test/servers.model.test.ts`.

## API
- `import { openServers, ServersButton, ServerForm } from "../servers"` (index registers the dialog in the shell's `Overlays` slot).
  `openServers(form?)` opens the list, or the add/edit form (`form.id` = edit) with the fields filled: the way S12 hands over what it pasted
  or scanned (name, address, secret, `selfSigned`, `pin`). The same `openServers`, `answered` and `listed` are in core
  (`@aiwb/core/state/serversdialog.ts`); the old page's `web/src/Servers.tsx` re-exports them.
- `ServersButton`: the foot's button (`testID servers-btn`, `dataSet {dot}`, title "Servers" / "Servers: one is not connected", the warn dot
  `servers-dot`). **S1 draws the foot with it**; until S1 merges, the shell's stand-in sidebar (`slots.tsx`) draws it so that A1.4 and A1.5
  reach the dialog. When S1's sidebar replaces the stand-in it must draw `servers-btn` (A1.4 `SERVERS_DIALOG`, A1.5 `SERVERS_BUTTON` are on).
- `ui/Overlay`, `Dialog`, `Sheet` have a new prop `closeOnBackdrop` (default true; false: a press on the dimmed page does not close it).

## testIDs (`dataSet` in brackets)
`servers-dialog` (a dialog on the wide layouts, a sheet with `sheet-handle` on the phone), `servers-notice`, `servers-list`,
`servers-row` [server, state], `servers-name`, `servers-state` [tone ok|wait|bad, server], `servers-addr`, `servers-line`, `servers-fp`,
`servers-result` [ok], `servers-result-msg`, `servers-step`, `servers-reason`, `servers-mcp`, `servers-owner-line`, `servers-add`,
`servers-close`, `servers-form` [mode add|edit], `servers-input` [field name|address|secret] (on a device `servers-input-<field>`, with `code` too: Maestro has no `dataSet`), `servers-selfsigned` (`aria-checked`),
`servers-problem`, `servers-save`. Buttons are told apart by their words (`getByRole("button", { name })`).

## Decisions
- **The owner's things** (this computer's row, `owner.status`, Restart server, Retry, Open server log) are drawn where `transport().way` is not
  `native` (`model.ts` `ownerThings`); a native app lists no row of this computer. A web build on a narrow window still has them (its
  transport is the host's): the phone *layout* is not the phone *app*.
- Esc and the back button leave the form first, then the dialog (the overlay stack's top answers, the confirm dialog above first); a press on
  the dimmed page closes the list and not a form.
- The mock (`web/dev/mock.mjs`) got `flags.app[op]` (`{answer}`, `{refuse: [status, sentence, code]}`, `{delay}`, or `{queue: [...]}`) to script
  an app operation's answer, and `appCalls` (every operation asked, a secret told by its length). It rejects an address with a trailing "/",
  which the Go server takes: L7 types addresses without it.
- The Servers parts of SEC.2 and AAC.1 (the dialog says the states' words; this computer's row with the MCP listener, Retry, Restart) are proved
  in L7 (list, owner's things), since S1 ports those two checks without a dialog; the "Servers…" of A1.3's warning waits for S4's `remote-bar`
  (its flag `SERVERS_DIALOG` stays false there).
