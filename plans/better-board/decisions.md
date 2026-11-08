# Decisions of the better-board prototype

Each entry: the decision, who made it (user / orchestrator / architect), why.

- tldraw 5.6.0 is the current stable (licence check, 2026-11-08). Pin it exactly unless a spike recorded another. (orchestrator)
- The prototype's Electron window loads a development bundle of the new board (a production `file://` page without a key goes blank after 5 s; licence.md). The web build over http://127.0.0.1 counts as development. No licence key is used or worked around. (orchestrator)
