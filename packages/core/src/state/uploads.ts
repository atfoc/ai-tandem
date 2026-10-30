// The images a chat's composers are uploading. A file that passed the check (logic/chatimage.ts checkFiles) is uploaded
// at once, and its upload belongs to the branch it was added on, not to the composer that started it: the composer can
// go away (another chat or branch is opened) and the upload goes on. When it is answered the image is in that branch's
// draft: in its composer when one is open, else in the draft itself. What a composer draws of its uploads, and what its
// error line says of the images, is read from here. What a thumbnail shows while its image is on its way is the client's
// (`setPreviews`): a browser's object URL of the file by default.
import { api, ApiError } from "../api.ts";
import { getState, setUploading } from "./store.ts";
import { ui } from "./ports.ts";
import { composerOpen, heldImages } from "./actions.ts";
import { draftToShow, putDraft, savesDone } from "./chatdraft.ts";
import { draftOf, staleOf } from "../logic/drafts.ts";
import { branchKey } from "../logic/branches.ts";
import { IMAGE_TYPES, imageUrl, checkFiles, fileType, goneLine, imagesBytes, isBytesFile, refusedLine, uploadFailed, withImages, withoutImages, type Picked, type Refused, type RefusedWhy, type UploadFile } from "../logic/chatimage.ts";
import type { ChatImage } from "../types.ts";

/** An upload that runs: key names it here, src is what its thumbnail shows meanwhile. */
export type Upload = { key: number; name: string; size: number; src: string };

/** A file the last add refused, kept so that the phone's strip can show it: key names it here; name and reason as the check gave them;
 *  uri: the file the picker left, when there is one (its tile's preview); off: for reason "off", why the chat takes no image now. */
export type RefusedFile = { key: number; name: string; reason: RefusedWhy; uri?: string; off?: string };

/** What a branch's composer draws of its uploads: the ones that run, in the order they were added, and what its error
 *  line says of the images (files that were not added, an upload that failed, images that are no longer there).
 *  refused: the files of the last add that were not added, one entry each (the phone's strip draws them, and the error line
 *  says them too: the wide layouts draw only the line). said: the error line without the sentence about those files, which the
 *  phone's strip says by the entries (an upload that failed, images that are gone, the picker that could not be opened). */
export type Slot = { uploads: readonly Upload[]; error: string; refused: readonly RefusedFile[]; said: string };

const NONE: Slot = { uploads: [], error: "", refused: [], said: "" };
const slots = new Map<string, Slot>();
const aborts = new Map<number, AbortController>();
const listeners = new Set<() => void>();
let seq = 0;

/** Calls f after every change of a slot; answers what ends that. */
export function subscribe(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

/** The slot of a branch's composer: the same object until it changes. */
export const slotOf = (chat: string, branch: string): Slot => slots.get(branchKey(chat, branch)) ?? NONE;

function setSlot(chat: string, branch: string, f: (s: Slot) => Slot) {
  const key = branchKey(chat, branch), was = slotOf(chat, branch), now = f(was);
  if (now === was) return;
  if (now.uploads.length || now.error || now.refused.length) slots.set(key, now); else slots.delete(key);
  if (!was.uploads.length !== !now.uploads.length) setUploading(chat, branch, now.uploads.length > 0);
  for (const l of [...listeners]) l();
}

/** Sets what the error line of a branch's composer says of its images; "" takes it away, and the refused files kept for the phone's strip with it. */
export function setImageError(chat: string, branch: string, error: string) {
  setSlot(chat, branch, (s) => (s.error === error && (error || !s.refused.length) ? s : { ...s, error, said: error, refused: error ? s.refused : [] }));
}

/** Takes a refused file out of the phone's strip: its tile and its line. */
export function dismissRefused(chat: string, branch: string, key: number) {
  setSlot(chat, branch, (s) => (s.refused.some((r) => r.key === key) ? { ...s, refused: s.refused.filter((r) => r.key !== key) } : s));
}

/** Says something of a branch's images: in the error line of its composer when one is open, after what the line says
 *  already; else in a dialog, since the line of a composer opened later would tell of what is long over. */
function say(chat: string, branch: string, text: string) {
  if (!getState().chats[chat]) return;
  if (composerOpen(chat, branch)) setSlot(chat, branch, (s) => ({ ...s, error: s.error ? `${s.error} ${text}` : text, said: s.said ? `${s.said} ${text}` : text }));
  else ui().reportError(`Couldn't add an image to “${getState().chats[chat]?.name || "the chat"}”`, new Error(text));
}

// ---- the thumbnail of an image uploaded from this page: the file itself, until the image's own address has loaded

/** What a client does for a thumbnail that shows the file an image was uploaded from (a seam: a browser has object URLs and an
 *  Image to load an address with, a phone has the file the picker left and fetches the picture through the transport). */
export type Previews = {
  /** An address the file can be shown from. */
  make(file: UploadFile): string;
  /** An address made is no longer shown. */
  release(src: string): void;
  /** Loads the image's own address (chat: the page's key of the top-level chat) and calls done, once, when it has loaded or cannot be.
   *  false: this client cannot load one, and nothing is kept. */
  loaded(chat: string, id: string, done: () => void): boolean;
};

/** The browser's: an object URL of the file, and an Image that loads the address the transport gives at once. */
const browserPreviews: Previews = {
  make: (file) => URL.createObjectURL(file as Blob),
  release: (src) => { URL.revokeObjectURL(src); },
  loaded(chat, id, done) {
    if (typeof Image === "undefined") return false;
    const img = new Image();
    img.onload = done; img.onerror = done;
    img.src = imageUrl(chat, id);
    return true;
  },
};
let previewsOf: Previews = browserPreviews;

/** Sets what a thumbnail shows while its image is on its way (once, at start). */
export function setPreviews(p: Previews) { previewsOf = p; }

const previews = new Map<string, string>(); // by the chat's key and the image's id: an id is one chat's on one server
let previewSeq = 0;
const previewKey = (chat: string, id: string): string => `${chat}/${id}`;

/** Counts the changes of the thumbnails kept here: what draws them reads them again when it changes. */
export const previewsAt = (): number => previewSeq;

/** What the thumbnail of an image of a chat shows in the place of its address while that loads: the file it was
 *  uploaded from, to that chat. chat: the page's key of the top-level chat. */
export const previewOf = (chat: string, id: string): string | undefined => previews.get(previewKey(chat, id));

/** Keeps the file an image was uploaded from as its thumbnail until the image's own address has loaded, or cannot be:
 *  the thumbnail does not blink as the upload ends. The same picture uploaded again to the same chat keeps the first
 *  file; uploaded to another chat, or to the chat with the same id on another server, it is that chat's own. */
function keepPreview(chat: string, id: string, src: string) {
  const key = previewKey(chat, id);
  if (previews.has(key)) { previewsOf.release(src); return; }
  previews.set(key, src);
  previewSeq++;
  let loading = false;
  try { loading = previewsOf.loaded(chat, id, () => dropPreview(key)); } catch { /* an address that cannot be made: nothing to wait for */ }
  if (!loading) { previews.delete(key); previewSeq++; previewsOf.release(src); }
}

function dropPreview(key: string) {
  const src = previews.get(key);
  if (src === undefined) return;
  previews.delete(key);
  previewSeq++;
  previewsOf.release(src);
  for (const l of [...listeners]) l();
}

// ---- adding files

export type { Picked };

/** Adds files to the message of a branch's composer, whichever way they came (a paste, the picker, the desktop app's
 *  dialog): each goes through the one check, and one that passes is uploaded at once. has: the images the composer
 *  holds; off: why the chat takes no image now (logic/chatimage.ts imagesOff: its server is not connected, or the
 *  model takes none), else ""; skipped: the files the desktop app's dialog left out.
 *  The composer's error line says which files were not added and why, or nothing. The same for a chat on this computer
 *  and on another server: the upload is the chat's own call, to the server the chat is on. */
export function addImages(chat: string, branch: string, files: readonly Picked[], o: { has: readonly ChatImage[]; off?: string; skipped?: readonly Refused[] }) {
  const slot = slotOf(chat, branch);
  const room = { count: o.has.length + slot.uploads.length, bytes: imagesBytes(o.has) + imagesBytes(slot.uploads) };
  const asked = files.map((f) => ({ ...f, type: f.file.type, size: f.file.size }));
  const { take, refused } = checkFiles(asked, room, !!o.off);
  const all = [...(o.skipped ?? []), ...refused], error = refusedLine(all, o.off || undefined);
  const kept = all.map((r): RefusedFile => {
    const file = files.find((f) => f.name === r.name)?.file;
    return { key: ++seq, name: r.name, reason: r.reason, ...(isBytesFile(file) && file.uri ? { uri: file.uri } : {}), ...(r.reason === "off" && o.off ? { off: o.off } : {}) };
  });
  setSlot(chat, branch, (s) => (!s.error && !s.refused.length && !error ? s : { ...s, error, said: "", refused: kept }));
  for (const f of take) start(chat, branch, f.file, f.name, fileType(f));
}

function start(chat: string, branch: string, file: UploadFile, name: string, type: string) {
  const up: Upload = { key: ++seq, name, size: file.size, src: previewsOf.make(file) };
  const abort = new AbortController();
  aborts.set(up.key, abort);
  setSlot(chat, branch, (s) => ({ ...s, uploads: [...s.uploads, up] }));
  const end = () => { aborts.delete(up.key); setSlot(chat, branch, (s) => ({ ...s, uploads: s.uploads.filter((u) => u.key !== up.key) })); };
  api.uploadImage(chat, file, name, type, abort.signal).then(
    (image) => {
      if (abort.signal.aborted || !isImage(image)) throw abort.signal.aborted ? abort.signal.reason : new Error("the server's answer names no image");
      keepPreview(chat, image.id, up.src);
      end();
      void arrived(chat, branch, image);
    },
  ).catch((e) => {
    end();
    previewsOf.release(up.src);
    if (abort.signal.aborted) return; // taken out of the strip by the user
    // (a cut connection has the browser's own words, which say nothing: "Failed to fetch")
    say(chat, branch, uploadFailed(name, e instanceof ApiError ? e.message : "the upload did not reach the server"));
  });
}

const isImage = (x: unknown): x is ChatImage => {
  const i = x as ChatImage | null;
  return !!i && typeof i.id === "string" && !!i.id && typeof i.name === "string" && typeof i.size === "number" && IMAGE_TYPES.includes(i.type);
};

/** Takes an upload that runs out of its composer's strip: it is cut, and its image is added to nothing. */
export function cancelUpload(chat: string, branch: string, key: number) {
  aborts.get(key)?.abort();
  setSlot(chat, branch, (s) => (s.uploads.some((u) => u.key === key) ? { ...s, uploads: s.uploads.filter((u) => u.key !== key) } : s));
}

/** What waits for a composer of a branch to open, by the branch's key. */
const opens = new Map<string, Set<() => void>>();

/** A composer of a chat's branch opened (fork/actions.ts registerComposer): an image that waits to go into the
 *  branch's draft goes into that composer. */
export function composerOpened(chat: string, branch: string) {
  for (const f of [...(opens.get(branchKey(chat, branch)) ?? [])]) f();
}

/** Resolves when a composer of the branch opens. stop ends the wait for it. */
function nextOpen(chat: string, branch: string): { opened: Promise<void>; stop(): void } {
  const key = branchKey(chat, branch), set = opens.get(key) ?? new Set();
  opens.set(key, set);
  let f = () => {};
  const opened = new Promise<void>((resolve) => { f = resolve; set.add(f); });
  return { opened, stop: () => { set.delete(f); if (!set.size && opens.get(key) === set) opens.delete(key); } };
}

/** An upload was answered: the image is in the draft of the branch it was added on. In that branch's composer when one
 *  is open, and under a pending move in what its composer left; they save it as they save what is typed. Else in the
 *  branch's draft: the one the next composer would open with, after the saves of it that are on their way (a composer
 *  that went away saves what it held), so that what was typed there since is in it and no save of that text comes
 *  after it; a composer that opens while it waits gets the image. A save refused because the draft was changed
 *  elsewhere meanwhile is made again on that draft. Nothing typed is lost or replaced. A chat that is gone by now
 *  gets nothing. */
async function arrived(chat: string, branch: string, image: ChatImage): Promise<void> {
  const add = (now: readonly ChatImage[]) => withImages(now, [image]);
  for (let i = 0; i < 4; i++) {
    if (!getState().chats[chat] || heldImages(chat, branch, add)) return;
    const wait = nextOpen(chat, branch);
    await Promise.race([savesDone(chat, branch), wait.opened]);
    wait.stop();
    if (!getState().chats[chat] || heldImages(chat, branch, add)) return;
    const d = draftToShow(chat, branch) ?? { text: "" };
    if (d.images?.some((x) => x.id === image.id)) return;
    try { await putDraft(chat, branch, draftOf(d.text, d.references, add(d.images ?? []))); return; }
    catch (e) { if (!staleOf(e)) return; } // not saved: the unsaved copy has it, and the branch's next composer saves it
  }
}

/** Images a draft of a branch named are no longer on the server (a save's answer or a refused Send told): they leave
 *  what the branch's composer holds, and its error line says what must be added again. With no composer of the branch
 *  open (a draft the browser kept was saved by itself when its server was back, keptdrafts.ts; a draft set from
 *  outside a composer) the line waits for the branch's next composer, which opens with the draft that lacks them:
 *  they would else be gone without a sign. It goes as that composer does. */
export function imagesGone(chat: string, branch: string, gone: readonly ChatImage[]) {
  if (!gone.length || !getState().chats[chat]) return;
  const ids = gone.map((x) => x.id);
  heldImages(chat, branch, (now) => (now.some((x) => ids.includes(x.id)) ? withoutImages(now, ids) : now as ChatImage[]));
  const line = goneLine(gone.map((x) => x.name));
  setSlot(chat, branch, (s) => ({ ...s, error: [s.error, line].filter(Boolean).join(" "), said: [s.said, line].filter(Boolean).join(" ") }));
}
