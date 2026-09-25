// The canvas: one Excalidraw for the selected board, plus the layers that show
// where an agent just worked and who is working on the board.
import React, { useEffect, useState } from "react";
import { Excalidraw, FONT_FAMILY } from "@excalidraw/excalidraw";
import { useStore, setState, getState, isBusy } from "./store.ts";
import { loadScene, sceneChanged, setLive, flush, liveBoard, type Scene } from "./board.ts";
import { AgentGlyph } from "./icons.tsx";
import type { ChatView } from "./types.ts";

// ---- drawing style (section 6)

const CLEAN = {
  currentItemRoughness: 0,              // "architect"
  currentItemRoundness: "sharp",
  currentItemArrowType: "sharp",
  currentItemFontFamily: FONT_FAMILY.Nunito, // Excalidraw's normal font
};

// Excalidraw keeps the user's style choices in appState only while the component lives; the canvas
// remounts per board, so the choices are carried here for the rest of the session (page lifetime).
let styleMemory: Record<string, unknown> = { ...CLEAN };

export function rememberStyle(appState: any) {
  for (const k of Object.keys(appState)) if (k.startsWith("currentItem")) styleMemory[k] = appState[k];
}

/** Excalidraw loads a scene when a .excalidraw file is dropped on it; the board's file is the app's. */
function blockSceneDrop(e: React.DragEvent) {
  const f = e.dataTransfer.files[0];
  if (f && (/\.(excalidraw|json)$/i.test(f.name) || f.type === "application/vnd.excalidraw+json")) {
    e.preventDefault(); e.stopPropagation(); // image and library drops still go through
  }
}

export function Canvas({ board }: { board: string }) {
  const b = useStore((s) => s.boards[board]);
  const [loaded, setLoaded] = useState<{ board: string; scene: Scene } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let gone = false;
    setErr("");
    loadScene(board).then(
      (scene) => { if (!gone) setLoaded({ board, scene }); },
      (e) => { if (!gone) setErr(e?.message ?? String(e)); },
    );
    return () => { gone = true; void flush(board); if (liveBoard === board) setLive(null, null); };
  }, [board]);

  if (err) return <div className="canvas-empty"><p>Couldn't open this board: {err}</p></div>;
  if (!b || !loaded || loaded.board !== board) return <div className="canvas-empty" />;
  const { scene } = loaded;
  const as = scene.appState ?? {};
  return (
    <div className="canvas" onDropCapture={blockSceneDrop}>
      <Excalidraw
        key={board}
        viewModeEnabled={!!b.archived}
        UIOptions={{ canvasActions: {
          loadScene: false,                      // no Open / ⌘O
          saveToActiveFile: false,               // no Save / ⌘S
          export: { saveFileToDisk: false } } }} // no Save to disk / ⌘⇧S; image export stays
        initialData={{
          elements: scene.elements,
          files: scene.files,
          appState: {
            viewBackgroundColor: as.viewBackgroundColor ?? "#ffffff",
            scrollX: as.scrollX ?? 0, scrollY: as.scrollY ?? 0, zoom: as.zoom ?? { value: 1 },
            ...styleMemory,
          } as any,
        }}
        excalidrawAPI={(api) => setLive(board, api)}
        onChange={(els, appState, files) => {
          if (!getState().boards[board]?.archived) sceneChanged(board, els, appState, files);
          rememberStyle(appState);
          const count = Object.keys(appState.selectedElementIds ?? {}).length;
          const v = getState().view;
          const z = appState.zoom.value;
          if (count !== getState().selection.count) setState({ selection: { count, lines: [] } });
          if (v.scrollX !== appState.scrollX || v.scrollY !== appState.scrollY || v.zoom !== z || v.width !== appState.width || v.height !== appState.height)
            setState({ view: { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: z, width: appState.width, height: appState.height } });
        }}
      />
      <FlashLayer board={board} />
      <Presence board={board} />
    </div>
  );
}

function FlashLayer({ board }: { board: string }) {
  const flashes = useStore((s) => s.flashes);
  const v = useStore((s) => s.view);
  return (
    <div className="flash-layer">
      {flashes.filter((f) => f.board === board).map((f) => {
        const pad = 10;
        const left = (f.box.x + v.scrollX) * v.zoom - pad, top = (f.box.y + v.scrollY) * v.zoom - pad;
        const w = f.box.width * v.zoom + pad * 2, h = f.box.height * v.zoom + pad * 2;
        return (
          <div key={f.id} className={`flash ${f.tone} agent-${f.agent}`} style={{ left, top, width: w, height: h }}>
            <span className="flash-tag"><AgentGlyph agent={f.agent} size={11} /> {f.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** "<Agent> is working on <board>" while one of the board's chats is busy, or another chat just edited it. */
function Presence({ board }: { board: string }) {
  const name = useStore((s) => s.boards[board]?.name ?? "");
  const own = useStore((s) => Object.values(s.chats).find((c: ChatView) => c.board === board && !c.archived && isBusy(c.status))?.agent);
  const other = useStore((s) => s.busyOn[board]?.agent);
  const agent = own ?? other;
  if (!agent) return null;
  return (
    <div className={`presence agent-${agent}`}>
      <AgentGlyph agent={agent} size={12} />
      <span>{agent === "cursor" ? "Cursor" : "Claude"} is working on {name}</span>
      <span className="dots"><i /><i /><i /></span>
    </div>
  );
}
