// A sent message's images, above its text (ChatView.tsx): a thumbnail each, and a click shows the image large. The
// images are fetched from the chat's own address (imageUrl), whichever server the chat is on: the local server passes
// the fetch on. One that cannot be fetched is the plain tile, and is tried again when the chat's server is back.
import React, { useMemo, useState } from "react";
import "./chatimage.css";
import { ImageThumb } from "./ImageThumb.tsx";
import { ImageLarge } from "./ImageLarge.tsx";
import { shownImages } from "./logic/messageimages.ts";
import type { ChatImage } from "./types.ts";

/** chat: the top-level chat's id. alone: the message draws no words under the images. again: when it changes, the
 *  images that could not be fetched are tried once more (ImageThumb). */
export function MessageImages({ chat, images, alone, again }: { chat: string; images: readonly ChatImage[]; alone?: boolean; again?: unknown }) {
  const shown = useMemo(() => shownImages(chat, images), [chat, images]);
  const [open, setOpen] = useState<number | null>(null);
  if (!shown.length) return null;
  return (
    <div className={`msg-images${alone ? " alone" : ""}`}>
      {shown.map((im, i) => <ImageThumb key={`${i}:${im.id}`} src={im.src} name={im.name} again={again} onOpen={() => setOpen(i)} />)}
      {open !== null && open < shown.length && <ImageLarge images={shown} at={open} onAt={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}
