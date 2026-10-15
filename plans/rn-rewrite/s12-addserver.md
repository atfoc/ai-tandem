# Package S12: adding a server on a phone, as built

Goal 4.7, AD-34, architecture §13.1 (the user did not object to the code to scan). Builds on S3's Servers dialog (`s3-servers.md`).

## What the person sees (phone layout, or any native app: `useCodeFlow()`)
"Add server" has, above S3's fields, `addserver-code-box`: a box to paste into (`servers-input` `field=code`), "Fill in the form", and "Scan code" where
the platform has a camera (`platform/scan`: native yes, web no). A paste is read at once (a change that inserts 20 characters or more: `isPaste`), a short
text by the button. A text that is taken fills the address (the first; the others are offered as `addserver-address` radios), the secret, "Self-signed
certificate" and a name when there is none; the box is emptied. **The fingerprint is not accepted for the person**: "Test connection" shows the one the
server presents and `addserver-fp-match` says whether it is the one the text printed (`data-match` match|differs; "differs" says not to accept it). A
refusal (`addserver-note`, `data-ok=false`) fills nothing and says why in words that never repeat the text or the secret.
Before the first connection (`addserver-localnet`, not on Android, not once the module says `granted`) the form says why the system will ask to reach the
local network. A test answered `local_network_denied`, or an unreachable entry whose detail is that outcome's message, shows `addserver-localnet-denied`
(words + "Open settings" -> `Linking.openSettings()` where the platform has settings: `platform/localnetwork`).

## What is read (`@aiwb/core/logic/servercode.ts`, `parseServerCode`)
The whole output of `setup-remote.sh` (addresses one to a line, `Fingerprint:`, `Secret:`); the output of `remote setup` (no secret: refused with the way to get
it, or accepted with the line of `ai-whiteboard secret` after it, the addresses made of `Names:` and `Port:`); `address secret` on one line or two; the text of a
server code (`codeText`). Refused, with a reason each: empty, too long (8000), not a server's text, no address, plain http (anywhere in the text), an address the form
refuses, no secret, a secret the form refuses, two secrets, a bad fingerprint, two fingerprints. Fixtures: real outputs of a scratch home
(`packages/core/test/fixtures/remote-setup`, the machine's own names replaced by example ones).

## The code (`scripts/server-code.sh`)
Runs `setup-remote.sh` (beside it, in `remote/`, or in the app bundle) or reads its output from stdin (`-`), keeps the addresses, the fingerprint and the secret
(`--address` narrows the addresses), and draws them with `qrencode -t ANSIUTF8 -l L -m 2` fed on its **standard input**. Without `qrencode`: how to get it
(brew, apt, dnf) and "paste the output instead"; nothing of the secret is printed. No file is written. The text it encodes is `codeText` of the parser. Not
in the server folder `build-server.sh` makes (its Go test lists the folder's files and the Go side does not change): copy the one file with the folder.

## Config
`app.config.ts`: the `expo-camera` plugin with a usage text, `microphonePermission: false`, `recordAudioAndroid: false`; `ios.infoPlist.NSLocalNetworkUsageDescription`;
the ATS dict is untouched (`test/appconfig.s12.test.ts` and N1's `appconfig.test.ts`).

## Tests
`packages/core/test/servercode.test.ts` (parser), `app/test/addcode.test.ts` (form decisions, the refusal's words equal the connection code's),
`app/test/servercode.script.test.ts` (the script with a stand-in `qrencode` and server program), `app/test/appconfig.s12.test.ts`, browser check
`web/dev/checks-app/L3-addserver.mjs`. The scan itself, the camera permission and "Open settings" are device-only: V1 (denied/granted on iOS) and V4.
V4 (`v4-storage-picker-permission.md`) ran the scanner's screen and the camera's permission on both platforms, and the text of a code made by `scripts/server-code.sh` through the form; a scan with a camera is by hand.
