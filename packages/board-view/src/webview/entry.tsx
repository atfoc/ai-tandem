// The board in the web view (AD-51): the endpoint wired to the app's side of `react-native-webview`. Out:
// `window.ReactNativeWebView.postMessage(JSON.stringify(m))`. In: the app calls the web view's `postMessage(json)`, which the
// page hears as a `message` event, on `window` (iOS) or on `document` (react-native-webview on Android `[not verified]`: B5
// checks), with no source window: that is what the app's own messages look like, and the only events taken. The text is
// parsed and validated, and what fails is logged and dropped. The listeners are bound before the first render, and `ready`
// is posted from the mount effect, so a message sent on `ready` finds them.
// `window.aiwbBoardReceive(json)` is the entry of the plain-browser harness (dev/harness.mjs) only; the app never calls it.
// (first: where Excalidraw's fonts are, and that it takes them from nowhere else; the page's inline script has put the
// fonts in the page and swaps each font address for them)
import "../fonts.ts";
import React from "react";
import { createRoot } from "react-dom/client";
import type { FromBoard } from "@aiwb/board-bridge/messages.ts";
import { parseToBoard } from "@aiwb/board-bridge/validate.ts";
import { createEndpoint } from "../endpoint.ts";
import "@excalidraw/excalidraw/index.css";
import "./page.css";

declare const __EXCALIDRAW_VERSION__: string;
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(text: string): void };
    aiwbBoardReceive?: (json: unknown) => void;
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

const post = (m: FromBoard) => window.ReactNativeWebView?.postMessage(JSON.stringify(m));
const endpoint = createEndpoint(post, { version: __EXCALIDRAW_VERSION__ });

function receive(json: unknown) {
  const r = parseToBoard(json);
  if (r.ok) endpoint.receive(r.value);
  else {
    let raw: unknown = null;
    try { raw = typeof json === "string" ? JSON.parse(json) : null; } catch { /* not JSON: nothing to answer */ }
    endpoint.refuse(raw, r.error);
  }
}

// Only the app's own messages: the ones the web view's `postMessage` dispatches have no source window. A frame cannot be
// embedded (CSP frame-src), and a message from one, or from `window.postMessage` of the page itself, has a source. An event
// that is heard on `document` and then on `window` (if it bubbles) is taken once.
const taken = new WeakSet<Event>();
function onMessage(e: Event) {
  const m = e as MessageEvent;
  if (m.source !== null || taken.has(e)) return;
  taken.add(e);
  receive(m.data);
}
window.addEventListener("message", onMessage);
document.addEventListener("message", onMessage);

window.aiwbBoardReceive = receive;

const Mount = endpoint.mount;
createRoot(document.getElementById("root")!).render(<Mount />);
