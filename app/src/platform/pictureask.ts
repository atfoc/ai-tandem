// What <Picture> on a phone does to get its address (AD-25), apart from React so that a test can run it: ask the seam with
// a signal, say the answer or the failure to the shell, and hand back the way to stop asking. Stopping (the picture
// scrolled out, its message gone, another address asked for) aborts the signal, which cancels the fetch down to the session
// (D-PC-08), and nothing is said to the shell afterwards, whichever way the request ends.
import type { PictureAddress } from "./picturecommon.tsx";

export function askPicture(
  ask: PictureAddress, server: string, chat: string, image: string,
  on: { address(a: string): void; failed(): void },
): () => void {
  let live = true;
  const ctl = new AbortController();
  Promise.resolve().then(() => ask(server, chat, image, ctl.signal)).then(
    (a) => { if (live) on.address(a); },
    () => { if (live) on.failed(); },
  );
  return () => { live = false; ctl.abort(); };
}
