// An image of a message shown large, over the page (a click on its thumbnail: MessageImages.tsx). Escape, the close
// button and a press beside the picture close it; with several images the arrow keys and the two buttons at the sides
// go from one to the next. It is drawn on document.body, outside the thread: its texts are no part of any message.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./chatimage.css";
import { largeCaption, stepImage, type ShownImage } from "./logic/messageimages.ts";

const Arrow = ({ back }: { back?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={back ? "M9 2L4 7l5 5" : "M5 2l5 5-5 5"} /></svg>
);

/** at: which of images is shown; onAt: another one is asked for. */
export function ImageLarge({ images, at, onAt, onClose }: { images: readonly ShownImage[]; at: number; onAt: (at: number) => void; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const image = images[at], count = images.length;
  // The focus is the view's while it is open, and goes back to what had it (the thumbnail), if that is still there.
  useEffect(() => {
    const before = document.activeElement;
    close.current?.focus({ preventScroll: true });
    return () => { if (before instanceof HTMLElement && before.isConnected && (document.activeElement === document.body || !document.activeElement)) before.focus({ preventScroll: true }); };
  }, []);
  // The keys are the view's before anything under it sees them (the composer's Escape would stop the agent).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); onAt(stepImage(at, count, e.key === "ArrowRight" ? 1 : -1)); return; }
      if (e.key !== "Tab") return;
      const els = [...(root.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const i = els.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length]?.focus();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [at, count, onAt, onClose]);
  if (!image) return null;
  return createPortal(
    // (a press, a click and a key in the view are not the message's it was opened from, nor the canvas's)
    <div ref={root} className="img-large" role="dialog" aria-modal="true" aria-label={image.name}
      onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {failed === image.src
        ? <div className="img-large-off">This image cannot be shown.</div>
        : <img key={image.src} className="img-large-pic" src={image.src} alt={image.name} draggable={false} onError={() => setFailed(image.src)} />}
      <div className="img-large-name" title={image.name}>{largeCaption(image.name, at, count)}</div>
      <button ref={close} type="button" className="img-large-btn img-large-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" /></svg>
      </button>
      {count > 1 && (
        <>
          {/* (at an end a step is marked as off, not disabled: a disabled button that has the focus would take the keys with it) */}
          <button type="button" className="img-large-btn img-large-prev" aria-label="Previous image" title="Previous (←)" aria-disabled={at <= 0} onClick={() => onAt(stepImage(at, count, -1))}><Arrow back /></button>
          <button type="button" className="img-large-btn img-large-next" aria-label="Next image" title="Next (→)" aria-disabled={at >= count - 1} onClick={() => onAt(stepImage(at, count, 1))}><Arrow /></button>
        </>
      )}
    </div>,
    document.body,
  );
}
