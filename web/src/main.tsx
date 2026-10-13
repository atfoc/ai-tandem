(window as any).EXCALIDRAW_ASSET_PATH = "/";
import React from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import "./flavours.css";
import "./flavours-canvas.css";
import { App } from "./App.tsx";
import { connect } from "./conn.ts";
import { flushAll, hasPendingSaves } from "./board.ts";
import { initTheme } from "./theme.ts";
import { watchKeptDrafts } from "./keptdrafts.ts";

// Autosave is always written before the tab goes away.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flushAll(); });
window.addEventListener("pagehide", () => { void flushAll(); });
window.addEventListener("beforeunload", (e) => { if (hasPendingSaves()) { void flushAll(); e.preventDefault(); } });
// The desktop app calls this and waits for it before it closes or reloads the window: there, a
// prevented beforeunload cancels the close with no prompt. True once every board is written.
(window as any).aiwbFlush = () => flushAll().then(() => !hasPendingSaves());

initTheme();
watchKeptDrafts(); // before the stream opens: its first snapshot saves the drafts a page before this one could not save
connect();
createRoot(document.getElementById("root")!).render(<App />);
