// The thumbnail of an image while it uploads, on a phone (core's state/uploads.ts `Previews`): the file the picker left in the app's cache (the picker's
// `uri`, kept by `fromDesktop`) until the image's own address has loaded. That address is asked of the transport (the picture is fetched, checked and
// cached on disk by C4's `pictureFile`) and prefetched, so the thumbnail does not blink as the upload ends; if either fails the thumbnail goes
// all the same (the tile of an image that cannot be had is <Picture>'s). The picker's file is not ours to delete. `prefetch` is React Native's
// `Image.prefetch`, given so that a test gives a fake.
import { imageAddress, isBytesFile } from "@aiwb/core/logic/chatimage.ts";
import type { Previews } from "@aiwb/core/state/uploads.ts";

export function nativePreviews(prefetch: (uri: string) => Promise<unknown>): Previews {
  return {
    make: (file) => (isBytesFile(file) ? file.uri ?? "" : ""),
    release() {},
    loaded(chat, id, done) {
      imageAddress(chat, id).then((uri) => prefetch(uri)).then(() => done(), () => done());
      return true;
    },
  };
}
