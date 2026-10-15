# Package S9: the context ring and the usage popup, as built

Code: `app/src/screens/usage/` (self-contained; nothing registers). Checks: `web/dev/checks-app/A2.4-usage.mjs`, `L12-usage.mjs`, the ring entries of `P0.3-smoke.mjs`;
unit test `app/test/usage.test.ts`.

## What it exports (`screens/usage/index.ts`)
| Export | For | What |
|---|---|---|
| `ContextMeter({ chat, compact? })` | **K3** | the ring of a chat with its popup. Reads the chat's shown view, its catalog and its server from the store; draws the warning meter ("Context unavailable") when the context is not known. `compact`: the toolbar has no room for the text: it is drawn and not seen (`ctx-text`, 1×1) and the title says it, as the old `.ctx-meter.compact` |
| `CtxRing`, `CtxError` | | the pure ring and the error meter, for a caller that has the numbers |
| `SubMeter({ sa })` | **S7** | a subagent's ring in its row and the drawer: no press, a title, nothing before it has used tokens (B-US-12) |
| `contextOf`, `contextLines`, `ctxTitle`, `ctxText`, `fmtK`, `ringOf`… (`meter.ts`) | | the pure numbers and words; Node loads them |

## Where K3 places it
In the composer's toolbar, as the last element before Send, where the old `Toolbar` drew `<ContextMeter c cat where compact={f.meter === "ring"} />`:
`<ContextMeter chat={chatId} compact={fit.meter === "ring"} />`. It is a `View` of its own (the popup's anchor), 24 px high; the fit (`logic/composerfit.ts`) measures it by
its `testID="ctx-meter"` (width of the ring alone with `compact`, with its text without). Until K3 registers its `Composer` part, `parts.tsx` draws a stand-in
(`composer-standin`: a bar with the meter at its right): K3's part replaces it. The checks run on that bar now and on K3's toolbar later.

## testIDs (dataSet)
`ctx-meter` (`tone` ok | warn | danger | error, `compact`, `used`, `win`; `aria-expanded` on the button), `ctx-text`; the popup `usage-pop` (the Overlay's surface: a popover above the ring on
the wide layouts, a sheet on the phone) with `usage-body`, `usage-context` (`usage-ctx` the lines, `ctx-refresh` "Count again"), `split` (`split-bar`, `split-seg` `cat` `slot`,
`split-row` `cat` `on`, `split-label`, `split-num`, `split-pct`, `split-item`, `split-facts`, `split-foot`), `usage-plan` (`plan-refresh` "Check again", `usage-row` `tone` `kind` with
`usage-bar` `pct` and `usage-reset`, `usage-note`, `usage-err`, `usage-foot` `stale`).

## Decisions
- The pure helpers (`fmtK`, `ctxTitle`, the share, the tone) were in `web/src/Composer.tsx`, not in core; they are `screens/usage/meter.ts` here, with the old page's text unchanged. The old page keeps its own.
- Esc, a press outside and the back button are the `Overlay`'s (the overlay stack takes Esc in the capture phase, so the composer under it never sees it: B-US-04); the popup is a bottom sheet on the phone (AD-70).
- The popup keeps each branch's last split and each server's and agent's last plan answer for the run (`lastSplit`, `lastUsage`), as the old one, and asks again on open.
- A chat with no agent (`agent: ""`) gets the context lines in the popup and no split and no plan; the old popover drew an empty backdrop.
- A finger's press on a split row or segment marks it as a mouse's hover does (the old page had hover only); the mark of a mouse ends when it leaves the split.
- Not in this package: B-US-03 (the other branch's usage) needs the branch switch (S8; `P0.4`): the meter reads `shownView`, the branch shown, as the old one. B-US-12's row is S7's to place.
