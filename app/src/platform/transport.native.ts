// The transport of the phone's app (AD-21). The app makes the Client once and gives it to `useTransport` before it
// connects: `useTransport(nativeTransport(createNativeClient()))`. (`transport.web.ts` is U3's.)
import { createClient, parseAppWaits, type Client } from "@aiwb/conn";
import { useTransport } from "@aiwb/core/transport/index.ts";
import { getRandomValues } from "expo-crypto";
import * as FileSystem from "expo-file-system";
import { AppState } from "react-native";

import AiwbNetModule from "../../modules/aiwb-net/src/AiwbNetModule.ts";
import { withForcedOutcome } from "../dev/forceoutcome.ts";
import { pickImages } from "./imagepick.native.ts";
import { nativeConnector } from "./net/nativeConnector.ts";
import { createNativeTransport } from "./nativetransport.ts";
import { createPictureCache, type FsModule } from "./picturecache.ts";
import { serverStore } from "./serverstore.native.ts";

export { pictureFile } from "./picturefile.ts";

/** The Client of every server on a phone: the native module's Connector, the phone's Store, no server of its own
 *  (goal 4.1). The waits are the shared code's, lowered by `EXPO_PUBLIC_AIWB_APP_WAITS` (inlined at build, empty in a
 *  release build) so that a device test can lower them as `AIWB_APP_WAITS` does on the desktop (AD-14). */
export function createNativeClient(): Client {
  return createClient({
    connector: withForcedOutcome(nativeConnector(AiwbNetModule)), // (the forced outcome is a development build's: dev/forceoutcome.ts)
    store: serverStore(),
    local: null,
    timing: parseAppWaits(process.env.EXPO_PUBLIC_AIWB_APP_WAITS),
    random: (bytes) => getRandomValues(bytes),
  });
}

/** The transport over `client`, with the phone's app state, picture cache and picker. */
export function nativeTransport(client: Client) {
  return createNativeTransport(client, { appState: AppState, cache: createPictureCache(FileSystem as unknown as FsModule), pickImages });
}

/** The app's transport (what `transport.web.ts` does on the web): the client is made once and its transport is set before the
 *  app connects. Always true: a phone has a way. */
export function setUpTransport(): boolean {
  useTransport(nativeTransport(createNativeClient()));
  return true;
}
