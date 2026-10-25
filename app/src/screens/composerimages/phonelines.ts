// What the phone's image strip says under its thumbnails (ux-improvements goal 3.6, "Images in the box"; mockup co-04b): a file that was not added is
// a marked tile with its reason in red, and a limit is said only when it is hit, naming what was left out. The words are core's where core has them
// (logic/chatimage.ts: the types, the limits); the sentence per file is the phone's. No React: tested in app/test/phoneimages.test.ts.
import { IMAGES_MESSAGE_BYTES, IMAGES_PER_MESSAGE, IMAGE_MAX_BYTES } from "@aiwb/core/logic/chatimage.ts";
import type { RefusedFile } from "@aiwb/core/state/uploads.ts";

const TYPE_NAMES = "PNG, JPEG, GIF or WebP";
const mb = (bytes: number): string => `${bytes / (1024 * 1024)} MB`;

/** The reasons whose file stays as a tile in the strip; the others (a limit, a chat that takes no image now) are only a line. */
export const isTile = (r: Pick<RefusedFile, "reason">): boolean => r.reason === "type" || r.reason === "size" || r.reason === "read";

/** What a refused tile says: the file's type as its name ends ("HEIC"), else its name. */
export function tileWord(name: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
  return ext ? ext.toUpperCase() : name || "File";
}

/** "A.png was left out", "A.png and 2 more were left out" (verb: "left out" or "not added"). */
function leftOut(names: readonly string[], verb: string): string {
  const first = names[0] || "A file";
  return names.length === 1 ? `${first} was ${verb}` : `${first} and ${names.length - 1} more were ${verb}`;
}

/** One line of the strip: key names the tile it belongs to (the line goes when the tile does); none: a line of the last add. */
export type StripLine = { key: string; text: string; refused?: number };

/** The lines under the strip, in this order: one per refused tile, then the limits and the chat that takes no image, then what the slot says
 *  besides (an upload that failed, images that are gone, a picker that could not be opened). */
export function stripLines(refused: readonly RefusedFile[], said: string): StripLine[] {
  const out: StripLine[] = [];
  for (const r of refused.filter(isTile)) {
    const name = r.name || "A file";
    const why = r.reason === "type" ? `send ${TYPE_NAMES}` : r.reason === "size" ? `over ${mb(IMAGE_MAX_BYTES)}` : "it could not be read";
    out.push({ key: `r${r.key}`, text: `${name} is not added: ${why}.`, refused: r.key });
  }
  const names = (why: RefusedFile["reason"]) => refused.filter((r) => r.reason === why).map((r) => r.name);
  if (names("count").length) out.push({ key: "count", text: `A message takes ${IMAGES_PER_MESSAGE} images: ${leftOut(names("count"), "left out")}.` });
  if (names("total").length) out.push({ key: "total", text: `The images of a message can be ${mb(IMAGES_MESSAGE_BYTES)} together: ${leftOut(names("total"), "left out")}.` });
  const off = refused.find((r) => r.reason === "off");
  if (off) out.push({ key: "off", text: `${off.off || "This chat takes no images now"}: ${leftOut(names("off"), "not added")}.` });
  if (said) out.push({ key: "said", text: said });
  return out;
}
