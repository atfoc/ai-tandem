# Package V4: the secure storage, the picker and the permissions on a device, as built

Flow `app/e2e/maestro/storage-picker-permission.yaml` (AD-83 flow 4, goal 7.4) with its parts `_v4-images.yaml`, `_v4-localnet-why.yaml`, `_v4-localnet.yaml`, `_v4-scan.yaml`; how to run it and what the
runner gives it (device routes, `--hold`, `devhooks=1`): `app/e2e/README.md`, "The secure storage, the picker and the permissions".

```sh
node app/e2e/run.mjs storage-picker-permission --platform ios --device <udid>
node app/e2e/run.mjs storage-picker-permission --platform android --device emulator-5554     # the emulator lock held
```

## What is proved on a device, and how
| Goal | Proof |
|---|---|
| The server and its secret survive a restart, and it connects | the runner stops and opens the app again (`POST /device/relaunch`); the sidebar says `127.0.0.1 — Connected` and has the server's board |
| The secret is in the secure store, in no MMKV file, and in no file of the app | the build's probe line (`probe-storage`: `secure=1 match=1 leak=no`, the secret compared by its SHA-256) and the runner's search of the app's whole data folder for the secret (`GET /device/storage`; the MMKV files are `Documents/mmkv/aiwb.{servers,page}` on iOS and `files/mmkv/aiwb.{servers,page}` on Android; the same search finds the server's address in `aiwb.servers`, so it does read them). Android's `shared_prefs/SecureStore.xml` holds the secret encrypted: not found |
| Removing the server removes its secret | `probe: list=0 secure=0 match=0 leak=no gone=1 gone-left=0 pending=0` (an entry seen in this launch left the list and the store's key is empty) |
| The picker, thumbnails, send, what the server holds | pictures put into the library; attach button; thumbnails; Send; `GET /chat-images` through the client API: a PNG of 64x48, a JPEG of 80x60 and (iOS) a JPEG of 96x72 that was a HEIC; each type is the one its bytes have |
| Refused files | a BMP: "Not a PNG, JPEG, GIF or WebP image: …"; a PNG of 8.7 MB: "Over 5 MB: …"; both in `composer-err`, nothing added |
| The photo-library permission | there is none to ask: the system's picker (iOS PHPicker, Android's photo picker) shows only what the person picks and hands the app those pictures. The flow resets (`simctl privacy reset`) and revokes (`revoke`) it and the picker works the same, with no prompt, so no refused state exists for the person to be shown. `photosPermission` of the plugin (`Info.plist`) is the text of a prompt that never comes; Android's app does not ask for `READ_MEDIA_IMAGES` |
| The local network | iOS simulator: it never asks (N1). Shown: the words that say why the system will ask, on the add form before the first connection (and gone once a connection has been made: the module says `granted`); a connection that ends as `local_network_denied` (forced by the build's dev hook for the dotted name) shows `addserver-localnet-denied` with its words and "Open settings", which opens the system's settings |
| The camera's permission for the scanner | both platforms: the scanner asks, with the app's words in the system's prompt (iOS: "…uses the camera only to scan the code that your server shows"; Android: the system's); refused, the scanner says the camera is off and gives "Open settings" (iOS at once, Android at the second refusal); given, the scanner is on the screen |
| The code to scan | `scripts/server-code.sh` makes it; its picture is read back with CoreImage and holds exactly the text the script fed `qrencode`; that text, typed into the paste box (the scanner and the paste share the parser), fills the form and the server it names answers with the fingerprint the text printed |

## Found on the way (and what was done)
- **A HEIC from the iOS library was refused ("Not a PNG, JPEG, GIF or WebP image").** K4 expected `expo-image-picker` to hand back a JPEG; its default `preferredAssetRepresentationMode`,
  `automatic`, hands a HEIC over as it is (`image/heic`, bytes `ftypheic`), and the type is taken from the bytes. A phone's own photos are HEIC unless the camera is set to "Most
  Compatible". Fixed in `platform/imagepickcore.ts`: the picker is asked for `compatible` (iOS makes the JPEG; Android has no such option and ignores it); `test/transport.native.test.ts` holds the option.
- **The composer's toolbar ran off the phone's screen (no attach button, no Send in the accessibility tree and not on screen).** The measuring layer was one point wide, so a text measured in
  it was wrapped at its longest word and its width kept was too small; the fit then drew every control. The same fault and the same fix as V3's (`composer/measure.tsx`, the layer's
  children in a 4000-point-wide box): applied here too so that the flow could press the attach button; the two edits are the same text, so the merge is clean.
- **A picture of 8.7 MB picked together with another one was dropped without a word on the iOS simulator** (the result of `launchImageLibraryAsync` held only the other). Picked alone it arrives and is refused
  as "Over 5 MB". Not understood (it is the library's own handling of the large asset, or a race of the picker); the flow picks them one at a time. Left as it is: nothing of the app's code is on that path.
- **Android's photo picker gives no file name**, so a thumbnail is labelled with a number ("23.png"). The platform's: left.
- The development client's round button stood over the picker's "Add" (and over a chat's "Tree") and a press there opened its menu: the runner switches it off before it opens the app.
- `expo-image-picker`'s `fileName` is `v4-green.jpeg` when the library holds `v4-green.jpg` on iOS (`.jpg` for the converted HEIC); the flow matches `.jpe?g`.
- Android: a permission refused twice is refused for good, and the app's own permissions module keeps its own note that it asked (`shared_prefs/expo.modules.permissions.asked.xml`), so `pm revoke`
  alone does not bring the first prompt back: the route of the runner also clears the permission's user flags and deletes that note (with the app stopped).

## By hand (goal 7.5)
- The system's prompt for the local network on a real iPhone (the simulator never asks): the first connection to a server on the LAN, "Don't Allow" and the app's words and "Open settings", then "Allow".
- A scan with a real camera: `sh scripts/server-code.sh` on the server's machine, "Scan code" in the app on a phone, the form is filled; on iOS and on Android.
- The photo library of a real iPhone with its own HEIC photos (Live Photos, large originals) and a real Android phone's picker with a cloud library.
- A secret in the Keychain / Android Keystore on a real device across a reinstall and a restore (the item is `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: it does not travel with a backup).
