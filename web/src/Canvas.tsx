// The canvas: one Excalidraw for the selected board, plus the layers that show
// where an agent just worked, who is working on the board, and the point being
// picked for a chat (⌘⇧L).
import React, { useEffect, useRef, useState } from "react";
import { Excalidraw, FONT_FAMILY } from "@excalidraw/excalidraw";
import { useStore, setState, getState, flash } from "./store.ts";
import { chatBusy } from "./logic/status.ts";
import { loadScene, sceneChanged, setLive, flush, liveBoard, pointRefOn, type Scene } from "./board.ts";
import { insertRef, pickPoint } from "./Composer.tsx";
import { pointLabel } from "./logic/refs.ts";
import { AgentGlyph } from "./icons.tsx";
import { agentClass, agentShortName } from "./agents.ts";
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
  const theme = useStore((s) => s.theme);
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
        theme={theme}                            // the app's theme; Excalidraw's own toggle is hidden
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
      <PickLayer board={board} />
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
          <div key={f.id} className={`flash ${f.tone} agent-${agentClass(f.agent)}`} style={{ left, top, width: w, height: h }}>
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
  const own = useStore((s) => Object.values(s.chats).find((c: ChatView) => c.board === board && !c.archived && chatBusy(c))?.agent);
  const other = useStore((s) => s.busyOn[board]?.agent);
  const agent = own ?? other;
  if (!agent) return null;
  return (
    <div className={`presence agent-${agentClass(agent)}`}>
      <AgentGlyph agent={agent} size={12} />
      <span>{agentShortName(agent)} is working on {name}</span>
      <span className="dots"><i /><i /><i /></span>
    </div>
  );
}

/**
 * While a chat of this board waits for a point (⌘⇧L): a crosshair over the
 * canvas; a click puts the point, in board coordinates, into the chat's message.
 * Esc cancels. The wheel still pans and zooms the board underneath.
 */
function PickLayer({ board }: { board: string }) {
  const chat = useStore((s) => (s.picking && s.chats[s.picking]?.board === board ? s.chats[s.picking] : undefined));
  const v = useStore((s) => s.view);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chat) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); pickPoint(null); } };
    const el = ref.current;
    const wheel = (e: WheelEvent) => { // hand the wheel to the canvas below
      e.preventDefault();
      if (!el) return;
      el.style.pointerEvents = "none";
      const under = document.elementFromPoint(e.clientX, e.clientY);
      el.style.pointerEvents = "";
      under?.dispatchEvent(new WheelEvent("wheel", e));
    };
    window.addEventListener("keydown", k, true);
    el?.addEventListener("wheel", wheel, { passive: false });
    return () => { window.removeEventListener("keydown", k, true); el?.removeEventListener("wheel", wheel); };
  }, [chat?.id]);
  if (!chat) return null;

  const toBoard = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / v.zoom - v.scrollX, y: (e.clientY - r.top) / v.zoom - v.scrollY, sx: e.clientX - r.left, sy: e.clientY - r.top };
  };
  return (
    <div ref={ref} className="pick-layer"
      onPointerMove={(e) => { const p = toBoard(e); setAt({ x: p.sx, y: p.sy }); }}
      onPointerLeave={() => setAt(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const p = toBoard(e);
        const r = pointRefOn(board, p.x, p.y);
        pickPoint(null);
        insertRef(chat.id, r);
        if (r.kind === "point") flash({ board, box: { x: r.x - 6, y: r.y - 6, width: 12, height: 12 }, agent: chat.agent, label: r.label, tone: "edit" }, 1600);
      }}>
      <div className="pick-hint">Click a point to add it to the chat <kbd>Esc</kbd> to cancel</div>
      {at && (() => {
        const bx = at.x / v.zoom - v.scrollX, by = at.y / v.zoom - v.scrollY;
        return <span className="pick-coord" style={{ left: at.x + 14, top: at.y + 14 }}>{pointLabel(bx, by)}</span>;
      })()}
    </div>
  );
}
