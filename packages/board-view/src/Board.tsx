// The React side of the endpoint: Excalidraw for the board that is shown, with the options the page's Canvas.tsx gives it,
// the theme (Excalidraw's light or dark, the canvas filter laid over it, the colours of its chrome) and nothing else. It holds no state of its own:
// it renders the endpoint's store and tells the endpoint what Excalidraw does (hooks).
import React, { Component, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ThemeMsg } from "@aiwb/board-bridge/messages.ts";
import { CanvasFilters } from "./CanvasFilters.tsx";
import { chromeCss, themeCss } from "./theme.ts";

/** A board that is shown: `gen` is raised for each (the Excalidraw is keyed by it), `initialData` is what it starts from. */
export type Shown = { gen: number; board: string; initialData: object };
export type BoardState = { shown: Shown | null; viewMode: boolean; theme: ThemeMsg };
export type BoardStore = { subscribe(listener: () => void): () => void; get(): BoardState };
export type BoardHooks = {
  /** The view runs. */
  mounted(): void;
  unmounted(): void;
  api(gen: number, api: unknown): void;
  change(gen: number, elements: readonly unknown[], appState: Record<string, unknown>, files: Record<string, unknown>): void;
  failed(message: string): void;
};

const UI_OPTIONS = {
  canvasActions: {
    loadScene: false,                      // no Open / ⌘O
    saveToActiveFile: false,               // no Save / ⌘S
    export: { saveFileToDisk: false },     // no Save to disk / ⌘⇧S; image export stays
  },
};

/** Excalidraw loads a scene when a .excalidraw file is dropped on it; the board's file is the app's. */
function blockSceneDrop(e: React.DragEvent) {
  const f = e.dataTransfer.files[0];
  if (f && (/\.(excalidraw|json)$/i.test(f.name) || f.type === "application/vnd.excalidraw+json")) {
    e.preventDefault(); e.stopPropagation(); // image and library drops still go through
  }
}

class Guard extends Component<{ failed(message: string): void; children: ReactNode }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() { return { broken: true }; }
  componentDidCatch(error: unknown) { this.props.failed((error as Error)?.message ?? String(error)); }
  render() { return this.state.broken ? null : this.props.children; }
}

export function Board({ store, hooks }: { store: BoardStore; hooks: BoardHooks }) {
  const s = useSyncExternalStore(store.subscribe, store.get);
  useEffect(() => { hooks.mounted(); return () => hooks.unmounted(); }, [hooks]);
  const css = [themeCss(s.theme.filter), chromeCss(s.theme.chrome)].filter(Boolean).join("\n");
  const shown = s.shown;
  return (
    <div className="aiwb-board" style={{ position: "relative", width: "100%", height: "100%" }} onDropCapture={blockSceneDrop}>
      {css && <style>{css}</style>}
      <CanvasFilters filter={s.theme.filter} />
      <Guard failed={hooks.failed} key={shown?.gen ?? 0}>
        {shown && (
          <Excalidraw
            key={shown.gen}
            theme={s.theme.mode}
            viewModeEnabled={s.viewMode}
            UIOptions={UI_OPTIONS}
            initialData={shown.initialData as never}
            excalidrawAPI={(api) => hooks.api(shown.gen, api)}
            onChange={(els, appState, files) => hooks.change(shown.gen, els, appState as never, files as never)}
          />
        )}
      </Guard>
    </div>
  );
}
