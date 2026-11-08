# Decisions of the better-board prototype

Each entry: the decision, who made it (user / orchestrator / architect), why.


## tldraw 5.6.0, pinned exactly (orchestrator's spike bb-spike-ui)

`tldraw` 5.6.0 and `@tldraw/assets` 5.6.0 (the matching `@tldraw/*` come with it at 5.6.0), the latest stable on
2026-11-08 (released 2026-10-28). No `^`. bb-spike-host had not recorded a version when bb-spike-ui started; the first
spike to pin was this one (`spikes/tl-ui/package.json`).
