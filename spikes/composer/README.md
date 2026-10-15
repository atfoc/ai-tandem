# Composer spike

A text input with inline board-reference chips, in React Native (Expo SDK 57) and react-native-web: the go / no-go of
the rewrite's hardest part. The findings are in `plans/rn-rewrite/spikes/composer.md`. Run everything with `./run.sh`
(`SKIP_IOS=1 ./run.sh` for the browser and the unit tests only).

- `src/logic/chipdoc.ts` — the document (text and `Ref`s in order), the edit diff that keeps a chip one unit, the selection
  snap, insert at the caret. No React; `test/chipdoc.test.ts` runs it in node. The message is `serialize(doc)` of the
  page's own `web/src/logic/refs.ts`, imported in place.
- `src/ChipInput.tsx` — the component, the same on every platform. `src/ChipField.tsx` (native) and
  `src/ChipField.web.tsx` are the two fields it draws with.
- `checks/web.mjs` (Playwright), `checks/ios.mjs` + `checks/ios/*.yaml` (Maestro) + `checks/ios-keys/` (XCUITest).
