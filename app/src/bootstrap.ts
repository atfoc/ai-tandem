// What the app does once at start (AD-76; the old page's main.tsx), in this order: the kv port, the app's version, the Ui and board-side
// seams of @aiwb/core, the lifecycle hooks, the transport (AD-20/21/22), the picture address (AD-25), the iOS local network feed, the sidebar's first state on a
// narrow tablet, `watchKeptDrafts()` and `connect()`. It is the same on every target; what differs is behind the ports it calls
// (`platform/kv`, `transport`, `lifecycle`). It does nothing twice. False: the page has no way to a server (a web page opened as a
// file, or in a browser without the app), and the app says so.
import { AppState, Dimensions, Platform } from "react-native";

import { connect, onEntryGone } from "@aiwb/core/state/conn.ts";
import { endSent } from "@aiwb/core/state/actions.ts";
import { watchKeptDrafts } from "@aiwb/core/state/keptdrafts.ts";
import { setBoardSide, setFlushBeforeReload, setKv, setUi } from "@aiwb/core/state/ports.ts";
import { setLocalNetworkDenied, setState } from "@aiwb/core/state/store.ts";
import { setPreviews } from "@aiwb/core/state/uploads.ts";
import { setPageVersion } from "@aiwb/core/state/version.ts";
import { transport } from "@aiwb/core/transport/index.ts";

import { kv } from "./platform/kv";
import { installLifecycle } from "./platform/lifecycle";
import { localNetwork } from "./platform/localnetwork";
import { feedLocalNetwork } from "./platform/localnetworkfeed.ts";
import { previews } from "./platform/previews";
import { setPictureAddress } from "./platform/picturecommon.tsx";
import { setUpTransport } from "./platform/transport";
import { setVoicePorts } from "./voice/ports.ts";
import { platformVoicePorts } from "./voice/platform/index";
import { boardApp } from "./screens/shell/boardside.ts";
import { forgetOpenedOn } from "./screens/home/recent.ts";
import { forgetHomeServer, loadHomePlace } from "./screens/shell/homeplace.ts";
import { appUi } from "./screens/shell/nav.ts";
import { startsHidden } from "./screens/shell/widths.ts";
import { windowLayout } from "./ui/useLayout.ts";

let started: boolean | null = null;

export function bootstrap(): boolean {
  if (started !== null) return started;
  // The seams of @aiwb/core, before the store is first read: this app's storage, screens and boards.
  setKv(kv);
  loadHomePlace(); // the phone's Home place, saved as the selection is (the store reads "aiwb.sel" from the same kv)
  onEntryGone((id) => { forgetHomeServer(id); forgetOpenedOn(id); }); // (a removed entry leaves nothing of it in the kv)
  setPageVersion(process.env.EXPO_PUBLIC_AIWB_VERSION ?? "dev");
  setUi(appUi);
  setBoardSide(boardApp);
  setVoicePorts(platformVoicePorts()); // voice's ports: the key's store, the calls to the service, the audio; nothing is started until a tap
  if (previews) setPreviews(previews); // what an image's thumbnail shows while it uploads (the web build keeps core's own: the browser's)
  // The desktop window calls `window.aiwbFlush` and waits for it before it closes or reloads; true once every board is written.
  setFlushBeforeReload(() => boardApp.flushAll().then(() => !boardApp.hasPendingSaves()));
  installLifecycle({ flushAll: () => boardApp.flushAll(), hasPendingSaves: () => boardApp.hasPendingSaves(), endSent });
  if (!setUpTransport()) return (started = false);
  // A picture's address is the transport's, whatever the way: at once on web, after the fetch and the cache on a phone.
  setPictureAddress((server, chat, image, signal) => transport().picture(server, chat, image, signal));
  // A tablet window too narrow for the sidebar beside the stage starts with it hidden, unless the user chose (it is not saved).
  const width = Dimensions.get("window").width;
  if (startsHidden(windowLayout(), width, kv.get("aiwb.side"))) setState({ sideHidden: true });
  feedLocalNetwork({ port: localNetwork, appState: AppState, ios: Platform.OS === "ios", set: setLocalNetworkDenied }); // iOS only: the store's `localNetworkDenied`, for "Local network off"
  watchKeptDrafts(); // before the stream opens: its first snapshot saves the drafts a page before this one could not save
  connect();
  return (started = true);
}
