# Decisions of the better-board prototype

Each entry: the decision, who made it (user / orchestrator / architect), why.


## tldraw version: 5.6.0, exact

- `tldraw` 5.6.0 and the matching `@tldraw/*` 5.6.0 (`@tldraw/editor`, `@tldraw/sync-core`, `@tldraw/tlschema`,
  `@tldraw/assets` for the font files), React 19.2.3 (the version the repository already has). Pinned exactly, no `^`.
- Who: `bb-spike-host` (the first package to add tldraw), 2026-11-08.
- Why: the latest stable release on npm that day (`latest` dist-tag 5.6.0; `next` is 5.7.0-next).
