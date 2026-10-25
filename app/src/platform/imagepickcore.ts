// Picking images on a phone (AD-26): the device's picker, each asset's bytes read, answered as the desktop's dialog
// answers (`DesktopPick`), with the checks of `desktop/lib.js` `pickImages`: the type is taken from the bytes, at most
// 5 MB, at most as many as a message takes. The composer's checks (`logic/chatimage.ts`) then apply as for every way in.
// The picker and the file system are given, so that the tests can give fakes; imagepick.native.ts gives the real ones.
import { IMAGES_PER_MESSAGE, IMAGE_MAX_BYTES, type DesktopPick } from "@aiwb/core/logic/chatimage.ts";

import type { FsFile } from "./picturecache.ts";

export type PickedAsset = { uri: string; fileName?: string | null; fileSize?: number };
export interface ImagePickerPort {
  launchImageLibraryAsync(options: { mediaTypes: "images"[]; allowsMultipleSelection: boolean; quality: number; preferredAssetRepresentationMode: "compatible" }): Promise<
    { canceled: true } | { canceled: false; assets: PickedAsset[] }
  >;
}
/** The camera of expo-image-picker (Take photo): the permission is asked first, then the camera's own screen. */
export interface CameraPort {
  requestCameraPermissionsAsync(): Promise<{ granted: boolean }>;
  launchCameraAsync(options: { mediaTypes: "images"[]; allowsEditing: boolean; quality: number; preferredAssetRepresentationMode: "compatible" }): Promise<
    { canceled: true } | { canceled: false; assets: PickedAsset[] }
  >;
}
export interface PickFs { File: new (...parts: any[]) => FsFile }

/** The type of an image taken from its first bytes alone; "" for anything else (the Client's rule for a picture). */
export function imageTypeOf(b: Uint8Array): string {
  const starts = (s: string, at = 0) => b.length >= at + s.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
  if (starts("\x89PNG\r\n\x1a\n")) return "image/png";
  if (starts("\xff\xd8\xff")) return "image/jpeg";
  if (starts("GIF87a") || starts("GIF89a")) return "image/gif";
  if (starts("RIFF") && starts("WEBP", 8)) return "image/webp";
  return "";
}

const nameOf = (a: PickedAsset): string => a.fileName || decodeURIComponent(a.uri.split("?")[0].split("/").pop() || "image");

/** What the picker's assets become: the checks of the library's pick (count, 5 MB, the type from the bytes) for each, the ones left out named with why. */
async function readAssets(assets: PickedAsset[], fs: PickFs): Promise<DesktopPick> {
  const files: DesktopPick["files"] = [];
  const skipped: DesktopPick["skipped"] = [];
  for (const asset of assets) {
    const name = nameOf(asset);
    if (files.length >= IMAGES_PER_MESSAGE) { skipped.push({ name, reason: "count" }); continue; }
    try {
      const file = new fs.File(asset.uri);
      const size = asset.fileSize ?? file.size;
      if (size > IMAGE_MAX_BYTES) { skipped.push({ name, reason: "size" }); continue; }
      const data = await file.bytes();
      if (data.length > IMAGE_MAX_BYTES) { skipped.push({ name, reason: "size" }); continue; }
      const type = imageTypeOf(data);
      if (!type) { skipped.push({ name, reason: "type" }); continue; }
      files.push({ name, type, data, uri: asset.uri }); // (the picker left the file in the app's cache: it is the thumbnail while the image uploads)
    } catch {
      skipped.push({ name, reason: "read" });
    }
  }
  return { files, skipped };
}

export async function pickImagesWith(picker: ImagePickerPort, fs: PickFs): Promise<DesktopPick> {
  // `compatible` (iOS; Android has no such thing): the system hands over a HEIC of the library as a JPEG. The default, `automatic`, hands it over as it is, and the
  // type is taken from the bytes: a phone's photos (HEIC unless the camera is set to "Most Compatible") would all be refused as "Not a PNG, JPEG, GIF or WebP image".
  const r = await picker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 1, preferredAssetRepresentationMode: "compatible" });
  if (r.canceled || !r.assets?.length) return { files: [], skipped: [] };
  return readAssets(r.assets, fs);
}

/** Take photo: the camera's one picture, answered as the library's pick is. A refused permission is an Error that says how to allow the camera. */
export async function takePhotoWith(picker: CameraPort, fs: PickFs): Promise<DesktopPick> {
  const allowed = await picker.requestCameraPermissionsAsync();
  if (!allowed.granted) throw new Error("The camera is off for AI Whiteboard. Allow it in Settings, under AI Whiteboard, then try again.");
  const r = await picker.launchCameraAsync({ mediaTypes: ["images"], allowsEditing: false, quality: 1, preferredAssetRepresentationMode: "compatible" });
  if (r.canceled || !r.assets?.length) return { files: [], skipped: [] };
  return readAssets(r.assets.slice(0, 1), fs);
}
