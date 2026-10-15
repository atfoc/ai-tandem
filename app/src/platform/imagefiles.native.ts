// Picking the files of an image (AD-26), iOS and Android: the device's picker (the transport's `pickImages`: expo-image-picker's library, each file
// read, its type taken from its bytes, 5 MB and the count checked, imagepickcore.ts). The files stay bytes, not Blobs (a Blob cannot be made from
// bytes here), with the file the picker left as their thumbnail while they upload.
import { fromDesktop, type Refused } from "@aiwb/core/logic/chatimage.ts";
import type { Picked } from "@aiwb/core/state/uploads.ts";
import { transport } from "@aiwb/core/transport/index.ts";

export async function pickImageFiles(): Promise<{ files: Picked[]; skipped: Refused[] }> {
  const pick = transport().pickImages;
  if (!pick) throw new Error("this device has no picker for images");
  return fromDesktop(await pick(), { asBytes: true });
}
