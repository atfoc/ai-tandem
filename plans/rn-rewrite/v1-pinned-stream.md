# Package V1: the pinned certificate and the stream on a device, as built

Flow `app/e2e/maestro/net-pinned-stream.yaml` (AD-83 flow 1, goals 4.6, 4.7, 7.4), run on the iOS simulator and the Android emulator against a scratch Go
server, through the real app. How to run it and what each step does: `app/e2e/README.md` ("The app itself"). Code: `app/e2e/lib/serverctl.mjs` (control API),
`run.mjs` (`app=1`, `agent`, `control` in the header, `--once`, a control reset before a second attempt), `maestro/_ctl.js`, `_open-app.yaml`, `_dismiss.yaml`,
`_forget-servers.yaml`, `_blur.yaml`.

```sh
node app/e2e/run.mjs net-pinned-stream --platform ios --device <udid>
node app/e2e/run.mjs net-pinned-stream --platform android --device emulator-5554     # the emulator lock held
```

## Found on the way (and what was done)
- **The confirm question could not be seen on a phone's sheet (iOS).** "Remove" on a server of the Servers sheet opened the confirm dialog, which is a second
  `Modal` beside the first; iOS presents a modal from the controller that is already presenting, so nothing showed and the entry could not be removed.
  Fixed in `ui/nestedlayer.tsx`: an open `Sheet` draws the popup inside its own `Modal` (`NestedLayer`, which the confirm dialog fills), and the confirm
  at the root of the shell yields while a sheet is open. Any other popup that rises from a sheet has the same fault until it does the same (S1 has `later`
  for its menus). Checks L3 and L7 (all three layouts) pass with it.
- **No testID told the boxes of the add form apart on a device.** `dataSet` is web only, so `servers-input` was the testID of four boxes and Maestro's
  `index` took the wrong one when the hierarchy left out an empty box. On a device the testID is now `servers-input-<field>` (`code`, `name`, `address`,
  `secret`); on the web it is still `servers-input` with `data-field`. The row's buttons have `servers-accept|test|edit|remove|show-fp`, the form's
  `servers-form-test|accept`.
- **Not done, found:** the sheet does not rise over the keyboard (iOS and Android), so with the keyboard up the boxes below the first are out of reach (a
  person can scroll; the flow takes the keyboard away). `ScrollView automaticallyAdjustKeyboardInsets` in `ui/Sheet.tsx` would be the first thing to try.
  iOS offers to save the secret as a password. Maestro's `hideKeyboard` on Android is the Back key.

## Since (package P1, `p1-sheets-keyboard.md`)
`ui/nestedlayer.tsx` is gone: every overlay primitive draws itself inside the topmost open overlay (`ui/overlayhost.tsx`); the sheet rises over the keyboard
(`ui/useKeyboardAvoid.ts`); the secret box is no longer a password to iOS (`ui/SecretInput.tsx`).

## Results
iOS simulator "iPhone 17": passed on the first attempt (about 2 minutes). Android emulator `Medium_Phone_API_36.1`: passed on the first attempt (8 minutes on a
busy machine). Evidence folders of the last runs: see the report.
