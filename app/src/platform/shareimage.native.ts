// The share-a-picture port on a device: the picture is written to a file in the cache and handed to the system's share sheet (RN's
// `Share`, which takes a file address on iOS only: Android's menu does not offer "Share image…", `share: false`).
// (`as unknown as FsModule`: the web check of the types sees the web declarations of expo-file-system, as in imagepick.native.ts.)
import * as FileSystem from "expo-file-system";
import { Platform, Share } from "react-native";

import type { FsModule } from "./picturecache.ts";
import type { ShareImage } from "./shareimage.types.ts";
import { fromBase64 } from "./shareimagecore.ts";

export type { ShareImage } from "./shareimage.types.ts";

const fs = FileSystem as unknown as FsModule;
const FOLDER = "aiwb-share";

export const shareImage: ShareImage = async (png, name) => {
  if (Platform.OS !== "ios") throw new Error("this device cannot share a picture from here");
  const dir = new fs.Directory(fs.Paths.cache, FOLDER);
  dir.create({ intermediates: true, idempotent: true });
  const file = new fs.File(dir, `${name}.png`);
  file.create({ overwrite: true });
  file.write(fromBase64(png));
  await Share.share({ url: file.uri });
};
