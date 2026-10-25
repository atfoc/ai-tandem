// Images in the composer (package K4): the strip above the text, the attach button of the toolbar's row and the picker behind it. Registers itself in
// the composer's parts (screens/composer/parts.tsx); registering the strip also turns the box's paste of images on. Imported by screens/register.ts.
import { pickImageFiles, takePhotoFiles } from "../../platform/imagefiles";
import { setComposerPart } from "../composer/parts.tsx";
import { AttachButton } from "./AttachButton.tsx";
import { ImageStrip } from "./ImageStrip.tsx";

setComposerPart("ImageStrip", ImageStrip);
setComposerPart("AttachButton", AttachButton);
setComposerPart("pickImages", pickImageFiles);
setComposerPart("takePhoto", takePhotoFiles); // the camera: native only (null in the web build)

export { AttachButton, ImageStrip };
