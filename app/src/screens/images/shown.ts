// A sent message's images as the thread shows them, and where the large view puts a picture. Pure: no React and no react-native, so Node loads it.
//
// `core/logic/messageimages.ts` `shownImages` gives each image a synchronous address (`imageUrl`), which only the ipc and http ways have; the
// app draws `<Picture server chat image>` (AD-25), which asks the transport for the address in the way of the platform. So here an image is
// what that address is made from.
import { IMAGE_WORD } from "@aiwb/core/logic/chatimage.ts";
import { splitKey } from "@aiwb/core/logic/keys.ts";
import type { ChatImage } from "@aiwb/core/types.ts";

/** One image of a message: the server and the chat's own id on it (what the picture's address is made from), the image's id, and the name
 *  its tile and the large view give it. */
export type ShownPicture = { id: string; server: string; chat: string; name: string };

/** A message's images, in the message's order (an image held twice is shown twice). chat: the page's key of the top-level chat
 *  (logic/keys.ts). An image without a name is named by the fixed word, so that a tile that cannot show the picture is never blank. */
export function shownPictures(chat: string, images: readonly ChatImage[] | undefined): ShownPicture[] {
  const at = splitKey(chat);
  return (images ?? []).map((im) => ({ id: im.id, server: at.server, chat: at.id, name: im.name?.trim() || IMAGE_WORD }));
}

export type Size = { width: number; height: number };

/** The size a picture of its own size `natural` is drawn at inside `box`: whole, in its own shape, and never larger than it is. */
export function fitInside(natural: Size, box: Size): Size {
  if (!(natural.width > 0) || !(natural.height > 0)) return { width: 0, height: 0 };
  const k = Math.min(1, Math.max(0, box.width) / natural.width, Math.max(0, box.height) / natural.height);
  return { width: Math.round(natural.width * k), height: Math.round(natural.height * k) };
}

/** The step the large view takes for a swipe of (dx, dy) points: -1 and 1 for a swipe right and left (the previous and the next image),
 *  "close" for a swipe down, 0 for anything that is not decided. */
export function swipeOf(dx: number, dy: number, velocityY = 0): -1 | 0 | 1 | "close" {
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) return dx > 0 ? -1 : 1;
  if (dy > 90 || (dy > 30 && velocityY > 800)) return "close";
  return 0;
}
