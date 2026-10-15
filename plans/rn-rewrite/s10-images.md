# Package S10: images in a sent message, the large view, `<Picture>`, as built

Code: `app/src/screens/images/` (registered as the chat view's `MessageImages` part by `screens/register.ts`), `app/src/platform/picture.*`,
`brokentile.*`; checks `web/dev/checks-app/{IM3.5-message,R3.12-images}.mjs`; unit test `app/test/images.test.ts`.

- `MessageImages` (`msg-images`, dataSet `alone`): 88 px `ImageThumb`s, in the message's order, above the words. `ImageThumb` (`image-thumb`, dataSet `state`
  loaded | broken | busy; `image-thumb-open` only when it can be opened; `image-thumb-busy`; `image-thumb-remove`) is **also the composer's strip
  thumbnail for K3**: `size` 64 (default), `busy`, `onRemove`, `uri` (the file it came from while it uploads), `again`.
- `ImageLarge`: a transparent full-screen `Modal` on a dark scrim in every theme (the "full-screen sheet" of the phone; slide on native phone, fade on
  tablet/desktop). Esc/back through `useOverlayClose` (the overlay stack: over a subagent drawer that is an `Overlay`, Esc closes the large view
  first; **S7 must close its drawer through `useOverlayClose` too**, not a window handler of its own, or B-IM-09 fails), ← → through the keys port,
  the two buttons (marked `aria-disabled` at an end, not disabled), a press beside the picture, and on touch a swipe sideways (step) or down (close,
  `swipeOf`). The picture is drawn whole and never larger than itself (`fitInside` from `onLoad`'s natural size; invisible until measured).
- `<Picture>` got `again` (ask once more when it changes), `onLoad({width,height})`, `lines`, and `onError` that is now called once for every kind of
  failure (an address that cannot be had, an image that cannot be loaded). `BrokenPicture` is split web/native: on web the name is drawn by CSS from
  `data-text` (not a text node: the quotes read a message's text nodes, B-IM-02).
- Left to later packages (flags at the top of `IM3.5-message.mjs`): TREE (S8: the tree names the message "Image"), DRAWER (S7); the composer's strip half
  of R3.12 waits for K3 (flag COMPOSER; the old body is in `web/dev/checks/R3.12-images.mjs`).
