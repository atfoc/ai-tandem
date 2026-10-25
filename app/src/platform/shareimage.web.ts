// The share-a-picture port on web: the browser's share with the file when it can send one (a phone's browser), else the file is downloaded.
import type { ShareImage } from "./shareimage.types.ts";
import { fromBase64 } from "./shareimagecore.ts";

export type { ShareImage } from "./shareimage.types.ts";

export const shareImage: ShareImage = async (png, name) => {
  const file = new File([fromBase64(png) as unknown as BlobPart], `${name}.png`, { type: "image/png" });
  if (typeof navigator.canShare === "function" && typeof navigator.share === "function" && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { if ((e as Error)?.name !== "AbortError") throw e; } // (AbortError: the person closed the sheet)
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};
