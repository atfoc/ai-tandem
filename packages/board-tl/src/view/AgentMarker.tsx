// The agent's marker (D11): for each chat whose agent just changed the board, a dashed outline around what it touched, with a
// pill labelled with the agent's name at its top-left. The bounds are page coordinates, so both follow the camera; the marker
// stays `ttlMs`, then fades (MARKER_FADE_MS) and goes. A child of `<Tldraw>` (it needs the editor for the camera).
import { useSyncExternalStore, type CSSProperties } from "react";
import { useEditor, useValue } from "tldraw";
import { MARKER_FADE_MS, type AgentMarkers, type Marker } from "./sync.ts";

/** A marker's box in the viewport (CSS px) for a camera: screen = (page + camera) * zoom. */
export function markerBox(b: Marker["bounds"], cam: { x: number; y: number; z: number }) {
  return { left: (b.x + cam.x) * cam.z, top: (b.y + cam.y) * cam.z, width: b.w * cam.z, height: b.h * cam.z };
}

export function AgentMarker({ markers }: { markers: AgentMarkers }) {
  const editor = useEditor();
  const list = useSyncExternalStore(markers.subscribe, markers.getSnapshot);
  const cam = useValue("aiwb marker camera", () => {
    const c = editor.getCamera();
    return { x: c.x, y: c.y, z: c.z };
  }, [editor]);
  if (!list.length) return null;
  return (
    <div className="aiwb-agent-markers" aria-hidden>
      {list.map((m) => {
        const pad = 6; // a little outside the elements, so the outline does not sit on their own edges
        const r = markerBox({ x: m.bounds.x - pad / cam.z, y: m.bounds.y - pad / cam.z, w: m.bounds.w + (2 * pad) / cam.z, h: m.bounds.h + (2 * pad) / cam.z }, cam);
        const style = { ...r, animationDelay: `${m.ttlMs}ms`, animationDuration: `${MARKER_FADE_MS}ms` } as CSSProperties;
        return (
          <div key={m.seq} className="aiwb-agent-marker" data-chat={m.chat} style={style}>
            <span className="aiwb-agent-pill">{m.label}</span>
          </div>
        );
      })}
    </div>
  );
}
