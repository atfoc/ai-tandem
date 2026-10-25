// Sharing and saving a picture on web. Save is a download of the picture's own address (an `<a download>`: the original bytes). Share is
// `navigator.share({ files })`, offered only when `navigator.canShare` takes a file: the app's JS makes no call of `fetch` outside aiwb-net
// (test/noplainhttp.test.ts), so the file is made from the picture the way the page draws it: loaded as an image and drawn on a canvas, and written as a
// png (its name's extension follows).
import { pictureAddress } from "../../platform/picturecommon.tsx";
import type { PictureShare, SharedPicture } from "./pictureshare.types.ts";

export type { PictureShare, SharedPicture } from "./pictureshare.types.ts";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, no) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => no(new Error("the picture could not be loaded"));
    img.src = src;
  });
}

async function fileOf(p: SharedPicture): Promise<File> {
  const img = await loadImage(await pictureAddress(p.server, p.chat, p.id));
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
  if (!blob) throw new Error("the picture could not be read");
  return new File([blob], p.name.replace(/\.[^./]+$/, "") + ".png", { type: "image/png" });
}

const canShareFiles = (): boolean => {
  try { return typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([], "a.png", { type: "image/png" })] }); }
  catch { return false; }
};

export const pictureShare: PictureShare = {
  canShare: canShareFiles,
  async share(p) {
    const file = await fileOf(p);
    try { await navigator.share({ files: [file], title: p.name }); }
    catch (e) { if ((e as Error)?.name !== "AbortError") throw e; } // (the person closed the share: nothing failed)
  },
  async save(p) {
    const a = document.createElement("a");
    a.href = await pictureAddress(p.server, p.chat, p.id); a.download = p.name; a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  },
};
