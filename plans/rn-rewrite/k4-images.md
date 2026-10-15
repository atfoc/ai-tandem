# Package K4: images in the composer, as built

What V4 (`storage-picker-permission.yaml`) tests on devices, and what S10 (the sent message's images) and K3 (the composer) meet. Code:
`app/src/screens/composerimages/` (`ImageStrip.tsx`, `AttachButton.tsx`; `index.ts` registers them as the composer's parts `ImageStrip`, `AttachButton`
and `pickImages`, imported by `screens/register.ts`), `app/src/platform/{imagefiles,previews}.{web,native}.ts` and `previewscore.ts`; core:
`state/uploads.ts` (`setPreviews`), `logic/chatimage.ts` (`BytesFile`, `UploadFile`, `fromDesktop(…, {asBytes})`), `api.ts` (`uploadImage` takes either).
Checks `web/dev/checks-app/{IM3.2-images,L18-imagelimits}.mjs` and the composer half of `R3.12-images.mjs` (flag `COMPOSER` is on); tests
`app/test/{composerimages,appconfig.k4}.test.ts`, `packages/core/test/previews.test.ts`.

## The three ways in (AD-26)
All three end in `Composer`'s `attach` → `parts.pickImages()` → `{files, skipped}` → `addImages` (the one check, then the upload at once), as a paste does.
- **Desktop app (ipc)**: `platform/imagefiles.web.ts` calls the transport's `pickImages` (the app's own open dialog through the bridge) and `fromDesktop`.
- **Web (http, a headless browser)**: the same file, no `pickImages` on the transport: a hidden `<input type=file multiple accept=image/png,…>`; a cancel answers no files.
- **Phone**: `platform/imagefiles.native.ts` calls the transport's `pickImages` (C4: `expo-image-picker`'s library, bytes read with `expo-file-system`, type from the
  bytes, 5 MB, ten at most) and keeps the files **as bytes** (`BytesFile`), not as Blobs.
- **Paste** is the web box's (`ChipInput.web`, `onImages`, on once `ImageStrip` is registered); the native box pastes images through the picker only (AD-60).

## What changed in core, and why
- **`BytesFile = {bytes, type, size, uri?}`** (`Picked.file` is `Blob | BytesFile`). React Native's `Blob` cannot be made from bytes, so a file picked on a phone is its
  bytes; `api.uploadImage` sends `bytes` as the call's body (the native transport takes a `Uint8Array` already), `fromDesktop(r, {asBytes: true})` makes them, and
  keeps the picker's `uri` (C4's `pickImagesWith` now answers it beside `name`, `type`, `data`; `DesktopPick.files[].uri` is optional). A Blob is still what a browser has.
- **`setPreviews` (`uploads.ts`)**: F3 left `URL.createObjectURL` and `new Image()` in `uploads.ts` (what a thumbnail shows while its image is on its way, and
  the wait for the image's own address). They are now a seam, `Previews {make, release, loaded}`; the default is the browser's, exactly as before (the old page and
  `web/test/actions.test.ts` are unchanged), and the web build of the app registers nothing. The phone's (`previewscore.ts`): `make` is the picker's file (`uri`),
  `release` does nothing (the picker's cache copy is not ours), `loaded` asks the transport for the picture (C4 fetches, checks and caches it) and `Image.prefetch`es
  it, and calls `done` when that ends in either way. `bootstrap.ts` registers it.

## What it draws
- `ImageStrip` (`composer-images`; the note under it `composer-images-note`): the draft's images (S10's `ImageThumb`, 64 px, with `uri` = the file it came from while
  `previewOf` has it), then the uploads that run (`busy`, their remove control cuts the upload); thumbnails wrap, 10 px apart, each remove control standing 6 px out
  of its corner (a finger reaches it: `hitSlop`). While the chat's server is not connected, or the composer is read-only, `onRemove` is not given: no remove control.
- `AttachButton` (`attach-btn`): the image icon, tooltip and label "Add images"; off with the reason as its title (`imagesOff`: "<server> is not connected: images
  can be added when it is back", "<model> takes no images"). It leaves the focus where it is (`keepFocus`). Measured in the toolbar's hidden layer without a testID.
- **`ChipInput.web` fix**: a paste of images into a **read-only** box reached nothing (K1 turned every paste off then); the old box handed images to `onImages` in every
  state, so that the composer can refuse them with the reason (C-IM-23). Images first, then the read-only rule for text.

## App config
`expo-image-picker`'s plugin entry: `photosPermission` (the text iOS shows before it asks for the photo library), `microphonePermission: false` (otherwise the
plugin adds `RECORD_AUDIO` on Android: S12's finding; the prebuilt manifest has `RECORD_AUDIO … tools:node="remove"`), and `cameraPermission` set to the camera plugin's
text, **not** `false` (that would block the `CAMERA` permission that the scan of a server's code needs). N1's ATS dict and S12's texts are unchanged
(`appconfig*.test.ts`).

## Checks
`IM3.2-images` (ported: all three viewports; the attach button through the browser's file chooser, a paste, the strip, Send while an upload runs, the draft over a reload,
a message of an image alone, a refused upload); `R3.12-images` (flag `COMPOSER` on: a section's chat's strip, the server away and back, an unstarted chat); `L18-imagelimits`
(new: ten at most, 6 MB refused, the sentences; the strip wraps, the remove controls stand out of their corners; a draft over 10 images or 20 MB holds Send with the
note under the thumbnails; a model with no images: the button off, a paste refused with the line, Send off with the sentence).

## Inventory rows made true on the new build
C-IM-01, 02, 03, 04, 05 (as the browser's paste event gives them; 05 and 06 are the desktop's), 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
28, 29 (by the logic of core, unchanged, and the strip that shows it); C-TX-02/05/07, C-DR-03 and C-RO-04/09 as `IM3.2` and `R3.12` prove them. New checks for the `none` rows:
C-IM-21 and C-IM-29 (`L18`).

## Not verified on a device (V4 and the by-hand list)
V4 ran the picker, the HEIC, the thumbnails and the refusals on the iOS simulator and the Android emulator: `v4-storage-picker-permission.md`. It found that a HEIC was handed over as a HEIC (refused as not an image) and fixed it (`compatible`); the list below is what is left.
- The photo library prompt and the picker on a real iOS and Android device (permission wording is checked in the prebuilt `Info.plist` and manifest only).
- HEIC from the iOS library: `expo-image-picker` is expected to give JPEG (`preferredAssetRepresentationMode` automatic); an original HEIC would be refused as "Not a PNG, JPEG, GIF
  or WebP image" (the type is taken from the bytes).
- `Image.prefetch` of the cached `file://` picture, and that the thumbnail does not blink as the upload ends (C-IM-11 on a device).
- Pasting an image into the native box (not offered; the picker is the way).
