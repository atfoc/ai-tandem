// The picture of a chat as a file on the phone (AD-25): fetched over the pinned session by the Client (which checks
// the bytes: PNG, JPEG, GIF or WebP, at most 5 MB, at most 8 at a time per server), written once under the system's
// cache folder and answered as its `file://` address. The image id is the SHA-256 of the bytes, so a file there never
// goes stale, and a file already there is answered without a fetch.
//
// Cancelling (D-PC-08): every caller may give a signal. Callers of the same picture (server, chat, image) share the one
// fetch that is running; a caller whose signal aborts is rejected at once and leaves it, and the fetch itself is aborted
// (down to the session, or out of the queue of eight) only when no caller is left. Once the bytes are in, nothing is
// aborted any more: the file is written and stays for the next caller.
import { TransportError, abortError } from "@aiwb/core/transport/types.ts";
import type { Client } from "@aiwb/conn";

/** The cache folder `Paths.cache/aiwb-pictures/<server>/<image id>`, over a file system (picturecache.ts). */
export interface PictureCache {
  /** The `file://` address of the cached picture, or null. */
  find(server: string, image: string): string | null;
  /** Writes the bytes and answers the address. A file that is half written is never answered by `find`. */
  put(server: string, image: string, data: Uint8Array): Promise<string>;
}

/** The server refused the picture (or could not be reached for it); `status` is the answer's. */
export class PictureError extends TransportError {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "PictureError"; this.status = status; }
}

// The names that make the path of a cached file: nothing the page says may leave the folder.
const SERVER = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE = /^[0-9a-f]{64}$/;

type Shared = { ctl: AbortController; wanted: number; fetched: boolean; done: Promise<string> };

export function pictureFile(client: Pick<Client, "picture">, cache: PictureCache) {
  const running = new Map<string, Shared>();

  function start(key: string, server: string, chat: string, image: string): Shared {
    const ctl = new AbortController();
    const shared = { ctl, wanted: 0, fetched: false } as Shared;
    shared.done = (async () => {
      const a = await client.picture({ server, chat, image, signal: ctl.signal });
      shared.fetched = true;
      if (ctl.signal.aborted) throw abortError(ctl.signal); // the last caller left as the bytes came: nothing is written
      if (!a.ok) throw new PictureError(a.status, a.text);
      return cache.put(server, image, a.data);
    })().finally(() => { if (running.get(key) === shared) running.delete(key); });
    shared.done.catch(() => {}); // a fetch every caller has left is rejected with no one to hear it
    running.set(key, shared);
    return shared;
  }

  return async (server: string, chat: string, image: string, signal?: AbortSignal): Promise<string> => {
    if (!SERVER.test(server) || !IMAGE.test(image)) throw new PictureError(400, "an image id is 64 lower-case hex digits");
    if (signal?.aborted) throw abortError(signal);
    const hit = cache.find(server, image);
    if (hit) return hit;
    const key = `${server}\n${chat}\n${image}`;
    const shared = running.get(key) ?? start(key, server, chat, image);
    shared.wanted++;
    if (!signal) return shared.done;
    let leave!: () => void;
    const left = new Promise<never>((_, reject) => {
      leave = () => {
        if (--shared.wanted === 0 && !shared.fetched) {
          if (running.get(key) === shared) running.delete(key); // a caller that comes next asks afresh
          shared.ctl.abort();
        }
        reject(abortError(signal));
      };
      signal.addEventListener("abort", leave, { once: true });
    });
    left.catch(() => {});
    try {
      return await Promise.race([shared.done, left]);
    } finally {
      signal.removeEventListener("abort", leave);
    }
  };
}
