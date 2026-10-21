// The voice net on a phone (architecture VC-4): the page calls the service itself. A call is `fetch` of `expo/fetch` (its body is a
// stream, which RN's own fetch does not give), the socket is RN's `WebSocket` with the key as a header (RN's takes headers, a browser's
// does not). The key is read from the keystore for each call, put in the header and dropped. Every address comes from `origin.ts`.
import { fetch as expoFetch } from "expo/fetch";

import type { Keystore, VoiceNet } from "../ports.ts";
import { createDirectNet, type FetchLike, type RawSocket } from "./net.core.ts";
import { voiceURL } from "./origin.ts";

type SocketWithHeaders = new (url: string, protocols: string[], options: { headers: Record<string, string> }) => RawSocket;

export function nativeNet(keystore: Keystore): VoiceNet {
  return createDirectNet({
    fetch: ((url, init) => expoFetch(url, init)) as FetchLike,
    openSocket: (url, headers) => new (WebSocket as unknown as SocketWithHeaders)(url, [], { headers: headers ?? {} }),
    keyOf: async () => (await keystore.get?.()) ?? null,
    address: voiceURL,
    socketAuth: "header",
    // A clip is a public address of the service's storage: https only, and only one that came in a voices answer.
    previewOk: (url) => url.startsWith("https://"),
  });
}
