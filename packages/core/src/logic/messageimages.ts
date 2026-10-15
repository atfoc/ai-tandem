// A sent message's images in the thread: whether the message's words are drawn, its thumbnails, and the steps of the
// large view (MessageImages.tsx, ImageLarge.tsx). What names such a message in one line is nameText (quotes.ts) and
// chatTitle (labels.ts). DOM-free.

import { IMAGE_WORD, imageUrl } from "./chatimage.ts";
import type { ChatImage, Item } from "../types.ts";

/** A user message as the thread draws it: an item of the chat, or the message on its way (logic/waits.ts). */
export type Said = Pick<Item, "text" | "references" | "images">;

/** Whether a user message's words are drawn. A message of quotes or of images alone has none to show; one with nothing
 *  at all still draws its empty text, so that the message is there. */
export const showsText = (m: Said): boolean => !!m.text?.trim() || !(m.references?.length || m.images?.length);

/** One image as the thread shows it: where its bytes are fetched from, and the name its tile and the large view give it. */
export type ShownImage = { id: string; src: string; name: string };

/** A message's images as its thumbnails, in the message's order. chat: the top-level chat's id (imageUrl). An image
 *  without a name is named by the fixed word, so that a tile that cannot show the picture is never blank. */
export const shownImages = (chat: string, images: readonly ChatImage[] | undefined): ShownImage[] =>
  (images ?? []).map((im) => ({ id: im.id, src: imageUrl(chat, im.id), name: im.name?.trim() || IMAGE_WORD }));

/** Where the large view is after a step of `by` from `at` among `count` images: it stops at both ends. */
export const stepImage = (at: number, count: number, by: number): number => Math.max(0, Math.min(count - 1, at + by));

/** The large view's line under the picture: the image's name, and which of several it is. */
export const largeCaption = (name: string, at: number, count: number): string => (count > 1 ? `${name} · ${at + 1} of ${count}` : name);
