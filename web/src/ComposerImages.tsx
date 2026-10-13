// What a chat's composer draws of its images: the strip of thumbnails above the text, and the attach button of its
// toolbar's row. The images a composer holds are its own state (Composer.tsx); the uploads that run are the branch's
// (uploads.ts), so a composer opened again shows them again. The same for a chat on this computer and on another
// server: an image's address is the chat's own, and the local server passes its fetch on.
import React, { useSyncExternalStore } from "react";
import "./composerimages.css";
import { ImageThumb } from "./ImageThumb.tsx";
import { IMAGE_TYPES, fromDesktop, imageUrl, type Refused } from "./logic/chatimage.ts";
import { cancelUpload, previewOf, previewsAt, slotOf, subscribe, type Picked, type Slot } from "./uploads.ts";
import type { ChatImage } from "./types.ts";

/** The uploads and the image error line of a branch's composer (uploads.ts Slot), as they change. */
export const useUploads = (chat: string, branch: string): Slot => useSyncExternalStore(subscribe, () => slotOf(chat, branch));

/** The strip above the composer's text: the images the message will carry, then the ones being uploaded, each with its
 *  remove control (of an upload: it is cut). An image uploaded from this page shows the file it came from until its own
 *  address has loaded (uploads.ts previewOf). note: why Send is off for the images, under them. Nothing for a message
 *  with no image. While the chat's server is not connected a draft keeps its images: one the browser fetched before
 *  still shows, another is the plain tile with the image's name. The composer is read-only then, and no image has a
 *  remove control (onRemove is none); an upload that runs can still be ended. again: when it changes (that server is
 *  connected again), the images that could not be fetched are tried once more. */
export function ImageStrip({ chat, branch, images, uploads, note, again, onRemove }: {
  chat: string; branch: string; images: readonly ChatImage[]; uploads: Slot["uploads"]; note: string; again?: unknown; onRemove?: (id: string) => void;
}) {
  useSyncExternalStore(subscribe, previewsAt); // a thumbnail goes from its file to the image's address when that has loaded
  if (!images.length && !uploads.length) return null;
  return (
    <div className="composer-images">
      <div className="composer-images-row">
        {images.map((x) => <ImageThumb key={x.id} src={previewOf(chat, x.id) ?? imageUrl(chat, x.id)} name={x.name} again={again} onRemove={onRemove ? () => onRemove(x.id) : undefined} />)}
        {uploads.map((u) => <ImageThumb key={`up:${u.key}`} src={u.src} name={u.name} busy onRemove={() => cancelUpload(chat, branch, u.key)} />)}
      </div>
      {note && <div className="composer-images-note">{note}</div>}
    </div>
  );
}

const AttachIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2.75" width="12" height="10.5" rx="2" /><circle cx="5.75" cy="6.25" r="1.1" /><path d="m2.5 11.5 3.25-3 2.5 2.25 2-1.75 3.25 3" />
  </svg>
);

/** The files the user picks: with the desktop app's own dialog when the app has one, else with the browser's picker
 *  (a browser tab, and an older desktop app showing this page). skipped: what the desktop app's dialog left out. A
 *  cancelled dialog answers no files. */
export async function pickImages(): Promise<{ files: Picked[]; skipped: Refused[] }> {
  if (typeof window.aiwbDesktop?.pickImages === "function") return fromDesktop(await window.aiwbDesktop.pickImages());
  return { files: (await browserPick()).map((f) => ({ file: f, name: f.name })), skipped: [] };
}

/** The browser's own picker, for several files of the types a chat takes. */
function browserPick(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true; input.accept = IMAGE_TYPES.join(","); input.hidden = true;
    const end = (files: File[]) => { input.remove(); resolve(files); };
    input.addEventListener("change", () => end([...(input.files ?? [])]));
    input.addEventListener("cancel", () => end([]));
    document.body.append(input);
    input.click();
  });
}

/** The attach button of the composer's toolbar row. off: why it adds nothing now (logic/chatimage.ts imagesOff: the
 *  chat's server is not connected, or the model takes no images), which is its tooltip then. A press with the mouse leaves the focus where it is, as the insert button's does. */
export function AttachButton({ off, onClick }: { off: string; onClick: () => void }) {
  return (
    <button type="button" className="icon-btn attach-btn" title={off || "Add images"} aria-label="Add images" disabled={!!off}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <AttachIcon />
    </button>
  );
}
