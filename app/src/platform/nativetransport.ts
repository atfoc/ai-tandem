// The transport of iOS and Android (AD-21): in-process, over the Client of @aiwb/conn. A call goes to the Client as it
// is (the AbortSignal passed through), the stream is the Client's subscription, `app` answers as text what the Client
// answers as a value, and pictures and picking are the device's (AD-25, AD-26). The Client does all the rest — the
// headers, the secret, the path checks — as the main process does on the desktop.
// What the platform gives (the app's state, the picture cache, the picker) comes in `deps`, so that the tests give
// fakes; transport.native.ts gives the real ones.
import type { Client } from "@aiwb/conn";
import type { DesktopPick } from "@aiwb/core/logic/chatimage.ts";
import { TransportError, type CallBody, type Transport } from "@aiwb/core/transport/types.ts";

import { pictureFile, type PictureCache } from "./picturefile.ts";

/** The part of React Native's AppState that is used. */
export interface AppStatePort {
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void };
}

export type NativeDeps = {
  appState: AppStatePort;
  cache: PictureCache;
  pickImages?: () => Promise<DesktopPick>;
};

// A Blob is turned into bytes first; the Client takes bytes.
async function bytesOf(b: Uint8Array | Blob): Promise<Uint8Array> {
  if (b instanceof Uint8Array) return b;
  if (typeof b.arrayBuffer !== "function") throw new TransportError("this device cannot read a Blob body");
  return new Uint8Array(await b.arrayBuffer());
}

async function bodyOf(b: CallBody | undefined) {
  if (!b || "json" in b) return b;
  return { bytes: await bytesOf(b.bytes), type: b.type };
}

export function createNativeTransport(client: Client, deps: NativeDeps): Transport {
  const picture = pictureFile(client, deps.cache);
  return {
    way: "native",
    async call(req) {
      const { signal } = req;
      return client.call({ server: req.server, method: req.method, path: req.path, body: await bodyOf(req.body), signal });
    },
    stream(onEnvelope, onState) {
      // Going to the background does nothing here: the system may suspend the app and the streams may end, which the
      // Client sees as any other cut. Coming back, every connection in its back-off tries now.
      const sub = client.subscribe(onEnvelope);
      const app = deps.appState.addEventListener("change", (s) => { if (s === "active") client.wake(); });
      onState("open");
      let open = true;
      return {
        close() {
          if (!open) return;
          open = false;
          app.remove();
          sub.close();
        },
      };
    },
    picture,
    async app(op, args) {
      const a = await client.app(op, args);
      return { status: a.status, text: JSON.stringify(a.body) };
    },
    ...(deps.pickImages ? { pickImages: deps.pickImages } : {}),
  };
}
