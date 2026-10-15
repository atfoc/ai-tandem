# Package S6: tool cards and permission cards, as built

Code: `app/src/screens/tools/` (registered with `setChatPart("ToolCard", …)` and `setChatPart("PermCard", …)`; the import is in `screens/register.ts`), the
checks `web/dev/checks-app/{A5.2-cards,A5.3-gaps,A5.4-large,L13-cards}.mjs` and the readers `cards.mjs`. What a card shows is core's, unchanged
(`logic/toolcard.ts`, `linediff.ts`, `labels.ts`, `perms.ts`); these files draw it.

## What it draws
- `ToolCard.tsx`: `tool-card` (dataSet `kind` shell | edit | write | delete | other, `state` running | denied | stopped | done, `running`, `err`, `open`) holding
  `tool-row` (a `Pressable`, `aria-expanded`) with `tool-icon` or `tool-spin`, `tool-label`, `tool-hint` (one line, cut), `tool-show` (a board tool's "Show"),
  `tool-chev`; open, `tool-detail`. The whole card is inside the `Guard` of the shell ("Couldn't show this tool call.", `guard-fail`, drawn again when its
  item changes, B-TH-17). A card that was opened stays open when its row is drawn again (`opened`, by chat and tool id): the thread is a virtual list and
  lets a row go when it is far off screen.
- `Parts.tsx`: `tool-path` (dataSet `full`; the tooltip on web is the full path) with `tool-path-name`, `tool-counts`, `tool-lines`; `tool-part` (dataSet
  `failed`) with `tool-sub`, `tool-lead`, `tool-text` or `tool-diff` (the box), `tool-pre` (dataSet `tokens`: the coloured runs), `diff-row` (dataSet `kind`)
  with `diff-sign`, `diff-text`; `tool-omit` with `tool-omit-text`, `tool-show-all`, `tool-show-less`; `tool-note`; `tool-more` ("⋯ 18 more edits").
  A long part shown whole is a `ScrollView` of at most 480 points; cut, a `View`. The sign of a change and the controls are not selectable.
- `Code.tsx`: a text as code, coloured by S5's `highlightRuns` (the same runs and tokens as a code block; none above 20,000 characters).
- `PermCard.tsx`: `perm` (dataSet `state` pending | allow | deny, `closed`) with `perm-sub`, `perm-title`, `perm-reason`, `perm-what`, `perm-actions`
  (`perm-allow`, `perm-deny`: `ui/Button`), `perm-done`, `perm-error`. The words and the rules are the page's (B-PM-01 to 09).

## Decisions
- The page's classes `running`, `err` and `k-<kind>` are the dataSet of `tool-card`; `cards.mjs` hands them back as `cls` so the old assertions read the same.
- A5.4's bound on the thread's markup is 12,000 characters closed (the page: 6,000) and 60,000 open: react-native-web writes every view's atomic classes.
  Its panes of 300 px are, at the desktop, a window of 300 px (the phone layout: a chat is the whole window) and the board panel at its minimum of 300;
  at the tablet and the phone the cards lie in the device's width.
- The checks leave the subagent's drawer to S7: the flag `DRAWER` and `DRAWER_ROOT` ("sub-drawer-body") at the top of A5.2, A5.3 and A5.4 turn it on.
  `A5.sub` of P0.3 is S7's as well.
- B-TH-17's fence cannot be provoked by data (core's readers never throw on an item); A5.3 proves that the malformed items cost no card, the fence itself is
  the shell's `Guard`, shared with the sidebar.

## Not verified here
Nothing ran in the iOS simulator or on Android (V-track). To look at there: the horizontal reach of a `Text` with `overflowWrap` (web-only; native wraps
at word boundaries and breaks a word that is longer than the line), the nested `ScrollView` of a long part inside the thread's list, the tap on a card's row
inside a list row, and `ActivityIndicator` at a scale of 0.55 as the running mark.
