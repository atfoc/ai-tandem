// The attach button of the composer's toolbar row (package K4; the old page's ComposerImages.tsx AttachButton): an image icon, tooltip "Add images", which
// picks several image files at once (the desktop app's dialog, the browser's file input, the device's picker: platform/imagefiles). `off`: why it
// adds nothing now (logic/chatimage.ts imagesOff: the chat's server is not connected, or the model takes no images), which is its tooltip then. A
// press with the mouse leaves the focus and the caret where they are, as the insert button's does.
import { IconButton } from "../../ui/IconButton.tsx";
import { tid } from "../../ui/tid.ts";
import { AttachIcon } from "../composer/AttachStandIn.tsx";
import { useMeasuring } from "../composer/measure.tsx";
import type { AttachButtonProps } from "../composer/parts.tsx";

export function AttachButton({ off, onPress }: AttachButtonProps) {
  const measuring = useMeasuring();
  return (
    <IconButton {...(measuring ? {} : tid("attach-btn"))} title={off || "Add images"} accessibilityLabel="Add images" disabled={!!off} keepFocus onPress={onPress}>
      {(colour) => <AttachIcon color={colour} />}
    </IconButton>
  );
}
