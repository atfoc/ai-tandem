// Modal pieces: the confirm dialog the sidebar menus use and the small popup menu.
import React, { useEffect, useRef, useState } from "react";
import { useStore, setState } from "./store.ts";

export type ConfirmRequest = {
  title: string; body?: string;
  /** refused: what an action's failure is answered with: another dialog in this one's place (a
   *  chat on a server that is not connected can be removed from this sidebar only), or null to
   *  show the error's sentence here. */
  actions: { label: string; tone?: "danger" | "primary"; run: () => Promise<void> | void; refused?: (err: unknown) => ConfirmRequest | null }[]; // plus Cancel
};

export function confirm(req: ConfirmRequest): void { setState({ confirm: req }); }

/** Shows an error the user should see, in the confirm dialog with only a Close button. */
export function reportError(title: string, err: unknown) {
  confirm({ title, body: err instanceof Error ? err.message : String(err), actions: [] });
}

export function ConfirmDialog(): React.JSX.Element | null {
  const req = useStore((s) => s.confirm);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const close = () => { setState({ confirm: null }); setErr(""); setBusy(false); };
  // The focus goes back to what had it when the dialog opened (a menu's button, a row), if that is still there.
  useEffect(() => {
    if (!req) return;
    const before = document.activeElement;
    return () => { if (before instanceof HTMLElement && before.isConnected && (document.activeElement === document.body || !document.activeElement)) before.focus({ preventScroll: true }); };
  }, [!req]);
  useEffect(() => {
    if (!req) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [req]);
  if (!req) return null;
  const run = async (a: ConfirmRequest["actions"][number]) => {
    setBusy(true); setErr("");
    try { await a.run(); close(); } catch (e: any) {
      const next = a.refused?.(e);
      if (next) setState({ confirm: next }); else setErr(e?.message ?? String(e));
      setBusy(false);
    }
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={req.title}>
        <div className="dialog-title">{req.title}</div>
        {req.body && <div className="dialog-body">{req.body}</div>}
        {err && <div className="dialog-err">{err}</div>}
        <div className="dialog-actions">
          <button className="btn sm" onClick={close} autoFocus={!req.actions.length}>{req.actions.length ? "Cancel" : "Close"}</button>
          {req.actions.map((a, i) => (
            <button key={a.label} className={`btn sm ${a.tone ?? ""}`} disabled={busy} autoFocus={i === req.actions.length - 1}
              onClick={() => run(a)}>{a.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Menu({ children, onClose, align = "left" }: { children: React.ReactNode; onClose: () => void; align?: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    // (the Escape is marked as taken: the server choice of a new whiteboard under the menu does not drop its draft for it)
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    const t = setTimeout(() => document.addEventListener("mousedown", h));
    document.addEventListener("keydown", k);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, []);
  return <div ref={ref} className={`menu ${align}`} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>{children}</div>;
}
