// Images the user attaches to a chat message: the limits, the types taken and the address of an image. The server has the
// same numbers (model.ImageMaxBytes and the constants after it) and decides; the page checks to say so early. DOM-free.
import { splitKey } from "./keys.ts";
import { transport } from "../transport/index.ts";

/** The types a chat takes. */
export const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** One image, in bytes. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Images in one message. */
export const IMAGES_PER_MESSAGE = 10;
/** The images of one message together, in bytes. */
export const IMAGES_MESSAGE_BYTES = 20 * 1024 * 1024;

/** The word that stands for the words of a message that is images alone, wherever a message is named by its words. */
export const IMAGE_WORD = "Image";

/** The name of a pasted picture, which has no file name of its own. */
export const PASTED_NAME = "Pasted image";

/** Where the page shows an image of a chat from: the transport's address of a picture, from the chat's server, the chat's own id
 *  and the image's id, which the app (or the host) fetches from that server and checks. chat: the page's key of the top-level
 *  chat (logic/keys.ts). */
export function imageUrl(chat: string, id: string): string {
  const at = splitKey(chat);
  const url = transport().pictureURL;
  if (!url) throw new Error("this transport gives no synchronous address of a picture: use imageAddress()");
  return url(at.server, at.id, id);
}

/** The same address, given asynchronously (D12): it resolves at once on ipc and http, after the fetch on native. A screen asks
 *  for it through <Picture>, so it does not know the platform. Rejects as transport().picture does. */
export function imageAddress(chat: string, id: string, signal?: AbortSignal): Promise<string> {
  const at = splitKey(chat);
  return transport().picture(at.server, at.id, id, signal);
}

// ---- the images of one message: a list with each image once, by its id

type Img = { id: string; name: string; type: string; size: number };

/** An image as a draft names it: its four fields and nothing else, in one order, so that two drafts with the same images
 *  compare as the same whatever sent them. */
export const plainImage = ({ id, name, type, size }: Img): Img => ({ id, name, type, size });

/** have, and after it what more has that have does not: the same picture is one image. */
export function withImages<T extends { id: string }>(have: readonly T[], more: readonly T[]): T[] {
  const out = [...have];
  for (const m of more) if (!out.some((x) => x.id === m.id)) out.push(m);
  return out;
}

/** have without the images named. */
export const withoutImages = <T extends { id: string }>(have: readonly T[], ids: readonly string[]): T[] => have.filter((x) => !ids.includes(x.id));

/** Whether two lists name the same images in the same order. */
export const sameImages = (a: readonly { id: string }[], b: readonly { id: string }[]): boolean => a.length === b.length && a.every((x, i) => x.id === b[i].id);

/** The images of a message together, in bytes. */
export const imagesBytes = (images: readonly { size: number }[]): number => images.reduce((n, x) => n + x.size, 0);

// ---- the one check for every way in (a paste, the attach button, the desktop app's dialog)

/** A file as the check reads it. */
export type FileLike = { name: string; type: string; size: number };

/** Why a file is not added. type: not one of IMAGE_TYPES; size: over IMAGE_MAX_BYTES; count, total: the message would
 *  pass IMAGES_PER_MESSAGE or IMAGES_MESSAGE_BYTES with it; off: the chat takes no image now (imagesOff); read: the
 *  desktop app could not read it. */
export type RefusedWhy = "type" | "size" | "count" | "total" | "off" | "read";
export type Refused = { name: string; reason: RefusedWhy };

const BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const ext = (name: string): string => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? "";

/** The type a file is uploaded as: its own when that is one a chat takes, and for a file that says none the one its name
 *  ends with. "": not a type a chat takes. The server finds the type from the bytes; this is to say so early. */
export function fileType(f: Pick<FileLike, "name" | "type">): string {
  const t = f.type.toLowerCase() === "image/jpg" ? "image/jpeg" : f.type.toLowerCase();
  if (t) return IMAGE_TYPES.includes(t) ? t : "";
  return BY_EXT[ext(f.name)] ?? "";
}

/** What a message has before a file is added: its images and the uploads that run, as their count and their bytes. */
export type Room = { count: number; bytes: number };

/** The check every file goes through, whichever way it came: its type, its size, the count and the total of the message
 *  with it, and that the chat takes images now (off: it takes none, imagesOff). take: the files to upload, in their
 *  order; refused: the others, each with why. A file that is refused takes no room from the ones after it. */
export function checkFiles<F extends FileLike>(files: readonly F[], has: Room, off = false): { take: F[]; refused: Refused[] } {
  const take: F[] = [], refused: Refused[] = [];
  let { count, bytes } = has;
  for (const f of files) {
    const why: RefusedWhy | "" = off ? "off" : !fileType(f) ? "type" : f.size > IMAGE_MAX_BYTES ? "size"
      : count >= IMAGES_PER_MESSAGE ? "count" : bytes + f.size > IMAGES_MESSAGE_BYTES ? "total" : "";
    if (why) { refused.push({ name: f.name, reason: why }); continue; }
    take.push(f); count++; bytes += f.size;
  }
  return { take, refused };
}

const mb = (bytes: number): string => `${bytes / (1024 * 1024)} MB`;
const TYPE_NAMES = "PNG, JPEG, GIF or WebP";
const WHYS: RefusedWhy[] = ["off", "type", "size", "count", "total", "read"];

/** A model that takes no images, in the words of the attach button's tooltip. */
export const noImagesLine = (model: string): string => `${model} takes no images`;
/** Why Send is off for a draft with images on such a model. */
export const noImagesSend = (model: string): string => `${noImagesLine(model)}: remove the images or choose another model`;

/** Why a chat's composer takes no image now. line: the reason, as the refusal of a pasted file says it; title: the
 *  attach button's tooltip, which also says when it takes them again. */
export type ImagesOff = { line: string; title: string };

/** Why the composer of a chat takes no image now, by a paste or by the attach button; null when it takes them.
 *  server: the name of the chat's server, and whether it is connected: an upload cannot reach a server that is not.
 *  model: the label of the model the message goes to when that takes no images, else "".
 *  The images a draft has already stay in it in each case, and can be removed. */
export function imagesOff(o: { server: string; connected: boolean; model: string }): ImagesOff | null {
  if (!o.connected) return { line: `${o.server} is not connected`, title: `${o.server} is not connected: images can be added when it is back` };
  return o.model ? { line: noImagesLine(o.model), title: noImagesLine(o.model) } : null;
}

/** What the composer's error line says of the files that were not added: one sentence per reason, each naming its
 *  files. off: why the chat takes no image now (ImagesOff.line), for the files that refused. "" for none. */
export function refusedLine(refused: readonly Refused[], off = "This chat takes no images now"): string {
  const why: Record<RefusedWhy, string> = {
    off: `${off}, not added`,
    type: `Not a ${TYPE_NAMES} image`,
    size: `Over ${mb(IMAGE_MAX_BYTES)}`,
    count: `A message takes ${IMAGES_PER_MESSAGE} images, not added`,
    total: `The images of a message can be ${mb(IMAGES_MESSAGE_BYTES)} together, not added`,
    read: "Could not be read",
  };
  return WHYS.flatMap((w) => {
    const names = refused.filter((r) => r.reason === w).map((r) => r.name || "a file");
    return names.length ? [`${why[w]}: ${names.join(", ")}.`] : [];
  }).join(" ");
}

/** Why a message with these images cannot be sent, as it can be after two drafts were joined: Send is off with it until
 *  images are removed. "" for one within the limits. */
export function overLimit(images: readonly { size: number }[]): string {
  if (images.length > IMAGES_PER_MESSAGE) {
    const n = images.length - IMAGES_PER_MESSAGE;
    return `A message takes ${IMAGES_PER_MESSAGE} images: remove ${n} to send`;
  }
  return imagesBytes(images) > IMAGES_MESSAGE_BYTES ? `The images of a message can be ${mb(IMAGES_MESSAGE_BYTES)} together: remove some to send` : "";
}

/** Why the Send of a composer is off for its images; "" when they do not hold it. uploading: an upload of the composer
 *  runs; noImages: the label of the model the message goes to when that takes no images, else "". */
export function imagesHold(images: readonly { size: number }[], uploading: boolean, noImages: string): string {
  if (uploading) return UPLOADING;
  if (!images.length) return "";
  return noImages ? noImagesSend(noImages) : overLimit(images);
}

export const UPLOADING = "An image is being uploaded";

/** What the error line says of an upload that failed or was cut: the image left the strip, and is not tried again. */
export const uploadFailed = (name: string, why: string): string => `${name} was not added: ${why.replace(/[.\s]+$/, "") || "the upload failed"}.`;

/** What the error line says of images a draft named that the chat no longer holds: they left the strip. */
export const goneLine = (names: readonly string[]): string => (names.length ? `No longer there, add again: ${names.join(", ")}.` : "");

// ---- a paste

/** What a paste holds, as the rule reads it. plain: it has plain text; rich: it has rich text (HTML or RTF). */
export type Pasted<F> = { plain: boolean; rich: boolean; files: readonly F[] };

/** Whether a pasted file is a picture, of a type a chat takes or not (the check says which it does not take). A file
 *  that names no type is one by its name's ending. */
const isPicture = (f: Pick<FileLike, "name" | "type">): boolean => (f.type ? f.type.toLowerCase().startsWith("image/") : ext(f.name) in BY_EXT);

/** The image files a paste adds to the message, which then consumes the paste; none: the paste goes on as it always did
 *  (its plain text is pasted). Image files are added, but when the clipboard has plain text and rich text too: a copied
 *  spreadsheet cell comes as a picture, plain text and rich text, and the user means the text. A file copied in a file
 *  manager, which may come with its name as plain text and no rich text, is an image to add. Files that are not
 *  pictures are left out. */
export function pastedImages<F extends Pick<FileLike, "name" | "type">>(p: Pasted<F>): F[] {
  return p.plain && p.rich ? [] : p.files.filter(isPicture);
}

/** The name of an image that came by a paste: the file's own, or PASTED_NAME for a picture that has none (the browser
 *  calls a pasted picture "image.png"). */
export const pastedName = (name: string): string => (!name || /^image\.[a-z0-9]+$/i.test(name) ? PASTED_NAME : name);

// ---- the attach button's files

/** A picked file as bytes, for a client with no Blob it can build from them (React Native's Blob takes no bytes): the bytes, the
 *  type they were found to have, their count, and, when the picker left the file somewhere, where (`uri`: its thumbnail is that file
 *  until the image's own address has loaded). A browser's File and Blob stay what they are. */
export type BytesFile = { readonly bytes: Uint8Array; readonly type: string; readonly size: number; readonly uri?: string };

/** What an upload sends: a Blob (a browser's file), or the bytes of a file picked on a device. */
export type UploadFile = Blob | BytesFile;

export const isBytesFile = (x: unknown): x is BytesFile => !!x && typeof x === "object" && (x as BytesFile).bytes instanceof Uint8Array && typeof (x as BytesFile).type === "string";

/** A file on its way into a message, under the name its image gets. */
export type Picked = { file: UploadFile; name: string };

/** What the desktop app's own open dialog answers (the transport's pickImages): the files it read, and the ones it
 *  left out, each with why. A cancelled dialog answers both lists empty. */
export type DesktopPick = { files: { name: string; type: string; data: Uint8Array; uri?: string }[]; skipped: { name: string; reason: "size" | "count" | "type" | "read" }[] };

/** What the desktop app's dialog returned, as files for the check every file goes through, and what it left out, for
 *  the composer's error line. An answer that is not of that shape gives nothing. asBytes: the files are not made Blobs but
 *  BytesFiles (a device, whose Blob cannot be made from bytes), keeping the picker's `uri` for the thumbnail. */
export function fromDesktop(r: DesktopPick | null | undefined, o?: { asBytes?: false }): { files: { file: Blob; name: string }[]; skipped: Refused[] };
export function fromDesktop(r: DesktopPick | null | undefined, o: { asBytes: boolean }): { files: Picked[]; skipped: Refused[] };
export function fromDesktop(r: DesktopPick | null | undefined, o: { asBytes?: boolean } = {}): { files: Picked[]; skipped: Refused[] } {
  const files = Array.isArray(r?.files) ? r.files : [], skipped = Array.isArray(r?.skipped) ? r.skipped : [];
  const typeOf = (f: { type: string }) => (typeof f.type === "string" ? f.type : "");
  return {
    files: files.filter((f) => f && typeof f.name === "string" && f.data instanceof Uint8Array)
      .map((f): Picked => ({
        file: o.asBytes
          ? { bytes: f.data, type: typeOf(f), size: f.data.length, ...(typeof f.uri === "string" && f.uri ? { uri: f.uri } : {}) }
          : new Blob([f.data as BlobPart], { type: typeOf(f) }),
        name: f.name,
      })),
    skipped: skipped.filter((s) => s && typeof s.name === "string").map((s) => ({ name: s.name, reason: (["size", "count", "type", "read"] as const).includes(s.reason) ? s.reason : "read" })),
  };
}
