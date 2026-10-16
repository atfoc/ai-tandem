# Device regression check: `board-webview` on the iOS simulator

Command: `TMPDIR=<private empty dir> node app/e2e/run.mjs board-webview --platform ios --device <own iPhone 17 simulator, iOS 26.3>` (development build + Metro).
No other flow covers theme switching on the board (`grep -i theme app/e2e/maestro/*` finds nothing), so this is the only flow run.

| State | Board self-test (8 cases) | Flow |
|---|---|---|
| `3a0021e7` (Merge xo-filter) | ok, 8 passed, 0 failed | FAILED at `assertVisible "touch strokes: 3.*"`, both attempts |
| `6da36280` (first parent, without the change) | ok, 8 passed, 0 failed | FAILED at the same step, both attempts |

The failure is not from this branch. On an iPhone 17 the toolbar sits at about y = 21 % and the flow taps the pencil at (60 %, 16 %) (a point calibrated for another
device), which lands on the self-test's status text; no stroke is drawn and the page keeps saying `touch strokes: 0`. The self-test screen is plain light, so the new
filter is not even drawn there. What this run shows: the page ships, loads, draws, applies, exports and loads 2,000 elements in the web view on the branch as before.

## Second run: iPad simulator

Command: `TMPDIR=<private empty dir> node app/e2e/run.mjs board-webview --platform ios --device <own simulator>` on branch `xo-devflow2` (`12446d6e`, same code as the Merge xo-filter result).
Simulator: iPad Air 11-inch (M3), iOS 26.3.1 (created for the run, deleted after it). Development build + Metro, 191 s.

Result lines:

- `board: PASS the page says ready ... Excalidraw 0.18.1, 1378 ms`
- `memory at memory-empty: app 268 MB, WebContent 78 MB`; `memory at memory-2000: app 275 MB, WebContent 148 MB`
- `board: ok (8 passed, 0 failed, 0 skipped)`
- touch: `touch strokes: 1` / `2` / `3`, then the text step `texts: ["hello"]`
- `maestro exited 0; the app reported 1 verdict(s)` / `PASSED board-webview on ios`

Verdict: passed. On the tablet layout the flow's tap at (60 %, 16 %) hits the pencil, so the earlier touch-step failure was the flow's iPhone calibration, not this branch. The page ships, loads, draws,
takes touches and text, and loads 2,000 elements on the branch. No run on the parent of the merge was needed. No shipped code or flow was changed.
