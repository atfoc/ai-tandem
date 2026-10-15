// What the app does once at start (AD-76; the old page's main.tsx), in this order: the kv port, the app's version, the Ui and board-side
// seams of @aiwb/core, the lifecycle hooks, the transport (AD-20/21/22), the picture address (AD-25), the sidebar's first state on a
// narrow tablet, `watchKeptDrafts()` and `connect()`. It is the same on every target; what differs is behind the ports it calls
// (`platform/kv`, `transport`, `lifecycle`). It does nothing twice. False: the page has no way to a server (a web page opened as a
// file, or in a browser without the app), and the app says so.
import { Dimensions } from "react-native";

import { connect } from "@aiwb/core/state/conn.ts";
import { endSent } from "@aiwb/core/state/actions.ts";
import { watchKeptDrafts } from "@aiwb/core/state/keptdrafts.ts";
import { setBoardSide, setFlushBeforeReload, setKv, setUi } from "@aiwb/core/state/ports.ts";
import { setState } from "@aiwb/core/state/store.ts";
import { setPreviews } from "@aiwb/core/state/uploads.ts";
import { setPageVersion } from "@aiwb/core/state/version.ts";
import { transport } from "@aiwb/core/transport/index.ts";

import { kv } from "./platform/kv";
import { installLifecycle } from "./platform/lifecycle";
import { previews } from "./platform/previews";
import { setPictureAddress } from "./platform/picturecommon.tsx";
import { setUpTransport } from "./platform/transport";
import { boardApp } from "./screens/shell/boardside.ts";
import { appUi } from "./screens/shell/nav.ts";
import { startsHidden } from "./screens/shell/widths.ts";
import { layoutOf } from "./ui/breakpoints.ts";

let started: boolean | null = null;

export function bootstrap(): boolean {
  if (started !== null) return started;
  // The seams of @aiwb/core, before the store is first read: this app's storage, screens and boards.
  setKv(kv);
  setPageVersion(process.env.EXPO_PUBLIC_AIWB_VERSION ?? "dev");
  setUi(appUi);
  setBoardSide(boardApp);
  if (previews) setPreviews(previews); // what an image's thumbnail shows while it uploads (the web build keeps core's own: the browser's)
  // The desktop window calls `window.aiwbFlush` and waits for it before it closes or reloads; true once every board is written.
  setFlushBeforeReload(() => boardApp.flushAll().then(() => !boardApp.hasPendingSaves()));
  installLifecycle({ flushAll: () => boardApp.flushAll(), hasPendingSaves: () => boardApp.hasPendingSaves(), endSent });
  if (!setUpTransport()) return (started = false);
  // A picture's address is the transport's, whatever the way: at once on web, after the fetch and the cache on a phone.
  setPictureAddress((server, chat, image, signal) => transport().picture(server, chat, image, signal));
  // A tablet window too narrow for the sidebar beside the stage starts with it hidden, unless the user chose (it is not saved).
  const width = Dimensions.get("window").width;
  if (startsHidden(layoutOf(width), width, kv.get("aiwb.side"))) setState({ sideHidden: true });
  watchKeptDrafts(); // before the stream opens: its first snapshot saves the drafts a page before this one could not save
  connect();
  return (started = true);
}
