(window as any).EXCALIDRAW_ASSET_PATH = "/";
import React from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import { App } from "./App.tsx";
import { connect } from "./conn.ts";
import { flushAll, hasPendingSaves } from "./board.ts";

// Autosave is always written before the tab goes away.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flushAll(); });
window.addEventListener("pagehide", () => { void flushAll(); });
window.addEventListener("beforeunload", (e) => { if (hasPendingSaves()) { void flushAll(); e.preventDefault(); } });

connect();
createRoot(document.getElementById("root")!).render(<App />);
