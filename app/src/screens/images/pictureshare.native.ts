// Sharing and saving a picture on a device: the picture is the file the app has cached (the transport's `picture()` ends in `pictureFile`: a `file://`
// address) and the system's share sheet takes it (RN's `Share.share({ url })`, which is iOS's). Save opens the same sheet: iOS offers "Save Image"
// there. The app has no photo-library module, and adding one is a native dependency and a dev-client rebuild, so it is not done here. RN's Share on
// Android takes no file, so Android has neither action (viewer.ts viewerActions).
import { Share } from "react-native";

import { pictureAddress } from "../../platform/picturecommon.tsx";
import type { PictureShare, SharedPicture } from "./pictureshare.types.ts";

export type { PictureShare, SharedPicture } from "./pictureshare.types.ts";

async function sheet(p: SharedPicture): Promise<void> {
  const url = await pictureAddress(p.server, p.chat, p.id);
  await Share.share({ url }); // (a dismissed sheet resolves with `dismissedAction`: not a failure)
}

export const pictureShare: PictureShare = { canShare: () => true, share: sheet, save: sheet };
