// The React side of the endpoint: Excalidraw for the board that is shown, with the options the page's Canvas.tsx gives it,
// the theme (Excalidraw's light or dark, the canvas filter laid over it, the colours of its chrome) and nothing else. It holds no state of its own:
// it renders the endpoint's store and tells the endpoint what Excalidraw does (hooks). With the phone's chrome set it gives Excalidraw
// a menu of its own (PhoneMenu.tsx) and its footer the look of one band (phonechrome.ts); without it, Excalidraw's own.
import React, { Component, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { CanvasFilterMsg, PhoneChromeMsg, ThemeMsg } from "@aiwb/board-bridge/messages.ts";
import { CanvasFilters } from "./CanvasFilters.tsx";
import { PhoneMenu } from "./PhoneMenu.tsx";
import { phoneCss, PHONE_CLASS, TOP_INSET_VAR, topInsetCss } from "./phonechrome.ts";
import type { Layer } from "./phonetheme.ts";
import { chromeCss } from "./theme.ts";

/** A board that is shown: `gen` is raised for each (the Excalidraw is keyed by it), `initialData` is what it starts from. */
export type Shown = { gen: number; board: string; initialData: object };
export type BoardState = { shown: Shown | null; viewMode: boolean; theme: ThemeMsg; phone: PhoneChromeMsg | null; /** Pixels kept free along the top edge (0: none). */ topInset: number };
/** The items of the phone's menu (PhoneMenu.tsx); the endpoint carries them out. */
export type MenuItem = "find" | "fit" | "export" | "share" | "clear";
export type BoardStore = { subscribe(listener: () => void): () => void; get(): BoardState };
export type BoardHooks = {
  /** The view runs. */
  mounted(): void;
  unmounted(): void;
  api(gen: number, api: unknown): void;
  change(gen: number, elements: readonly unknown[], appState: Record<string, unknown>, files: Record<string, unknown>): void;
  /** An item of the phone's menu was pressed. */
  menu(item: MenuItem): void;
  failed(message: string): void;
};

/** How a target draws the canvas filter: the CSS of it, and the layers rendered over the canvases (none for the SVG filter). */
export type BoardCanvas = (filter: CanvasFilterMsg | null) => { css: string; layers: Layer[] };

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

export function Board({ store, hooks, canvas }: { store: BoardStore; hooks: BoardHooks; canvas: BoardCanvas }) {
  const s = useSyncExternalStore(store.subscribe, store.get);
  useEffect(() => { hooks.mounted(); return () => hooks.unmounted(); }, [hooks]);
  const drawn = useMemo(() => canvas(s.theme.filter), [canvas, s.theme.filter]);
  const css = [drawn.css, chromeCss(s.theme.chrome), phoneCss(s.phone), topInsetCss(s.topInset)].filter(Boolean).join("\n");
  const shown = s.shown;
  return (
    <div className={s.phone ? `aiwb-board ${PHONE_CLASS}` : "aiwb-board"} style={{ position: "relative", width: "100%", height: "100%", ...(s.topInset > 0 ? { [TOP_INSET_VAR]: `${s.topInset}px` } : null) }} onDropCapture={blockSceneDrop}>
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
          >
            {s.phone && <PhoneMenu chrome={s.phone} viewMode={s.viewMode} onItem={hooks.menu} />}
          </Excalidraw>
        )}
      </Guard>
      {/* (after Excalidraw, so painted over both of its canvases and under the rest of it: the colours of the canvas filter, phonetheme.ts) */}
      {shown && drawn.layers.map((l) => (
        <div
          key={l.mode} className="aiwb-canvas-layer" aria-hidden="true"
          style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none", background: l.colour, mixBlendMode: l.mode }}
        />
      ))}
    </div>
  );
}
