// The picker of images on iOS and Android (AD-26): expo-image-picker's library, the files read with expo-file-system.
// (`as unknown as PickFs`: the web check of the types sees the web declarations of expo-file-system, whose File is a stub.)
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

import { pickImagesWith, type ImagePickerPort, type PickFs } from "./imagepickcore.ts";

export const pickImages = () => pickImagesWith(ImagePicker as unknown as ImagePickerPort, FileSystem as unknown as PickFs);
