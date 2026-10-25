// Picking the files of an image (AD-26), web build: the desktop app's own open dialog when the window has one (the transport's `pickImages`,
// through the bridge: several image files, in the dialog's order, the ones it left out named with why), else the browser's own file input (the
// page in a headless browser, which has no dialog of the app). A cancelled dialog answers no files.
import { IMAGE_TYPES, fromDesktop, type Refused } from "@aiwb/core/logic/chatimage.ts";
import type { Picked } from "@aiwb/core/state/uploads.ts";
import { transport } from "@aiwb/core/transport/index.ts";

export async function pickImageFiles(): Promise<{ files: Picked[]; skipped: Refused[] }> {
  const t = transport();
  if (t.pickImages) return fromDesktop(await t.pickImages());
  return { files: (await browserPick()).map((f) => ({ file: f, name: f.name })), skipped: [] };
}

/** No camera in the web build: the browser's file input is the one picker (the composer part `takePhoto` is null there). */
export const takePhotoFiles = null;

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
